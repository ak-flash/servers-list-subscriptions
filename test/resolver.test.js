const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const health = require('../src/services/subscriptionHealth');
const { saveAssignments } = require('../src/services/subscriptionAssignments');
const { resolveUserSubscription, subscriptionPreview } = require('../src/services/subscriptionResolver');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { buildFullSubscription, publicServer } = require('../src/utils/linkBuilder');
const { link, config, UUID } = require('./fixtures');

test('resolver: with an extra HTTP proxy, only fresh proxy-healthy nodes come first, direct-only nodes fill the rest', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config({ httpProxy: { protocol: 'http', address: '127.0.0.1', port: 3128, user: '', pass: '' }, httpProxyMode: 'extra' });
  const now = Date.now();
  db.run("INSERT INTO users (id, username) VALUES ('u', 'User')");
  const source = sources.createSource({ name: 'Proxied', url: 'https://proxy.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription([link('a.example.com'), link('b.example.com'), link('c.example.com'), link('d.example.com')].join('\n')));
  const proxy = {
    'a.example.com': { status: 'healthy', latencyMs: 250, httpStatus: 204, attempts: [] },
    'b.example.com': { status: 'healthy', latencyMs: 80, httpStatus: 204, attempts: [] },
    'c.example.com': { status: 'offline', errorCode: 'probe_timeout', errorMessage: 'timeout', attempts: [] },
    'd.example.com': { status: 'healthy', latencyMs: 120, httpStatus: 204, attempts: [] }
  };
  const directLatency = { 'a.example.com': 300, 'b.example.com': 50, 'c.example.com': 100, 'd.example.com': 200 };
  for (const node of health.getNodes(source.id)) {
    health.markStarted(node, node.id, now - 200);
    health.recordResult(node, node.id, { status: 'healthy', successCount: 3, attemptCount: 3, targetId: 'primary', targetPriority: 0,
      latencyMs: directLatency[node.host], checkedAddress: node.host, httpStatus: 204, attempts: [], proxy: { ...proxy[node.host], checkedAddress: node.host } }, settings, null, now - 100);
  }
  db.run("UPDATE subscription_node_health SET proxy_checked_at = ? WHERE node_id = (SELECT id FROM subscription_nodes WHERE host = 'd.example.com')", [now - settings.healthyTtlMs - 1]);
  saveAssignments('u', { sources: [source.id] });
  const result = resolveUserSubscription('u', now, settings);
  assert.deepEqual(result.servers.map(server => server.host), ['b.example.com', 'a.example.com', 'c.example.com', 'd.example.com']);
  assert.equal(result.sources[0].excluded.stale, undefined);
  assert.equal(result.sources[0].excluded.proxy_unavailable, undefined);
  assert.equal(result.sources[0].resolved_at, now);
});

test('resolver: deduplicates subscription nodes by checked IP, not hostname', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const now = Date.now();
  db.run("INSERT INTO users (id, username) VALUES ('u', 'User')");
  const source = sources.createSource({ name: 'IPs', url: 'https://ips.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription([link('one.example.com'), link('two.example.com'), link('three.example.com')].join('\n')));
  const latencies = { 'one.example.com': 50, 'two.example.com': 60, 'three.example.com': 70 };
  for (const node of health.getNodes(source.id)) {
    health.markStarted(node, node.id, now - 200);
    health.recordResult(node, node.id, { status: 'healthy', successCount: 3, attemptCount: 3, targetId: 'primary', targetPriority: 0,
      latencyMs: latencies[node.host], checkedAddress: node.host === 'three.example.com' ? '1.1.1.1' : '8.8.8.8', httpStatus: 204, attempts: [] }, settings, null, now - 100);
  }
  saveAssignments('u', { sources: [source.id], source_limits: { [source.id]: '3' } });
  const result = resolveUserSubscription('u', now, settings);
  assert.deepEqual(result.servers.map(server => server.host), ['one.example.com', 'three.example.com']);
  assert.equal(result.sources[0].excluded.duplicate, 1);
});

test('resolver reports per-node selection reasons without exposing credentials', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const now = Date.now();
  db.run("INSERT INTO users (id, username) VALUES ('u', 'User')");
  const source = sources.createSource({ name: 'Reasons', url: 'https://reasons.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription([link('fast.example.com'), link('slow.example.com'), link('dup-a.example.com'), link('dup-b.example.com')].join('\n')));
  const latency = { 'fast.example.com': 50, 'slow.example.com': 900, 'dup-a.example.com': 60, 'dup-b.example.com': 70 };
  for (const node of health.getNodes(source.id)) {
    health.markStarted(node, node.id, now - 200);
    health.recordResult(node, node.id, { status: 'healthy', successCount: 3, attemptCount: 3, targetId: 'primary', targetPriority: 0,
      latencyMs: latency[node.host], checkedAddress: node.host.endsWith('dup-a.example.com') || node.host.endsWith('dup-b.example.com') ? '203.0.113.9' : node.host,
      httpStatus: 204, attempts: [] }, settings, null, now - 100);
  }
  saveAssignments('u', { sources: [source.id], source_limits: { [source.id]: '1' }, max_latency: { [source.id]: '500' } });
  const result = resolveUserSubscription('u', now, settings);
  const report = result.sources[0];
  assert.deepEqual(result.servers.map(server => server.host), ['fast.example.com']);
  const reasons = Object.fromEntries(report.nodes.map(node => [node.host, node.reason]));
  assert.equal(reasons['fast.example.com'], 'selected');
  assert.equal(reasons['slow.example.com'], 'latency');
  assert.equal(reasons['dup-a.example.com'], 'quota');
  assert.equal(reasons['dup-b.example.com'], 'duplicate');
  assert.ok(report.nodes.every(node => !('raw_link' in node) && !('normalized_config_json' in node)));
  assert.ok(!JSON.stringify(subscriptionPreview(result)).includes(UUID));
});

test('resolver returns no source nodes after hard expiry while preserving diagnostics', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config({ healthyTtlMs: 1000, hardExpiryMs: 2000 });
  const now = 10000;
  db.run("INSERT INTO users (id, username) VALUES ('expired', 'Expired')");
  const source = sources.createSource({ name: 'Expired', url: 'https://expired.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link('expired.example.com')));
  const node = health.getNodes(source.id)[0];
  health.markStarted(node, node.id, now - 3000);
  health.recordResult(node, node.id, { status: 'healthy', successCount: 3, attemptCount: 3, targetId: 'primary', targetPriority: 0,
    latencyMs: 10, checkedAddress: '198.51.100.9', httpStatus: 204, attempts: [] }, settings, null, now - 2500);
  saveAssignments('expired', { sources: [source.id], source_limits: { [source.id]: '1' } });
  const result = resolveUserSubscription('expired', now, settings);
  assert.equal(result.servers.filter(server => server.origin === 'source').length, 0);
  assert.equal(result.sources[0].excluded.hard_expired, 1);
});

test('resolver fresh candidates from later source beat stale candidates from earlier source without reserving IP', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config({ healthyTtlMs: 1000 });
  const now = 10000;
  db.run("INSERT INTO users (id, username) VALUES ('slo', 'SLO')");
  const early = sources.createSource({ name: 'Early', url: 'https://early.example.com', is_active: true }, settings);
  const late = sources.createSource({ name: 'Late', url: 'https://late.example.com', is_active: true }, settings);
  sources.applySnapshot(early, parseSubscription(link('shared.example.com')));
  sources.applySnapshot(late, parseSubscription([link('shared.example.com'), link('fresh.example.com')].join('\\n')));
  for (const [source, checkedAt] of [[early, now - 2000], [late, now - 100]]) {
    for (const node of health.getNodes(source.id)) {
      health.markStarted(node, node.id, checkedAt - 1);
      health.recordResult(node, node.id, { ...successful, checkedAddress: node.host }, settings, null, checkedAt);
    }
  }
  saveAssignments('slo', { sources: [early.id, late.id], source_limits: { [early.id]: '1', [late.id]: '1' }, priorities: { [early.id]: '0', [late.id]: '1' } });
  const result = resolveUserSubscription('slo', now, settings);
  assert.deepEqual(result.servers.filter(server => server.origin === 'source').map(server => server.host), ['shared.example.com']);
  assert.equal(result.sources[0].excluded.stale, 1);
});

const successful = { status: 'healthy', successCount: 3, attemptCount: 3, targetId: 'primary', targetPriority: 0, latencyMs: 20, httpStatus: 204, attempts: [] };

test('resolver: original credentials, manual overrides, dedupe/refill, priority, freshness and user isolation', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const now = Date.now();
  db.run("INSERT INTO users (id, username) VALUES ('u', 'User'), ('other', 'Other')");
  const first = sources.createSource({ name: 'First', url: 'https://one.example.com', is_active: true }, settings);
  const second = sources.createSource({ name: 'Second', url: 'https://two.example.com', is_active: true }, settings);
  sources.applySnapshot(first, parseSubscription([link('a.example.com'), link('b.example.com'), link('c.example.com')].join('\n')));
  sources.applySnapshot(second, parseSubscription([link('a.example.com'), link('d.example.com'), link('e.example.com')].join('\n')));
  for (const source of [first, second]) {
    for (const [index, node] of health.getNodes(source.id).sort((a, b) => a.host.localeCompare(b.host)).entries()) {
      health.markStarted(node, node.id, now - 200);
      health.recordResult(node, node.id, { status: 'healthy', successCount: index === 0 ? 2 : 3, attemptCount: 3, targetId: 'primary', targetPriority: 0,
        latencyMs: index === 0 ? 300 : 100 + index * 100, checkedAddress: node.host, httpStatus: 204, attempts: [] }, settings, null, now - 100);
    }
  }
  const input = { sources: [first.id, second.id], source_limits: { [first.id]: '2', [second.id]: '2' }, priorities: { [first.id]: '0', [second.id]: '1' } };
  saveAssignments('u', input);
  saveAssignments('u', input);
  assert.equal(db.get('SELECT count(*) AS n FROM user_subscription_sources').n, 2);
  db.run("INSERT INTO servers (id, name, link) VALUES ('legacy-manual', 'Legacy', ?)", [link('legacy.example.com')]);
  db.run("INSERT INTO user_servers (user_id, server_id, uuid) VALUES ('u', 'legacy-manual', ?)", [UUID]);
  assert.doesNotThrow(() => saveAssignments('u', { servers: ['legacy-manual'], uuids: { 'legacy-manual': UUID }, sources: [first.id, second.id], source_limits: { [first.id]: '2', [second.id]: '2' }, priorities: { [first.id]: '0', [second.id]: '1' } }));
  const result = resolveUserSubscription('u', now, settings);
  assert.deepEqual(result.servers.filter(s => s.origin === 'source').map(s => s.host).sort(), ['b.example.com', 'c.example.com', 'd.example.com', 'e.example.com']);
  assert.deepEqual(resolveUserSubscription('u', now, settings), result);
  assert.equal(resolveUserSubscription('other', now, settings).servers.length, 0);
  const raw = Buffer.from(buildFullSubscription(result.servers, 'u'), 'base64').toString('utf8');
  assert.equal((raw.match(new RegExp(UUID, 'g')) || []).length, 5);
  assert.ok(result.servers.map(publicServer).every(server => server.uuid === UUID));
  assert.ok(!JSON.stringify(subscriptionPreview(result)).includes(UUID));
  assert.throws(() => saveAssignments('u', { ...input, source_limits: { [first.id]: '10001' } }));
  assert.equal(resolveUserSubscription('u', now, settings).servers.length, 5);
  assert.equal(resolveUserSubscription('u', now + settings.healthyTtlMs, settings).servers.length, 1);
  saveAssignments('u', { sources: [first.id], max_latency: { [first.id]: '150' } });
  assert.equal(resolveUserSubscription('u', now, settings).servers.length, 0);
  db.run("INSERT INTO servers (id, name, link) VALUES ('manual', 'Manual', ?)", [link('a.example.com')]);
  assert.doesNotThrow(() => saveAssignments('u', { servers: ['manual'], uuids: { manual: 'custom-credential' }, sources: [first.id], source_limits: { [first.id]: '2' } }));
  assert.ok(resolveUserSubscription('u', now, settings).servers[0].link.includes('custom-credential'));
  saveAssignments('u', { servers: ['manual'], uuids: { manual: UUID }, sources: [first.id], source_limits: { [first.id]: '2' } });
  const combined = resolveUserSubscription('u', now, settings);
  assert.equal(combined.servers.length, 3);
  assert.equal(combined.servers[0].origin, 'manual');
  const external = combined.servers.find(server => server.origin === 'source');
  const encoded = buildFullSubscription([{ ...external, user_server_uuid: 'must-not-replace' }], 'u');
  assert.ok(Buffer.from(encoded, 'base64').toString().includes(UUID));
  sources.setNodeEnabled(external.id, false);
  assert.ok(!resolveUserSubscription('u', now, settings).servers.some(server => server.id === external.id));
  db.run("UPDATE users SET is_active = 0 WHERE id = 'u'");
  assert.equal(resolveUserSubscription('u', now, settings).user, null);
});

test('resolver exposes service gates and persisted stability, and tolerates malformed gate JSON', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const now = Date.now();
  db.run("INSERT INTO users (id, username) VALUES ('gates', 'Gates')");
  const source = sources.createSource({ name: 'Gates', url: 'https://gates.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link('gates.example.com')));
  const node = health.getNodes(source.id)[0];
  const gates = [{ targetId: 'primary', passed: true, status: 204, errorCode: null }];
  health.markStarted(node, 'gates-cycle', now - 2);
  health.recordResult(node, 'gates-cycle', { ...successful, status: 'healthy', latencyMs: 15,
    checkedAddress: '198.51.100.7', throughputBps: 2 * 1024 * 1024, serviceGates: gates }, settings, null, now - 1);
  saveAssignments('gates', { sources: [source.id] });
  const resolved = resolveUserSubscription('gates', now, settings);
  assert.deepEqual(resolved.servers[0].service_gates, gates);
  assert.ok(resolved.servers[0].stability > 0 && resolved.servers[0].stability <= 1);
  assert.equal(resolved.servers[0].throughput_bps, 2 * 1024 * 1024);
  db.run('UPDATE subscription_node_health SET service_gates_json = ? WHERE node_id = ?', ['{broken', node.id]);
  assert.deepEqual(health.safeNode(health.getNode(node.id), settings, now).service_gates, []);
  assert.deepEqual(resolveUserSubscription('gates', now, settings).servers[0].service_gates, []);
  db.run('UPDATE subscription_node_health SET service_gates_json = ? WHERE node_id = ?', ['[null,{"passed":true}]', node.id]);
  assert.deepEqual(health.safeNode(health.getNode(node.id), settings, now).service_gates, [{ passed: true }]);
});

test('resolver applies a separate quota to LTE, base-station and white-list nodes', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const now = Date.now();
  db.run("INSERT INTO users (id, username) VALUES ('special', 'Special')");
  const source = sources.createSource({ name: 'Mixed', url: 'https://mixed.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription([
    link('o1.example.com', '', 'Обычный 1'), link('o2.example.com', '', 'Обычный 2'), link('o3.example.com', '', 'Обычный 3'),
    link('lte.example.com', '', 'LTE Москва'), link('bs.example.com', '', 'БС-777'), link('white.example.com', '', 'Белые списки')
  ].join('\n')));
  const latencies = { 'o1.example.com': 10, 'o2.example.com': 20, 'o3.example.com': 30,
    'lte.example.com': 40, 'bs.example.com': 50, 'white.example.com': 60 };
  for (const node of health.getNodes(source.id)) {
    health.markStarted(node, node.id, now - 200);
    health.recordResult(node, node.id, { ...successful, latencyMs: latencies[node.host], checkedAddress: node.host }, settings, null, now - 100);
  }

  // One ordinary node plus a separate quota of two special nodes.
  saveAssignments('special', { sources: [source.id], source_limits: { [source.id]: '1' }, special_node_limits: { [source.id]: '2' } });
  const result = resolveUserSubscription('special', now, settings);
  assert.deepEqual(result.servers.map(server => server.host), ['o1.example.com', 'lte.example.com', 'bs.example.com']);
  assert.deepEqual(result.servers.map(server => server.special), [false, true, true]);
  const report = result.sources[0];
  assert.equal(report.requested, 1);
  assert.equal(report.requested_special, 2);
  assert.equal(report.separate_special, true);
  assert.equal(report.available, 3);
  assert.equal(report.available_special, 3);
  assert.equal(report.selected_special, 2);
  assert.equal(report.excluded.quota, 2);
  assert.equal(report.excluded.special_quota, 1);

  // Zero disables the separate block without touching the ordinary quota.
  saveAssignments('special', { sources: [source.id], source_limits: { [source.id]: '1' }, special_node_limits: { [source.id]: '0' } });
  const disabled = resolveUserSubscription('special', now, settings);
  assert.deepEqual(disabled.servers.map(server => server.host), ['o1.example.com']);
  assert.equal(disabled.sources[0].excluded.special_quota, 3);

  // An empty field keeps the historical shared quota and rank order.
  saveAssignments('special', { sources: [source.id], source_limits: { [source.id]: '2' } });
  const legacy = resolveUserSubscription('special', now, settings);
  assert.deepEqual(legacy.servers.map(server => server.host), ['o1.example.com', 'o2.example.com']);
  assert.equal(legacy.sources[0].requested_special, null);
  assert.equal(legacy.sources[0].separate_special, false);
  assert.equal(legacy.sources[0].excluded.quota, 4);
  assert.equal(legacy.sources[0].excluded.special_quota, undefined);
  assert.throws(() => saveAssignments('special', { sources: [source.id], special_node_limits: { [source.id]: '-1' } }));
  assert.throws(() => saveAssignments('special', { sources: [source.id], special_node_limits: { [source.id]: '10001' } }));
});
