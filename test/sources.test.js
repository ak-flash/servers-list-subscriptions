const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { getNodes, markStarted, recordResult } = require('../src/services/subscriptionHealth');
const { link, config } = require('./fixtures');

test('disabling clears temporary data through both settings paths and preserves history and assignments', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  db.run("INSERT INTO users (id, username) VALUES ('cleanup-user', 'cleanup-user')");
  for (const mode of ['toggle', 'edit']) {
    const source = sources.createSource({ name: mode, url: 'https://example.com/sub', authorization: 'Bearer keep' }, settings);
    sources.applySnapshot(source, parseSubscription(link()), { etag: 'old', 'last-modified': 'old', 'subscription-userinfo': 'total=100' }, 1000);
    const node = getNodes(source.id)[0];
    db.run(`INSERT INTO subscription_node_checks (cycle_id, node_id, config_fingerprint, generation, probe_profile_version, outcome, checked_at)
      VALUES ('cycle', ?, ?, ?, 'test', 'success', 1000)`, [node.id, node.fingerprint, node.generation]);
    db.run(`INSERT INTO background_jobs (id, type, dedupe_key, source_id, node_id, reason, created_at)
      VALUES (?, 'check', ?, ?, ?, 'test', 1000)`, [mode, mode, source.id, node.id]);
    db.run(`INSERT INTO user_subscription_sources (user_id, source_id, created_at, updated_at)
      VALUES ('cleanup-user', ?, 1000, 1000)`, [source.id]);
    sources.recordSourceHistory(source.id, 1000);
    const history = db.all('SELECT * FROM subscription_source_history WHERE source_id = ?', [source.id]);
    db.run("UPDATE subscription_sources SET candidate_json = '{}', last_error = 'error', failure_count = 3 WHERE id = ?", [source.id]);
    const disabled = mode === 'toggle' ? sources.setSourceEnabled(source.id, false) :
      sources.updateSource(source.id, { name: mode, is_active: '0' }, settings);
    assert.equal(disabled.is_active, 0);
    assert.equal(disabled.sync_status, 'pending');
    assert.equal(disabled.failure_count, 0);
    for (const field of ['etag', 'last_modified', 'last_attempt_at', 'last_success_at', 'metadata_json', 'report_json', 'candidate_json', 'last_error']) assert.equal(disabled[field], null, field);
    assert.equal(disabled.url, source.url);
    assert.equal(disabled.headers_json, source.headers_json);
    assert.deepEqual(getNodes(source.id), []);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM subscription_node_health WHERE node_id = ?', [node.id]).n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM subscription_node_checks WHERE node_id = ?', [node.id]).n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM background_jobs WHERE source_id = ?', [source.id]).n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM user_subscription_sources WHERE source_id = ?', [source.id]).n, 1);
    sources.recordSourceHistory(source.id, 2000);
    assert.deepEqual(db.all('SELECT * FROM subscription_source_history WHERE source_id = ?', [source.id]), history);
    assert.throws(() => sources.applySnapshot(source, parseSubscription(link()), {}, 2000), { code: 'superseded' });
    sources.setSourceEnabled(source.id, true);
    await sources.syncSource(source.id, settings, { download: async current => {
      assert.equal(current.etag, null);
      assert.equal(current.last_modified, null);
      return { status: 200, body: link(), headers: {} };
    } });
    assert.equal(getNodes(source.id).length, 1);
    assert.notEqual(getNodes(source.id)[0].id, node.id);
  }
});

test('disable cleanup rolls back atomically if deleting nodes fails', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const source = sources.createSource({ name: 'Rollback', url: 'https://example.com/sub' }, config());
  sources.applySnapshot(source, parseSubscription(link()), { etag: 'keep' }, 1000);
  const before = sources.getSource(source.id);
  const nodes = getNodes(source.id);
  db.run("CREATE TRIGGER reject_node_delete BEFORE DELETE ON subscription_nodes BEGIN SELECT RAISE(ABORT, 'cleanup failure'); END");
  assert.throws(() => sources.setSourceEnabled(source.id, false), /cleanup failure/);
  assert.deepEqual(sources.getSource(source.id), before);
  assert.deepEqual(getNodes(source.id), nodes);
});

