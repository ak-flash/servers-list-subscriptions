const db = require('../db/database');
const health = require('./subscriptionHealth');
const { effectiveLink } = require('../utils/linkBuilder');
const { isSpecialNodeName } = require('../utils/specialNodes');
const { remainingTrafficLabel } = require('../utils/traffic');
const { loadConfig } = require('../config/subscriptions');

function resolveUserSubscription(userId, now = Date.now(), config = loadConfig()) {
  const user = db.get('SELECT id, username, is_active FROM users WHERE id = ? AND is_active = 1', [userId]);
  if (!user) return { user: null, servers: [], sources: [], resolved_at: now };
  const servers = [];
  const seenSubscriptionIps = new Set();
  for (const manual of db.getUserServersWithUuid(userId).sort((a, b) => a.id.localeCompare(b.id))) {
    const server = { ...manual, credential_mode: 'user_override', origin: 'manual' };
    server.link = effectiveLink(server);
    servers.push(server);
  }
  const bindings = db.all(`SELECT us.*, s.name, s.is_active AS source_active, s.metadata_json FROM user_subscription_sources us
    JOIN subscription_sources s ON s.id = us.source_id WHERE us.user_id = ? ORDER BY us.priority, us.source_id`, [userId]);
  const diagnostics = [];
  for (const binding of bindings) {
    // NULL keeps the legacy single-quota behavior. A number enables an
    // independent quota for LTE / base-station / white-list nodes.
    const separateSpecial = Number.isInteger(binding.special_node_limit) && binding.special_node_limit >= 0;
    const specialLimit = separateSpecial ? binding.special_node_limit : null;
    const report = { source_id: binding.source_id, name: binding.name, requested: binding.node_limit,
      requested_special: specialLimit, separate_special: separateSpecial, available: 0, available_special: 0,
      selected: [], selected_special: 0, excluded: {}, nodes: [], resolved_at: now };
    const exclude = reason => { report.excluded[reason] = (report.excluded[reason] || 0) + 1; };
    const noteNode = (node, reason, special = isSpecialNodeName(node.name)) => report.nodes.push({
      id: node.id, name: node.name, host: node.host, port: node.port, latency_ms: node.latency_ms ?? null,
      reason, special, selected: reason === 'selected'
    });
    if (!binding.is_active || !binding.source_active) {
      exclude('source_disabled');
      for (const node of health.getNodes(binding.source_id)) noteNode(node, 'source_disabled');
      diagnostics.push(report);
      continue;
    }
    const candidates = health.getNodes(binding.source_id).filter(node => {
      const state = health.deliveryState(node, config, now);
      if (state !== 'fresh') { exclude(state); noteNode(node, state); return false; }
      // The user limit applies to the stored main measurement: direct, or the proxy path in "only" mode.
      if (binding.max_latency_ms && node.latency_ms > binding.max_latency_ms) { exclude('latency'); noteNode(node, 'latency'); return false; }
      return true;
    });
    const pool = health.rankNodes(candidates, config, now);
    const sourceIps = new Set();
    const selectedCount = { ordinary: 0, special: 0 };
    const selectedServers = { ordinary: [], special: [] };
    const selectedInOrder = [];
    let sourceMetadata = {};
    try { sourceMetadata = JSON.parse(binding.metadata_json || '{}') || {}; } catch { /* Tolerate legacy malformed metadata. */ }
    const trafficLabel = remainingTrafficLabel(sourceMetadata);
    for (const node of pool) {
      const special = isSpecialNodeName(node.name);
      // The provider quota is most useful on the special LTE / base-station /
      // white-list nodes, so append it to their delivered names.
      const name = special && trafficLabel ? `${binding.name} - ${node.name} | Осталось трафика: ${trafficLabel}` : `${binding.name} - ${node.name}`;
      const server = { id: node.id, name, remark: node.name, link: node.raw_link, credential_mode: 'original',
        origin: 'source', special, host: node.host, port: node.port, protocol: node.protocol,
        last_checked_at: node.last_checked_at, checked_address: node.checked_address, latency_ms: node.latency_ms, test_target_id: node.test_target_id,
        probe_profile: node.probe_profile || 'full', score: node.score ?? null, throughput_bps: node.throughput_bps ?? null,
         fast_status: node.fast_status ?? null, fast_latency_ms: node.fast_latency_ms ?? null, fast_checked_at: node.fast_checked_at ?? null,
         service_gates: health.parseServiceGates(node.service_gates_json),
         stability: Number.isFinite(node.stability) ? node.stability : null,
         proxy_status: node.proxy_status, proxy_latency_ms: node.proxy_latency_ms, proxy_checked_at: node.proxy_checked_at };
      const key = health.checkedAddressKey(node);
      if (!key) { exclude('unknown_address'); noteNode(node, 'unknown_address', special); continue; }
      if (seenSubscriptionIps.has(key) || sourceIps.has(key)) { exclude('duplicate'); noteNode(node, 'duplicate', special); continue; }
      sourceIps.add(key);
      if (separateSpecial) {
        if (special) report.available_special++;
        else report.available++;
      } else {
        report.available++;
        if (special) report.available_special++;
      }
      const limit = special && separateSpecial ? specialLimit : binding.node_limit;
      const used = special && separateSpecial ? selectedCount.special : selectedCount.ordinary;
      const quotaReached = special && separateSpecial ? used >= limit : Number.isFinite(limit) && limit > 0 && used >= limit;
      if (quotaReached) {
        const reason = special && separateSpecial ? 'special_quota' : 'quota';
        exclude(reason);
        noteNode(node, reason, special);
        continue;
      }
      seenSubscriptionIps.add(key);
      if (special && separateSpecial) selectedCount.special++;
      else selectedCount.ordinary++;
      noteNode(node, 'selected', special);
      selectedServers[special ? 'special' : 'ordinary'].push(server);
      selectedInOrder.push(server);
      report.selected.push({ id: node.id, name: node.name, host: node.host, port: node.port, latency_ms: node.latency_ms,
        test_target_id: node.test_target_id, last_checked_at: node.last_checked_at, special });
    }
    // With a separate quota, ordinary and special nodes form separate blocks
    // in the delivered subscription. Otherwise keep the historical ranked
    // order across all nodes.
    servers.push(...(separateSpecial
      ? [...selectedServers.ordinary, ...selectedServers.special]
      : selectedInOrder));
    report.selected_special = selectedServers.special.length;
    diagnostics.push(report);
  }
  return { user, servers, sources: diagnostics, resolved_at: now };
}

function subscriptionPreview(result) {
  return { user: result.user, sources: result.sources, resolved_at: result.resolved_at, servers: result.servers.map(server => ({
    id: server.id, name: server.name, origin: server.origin, special: Boolean(server.special), host: server.host, port: server.port,
    latency_ms: server.latency_ms ?? null, last_checked_at: server.last_checked_at ?? null,
    proxy_status: server.proxy_status ?? null, proxy_latency_ms: server.proxy_latency_ms ?? null, proxy_checked_at: server.proxy_checked_at ?? null,
    probe_profile: server.probe_profile || 'full', score: server.score ?? null, throughput_bps: server.throughput_bps ?? null,
    fast_status: server.fast_status ?? null, fast_latency_ms: server.fast_latency_ms ?? null, fast_checked_at: server.fast_checked_at ?? null,
    service_gates: server.service_gates || [], stability: server.stability ?? null
  })) };
}

module.exports = { resolveUserSubscription, subscriptionPreview };
