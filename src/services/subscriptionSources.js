const crypto = require('crypto');
const db = require('../db/database');
const { parseSubscription, parseSubscriptionNode } = require('../utils/subscriptionParser');
const { downloadSource, validateSourceUrl, maskSourceUrl } = require('../utils/safeHttp');
const { SubscriptionError, safeError } = require('../utils/subscriptionErrors');

function getSource(id) {
  return db.get('SELECT * FROM subscription_sources WHERE id = ?', [id]);
}

function publicSource(source) {
  const { url, headers_json, ...safe } = source;
  const headers = JSON.parse(headers_json || '{}');
  return { ...safe, masked_url: maskSourceUrl(url), has_authorization: !!headers.authorization,
    suspect: safe.sync_status === 'suspect', suspect_candidate: safe.candidate_json ? JSON.parse(safe.candidate_json) : null };
}

function validateSettings(input, existing, config) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 160) throw new SubscriptionError('validation', 'Название источника должно содержать от 1 до 160 символов.');
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : existing?.url;
  validateSourceUrl(url);
  const interval = Number(input.sync_interval_seconds ?? existing?.sync_interval_seconds ?? config.syncIntervalMs / 1000);
  if (!Number.isInteger(interval) || interval < 60 || interval > 604800) throw new SubscriptionError('validation', 'Интервал обновления: от 60 до 604800 секунд.');
  const headers = existing ? JSON.parse(existing.headers_json) : {};
  for (const [field, header, limit] of [['user_agent', 'user-agent', 256], ['authorization', 'authorization', 2048]]) {
    if (input[field] === undefined || (field === 'authorization' && input[field] === '')) continue;
    if (typeof input[field] !== 'string' || input[field].length > limit || /[\r\n\u0000]/.test(input[field])) throw new SubscriptionError('validation', 'Некорректный HTTP-заголовок источника.');
    if (input[field].trim()) headers[header] = input[field].trim();
    else delete headers[header];
  }
  if (input.clear_authorization === '1' || input.clear_authorization === true) delete headers.authorization;
  return { name, url, headers_json: JSON.stringify(headers), sync_interval_seconds: interval, is_active: 1 };
}

