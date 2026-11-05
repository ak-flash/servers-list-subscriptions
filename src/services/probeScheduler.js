const crypto = require('crypto');
const { setTimeout: delay } = require('timers/promises');
const db = require('../db/database');
const sources = require('./subscriptionSources');
const health = require('./subscriptionHealth');
const { VpnChecker } = require('./vpnChecker');
const { SubscriptionError, safeError } = require('../utils/subscriptionErrors');
const { snapshotProbeConfig } = require('../config/subscriptions');

class ProbeScheduler {
  constructor(config, { checker = new VpnChecker(config), sync = sources.syncSource } = {}) {
    this.config = config;
    this.checker = checker;
    this.sync = sync;
    this.tasks = new Map();
    this.queueProgress = { total: 0, completed: 0 };
    this.running = new Set();
    this.results = [];
    this.counts = { sync: 0, check: 0 };
    this.lastServed = new Map();
    this.admissionCursor = new Map();
    this.sequence = 0;
    this.closed = false;
    this.started = false;
    this.storageError = null;
    this.nextBinaryRetry = 0;
    this.lastPrune = 0;
    this.checkDurations = [];
    this.completionTimes = [];
    this.completionIntervals = [];
    this.lastCompletionAt = null;
  }

  job(id) {
    const row = db.get('SELECT * FROM background_jobs WHERE id = ?', [id]);
    if (!row) return null;
    const { dedupe_key, ...safe } = row;
    return safe;
  }

