const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const health = require('../src/services/subscriptionHealth');
const { fingerprint } = require('../src/utils/protocolParsers');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { ProbeScheduler } = require('../src/services/probeScheduler');
const { saveAssignments } = require('../src/services/subscriptionAssignments');
const { resolveUserSubscription } = require('../src/services/subscriptionResolver');
const { config, UUID } = require('./fixtures');

const LEGACY_ERROR = 'В первой версии поддерживается security=tls. Reality и соединения без TLS пока не проверяются.';
const PUBLIC_KEY = Buffer.alloc(32, 4).toString('base64url');

// Frozen shape from the TLS-only parser, before Reality fields became first-class connection settings.
function seedLegacy(sourceId, id, { security = 'reality', host = `${id}.example.com`, fp = '', sid = 'ABCD', enabled = 1, present = 1, seen = Date.now() - 1000 } = {}) {
  const extra = security === 'reality' ? { pbk: PUBLIC_KEY, sid } : {};
  const previous = {
    schema_version: 1, protocol: 'vless', host, port: 443, uuid: UUID, encryption: 'none', network: 'tcp', security,
    sni: 'cover.example.com', alpn: [], fingerprint: fp, flow: '', allowInsecure: false, headerType: 'none', ws: null, extra
  };
  const params = new URLSearchParams({ type: 'tcp', security, sni: previous.sni, ...extra });
  if (fp) params.set('fp', fp);
  const raw = `vless://${UUID}@${host}:443?${params}#${id}`;
  const oldFingerprint = fingerprint(previous);
  db.transaction(() => {
    db.run(`INSERT INTO subscription_nodes (id, source_id, fingerprint, raw_link, normalized_config_json,
      name, protocol, host, port, capability_status, parse_error, generation, first_seen_at, last_seen_at,
      is_enabled, is_present, removed_at, next_check_at) VALUES (?, ?, ?, ?, ?, ?, 'vless', ?, 443, 'unsupported', ?, 7, ?, ?, ?, ?, ?, ?)`,
    [id, sourceId, oldFingerprint, raw, JSON.stringify(previous), id, host, LEGACY_ERROR, seen, seen, enabled, present, present ? null : seen, Date.now() + 86400000]);
    db.run(`INSERT INTO subscription_node_health (node_id, config_fingerprint, generation, status, error_message)
      VALUES (?, ?, 7, 'unsupported', ?)`, [id, oldFingerprint, LEGACY_ERROR]);
  });
  return raw;
}

test('stored unsupported nodes are reparsed in place, preserve exclusions and remain unissued until checked', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Existing source', url: 'https://example.com/subscription', is_active: true }, settings);
  const reality = seedLegacy(source.id, 'reality');
  const plain = seedLegacy(source.id, 'plain', { security: 'none', enabled: 0 });
  seedLegacy(source.id, 'removed', { security: 'none', present: 0 });
  db.run("INSERT INTO users (id, username) VALUES ('user', 'User')");
  saveAssignments('user', { sources: [source.id] });
  const before = health.getNode('reality');
  health.markStarted(before, 'old-cycle');
  assert.deepEqual(sources.reparseStoredNodes(), { updated: 3, merged: 0 });
  const node = health.getNode('reality');
  assert.equal(node.capability_status, 'supported');
  assert.equal(node.status, 'unknown');
  assert.equal(node.parse_error, null);
  assert.equal(node.error_message, null);
  assert.equal(node.next_check_at, 0);
  assert.equal(node.generation, 8);
  assert.equal(JSON.parse(node.normalized_config_json).reality.publicKey, PUBLIC_KEY);
  assert.equal(node.raw_link, reality);
  assert.equal(health.getNode('plain').is_enabled, 0);
  assert.equal(health.getNode('removed').is_present, 0);
  assert.equal(resolveUserSubscription('user', Date.now(), settings).servers.length, 0);
  assert.equal(health.recordResult(before, 'old-cycle', { status: 'healthy', attempts: [] }, settings), false);
  assert.deepEqual(sources.reparseStoredNodes(), { updated: 0, merged: 0 });
  const report = sources.applySnapshot(source, parseSubscription([reality, plain].join('\n')));
  assert.equal(report.added, 0);
  assert.equal(report.existing, 2);
  assert.equal(health.getNode('reality').id, 'reality');
  assert.equal(health.getNode('plain').is_enabled, 0);
});

