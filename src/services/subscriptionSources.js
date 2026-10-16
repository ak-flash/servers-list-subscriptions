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
  return { ...safe, masked_url: maskSourceUrl(url), has_authorization: !!JSON.parse(headers_json).authorization };
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
  return { name, url, headers_json: JSON.stringify(headers), sync_interval_seconds: interval, is_active: ['1', 'on', 1, true].includes(input.is_active) ? 1 : 0 };
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
  const reset = source.url !== old.url || source.headers_json !== old.headers_json;
  db.transaction(() => {
    db.run(`UPDATE subscription_sources SET name = ?, url = ?, headers_json = ?, sync_interval_seconds = ?,
      is_active = ?, revision = revision + 1, updated_at = ?, next_sync_at = 0 WHERE id = ?`,
    [source.name, source.url, source.headers_json, source.sync_interval_seconds, source.is_active, now, id]);
    if (reset) {
      db.run(`UPDATE subscription_sources SET etag = NULL, last_modified = NULL, last_success_at = NULL,
        metadata_json = NULL, report_json = NULL, last_error = NULL, sync_status = 'pending', failure_count = 0 WHERE id = ?`, [id]);
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
    if (members.length === 1 && survivor.fingerprint === parsed.fingerprint && survivor.normalized_config_json === normalized &&
        survivor.capability_status === parsed.capability && survivor.parse_error === parsed.error) continue;
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
    if (!snapshot.complete) {
      const present = new Set([...existing.values()].filter(node => node.is_present).map(node => node.fingerprint));
      for (const node of snapshot.nodes) present.add(node.fingerprint);
      if (present.size > (snapshot.maxNodes || 1000)) throw new SubscriptionError('too_many_nodes');
    }
    const report = { ...snapshot.report, added: 0, existing: 0, removed: 0, complete: snapshot.complete };
    const seen = new Set();
    for (const node of snapshot.nodes) {
      seen.add(node.fingerprint);
      const old = existing.get(node.fingerprint);
      const id = old?.id || crypto.randomUUID();
      const generation = old ? old.generation + (old.is_present ? 0 : 1) : 1;
      if (old) {
        report.existing++;
        db.run(`UPDATE subscription_nodes SET raw_link = ?, normalized_config_json = ?, name = ?, capability_status = ?,
          parse_error = ?, last_seen_at = ?, removed_at = NULL, is_present = 1, generation = ?,
          next_check_at = CASE WHEN is_present = 0 THEN 0 ELSE next_check_at END WHERE id = ?`,
        [node.rawLink, node.config ? JSON.stringify(node.config) : null, node.name, node.capability, node.error, now, generation, id]);
      } else {
        report.added++;
        db.run(`INSERT INTO subscription_nodes
          (id, source_id, fingerprint, raw_link, normalized_config_json, name, protocol, host, port, capability_status, parse_error, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, source.id, node.fingerprint, node.rawLink, node.config ? JSON.stringify(node.config) : null, node.name, node.protocol, node.host, node.port, node.capability, node.error, now, now]);
      }
      if (!old || !old.is_present) {
        db.run(`INSERT INTO subscription_node_health (node_id, config_fingerprint, generation, status)
          VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET generation = excluded.generation,
          status = excluded.status, pending_cycle_id = NULL, last_checked_at = NULL, last_success_at = NULL,
          latency_ms = NULL, runner_error_code = NULL, runner_error_message = NULL`,
        [id, node.fingerprint, generation, node.capability === 'supported' ? 'unknown' : node.capability]);
      }
    }
    if (snapshot.complete) {
      for (const old of existing.values()) {
        if (old.is_present && !seen.has(old.fingerprint)) {
          report.removed++;
          db.run('UPDATE subscription_nodes SET is_present = 0, removed_at = ?, generation = generation + 1 WHERE id = ?', [now, old.id]);
        }
      }
    }
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
  if (!source || !source.is_active) throw new SubscriptionError('superseded');
  reparseStoredNodes(id);
  db.run("UPDATE subscription_sources SET last_attempt_at = ?, sync_status = 'running' WHERE id = ?", [now(), id]);
  try {
    const response = await download(source, config, { signal });
    const current = getSource(id);
    if (!current || !current.is_active || current.revision !== source.revision) throw new SubscriptionError('superseded');
    if (response.status === 304) {
      db.run(`UPDATE subscription_sources SET last_success_at = ?, sync_status = 'success', last_error = NULL,
        failure_count = 0, next_sync_at = ? WHERE id = ?`, [now(), now() + source.sync_interval_seconds * 1000, id]);
      return { unchanged: true };
    }
    return applySnapshot(source, parseSubscription(response.body, config), response.headers, now());
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
