const crypto = require('crypto');
const { setTimeout: delay } = require('timers/promises');
const db = require('../db/database');
const sources = require('./subscriptionSources');
const health = require('./subscriptionHealth');
const { VpnChecker } = require('./vpnChecker');
const { SubscriptionError, safeError } = require('../utils/subscriptionErrors');

class ProbeScheduler {
  constructor(config, { checker = new VpnChecker(config), sync = sources.syncSource } = {}) {
    this.config = config;
    this.checker = checker;
    this.sync = sync;
    this.tasks = new Map();
    this.running = new Set();
    this.results = [];
    this.counts = { sync: 0, check: 0 };
    this.lastServed = new Map();
    this.sequence = 0;
    this.closed = false;
    this.started = false;
    this.storageError = null;
    this.nextBinaryRetry = 0;
    this.lastPrune = 0;
  }

  job(id) {
    const row = db.get('SELECT * FROM background_jobs WHERE id = ?', [id]);
    if (!row) return null;
    const { dedupe_key, ...safe } = row;
    return safe;
  }

  createJob(type, key, sourceId, nodeId, reason, total) {
    const existing = db.get("SELECT id FROM background_jobs WHERE dedupe_key = ? AND state IN ('queued', 'running')", [key]);
    if (existing) return { id: existing.id, existing: true };
    const id = crypto.randomUUID();
    const now = Date.now();
    db.run(`INSERT INTO background_jobs (id, type, dedupe_key, source_id, node_id, reason, total, created_at, state, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, type, key, sourceId, nodeId, reason, total, now, total ? 'queued' : 'completed', total ? null : now]);
    return { id, existing: false };
  }

  ensureCapacity(additional) {
    if (this.closed) throw new SubscriptionError('cancelled', undefined, 503);
    if (this.storageError) throw new SubscriptionError('storage_error', 'Не удалось сохранить БД. Проверьте свободное место и перезапустите сервис.', 503);
    if (this.tasks.size + additional > this.config.maxQueued) throw new SubscriptionError('queue_full', undefined, 429);
  }

  enqueueSync(sourceId, reason = 'manual') {
    const source = sources.getSource(sourceId);
    if (!source || !source.is_active) throw new SubscriptionError('validation', 'Источник не найден или отключён.', 409);
    const key = `sync:${sourceId}:${source.revision}`;
    this.ensureCapacity(this.tasks.has(key) ? 0 : 1);
    const job = this.createJob('sync', key, sourceId, null, reason, 1);
    if (!job.existing) this.tasks.set(key, {
      key, kind: 'sync', sourceId, revision: source.revision, jobIds: new Set([job.id]),
      state: 'queued', queuedAt: Date.now(), priority: 0, controller: new AbortController()
    });
    this.pump();
    return this.job(job.id);
  }

  nodeKey(node) {
    return `check:${node.id}:${node.generation}:${node.source_revision}:${this.config.profileVersion}`;
  }

  enqueueCheck({ sourceId, nodeId, reason = 'manual', dueOnly = false } = {}) {
    let nodes = nodeId ? [health.getNode(nodeId)].filter(Boolean) : health.getNodes(sourceId);
    nodes = nodes.filter(node => node.source_active && node.is_enabled && node.is_present && node.capability_status === 'supported');
    if (nodeId && !nodes.length) throw new SubscriptionError('validation', 'Узел недоступен для проверки: он отключён, удалён или не поддерживается.', 409);
    if (!nodeId && !sources.getSource(sourceId)?.is_active) throw new SubscriptionError('validation', 'Источник не найден или отключён.', 409);
    const now = Date.now();
    if (dueOnly) {
      nodes = nodes.filter(node => !this.tasks.has(this.nodeKey(node)) &&
        (node.next_check_at <= now || (node.last_checked_at && node.last_attempt_at <= node.last_checked_at && node.probe_profile_version !== this.config.profileVersion)));
      nodes = nodes.slice(0, Math.max(0, this.config.maxQueued - this.tasks.size));
      if (!nodes.length) return null;
    }
    this.ensureCapacity(nodes.filter(node => !this.tasks.has(this.nodeKey(node))).length);
    sourceId = sourceId || nodes[0]?.source_id;
    const signature = crypto.createHash('sha256').update(nodes.map(node => this.nodeKey(node)).sort().join('|')).digest('hex');
    const key = `${nodeId ? 'node' : 'source'}:${nodeId || sourceId}:${reason}:${signature}`;
    let job;
    db.transaction(() => {
      job = this.createJob(nodeId ? 'check_node' : 'check_source', key, sourceId, nodeId || null, reason, nodes.length);
    });
    if (!job.existing) {
      for (const node of nodes) {
        const taskKey = this.nodeKey(node);
        let task = this.tasks.get(taskKey);
        const assigned = db.get(`SELECT 1 FROM user_subscription_sources us JOIN users u ON u.id = us.user_id
          WHERE us.source_id = ? AND us.is_active = 1 AND u.is_active = 1 LIMIT 1`, [node.source_id]);
        const priority = !node.last_checked_at || node.generation !== node.health_generation ? 0 : assigned ? 1 : 2;
        if (!task) {
          task = { key: taskKey, kind: 'check', sourceId: node.source_id, node, jobIds: new Set(), state: 'queued',
            queuedAt: now, priority, assigned: !!assigned, controller: new AbortController() };
          this.tasks.set(taskKey, task);
        }
        task.jobIds.add(job.id);
      }
    }
    this.pump();
    return this.job(job.id);
  }

  pump() {
    if (this.closed || this.storageError || this.pumping) return;
    this.pumping = true;
    try {
      const now = Date.now();
      const priority = task => {
        // Keep already usable assigned nodes fresh while a large initial import is still being checked.
        if (task.assigned && task.node?.status === 'healthy' && now - task.node.last_checked_at >= this.config.healthyTtlMs / 2) return -1;
        return Math.max(0, task.priority - Math.floor((now - task.queuedAt) / this.config.checkIntervalMs));
      };
      const candidates = [...this.tasks.values()].filter(task => task.state === 'queued')
        .sort((a, b) => priority(a) - priority(b) || (this.lastServed.get(a.sourceId) || 0) - (this.lastServed.get(b.sourceId) || 0) || a.queuedAt - b.queuedAt);
      if (!candidates.length) return;
      db.transaction(() => {
        for (const task of candidates) {
          const capacity = task.kind === 'check' ? this.config.concurrency : this.config.syncConcurrency;
          if (this.counts[task.kind] >= capacity || (task.kind === 'check' && this.checker.status?.available === false)) continue;
          if (task.kind === 'check') {
            const current = health.getNode(task.node.id);
            if (!current || this.nodeKey(current) !== task.key || !current.source_active || !current.is_present || !current.is_enabled) {
              this.complete(task, { status: 'cancelled', errorCode: 'superseded' });
              continue;
            }
            task.cycleId = crypto.randomUUID();
            health.markStarted(task.node, task.cycleId, now);
          }
          task.state = 'running';
          task.startedAt = now;
          this.lastServed.set(task.sourceId, ++this.sequence);
          this.counts[task.kind]++;
          for (const jobId of task.jobIds) db.run("UPDATE background_jobs SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", [now, jobId]);
          const promise = Promise.resolve().then(() => task.kind === 'check' ?
            this.checker.check(task.node, { signal: task.controller.signal }) :
            this.sync(task.sourceId, this.config, { signal: task.controller.signal }))
            .then(result => this.complete(task, result))
            .catch(error => {
              const safe = safeError(error, task.kind === 'sync' ? 'download_failed' : 'runner_error');
              this.complete(task, { status: ['superseded', 'cancelled'].includes(safe.code) ? 'cancelled' : 'runner_error', errorCode: safe.code, errorMessage: safe.message });
            })
            .finally(() => {
              this.running.delete(promise);
              this.counts[task.kind]--;
              this.pump();
            });
          this.running.add(promise);
        }
      });
    } catch (error) {
      this.storageError = 'Не удалось сохранить состояние фоновых задач.';
      for (const task of this.tasks.values()) task.controller.abort(new SubscriptionError('cancelled'));
    } finally {
      this.pumping = false;
    }
  }

  complete(task, result) {
    if (task.state === 'finishing') return;
    task.state = 'finishing';
    this.results.push({ task, result });
    if (this.results.length >= 10) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.results.length || this.storageError) return;
    const batch = this.results.splice(0);
    try {
      db.transaction(() => {
        for (const { task, result } of batch) {
          let applied = true;
          if (task.kind === 'check' && task.cycleId) applied = health.recordResult(task.node, task.cycleId, result, this.config, [...task.jobIds][0]);
          const failed = !applied || ['runner_error', 'cancelled'].includes(result.status);
          for (const jobId of task.jobIds) {
            db.run(`UPDATE background_jobs SET completed = completed + 1, failed = failed + ?, error = COALESCE(?, error), result_json = ? WHERE id = ?`,
              [failed ? 1 : 0, result.errorMessage || (!applied ? 'Настройки изменились. Результат не применён.' : null),
                JSON.stringify(task.kind === 'sync' && !failed ? result : { last_status: result.status || 'completed' }), jobId]);
            db.run(`UPDATE background_jobs SET state = CASE WHEN failed = total AND total > 0 THEN 'failed' ELSE 'completed' END,
              finished_at = ? WHERE id = ? AND completed >= total`, [Date.now(), jobId]);
          }
        }
      });
      for (const { task } of batch) this.tasks.delete(task.key);
      this.pump();
    } catch {
      this.results.unshift(...batch);
      this.storageError = 'Не удалось сохранить результаты. Проверьте свободное место и перезапустите сервис.';
      for (const task of this.tasks.values()) task.controller.abort(new SubscriptionError('cancelled'));
    }
  }

  invalidateSource(sourceId) {
    for (const task of this.tasks.values()) {
      if (task.sourceId !== sourceId) continue;
      task.controller.abort(new SubscriptionError('superseded'));
      if (task.state === 'queued') this.complete(task, { status: 'cancelled', errorCode: 'superseded', errorMessage: 'Настройки источника изменились.' });
    }
    this.flush();
  }

  async tick() {
    if (this.closed || this.storageError || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      if (this.checker.status?.available === false && now >= this.nextBinaryRetry) {
        this.nextBinaryRetry = now + 60000;
        try { await this.checker.verifyBinary(); } catch { /* Shown as a runner problem, not an offline pool. */ }
      }
      const active = db.all('SELECT id, next_sync_at FROM subscription_sources WHERE is_active = 1 ORDER BY next_sync_at, id');
      for (const source of active) {
        try {
          if (source.next_sync_at <= now) this.enqueueSync(source.id, 'scheduled');
          this.enqueueCheck({ sourceId: source.id, reason: 'scheduled', dueOnly: true });
        } catch (error) {
          if (error.code !== 'queue_full') throw error;
        }
      }
      if (now - this.lastPrune >= 3600000) {
        health.pruneHistory(this.config, now);
        this.lastPrune = now;
      }
      this.pump();
    } finally {
      this.ticking = false;
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    db.transaction(() => {
      db.run("UPDATE background_jobs SET state = 'interrupted', finished_at = ?, error = 'Прервано перезапуском сервиса.' WHERE state IN ('queued', 'running')", [Date.now()]);
      db.run("UPDATE subscription_sources SET sync_status = 'pending', next_sync_at = 0 WHERE sync_status = 'running'");
      db.run('UPDATE subscription_node_health SET pending_cycle_id = NULL');
      sources.reparseStoredNodes();
    });
    await this.checker.cleanup();
    try { await this.checker.verifyBinary(); } catch { this.nextBinaryRetry = Date.now() + 60000; }
    const tick = () => this.tick().catch(() => { this.storageError = 'Ошибка планировщика. Проверьте БД и перезапустите сервис.'; });
    this.interval = setInterval(tick, 5000);
    this.interval.unref();
    await tick();
  }

  metrics() {
    const queued = [...this.tasks.values()].filter(task => task.state === 'queued');
    return {
      queued: queued.length, running: { ...this.counts },
      oldest_wait_ms: queued.length ? Date.now() - Math.min(...queued.map(task => task.queuedAt)) : 0,
      runner: this.checker.status, storage_error: this.storageError
    };
  }

  async idle() {
    while (this.tasks.size && !this.storageError) {
      await Promise.all([...this.running]);
      this.flush();
      if (this.tasks.size) await delay(10);
    }
  }

  async stop() {
    this.closed = true;
    clearInterval(this.interval);
    for (const task of this.tasks.values()) {
      task.controller.abort(new SubscriptionError('cancelled'));
      if (task.state === 'queued') this.complete(task, { status: 'cancelled', errorCode: 'cancelled', errorMessage: 'Задача прервана завершением сервиса.' });
    }
    await this.checker.stop();
    await Promise.all([...this.running]);
    this.flush();
  }
}

module.exports = { ProbeScheduler };