test('a download finishing after disabling cannot restore deleted nodes or temporary metadata', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const source = sources.createSource({ name: 'Late download', url: 'https://example.com/sub' }, config());
  sources.applySnapshot(source, parseSubscription(link()), {}, 1000);
  let finish;
  const request = sources.syncSource(source.id, config(), { download: () => new Promise(resolve => { finish = resolve; }) });
  sources.setSourceEnabled(source.id, false);
  finish({ status: 200, body: link(), headers: { etag: 'stale' } });
  await assert.rejects(request, { code: 'superseded' });
  assert.deepEqual(getNodes(source.id), []);
  assert.equal(sources.getSource(source.id).etag, null);
  assert.equal(sources.getSource(source.id).sync_status, 'pending');
  await assert.rejects(sources.syncSource(source.id, config()), { code: 'superseded' });
  assert.equal(sources.getSource(source.id).last_attempt_at, null);
});

test('provider notices persist as source metadata, expire and disappear with a fresh snapshot', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const source = sources.createSource({ name: 'Notices', url: 'https://example.com/sub', is_active: true }, config());
  const snapshot = parseSubscription(`${link()}\nvless://xxxxxxxxxx1@localhost:80?...#${encodeURIComponent('📆 Осталось: 23 дня')}\nvless://xxxxxxxxxx1@localhost:444?...#${encodeURIComponent('➡️t.me/example_bot')}`);
  assert.deepEqual(snapshot.metadata, { remaining_days: 23, contact_url: 'https://t.me/example_bot' });
  assert.equal(snapshot.nodes.length, 1);
  sources.applySnapshot(source, snapshot, { 'subscription-userinfo': 'total=100' }, Date.now() - 86400000);
  let publicSource = sources.publicSource(sources.getSource(source.id));
  assert.equal(publicSource.remaining_days, 22);
  assert.equal(publicSource.contact_url, 'https://t.me/example_bot');
  assert.equal(JSON.parse(publicSource.metadata_json).total, 100);
  assert.equal(sources.publicSource({ ...sources.getSource(source.id), metadata_json: '{"contact_url":"javascript:alert(1)"}' }).contact_url, null);
  sources.applySnapshot(source, parseSubscription(link()), {}, Date.now());
  publicSource = sources.publicSource(sources.getSource(source.id));
  assert.equal(publicSource.remaining_days, null);
  assert.equal(publicSource.contact_url, null);
});

test('provider remaining traffic persists on the source and falls back to userinfo counters', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const source = sources.createSource({ name: 'Traffic', url: 'https://example.com/traffic', is_active: true }, config());
  const snapshot = parseSubscription(`${link()}\nvless://xxxxxxxxxx3@localhost:8443?...#${encodeURIComponent('Осталось трафика: 100 GB')}`);
  sources.applySnapshot(source, snapshot, {}, 1000);
  let publicSource = sources.publicSource(sources.getSource(source.id));
  assert.equal(publicSource.remaining_traffic, 100 * 1024 ** 3);
  assert.equal(publicSource.remaining_traffic_label, '100 GB');
  assert.equal(JSON.parse(publicSource.metadata_json).remaining_traffic, 100 * 1024 ** 3);
  sources.applySnapshot(source, parseSubscription(link()), { 'subscription-userinfo': `total=${10 * 1024 ** 3}; upload=${2 * 1024 ** 3}; download=${3 * 1024 ** 3}` }, 2000);
  publicSource = sources.publicSource(sources.getSource(source.id));
  assert.equal(publicSource.remaining_traffic, 5 * 1024 ** 3);
  assert.equal(publicSource.remaining_traffic_label, '5 GB');
});

test('snapshot node cap applies to union of retained and incoming nodes', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config({ maxNodes: 2 });
  const source = sources.createSource({ name: 'Capped', url: 'https://cap.example.com', is_active: true }, settings);
  const firstSnapshot = parseSubscription([link('one.example.com'), link('two.example.com')].join('\n')); firstSnapshot.maxNodes = 2;
  const secondSnapshot = parseSubscription([link('three.example.com'), link('four.example.com')].join('\n')); secondSnapshot.maxNodes = 2;
  sources.applySnapshot(source, firstSnapshot, {}, 1000);
  sources.applySnapshot(source, secondSnapshot, {}, 2000);
  assert.equal(getNodes(source.id).filter(node => node.is_present).length, 2);
  assert.equal(getNodes(source.id).some(node => node.host === 'one.example.com'), false);
});