function createSource(input, config, now = Date.now()) {
  const source = { id: crypto.randomUUID(), ...validateSettings(input, null, config) };
  db.run(`INSERT INTO subscription_sources (id, name, url, headers_json, sync_interval_seconds, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [source.id, source.name, source.url, source.headers_json, source.sync_interval_seconds, source.is_active, now, now]);
  return getSource(source.id);
}

function updateSource(id, input, config, now = Date.now()) {
  const old = getSource(id);
  if (!old) throw new SubscriptionError('not_found', 'Источник не найден.', 404);
  const source = validateSettings(input, old, config);
  const oldHeaders = JSON.parse(old.headers_json || '{}');
  const newHeaders = JSON.parse(source.headers_json || '{}');
  const urlChanged = source.url !== old.url;
  const authorizationChanged = (oldHeaders.authorization || '') !== (newHeaders.authorization || '');
  const userAgentChanged = (oldHeaders['user-agent'] || '') !== (newHeaders['user-agent'] || '');
  const reset = urlChanged || authorizationChanged || userAgentChanged;
  db.transaction(() => {
    db.run(`UPDATE subscription_sources SET name = ?, url = ?, headers_json = ?, sync_interval_seconds = ?,
      is_active = ?, revision = revision + 1, updated_at = ?, next_sync_at = 0 WHERE id = ?`,
    [source.name, source.url, source.headers_json, source.sync_interval_seconds, source.is_active, now, id]);
    if (reset) {
      db.run(`UPDATE subscription_sources SET etag = NULL, last_modified = NULL, last_success_at = NULL,
        metadata_json = NULL, report_json = NULL, candidate_json = NULL, last_error = NULL, sync_status = 'pending', failure_count = 0 WHERE id = ?`, [id]);
      // URL and Authorization can select a different account/catalog: hide the
      // old representation immediately. User-Agent is treated identically to
      // avoid serving a catalog parsed under another representation.
      db.run('UPDATE subscription_nodes SET is_present = 0, removed_at = ?, generation = generation + 1 WHERE source_id = ?', [now, id]);
    }
  });
  return getSource(id);
}

function deleteSource(id) {
  db.run('DELETE FROM subscription_sources WHERE id = ?', [id]);
}

function setNodeEnabled(id, enabled) {
  const node = db.get('SELECT * FROM subscription_nodes WHERE id = ?', [id]);
  if (!node) throw new SubscriptionError('not_found', 'Узел не найден.', 404);
  if (node.is_enabled === Number(enabled)) return node;
  db.transaction(() => {
    db.run('UPDATE subscription_nodes SET is_enabled = ?, generation = generation + 1, next_check_at = 0 WHERE id = ?', [Number(enabled), id]);
    db.run("UPDATE subscription_node_health SET status = 'unknown', pending_cycle_id = NULL WHERE node_id = ?", [id]);
  });
  return db.get('SELECT * FROM subscription_nodes WHERE id = ?', [id]);
}

function sourceMetadata(headers) {
  const values = {};
  for (const part of String(headers['subscription-userinfo'] || '').split(';')) {
    const match = /^\s*(upload|download|total|expire)=(\d+)\s*$/.exec(part);
    if (match && Number.isSafeInteger(Number(match[2]))) values[match[1]] = Number(match[2]);
  }
  return Object.keys(values).length ? JSON.stringify(values) : null;
}

function reparseStoredNodes(sourceId = null) {
  const rows = db.all(`SELECT * FROM subscription_nodes${sourceId ? ' WHERE source_id = ?' : ''} ORDER BY first_seen_at, id`, sourceId ? [sourceId] : []);
  const groups = new Map();
  for (const old of rows) {
    const parsed = parseSubscriptionNode(old.raw_link);
    const key = `${old.source_id}:${parsed.fingerprint}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ old, parsed });
  }
  const updates = [];
  for (const members of groups.values()) {
    // Preserve an existing present ID where possible. Equivalent URI spellings can converge after normalization.
    members.sort((a, b) => b.old.is_present - a.old.is_present ||
      Number(b.old.fingerprint === b.parsed.fingerprint) - Number(a.old.fingerprint === a.parsed.fingerprint) ||
      a.old.first_seen_at - b.old.first_seen_at || a.old.id.localeCompare(b.old.id));
    const survivor = members[0].old;
    const display = [...members].sort((a, b) => b.old.is_present - a.old.is_present || b.old.last_seen_at - a.old.last_seen_at || a.old.id.localeCompare(b.old.id))[0];
    const parsed = display.parsed;
    const normalized = parsed.config ? JSON.stringify(parsed.config) : null;
    const sameConfig = members.length === 1 && survivor.fingerprint === parsed.fingerprint &&
      Boolean(survivor.normalized_config_json) === Boolean(normalized) &&
      survivor.capability_status === parsed.capability &&
      (survivor.parse_error || null) === (parsed.error || null);
    if (sameConfig) {
      if (survivor.raw_link !== display.old.raw_link || survivor.name !== parsed.name) {
        db.run('UPDATE subscription_nodes SET raw_link = ?, name = ?, last_seen_at = ? WHERE id = ?',
          [display.old.raw_link, parsed.name, Math.max(survivor.last_seen_at, display.old.last_seen_at), survivor.id]);
      }
      continue;
    }
    updates.push({ members, survivor, parsed, normalized, rawLink: display.old.raw_link });
  }
  if (!updates.length) return { updated: 0, merged: 0 };
  return db.transaction(() => {
    // Vacate old fingerprints first so unique(source_id, fingerprint) remains valid during regrouping.
    for (const update of updates) {
      for (const { old } of update.members) db.run('UPDATE subscription_nodes SET fingerprint = ? WHERE id = ?', [`reparse:${old.id}`, old.id]);
    }
    let merged = 0;
    for (const { members, survivor, parsed, normalized, rawLink } of updates) {
      for (const { old } of members) {
        if (old.id === survivor.id) continue;
        db.run('UPDATE subscription_node_checks SET node_id = ? WHERE node_id = ?', [survivor.id, old.id]);
        db.run('UPDATE background_jobs SET node_id = ? WHERE node_id = ?', [survivor.id, old.id]);
        db.run('DELETE FROM subscription_nodes WHERE id = ?', [old.id]);
        merged++;
      }
      const present = members.some(({ old }) => old.is_present) ? 1 : 0;
      // An explicitly excluded configuration must not silently become enabled when aliases merge.
      const enabled = members.every(({ old }) => old.is_enabled) ? 1 : 0;
      const generation = Math.max(...members.map(({ old }) => old.generation)) + 1;
      const firstSeen = Math.min(...members.map(({ old }) => old.first_seen_at));
      const lastSeen = Math.max(...members.map(({ old }) => old.last_seen_at));
      const removedAt = present ? null : Math.max(...members.map(({ old }) => old.removed_at || old.last_seen_at));
      db.run(`UPDATE subscription_nodes SET fingerprint = ?, raw_link = ?, normalized_config_json = ?, name = ?, protocol = ?, host = ?, port = ?,
        capability_status = ?, parse_error = ?, generation = ?, is_present = ?, is_enabled = ?, first_seen_at = ?, last_seen_at = ?, removed_at = ?, next_check_at = 0 WHERE id = ?`,
      [parsed.fingerprint, rawLink, normalized, parsed.name, parsed.protocol, parsed.host, parsed.port, parsed.capability, parsed.error,
        generation, present, enabled, firstSeen, lastSeen, removedAt, survivor.id]);
      db.run('DELETE FROM subscription_node_health WHERE node_id = ?', [survivor.id]);
      db.run('INSERT INTO subscription_node_health (node_id, config_fingerprint, generation, status) VALUES (?, ?, ?, ?)',
        [survivor.id, parsed.fingerprint, generation, parsed.capability === 'supported' ? 'unknown' : parsed.capability]);
    }
    return { updated: updates.length, merged };
  });
}

