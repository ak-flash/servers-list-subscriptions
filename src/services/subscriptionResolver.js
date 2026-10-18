const db = require('../db/database');
const health = require('./subscriptionHealth');
const { effectiveLink } = require('../utils/linkBuilder');
const { effectiveFingerprint } = require('../utils/protocolParsers');
const { loadConfig } = require('../config/subscriptions');

function resolveUserSubscription(userId, now = Date.now(), config = loadConfig()) {
  const user = db.get('SELECT id, username, is_active FROM users WHERE id = ? AND is_active = 1', [userId]);
  if (!user) return { user: null, servers: [], sources: [], resolved_at: now };
  const servers = [];
  const seen = new Set();
  for (const manual of db.getUserServersWithUuid(userId).sort((a, b) => a.id.localeCompare(b.id))) {
    const server = { ...manual, credential_mode: 'user_override', origin: 'manual' };
    server.link = effectiveLink(server);
    const key = effectiveFingerprint(server.link);
    if (seen.has(key)) continue;
    seen.add(key);
    servers.push(server);
  }
  const bindings = db.all(`SELECT us.*, s.name, s.is_active AS source_active FROM user_subscription_sources us
    JOIN subscription_sources s ON s.id = us.source_id WHERE us.user_id = ? ORDER BY us.priority, us.source_id`, [userId]);
  const diagnostics = [];
  for (const binding of bindings) {
    const report = { source_id: binding.source_id, name: binding.name, requested: null, available: 0, selected: [], excluded: {} };
    const exclude = reason => { report.excluded[reason] = (report.excluded[reason] || 0) + 1; };
    if (!binding.is_active || !binding.source_active) {
      exclude('source_disabled');
      diagnostics.push(report);
      continue;
    }
    const candidates = health.getNodes(binding.source_id).filter(node => {
      const state = health.eligibility(node, config, now);
      if (state !== 'healthy') { exclude(state); return false; }
      if (binding.max_latency_ms && node.latency_ms > binding.max_latency_ms) { exclude('latency'); return false; }
      return true;
    }).sort((a, b) => a.latency_ms - b.latency_ms ||
      (b.successful_attempts / b.total_attempts) - (a.successful_attempts / a.total_attempts) ||
      a.target_priority - b.target_priority || a.fingerprint.localeCompare(b.fingerprint));
    for (const node of candidates) {
      const server = { id: node.id, name: `${binding.name} - ${node.name}`, remark: node.name, link: node.raw_link, credential_mode: 'original',
        origin: 'source', host: node.host, port: node.port, protocol: node.protocol,
        last_checked_at: node.last_checked_at, latency_ms: node.latency_ms, test_target_id: node.test_target_id };
      const key = effectiveFingerprint(server.link);
      if (seen.has(key)) { exclude('duplicate'); continue; }
      report.available++;
       seen.add(key);
      servers.push(server);
      report.selected.push({ id: node.id, name: node.name, host: node.host, port: node.port, latency_ms: node.latency_ms,
        test_target_id: node.test_target_id, last_checked_at: node.last_checked_at });
    }
    diagnostics.push(report);
  }
  servers.sort((a, b) => {
    const aLatency = Number.isFinite(a.latency_ms) ? a.latency_ms : Number.POSITIVE_INFINITY;
    const bLatency = Number.isFinite(b.latency_ms) ? b.latency_ms : Number.POSITIVE_INFINITY;
    return aLatency - bLatency || a.id.localeCompare(b.id);
  });
  return { user, servers, sources: diagnostics, resolved_at: now };
}

function subscriptionPreview(result) {
  return { user: result.user, sources: result.sources, resolved_at: result.resolved_at, servers: result.servers.map(server => ({
    id: server.id, name: server.name, origin: server.origin, host: server.host, port: server.port,
    latency_ms: server.latency_ms ?? null, last_checked_at: server.last_checked_at ?? null
  })) };
}

module.exports = { resolveUserSubscription, subscriptionPreview };
