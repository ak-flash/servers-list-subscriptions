const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const health = require('../src/services/subscriptionHealth');
const { saveAssignments } = require('../src/services/subscriptionAssignments');
const { resolveUserSubscription } = require('../src/services/subscriptionResolver');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { hashPassword } = require('../src/utils/passwords');
const { app, subscriptionConfig } = require('../src/index');
const { link } = require('./fixtures');

test('source catalog lists eligible nodes in subscription order before unavailable nodes, then paginates', async t => {
  await db.initDb({ filePath: ':memory:' });
  db.run("INSERT INTO users (id, username, password, must_change_password) VALUES ('catalog-admin', 'catalog-admin', ?, 0), ('catalog-user', 'catalog-user', NULL, 0)", [hashPassword('test-password')]);
  const source = sources.createSource({ name: 'Catalog order', url: 'https://source.example.com', is_active: true }, subscriptionConfig);
  const hosts = ['slow-reliable.example.com', 'fast-unreliable.example.com', 'fallback.example.com',
    'offline.example.com', 'stale.example.com', 'disabled.example.com', 'unknown.example.com', 'removed.example.com'];
  const extraHosts = Array.from({ length: 50 }, (_, index) => `unavailable-${index}.example.com`);
  const now = Date.now();
  sources.applySnapshot(source, parseSubscription([...hosts, ...extraHosts].map(host => link(host, '', host)).join('\n')), {}, now);
  saveAssignments('catalog-user', { sources: [source.id], source_limits: { [source.id]: '20' } });
  const nodes = health.getNodes(source.id);
  const nodeId = host => nodes.find(node => node.host === host).id;
  for (const node of nodes) {
    health.markStarted(node, node.id, now - 200);
    health.recordResult(node, node.id, { status: 'healthy', successCount: subscriptionConfig.attempts, attemptCount: subscriptionConfig.attempts, latencyMs: 500,
      targetPriority: 0, targetId: 'primary', httpStatus: 204, attempts: [] }, subscriptionConfig, null, now - 100);
  }
  db.run('UPDATE subscription_node_health SET successful_attempts = ?, latency_ms = 5 WHERE node_id = ?', [subscriptionConfig.minSuccess, nodeId(hosts[1])]);
  db.run("UPDATE subscription_node_health SET target_priority = 1, test_target_id = 'fallback', latency_ms = 2 WHERE node_id = ?", [nodeId(hosts[2])]);
  for (const host of [hosts[3], ...extraHosts]) {
    db.run("UPDATE subscription_node_health SET status = 'offline', latency_ms = 1 WHERE node_id = ?", [nodeId(host)]);
  }
  db.run('UPDATE subscription_node_health SET last_checked_at = 1, latency_ms = 1 WHERE node_id = ?', [nodeId(hosts[4])]);
  db.run('UPDATE subscription_nodes SET is_enabled = 0 WHERE id = ?', [nodeId(hosts[5])]);
  db.run("UPDATE subscription_node_health SET status = 'unknown', last_checked_at = NULL, latency_ms = NULL WHERE node_id = ?", [nodeId(hosts[6])]);
  db.run('UPDATE subscription_nodes SET is_present = 0 WHERE id = ?', [nodeId(hosts[7])]);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.closeDb(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const render = t.mock.method(app, 'render');
  const login = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'catalog-admin', password: 'test-password' }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const catalog = async (query = '') => {
    const response = await fetch(`${base}/admin/subscription-sources/${source.id}/nodes${query}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    const call = render.mock.calls.at(-1);
    assert.equal(call.arguments[0], 'subscription-source-nodes');
    return { ...call.arguments[1], html };
  };

  const resolved = resolveUserSubscription('catalog-user', now, subscriptionConfig);
  const expected = resolved.servers.filter(server => server.origin === 'source').map(server => server.id);
  assert.equal(expected.length, 3, JSON.stringify(resolved.sources));
  const first = await catalog();
  assert.deepEqual(first.nodes.slice(0, expected.length).map(node => node.id), expected);
  assert.ok(first.nodes.slice(0, 3).every(node => node.effective_status === 'healthy'));
  assert.ok(first.nodes.slice(3).every(node => node.effective_status !== 'healthy'));
  assert.ok(first.nodes.slice(0, expected.length).every(node => node.delivery_candidate));
  assert.ok(first.nodes.slice(expected.length).every(node => !node.delivery_candidate));
  assert.equal(first.total, 57);
  assert.equal(first.pages, 2);
  assert.equal(first.nodes.length, 50);
  assert.ok(first.html.includes('Сначала показаны узлы, подходящие для выдачи, в порядке отбора.'));
  assert.ok(first.html.includes('Будет выдан'));
  assert.ok(first.html.includes('data-node-delivery'));

  const second = await catalog('?page=2');
  assert.equal(second.nodes.length, 7);
  assert.ok(second.nodes.every(node => node.effective_status !== 'healthy'));
  assert.equal(new Set([...first.nodes, ...second.nodes].map(node => node.id)).size, 57);
  const healthy = await catalog('?status=healthy');
  assert.deepEqual(healthy.nodes.map(node => node.id), expected);
  const offline = await catalog('?status=offline');
  assert.ok(offline.nodes.every(node => node.effective_status === 'offline'));
  const removed = await catalog('?status=removed&removed=1');
  assert.deepEqual(removed.nodes.map(node => node.id), [nodeId(hosts[7])]);
  const english = await catalog('?lang=en');
  assert.ok(english.html.includes('Eligible nodes are shown first, in selection order.'));
  assert.ok(english.html.includes('Will be delivered'));

  // A second URI on the same checked IP must not displace the next unique candidate.
  db.run('UPDATE subscription_node_health SET checked_address = ?, latency_ms = 1 WHERE node_id IN (?, ?)',
    ['198.51.100.1', nodeId(hosts[0]), nodeId(hosts[2])]);
  const uniqueExpected = resolveUserSubscription('catalog-user', now, subscriptionConfig).servers.map(server => server.id);
  assert.deepEqual(uniqueExpected, [nodeId(hosts[0]), nodeId(hosts[1])]);
  const deduplicated = await catalog();
  assert.deepEqual(deduplicated.nodes.slice(0, 2).map(node => node.id), uniqueExpected);
  assert.ok(deduplicated.nodes.findIndex(node => node.id === nodeId(hosts[2])) >= uniqueExpected.length);
  assert.equal(deduplicated.nodes.find(node => node.id === nodeId(hosts[0])).delivery_candidate, true);
  assert.equal(deduplicated.nodes.find(node => node.id === nodeId(hosts[2])).delivery_candidate, false);
  saveAssignments('catalog-user', { sources: [source.id], source_limits: { [source.id]: '1' } });
  const limited = resolveUserSubscription('catalog-user', now, subscriptionConfig);
  assert.deepEqual(limited.servers.map(server => server.id), [deduplicated.nodes[0].id]);
  assert.equal(limited.sources[0].requested, 1);
  assert.equal(limited.sources[0].available, 2);
  assert.equal(limited.sources[0].excluded.duplicate, 1);
  assert.equal(limited.sources[0].excluded.quota, 1);
});