  createJob(type, key, sourceId, nodeId, reason, total, deferred = 0) {
    const existing = db.get("SELECT id FROM background_jobs WHERE dedupe_key = ? AND state IN ('queued', 'running')", [key]);
    if (existing) return { id: existing.id, existing: true };
    const id = crypto.randomUUID();
    const now = Date.now();
    db.run(`INSERT INTO background_jobs (id, type, dedupe_key, source_id, node_id, reason, total, deferred, created_at, state, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, type, key, sourceId, nodeId, reason, total, deferred, now, total ? 'queued' : 'completed', total ? null : now]);
    return { id, existing: false };
  }

  ensureCapacity(additional) {
    if (this.closed) throw new SubscriptionError('cancelled', undefined, 503);
    if (this.storageError) throw new SubscriptionError('storage_error', 'Не удалось сохранить БД. Проверьте свободное место и перезапустите сервис.', 503);
    if (this.tasks.size + additional > this.config.maxQueued) throw new SubscriptionError('queue_full', undefined, 429);
  }

  addTask(task) {
    // Track unique tasks until the queue drains, not overlapping background jobs.
    if (!this.tasks.size) this.queueProgress = { total: 0, completed: 0 };
    this.tasks.set(task.key, task);
    this.queueProgress.total++;
  }

  enqueueSync(sourceId, reason = 'manual') {
    const source = sources.getSource(sourceId);
    if (!source || !source.is_active) throw new SubscriptionError('validation', 'Источник не найден или отключён.', 409);
    const key = `sync:${sourceId}:${source.revision}`;
    this.ensureCapacity(this.tasks.has(key) ? 0 : 1);
    const job = this.createJob('sync', key, sourceId, null, reason, 1);
    if (!job.existing) this.addTask({
      key, kind: 'sync', sourceId, revision: source.revision, jobIds: new Set([job.id]),
      state: 'queued', queuedAt: Date.now(), priority: 0, controller: new AbortController()
    });
    this.pump();
    return this.job(job.id);
  }

  nodeKey(node, config = this.config) {
    return `check:${node.id}:${node.generation}:${node.source_revision}:${config.profileVersion}`;
  }

  recordCheckResult(node, cycleId, result, config, jobId = null) {
    return db.transaction(() => {
      const applied = health.recordResult(node, cycleId, result, config, jobId);
      if (applied && config.profileVersion !== this.config.profileVersion) {
        // Retain the actual profile on late results and promptly retry under the new one.
        db.run('UPDATE subscription_nodes SET next_check_at = 0 WHERE id = ?', [node.id]);
      }
      return applied;
    });
  }

  async checkNodeNow(nodeId, { signal } = {}) {
    if (this.closed) throw new SubscriptionError('cancelled', undefined, 503);
    if (this.storageError) throw new SubscriptionError('storage_error', 'Не удалось сохранить БД. Проверьте свободное место и перезапустите сервис.', 503);
    signal?.throwIfAborted();
    const node = health.getNode(nodeId);
    if (!node || !node.source_active || !node.is_enabled || !node.is_present || node.capability_status !== 'supported') {
      throw new SubscriptionError('validation', 'Узел недоступен для проверки: он отключён, удалён или не поддерживается.', 409);
    }
    const config = snapshotProbeConfig(this.config);
    const key = this.nodeKey(node, config);
    let task = this.tasks.get(key);
    if (!task) {
      // Only one compatible cycle may own the node's pending check. An
      // incompatible profile/generation must not run alongside it.
      for (const other of this.tasks.values()) {
        if (other.kind !== 'check' || other.node.id !== node.id) continue;
        other.controller.abort(new SubscriptionError('superseded'));
        if (other.state === 'queued') this.complete(other, {
          status: 'cancelled', errorCode: 'superseded', errorMessage: 'Проверка заменена несовместимым запросом.'
        });
      }
      this.ensureCapacity(1);
      const job = this.createJob('check_node', `manual:${key}`, node.source_id, node.id, 'manual', 1);
      if (job.existing) task = this.tasks.get(key);
      if (!task) {
        task = { key, kind: 'check', sourceId: node.source_id, node, config, jobIds: new Set(), state: 'queued',
          queuedAt: Date.now(), priority: 0, assigned: true, waiters: [], controller: new AbortController() };
        this.addTask(task);
      }
      task.jobIds.add(job.id);
    } else {
      const job = this.createJob('check_node', `manual:${key}`, node.source_id, node.id, 'manual', 1);
      task.jobIds.add(job.id);
    }
    const outcome = new Promise((resolve, reject) => {
      task.waiters = task.waiters || [];
      task.waiters.push({ resolve, reject, signal });
      if (signal) {
        const abort = () => {
            task.waiters = task.waiters.filter(waiter => waiter.resolve !== resolve);
          reject(new SubscriptionError('cancelled', undefined, 499));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
    });
    this.pump();
    return outcome;
  }

  settleWaiters(task, result, applied, error = null) {
    const waiters = task.waiters || [];
    task.waiters = [];
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else if (!applied) waiter.reject(new SubscriptionError('superseded', 'Настройки узла изменились. Повторите проверку.', 409));
      else waiter.resolve(result);
    }
  }

  enqueueAllChecks({ reason = 'manual' } = {}) {
    // A full recheck marks every eligible node due so the work survives a
    // restart even when only a portion fits into the current queue.
    db.run(`UPDATE subscription_nodes SET next_check_at = 0
      WHERE is_present = 1 AND is_enabled = 1 AND capability_status = 'supported'
        AND source_id IN (SELECT id FROM subscription_sources WHERE is_active = 1)`);
    const sources = db.all('SELECT id FROM subscription_sources WHERE is_active = 1');
    const jobs = [];
    for (const source of sources) {
      try { jobs.push(this.enqueueCheck({ sourceId: source.id, reason, dueOnly: false })); } catch { jobs.push(null); }
    }
    return jobs.filter(Boolean);
  }

  enqueueCheck({ sourceId, nodeId, reason = 'manual', dueOnly = false } = {}) {
    const config = snapshotProbeConfig(this.config);
    let nodes = nodeId ? [health.getNode(nodeId)].filter(Boolean) : health.getNodes(sourceId);
    nodes = nodes.filter(node => node.source_active && node.is_enabled && node.is_present && node.capability_status === 'supported');
    if (nodeId && !nodes.length) throw new SubscriptionError('validation', 'Узел недоступен для проверки: он отключён, удалён или не поддерживается.', 409);
    if (!nodeId && !sources.getSource(sourceId)?.is_active) throw new SubscriptionError('validation', 'Источник не найден или отключён.', 409);
    const now = Date.now();
    if (dueOnly) {
      nodes = nodes.filter(node => !this.tasks.has(this.nodeKey(node, config)) &&
        (node.next_check_at <= now || (node.last_checked_at && node.last_attempt_at <= node.last_checked_at && node.probe_profile_version !== config.profileVersion)));
       if (!nodes.length) return null;
    }
    const newNodes = nodes.filter(node => !this.tasks.has(this.nodeKey(node, config)));
    const available = Math.max(0, this.config.maxQueued - this.tasks.size);
    let deferred = 0;
    if (newNodes.length > available) {
      // Admit a bounded, rotating batch instead of repeatedly taking the
      // first rows and starving the tail of a large source.
      const offset = this.admissionCursor.get(sourceId) || 0;
      const rotated = newNodes.slice(offset).concat(newNodes.slice(0, offset));
      const admitted = new Set(rotated.slice(0, available).map(node => node.id));
      this.admissionCursor.set(sourceId, (offset + Math.max(1, admitted.size)) % newNodes.length);
      nodes = nodes.filter(node => this.tasks.has(this.nodeKey(node, config)) || admitted.has(node.id));
      deferred = newNodes.length - admitted.size;
    }
    if (!nodes.length) return null;
    sourceId = sourceId || nodes[0]?.source_id;
    const signature = crypto.createHash('sha256').update(nodes.map(node => this.nodeKey(node, config)).sort().join('|')).digest('hex');
    const key = `${nodeId ? 'node' : 'source'}:${nodeId || sourceId}:${reason}:${signature}`;
    let job;
    db.transaction(() => {
      job = this.createJob(nodeId ? 'check_node' : 'check_source', key, sourceId, nodeId || null, reason, nodes.length, deferred);
    });
    if (!job.existing) {
      for (const node of nodes) {
        const taskKey = this.nodeKey(node, config);
        let task = this.tasks.get(taskKey);
        const assigned = db.get(`SELECT 1 FROM user_subscription_sources us JOIN users u ON u.id = us.user_id
          WHERE us.source_id = ? AND us.is_active = 1 AND u.is_active = 1 LIMIT 1`, [node.source_id]);
        const priority = !node.last_checked_at || node.generation !== node.health_generation ? 0 : assigned ? 1 : 2;
        if (!task) {
          task = { key: taskKey, kind: 'check', sourceId: node.source_id, node, config, jobIds: new Set(), state: 'queued',
            queuedAt: now, priority, assigned: !!assigned, controller: new AbortController() };
          this.addTask(task);
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
              if (current && this.nodeKey(current, task.config) === task.key && task.config.profileVersion !== this.config.profileVersion) {
                db.run('UPDATE subscription_nodes SET next_check_at = 0 WHERE id = ?', [current.id]);
              }
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
            this.checker.check(task.node, { signal: task.controller.signal, config: task.config }) :
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
    if (this.results.length >= 1000) this.results.shift();
    this.results.push({ task, result });
    if (this.results.length >= 10) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.results.length || this.storageError) return;
    const batch = this.results.splice(0);
    const appliedByTask = new Map();
    try {
      db.transaction(() => {
        for (const { task, result } of batch) {
          let applied = true;
          if (task.kind === 'check' && task.cycleId) applied = this.recordCheckResult(task.node, task.cycleId, result, task.config, [...task.jobIds][0]);
          appliedByTask.set(task, applied);
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
      const finishedAt = Date.now();
      for (const { task, result } of batch) {
        if (this.tasks.delete(task.key)) this.queueProgress.completed++;
        if (task.kind === 'check' && task.startedAt) {
          this.checkDurations.push(Math.max(0, finishedAt - task.startedAt));
          if (this.checkDurations.length > 200) this.checkDurations.shift();
        }
        if (task.kind === 'check') {
          this.completionTimes.push(finishedAt);
          if (this.lastCompletionAt !== null) {
            this.completionIntervals.push(Math.max(0, finishedAt - this.lastCompletionAt));
            if (this.completionIntervals.length > 600) this.completionIntervals.shift();
          }
          this.lastCompletionAt = finishedAt;
          if (this.completionTimes.length > 600) this.completionTimes.shift();
        }
        this.settleWaiters(task, result, appliedByTask.get(task) !== false);
      }
      this.pump();
    } catch (error) {
      const storageFailure = new SubscriptionError('storage_error', 'Не удалось сохранить результаты проверки. Повторите попытку.', 503);
      for (const { task } of batch) this.settleWaiters(task, null, false, storageFailure);
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
        health.pruneHistory(now, this.config);
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
    const now = Date.now();
    const queued = [...this.tasks.values()].filter(task => task.state === 'queued');
    const dueRows = db.all(`SELECT n.id, n.generation, n.next_check_at, s.revision AS source_revision
      FROM subscription_nodes n JOIN subscription_sources s ON s.id = n.source_id
      WHERE s.is_active = 1 AND n.is_present = 1 AND n.is_enabled = 1
        AND n.capability_status = 'supported' AND n.next_check_at <= ?`, [now]);
    const due = { n: dueRows.length, oldest: dueRows.length ? Math.min(...dueRows.map(row => row.next_check_at)) : now };
    const dueOutside = dueRows.filter(row =>
      !this.tasks.has(`check:${row.id}:${row.generation}:${row.source_revision}:${this.config.profileVersion}`)).length;
    const durations = [...this.checkDurations].sort((a, b) => a - b);
    const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : null;
    const intervals = [...this.completionIntervals].sort((a, b) => a - b);
    const intervalP95 = intervals.length ? intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * 0.95))] : null;
    const refresh = db.get(`SELECT SUM(CASE WHEN h.status = 'healthy' AND h.last_checked_at > ? THEN 1 ELSE 0 END) AS fresh,
      SUM(CASE WHEN h.status = 'healthy' AND h.last_checked_at <= ? THEN 1 ELSE 0 END) AS stale
      FROM subscription_node_health h JOIN subscription_nodes n ON n.id = h.node_id
      JOIN subscription_sources s ON s.id = n.source_id
      WHERE s.is_active = 1 AND n.is_present = 1 AND n.is_enabled = 1`, [now - this.config.healthyTtlMs, now - this.config.healthyTtlMs]);
    return {
      queued: queued.length, running: { ...this.counts },
      progress: { ...this.queueProgress },
      oldest_wait_ms: queued.length ? now - Math.min(...queued.map(task => task.queuedAt)) : 0,
      due: due.n, due_outside_queue: dueOutside, deferred: dueOutside,
      overdue_age_ms: due.n ? Math.max(0, now - due.oldest) : 0,
      fresh: refresh.fresh || 0, stale: refresh.stale || 0,
      hard_expired: Math.max(0, dueRows.length - (refresh.fresh || 0) - (refresh.stale || 0)),
      p95_check_ms: p95, expected_sweep_ms: due.n && p95 ? Math.ceil(due.n * p95 / Math.max(1, this.config.concurrency)) : null,
      completed_last_minute: this.completionTimes.filter(at => now - at < 60000).length,
      completion_interval_p95_ms: intervalP95,
      slo: {
        runner_available: this.checker.status?.available !== false,
        overdue: due.n > 0 && due.oldest < now,
        hard_cap_ms: 180000,
        expected_sweep_exceeds_hard_cap: Boolean(due.n && p95 && Math.ceil(due.n * p95 / Math.max(1, this.config.concurrency)) > 180000)
      },
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