test('normalization merges equivalent Reality URI variants without losing exclusions, history or source assignments', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Aliases', url: 'https://example.com/subscription', is_active: true }, settings);
  seedLegacy(source.id, 'first', { host: 'same.example.com', seen: 1000 });
  seedLegacy(source.id, 'second', { host: 'same.example.com', fp: 'chrome', sid: 'abcd', enabled: 0, seen: 2000 });
  db.run(`INSERT INTO background_jobs (id, type, dedupe_key, source_id, node_id, reason, state, created_at)
    VALUES ('old-job', 'check_node', 'old-key', ?, 'second', 'manual', 'completed', 2000)`, [source.id]);
  db.run(`INSERT INTO subscription_node_checks (job_id, cycle_id, node_id, config_fingerprint, generation, probe_profile_version, outcome, checked_at)
    VALUES ('old-job', 'old-cycle', 'second', 'legacy-fingerprint', 7, 'legacy-profile', 'failure', 2000)`);
  db.run("INSERT INTO users (id, username) VALUES ('user', 'User')");
  saveAssignments('user', { sources: [source.id] });
  assert.deepEqual(sources.reparseStoredNodes(), { updated: 1, merged: 1 });
  const nodes = health.getNodes(source.id);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'first');
  assert.equal(nodes[0].is_enabled, 0);
  assert.equal(nodes[0].first_seen_at, 1000);
  assert.equal(nodes[0].last_seen_at, 2000);
  assert.equal(nodes[0].status, 'unknown');
  assert.equal(db.get("SELECT node_id FROM background_jobs WHERE id = 'old-job'").node_id, 'first');
  assert.equal(db.get('SELECT node_id FROM subscription_node_checks').node_id, 'first');
  assert.equal(db.get('SELECT count(*) AS n FROM user_subscription_sources').n, 1);
  assert.deepEqual(sources.reparseStoredNodes(), { updated: 0, merged: 0 });
});

test('304 does not block reclassification; startup automatically checks nodes accepted by the new parser', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config();
  const source = sources.createSource({ name: 'Cached', url: 'https://example.com/subscription', is_active: true }, settings);
  seedLegacy(source.id, 'cached');
  db.run('UPDATE subscription_sources SET etag = ?, last_success_at = ?, next_sync_at = ? WHERE id = ?',
    ['unchanged', Date.now(), Date.now() + 86400000, source.id]);
  await sources.syncSource(source.id, settings, { download: async () => ({ status: 304 }) });
  assert.equal(health.getNode('cached').capability_status, 'supported');
  assert.equal(health.getNode('cached').status, 'unknown');
  assert.equal(health.getNode('cached').last_checked_at, null);
  seedLegacy(source.id, 'on-restart', { security: 'none' });
  const checked = [];
  const checker = {
    status: { available: true }, verifyBinary: async () => {}, cleanup: async () => {}, stop: async () => {},
    check: async node => {
      checked.push(node.id);
      return { status: 'healthy', successCount: 3, attemptCount: 3, targetId: 'primary', targetPriority: 0, latencyMs: 50, httpStatus: 204, attempts: [] };
    }
  };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  await scheduler.start();
  await scheduler.idle();
  assert.deepEqual(checked.sort(), ['cached', 'on-restart']);
  assert.ok(health.getNodes(source.id).every(node => health.eligibility(node, settings) === 'healthy'));
});