function applySnapshot(source, snapshot, headers = {}, now = Date.now()) {
  return db.transaction(() => {
    const current = getSource(source.id);
    if (!current || !current.is_active || current.revision !== source.revision) throw new SubscriptionError('superseded');
    reparseStoredNodes(source.id);
    const existing = new Map(db.all('SELECT * FROM subscription_nodes WHERE source_id = ?', [source.id]).map(node => [node.fingerprint, node]));
    // Enforce the cap on the union of retained and incoming fingerprints for
    // every snapshot type. Partial snapshots must not bypass it, and complete
    // snapshots must not temporarily stage more than SOURCE_MAX_NODES either.
    const present = new Set([...existing.values()].filter(node => node.is_present).map(node => node.fingerprint));
    for (const node of snapshot.nodes) present.add(node.fingerprint);
    if (present.size > (snapshot.maxNodes || 1000)) throw new SubscriptionError('too_many_nodes');
    const report = { ...snapshot.report, added: 0, existing: 0, removed: 0, complete: snapshot.complete,
      parseComplete: snapshot.parseComplete ?? snapshot.complete, acceptance: snapshot.acceptance || (snapshot.complete ? 'accepted' : 'partial') };
    const seen = new Set();
    for (const node of snapshot.nodes) {
      seen.add(node.fingerprint);
      const old = existing.get(node.fingerprint);
      const id = old?.id || crypto.randomUUID();
      const configJson = node.config ? JSON.stringify(node.config) : null;
      const sameConfig = old && old.fingerprint === node.fingerprint &&
        Boolean(old.normalized_config_json) === Boolean(configJson) &&
        old.capability_status === node.capability &&
        (old.parse_error || null) === (node.error || null);
      if (old && old.is_present && sameConfig) {
        report.existing++;
        db.run(`UPDATE subscription_nodes SET raw_link = ?, name = ?, last_seen_at = ?,
          removed_at = NULL WHERE id = ?`, [node.rawLink, node.name, now, id]);
        continue;
      }
      const generation = old ? old.generation + 1 : 1;
      if (old) {
        report.existing++;
        db.run(`UPDATE subscription_nodes SET raw_link = ?, normalized_config_json = ?, name = ?, capability_status = ?,
          parse_error = ?, last_seen_at = ?, removed_at = NULL, is_present = 1, generation = ?,
          next_check_at = 0 WHERE id = ?`,
        [node.rawLink, configJson, node.name, node.capability, node.error, now, generation, id]);
      } else {
        report.added++;
        db.run(`INSERT INTO subscription_nodes
          (id, source_id, fingerprint, raw_link, normalized_config_json, name, protocol, host, port, capability_status, parse_error, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, source.id, node.fingerprint, node.rawLink, configJson, node.name, node.protocol, node.host, node.port, node.capability, node.error, now, now]);
      }
      db.run(`INSERT INTO subscription_node_health (node_id, config_fingerprint, generation, status)
        VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET config_fingerprint = excluded.config_fingerprint,
        generation = excluded.generation, status = excluded.status, pending_cycle_id = NULL,
        last_checked_at = NULL, last_success_at = NULL, latency_ms = NULL,
        runner_error_code = NULL, runner_error_message = NULL`,
      [id, node.fingerprint, generation, node.capability === 'supported' ? 'unknown' : node.capability]);
    }
    if (snapshot.complete) {
      for (const old of existing.values()) {
        if (old.is_present && !seen.has(old.fingerprint)) {
          report.removed++;
          db.run('UPDATE subscription_nodes SET is_present = 0, removed_at = ? WHERE id = ?', [now, old.id]);
        }
      }
    }
    // Row history for absent nodes is kept (is_present = 0) and cleaned up by historyDays pruning.
    // Do not keep even old validators after a partial response: a subsequent 304 cannot certify that snapshot.
    db.run(`UPDATE subscription_sources SET sync_status = ?, last_success_at = ?, last_error = ?, failure_count = 0,
      next_sync_at = ?, etag = ?, last_modified = ?, metadata_json = ?, report_json = ? WHERE id = ?`,
    [snapshot.complete ? 'success' : 'partial', snapshot.complete ? now : current.last_success_at,
      snapshot.complete ? null : 'Часть записей не разобрана. Отсутствующие узлы сохранены.', now + current.sync_interval_seconds * 1000,
      snapshot.complete ? headers.etag || null : null, snapshot.complete ? headers['last-modified'] || null : null,
      sourceMetadata(headers), JSON.stringify(report), source.id]);
    return report;
  });
}

async function syncSource(id, config, { signal, download = downloadSource, now = Date.now } = {}) {
  const source = getSource(id);
  if (!source) throw new SubscriptionError('superseded');
  reparseStoredNodes(id);
  db.run("UPDATE subscription_sources SET last_attempt_at = ?, sync_status = 'running' WHERE id = ?", [now(), id]);
  try {
    const response = await download(source, config, { signal });
    const current = getSource(id);
    if (!current || !current.is_active || current.revision !== source.revision) throw new SubscriptionError('superseded');
    if (response.status === 304) {
      // A conditional response is valid only after an accepted representation.
      // Partial/invalid imports deliberately clear validators, so 304 cannot certify them.
      if (!source.etag && !source.last_modified) throw new SubscriptionError('unsupported_format');
      db.run(`UPDATE subscription_sources SET last_success_at = ?, sync_status = 'success', last_error = NULL,
        failure_count = 0, next_sync_at = ? WHERE id = ?`, [now(), now() + source.sync_interval_seconds * 1000, id]);
      return { unchanged: true };
    }
    const parsed = parseSubscription(response.body, config);
    if (!parsed.complete) {
      db.run('UPDATE subscription_sources SET etag = NULL, last_modified = NULL WHERE id = ?', [id]);
    }
    const observedAt = now();
    // Shrink protection is opt-in; never silently change acceptance policy.
    const ratio = config.sourceMinRetainRatio;
    const presentCount = db.get('SELECT count(*) AS n FROM subscription_nodes WHERE source_id = ? AND is_present = 1', [id]).n;
    const suspect = parsed.complete && Number.isFinite(ratio) && ratio > 0 && ratio < 1 &&
      presentCount >= (config.sourceMinRetainNodes || 20) && parsed.nodes.length < presentCount * ratio;
    if (suspect) {
      const hash = crypto.createHash('sha256').update(JSON.stringify(parsed.nodes.map(node => node.fingerprint).sort())).digest('hex');
      const previous = current.candidate_json ? JSON.parse(current.candidate_json) : null;
      const same = previous?.hash === hash && previous.revision === source.revision;
      const candidate = same ? { ...previous } : { hash, revision: source.revision, firstSeen: observedAt, lastSeen: observedAt, confirmations: 1 };
      if (same && observedAt - previous.lastSeen >= (config.sourceConfirmationIntervalMs || 60000)) {
        candidate.confirmations++;
        candidate.lastSeen = observedAt;
      }
      if (candidate.confirmations < (config.sourceConfirmations || 2)) {
        db.run(`UPDATE subscription_sources SET candidate_json = ?, etag = NULL, last_modified = NULL,
          sync_status = 'suspect', last_error = ?, next_sync_at = ? WHERE id = ?`,
        [JSON.stringify(candidate), 'Сокращение каталога ожидает подтверждения.', observedAt + (config.sourceConfirmationIntervalMs || 60000), id]);
        return { acceptance: 'suspect', parseComplete: true, candidate_count: parsed.nodes.length };
      }
    }
    return db.transaction(() => {
      const report = applySnapshot(source, parsed, response.headers, observedAt);
      db.run('UPDATE subscription_sources SET candidate_json = NULL WHERE id = ?', [id]);
      return report;
    });
  } catch (error) {
    const current = getSource(id);
    if (current && current.revision === source.revision && !['superseded', 'cancelled'].includes(error.code)) {
      const backoff = Math.min(21600000, source.sync_interval_seconds * 1000 * (2 ** Math.min(current.failure_count, 6)));
      db.run(`UPDATE subscription_sources SET sync_status = 'error', last_error = ?, failure_count = failure_count + 1,
        next_sync_at = ? WHERE id = ?`, [safeError(error, 'download_failed').message, now() + backoff + Math.floor(Math.random() * 10000), id]);
    }
    throw error;
  }
}

module.exports = { getSource, publicSource, createSource, updateSource, deleteSource, setNodeEnabled, applySnapshot, syncSource, reparseStoredNodes };