test('atomic imports preserve identities; partial/failed fetch, disappearance and return invalidate health', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Test', url: 'https://source.example.com/private?token=secret', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription([link(), link('two.example.com')].join('\n')), { etag: 'v1' }, 1000);
  const first = getNodes(source.id).find(node => node.host === 'vpn.example.com');
  db.run("UPDATE subscription_node_health SET status = 'healthy', last_checked_at = 1000 WHERE node_id = ?", [first.id]);
  sources.applySnapshot(source, parseSubscription([link(), link('two.example.com')].join('\n')), { etag: 'v1' }, 2000);
  assert.equal(getNodes(source.id).find(n => n.id === first.id).status, 'healthy');
  sources.applySnapshot(source, parseSubscription(link() + '\nbad record'), { etag: 'partial' }, 3000);
  assert.equal(getNodes(source.id).filter(n => n.is_present).length, 2);
  assert.equal(sources.getSource(source.id).etag, null);
  const failed = () => Promise.resolve({ status: 200, body: '<html>Error</html>', headers: {} });
  await assert.rejects(sources.syncSource(source.id, settings, { download: failed }), { code: 'unsupported_format' });
  assert.equal(getNodes(source.id).filter(n => n.is_present).length, 2);
  sources.applySnapshot(source, parseSubscription(link('two.example.com')), {}, 4000);
  sources.applySnapshot(source, parseSubscription(link()), {}, 5000);
  assert.equal(getNodes(source.id).filter(n => n.is_present).length, 1);

  assert.ok(!JSON.stringify(sources.publicSource(sources.getSource(source.id))).includes('token=secret'));
});

test('metadata-only rename preserves health and generation', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Rename', url: 'https://example.com/rename', is_active: true }, settings);
  const original = link();
  const renamed = `${original.split('#')[0]}#New%20name`;
  sources.applySnapshot(source, parseSubscription(original), {}, 1000);
  const before = getNodes(source.id)[0];
  db.run(`UPDATE subscription_node_health SET status = 'healthy', generation = ?, last_checked_at = ?,
    last_success_at = ? WHERE node_id = ?`, [before.generation, 900, 900, before.id]);
  sources.applySnapshot(source, parseSubscription(renamed), {}, 2000);
  const after = getNodes(source.id)[0];
  assert.equal(after.id, before.id);
  assert.equal(after.generation, before.generation);
  assert.equal(after.status, 'healthy');
  assert.equal(after.last_checked_at, 900);
  assert.equal(after.name, 'New name');
});

test('reparse preserves metadata-only health but invalidates changed configuration', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Reparse', url: 'https://example.com/reparse', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()), {}, 1000);
  const before = getNodes(source.id)[0];
  db.run(`UPDATE subscription_node_health SET status = 'healthy', generation = ?, last_checked_at = ?, last_success_at = ? WHERE node_id = ?`,
    [before.generation, 900, 900, before.id]);
  db.run('UPDATE subscription_nodes SET raw_link = ? WHERE id = ?', [`${link().split('#')[0]}#Renamed`, before.id]);
  sources.reparseStoredNodes(source.id);
  let after = getNodes(source.id)[0];
  assert.equal(after.id, before.id);
  assert.equal(after.generation, before.generation);
  assert.equal(after.status, 'healthy');
  assert.equal(after.name, 'Renamed');

  db.run('UPDATE subscription_nodes SET raw_link = ? WHERE id = ?', [link('changed.example.com'), before.id]);
  sources.reparseStoredNodes(source.id);
  after = getNodes(source.id)[0];
  assert.ok(after.generation > before.generation);
  assert.equal(after.status, 'unknown');
  assert.equal(after.last_checked_at, null);
});

test('unsupported-only snapshot is accepted and removes missing supported nodes', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Opaque', url: 'https://example.com/opaque', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription([link(), 'ss://opaque.example/secret'].join('\n')), {}, 1000);
  assert.equal(getNodes(source.id).filter(node => node.is_present).length, 2);
  sources.applySnapshot(source, parseSubscription('ss://opaque.example/secret'), {}, 2000);
  const nodes = getNodes(source.id);
  assert.equal(nodes.filter(node => node.is_present).length, 1);
  assert.equal(nodes.some(node => node.protocol === 'vless'), false);
  assert.equal(sources.getSource(source.id).sync_status, 'success');
});

