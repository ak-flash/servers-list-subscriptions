const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { getNodes, markStarted, recordResult } = require('../src/services/subscriptionHealth');
const { link, config } = require('./fixtures');

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
