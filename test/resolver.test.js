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
        latencyMs: index === 0 ? 300 : 100 + index * 100, httpStatus: 204, attempts: [] }, settings, null, now - 100);
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