test('suspect shrink preserves catalog until independently observed confirmation', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config({ sourceMinRetainRatio: 0.5, sourceMinRetainNodes: 3, sourceConfirmationIntervalMs: 1000 });
  const source = sources.createSource({ name: 'Shrink', url: 'https://example.com/shrink' }, settings);
  sources.applySnapshot(source, parseSubscription([link(), link('two.example.com'), link('three.example.com')].join('\n')), { etag: 'accepted' }, 1000);
  const download = async () => ({ status: 200, body: link(), headers: { etag: 'small' } });
  const first = await sources.syncSource(source.id, settings, { download, now: () => 2000 });
  assert.equal(first.acceptance, 'suspect');
  assert.equal(getNodes(source.id).filter(n => n.is_present).length, 3);
  assert.equal(sources.getSource(source.id).etag, null);
  assert.ok(sources.getSource(source.id).candidate_json);
  await assert.rejects(sources.syncSource(source.id, settings, { download: async () => ({ status: 304 }), now: () => 2100 }), { code: 'unsupported_format' });
  await sources.syncSource(source.id, settings, { download, now: () => 2200 });
  assert.equal(getNodes(source.id).filter(n => n.is_present).length, 3);
  await sources.syncSource(source.id, settings, { download, now: () => 3100 });
  assert.equal(getNodes(source.id).filter(n => n.is_present).length, 1);
  assert.equal(sources.getSource(source.id).candidate_json, null);
  assert.equal(sources.getSource(source.id).etag, 'small');
});

test('suspect candidate survives reopening and failed replacement rolls back catalog and candidate', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = fs.mkdtempSync('/tmp/opencode/suspect-');
  const filePath = path.join(directory, 'test.db');
  t.after(() => { db.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
  await db.initDb({ filePath });
  const settings = config({ sourceMinRetainRatio: 0.5, sourceMinRetainNodes: 3, sourceConfirmationIntervalMs: 1000 });
  const source = sources.createSource({ name: 'Durable shrink', url: 'https://example.com/durable' }, settings);
  sources.applySnapshot(source, parseSubscription([link(), link('two.example.com'), link('three.example.com')].join('\n')), { etag: 'old' }, 1000);
  const download = async () => ({ status: 200, body: link(), headers: { etag: 'new' } });
  await sources.syncSource(source.id, settings, { download, now: () => 2000 });
  const candidate = sources.getSource(source.id).candidate_json;
  db.closeDb();
  await db.initDb({ filePath });
  assert.equal(sources.getSource(source.id).candidate_json, candidate);
  db.run(`CREATE TRIGGER reject_candidate_clear BEFORE UPDATE OF candidate_json ON subscription_sources
    WHEN NEW.candidate_json IS NULL BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END`);
  await assert.rejects(sources.syncSource(source.id, settings, { download, now: () => 3100 }), /injected replacement failure/);
  assert.equal(getNodes(source.id).filter(node => node.is_present).length, 3);
  assert.equal(sources.getSource(source.id).candidate_json, candidate);
  assert.equal(sources.getSource(source.id).etag, null);
  db.run('DROP TRIGGER reject_candidate_clear');
  await sources.syncSource(source.id, settings, { download, now: () => 4200 });
  assert.equal(getNodes(source.id).filter(node => node.is_present).length, 1);
  assert.equal(sources.getSource(source.id).candidate_json, null);
  assert.equal(sources.getSource(source.id).etag, 'new');
});

test('public source suspect metadata is safe and omits authorization', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config({ sourceMinRetainRatio: 0.5, sourceMinRetainNodes: 3 });
  const source = sources.createSource({ name: 'Public suspect', url: 'https://example.com/public', authorization: 'Bearer secret' }, settings);
  db.run("UPDATE subscription_sources SET sync_status = 'suspect', candidate_json = ? WHERE id = ?", [JSON.stringify({ confirmations: 1, hash: 'h' }), source.id]);
  const publicView = sources.publicSource(sources.getSource(source.id));
  assert.equal(publicView.has_authorization, true);
  assert.equal(publicView.suspect, true);
  assert.equal(publicView.suspect_candidate.confirmations, 1);
  assert.equal(JSON.stringify(publicView).includes('Bearer secret'), false);
});

test('suspect candidate transitions reset on changed composition, partial response and errors', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config({ sourceMinRetainRatio: 0.5, sourceMinRetainNodes: 3, sourceConfirmationIntervalMs: 1000 });
  const source = sources.createSource({ name: 'Transitions', url: 'https://example.com/transitions' }, settings);
  sources.applySnapshot(source, parseSubscription([link(), link('two.example.com'), link('three.example.com'), link('four.example.com')].join('\n')), { etag: 'ok' }, 1000);
  const small = async body => ({ status: 200, body, headers: {} });
  await sources.syncSource(source.id, settings, { download: () => small(link()), now: () => 2000 });
  assert.ok(sources.getSource(source.id).candidate_json);
  await sources.syncSource(source.id, settings, { download: () => small(link('different.example.com')), now: () => 3000 });
  const candidate = JSON.parse(sources.getSource(source.id).candidate_json);
  assert.equal(candidate.confirmations, 1);
  await assert.rejects(sources.syncSource(source.id, settings, { download: async () => { throw new Error('network'); }, now: () => 4000 }));
  assert.equal(JSON.parse(sources.getSource(source.id).candidate_json).confirmations, 1);
  await assert.rejects(sources.syncSource(source.id, settings, { download: () => small('not-a-subscription'), now: () => 5000 }));
  assert.equal(JSON.parse(sources.getSource(source.id).candidate_json).confirmations, 1);
});

test('URL, authorization and user-agent changes invalidate the old representation', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Headers', url: 'https://example.com/headers', authorization: 'Bearer old', user_agent: 'old-agent', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()), { etag: 'old' }, 1000);
  const node = getNodes(source.id)[0];
  for (const change of [
    { authorization: 'Bearer new' },
    { user_agent: 'new-agent' },
    { url: 'https://example.com/new' }
  ]) {
    const current = sources.getSource(source.id);
    sources.updateSource(source.id, { name: current.name, url: change.url || current.url,
      authorization: change.authorization, user_agent: change.user_agent, is_active: true }, settings, 2000);
    assert.equal(sources.getSource(source.id).etag, null);
    assert.equal(getNodes(source.id).find(candidate => candidate.id === node.id).is_present, 0);
    sources.applySnapshot(sources.getSource(source.id), parseSubscription(link()), { etag: 'accepted' }, 3000);
  }
});

test('partial snapshots clear validators and cannot be certified by a later 304', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Validators', url: 'https://example.com/validators', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()), { etag: 'accepted' }, 1000);
  const failed = () => Promise.resolve({ status: 200, body: `${link()}\nbad record`, headers: { etag: 'partial' } });
  await sources.syncSource(source.id, settings, { download: failed });
  assert.equal(sources.getSource(source.id).etag, null);
  await assert.rejects(sources.syncSource(source.id, settings, { download: () => Promise.resolve({ status: 304, headers: {} }) }), { code: 'unsupported_format' });
});

test('URL change during download discards old result; 304 never refreshes health', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Test', url: 'https://example.com/old', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()), { etag: 'first' }, 1000);
  const node = getNodes(source.id)[0];
  db.run("UPDATE subscription_node_health SET status = 'healthy', last_checked_at = 900 WHERE node_id = ?", [node.id]);
  await sources.syncSource(source.id, settings, { download: async () => ({ status: 304, headers: {} }), now: () => 2000 });
  assert.equal(getNodes(source.id)[0].last_checked_at, 900);
  let finish;
  const task = sources.syncSource(source.id, settings, { download: () => new Promise(resolve => { finish = resolve; }) });
  sources.updateSource(source.id, { name: source.name, url: 'https://example.com/new', is_active: true }, settings);
  finish({ status: 200, body: link(), headers: {} });
  await assert.rejects(task, { code: 'superseded' });
  assert.equal(getNodes(source.id)[0].is_present, 0);
  assert.equal(sources.getSource(source.id).etag, null);
  sources.deleteSource(source.id);
  assert.equal(db.get('SELECT count(*) AS n FROM subscription_nodes').n, 0);
  assert.equal(db.get('SELECT count(*) AS n FROM subscription_node_health').n, 0);
});
