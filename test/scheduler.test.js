const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('timers/promises');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const { getNodes, getNode, eligibility, markStarted, recordResult, pruneHistory } = require('../src/services/subscriptionHealth');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { ProbeScheduler } = require('../src/services/probeScheduler');
const { applyProxyToConfig } = require('../src/services/proxySettings');
const { config, link } = require('./fixtures');

const successful = { status: 'healthy', successCount: 3, attemptCount: 3, targetId: 'primary', targetPriority: 0, latencyMs: 50, httpStatus: 204, attempts: [] };

function deferredChecker() {
  const calls = [];
  const result = { ...successful, checkedAddress: '8.8.8.8', attempts: [1, 2, 3].map(attempt => ({
    attempt, targetId: 'primary', outcome: 'success', latencyMs: 50, httpStatus: 204
  })) };
  const checker = { status: { available: true }, stop: async () => {
    for (const call of calls) call.resolve({ status: 'cancelled', errorCode: 'cancelled' });
  }, check: async (node, options) => {
    const deferred = Promise.withResolvers();
    calls.push({ node, ...options, ...deferred });
    return deferred.promise;
  } };
  return { checker, calls, result };
}

function proxyProfiles() {
  const proxy = { protocol: 'http', address: 'proxy.example.com', port: 3128, user: 'probe-user', pass: 'probe-pass' };
  const only = applyProxyToConfig(config({ concurrency: 1 }), { proxy, mode: 'only' });
  const extra = applyProxyToConfig(only, { proxy, mode: 'extra' });
  return { only, extra };
}

test('bounded queue shares node checks, persists progress and ignores a result from an old generation', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config({ concurrency: 2 });
  let running = 0;
  let maximum = 0;
  let calls = 0;
  const checker = { status: { available: true }, stop: async () => {}, check: async () => {
    calls++; maximum = Math.max(maximum, ++running);
    await delay(30); running--;
    return successful;
  } };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Test', url: 'https://example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(Array.from({ length: 6 }, (_, i) => link(`vpn${i}.example.com`)).join('\n')));
  const job = scheduler.enqueueCheck({ sourceId: source.id });
  assert.equal(scheduler.enqueueCheck({ sourceId: source.id }).id, job.id);
  const single = scheduler.enqueueCheck({ nodeId: getNodes(source.id)[0].id });
  assert.deepEqual(scheduler.metrics().progress, { total: 6, completed: 0 });
  await scheduler.idle();
  assert.deepEqual(scheduler.metrics().progress, { total: 6, completed: 6 });
  assert.equal(calls, 6);
  assert.equal(maximum, 2);
  assert.equal(scheduler.job(job.id).completed, 6);
  assert.equal(scheduler.job(single.id).state, 'completed');
  assert.ok(getNodes(source.id).every(node => eligibility(node, settings) === 'healthy'));
  const node = getNodes(source.id)[0];
  markStarted(node, 'old');
  sources.setNodeEnabled(node.id, false);
  sources.setNodeEnabled(node.id, true);
  assert.equal(recordResult(node, 'old', successful, settings), false);
  assert.equal(eligibility(getNode(node.id), settings), 'unknown');
  scheduler.enqueueCheck({ nodeId: node.id });
  assert.deepEqual(scheduler.metrics().progress, { total: 1, completed: 0 });
  await scheduler.idle();
  assert.deepEqual(scheduler.metrics().progress, { total: 1, completed: 1 });
});

test('queue progress includes new tasks during a cycle and advances only after results are saved', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config();
  const scheduler = new ProbeScheduler(settings, { checker: { status: { available: false }, stop: async () => {} } });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  assert.deepEqual(scheduler.metrics().progress, { total: 0, completed: 0 });
  const source = sources.createSource({ name: 'Test', url: 'https://example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription([link('one.example.com'), link('two.example.com')].join('\n')));
  scheduler.enqueueCheck({ sourceId: source.id });
  const first = [...scheduler.tasks.values()][0];
  scheduler.complete(first, { status: 'cancelled', errorCode: 'cancelled' });
  assert.deepEqual(scheduler.metrics().progress, { total: 2, completed: 0 });
  scheduler.flush();
  assert.deepEqual(scheduler.metrics().progress, { total: 2, completed: 1 });
  // A new job rechecks the processed node while sharing the still-queued node.
  scheduler.enqueueCheck({ sourceId: source.id, reason: 'scheduled' });
  assert.deepEqual(scheduler.metrics().progress, { total: 3, completed: 1 });
  for (const task of scheduler.tasks.values()) scheduler.complete(task, { status: 'runner_error', errorCode: 'runner_error' });
  const transaction = t.mock.method(db, 'transaction', () => { throw new Error('Storage unavailable'); });
  scheduler.flush();
  assert.deepEqual(scheduler.metrics().progress, { total: 3, completed: 1 });
  assert.ok(scheduler.metrics().storage_error);
  transaction.mock.restore();
  scheduler.storageError = null;
  scheduler.flush();
  assert.deepEqual(scheduler.metrics().progress, { total: 3, completed: 3 });
  assert.equal(scheduler.tasks.size, 0);
});

test('queued probes retain the config they ran with across a proxy-only to extra profile change', async t => {
  await db.initDb({ filePath: ':memory:' });
  const { only, extra } = proxyProfiles();
  const { checker, calls, result } = deferredChecker();
  const scheduler = new ProbeScheduler(only, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Profile race', url: 'https://example.com', is_active: true }, only);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = getNodes(source.id)[0];
  const job = scheduler.enqueueCheck({ nodeId: node.id });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.profileVersion, only.profileVersion);
  assert.equal(calls[0].config.httpProxyMode, 'only');
  assert.ok(Object.isFrozen(calls[0].config));
  assert.ok(Object.isFrozen(calls[0].config.httpProxy));
  assert.ok(Object.isFrozen(calls[0].config.targets[0]));
  scheduler.config = extra;
  checker.config = extra;
  calls[0].resolve(result);
  await scheduler.idle();
  assert.equal(scheduler.job(job.id).state, 'completed');
  const saved = getNode(node.id);
  assert.equal(saved.probe_profile_version, only.profileVersion);
  assert.equal(eligibility(saved, only), 'healthy');
  assert.equal(eligibility(saved, extra), 'unknown');
  assert.equal(saved.next_check_at, 0);
  assert.ok(db.all('SELECT probe_profile_version FROM subscription_node_checks WHERE node_id = ?', [node.id])
    .every(row => row.probe_profile_version === only.profileVersion));

  const retry = scheduler.enqueueCheck({ nodeId: node.id, reason: 'scheduled', dueOnly: true });
  assert.ok(retry);
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].config.profileVersion, extra.profileVersion);
  assert.equal(calls[1].config.httpProxyMode, 'extra');
  calls[1].resolve({ ...result, proxy: { status: 'healthy', latencyMs: 70, attempts: [] } });
  await scheduler.idle();
  assert.equal(getNode(node.id).probe_profile_version, extra.profileVersion);
  assert.equal(eligibility(getNode(node.id), extra), 'healthy');
});

test('checkNodeNow records the captured profile and makes a late result due under changed authentication', async t => {
  await db.initDb({ filePath: ':memory:' });
  const { only } = proxyProfiles();
  const changed = applyProxyToConfig(only, { proxy: { ...only.httpProxy, pass: 'new-pass' }, mode: 'extra' });
  const { checker, calls, result } = deferredChecker();
  const scheduler = new ProbeScheduler(only, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Immediate race', url: 'https://example.com', is_active: true }, only);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = getNodes(source.id)[0];
  const pending = scheduler.checkNodeNow(node.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.httpProxy.pass, 'probe-pass');
  scheduler.config = changed;
  checker.config = changed;
  calls[0].resolve(result);
  assert.equal((await pending).status, 'healthy');
  assert.equal(getNode(node.id).probe_profile_version, only.profileVersion);
  assert.equal(eligibility(getNode(node.id), changed), 'unknown');
  assert.equal(getNode(node.id).next_check_at, 0);
  const retry = scheduler.checkNodeNow(node.id);
  assert.equal(calls[1].config.profileVersion, changed.profileVersion);
  assert.equal(calls[1].config.httpProxy.pass, 'new-pass');
  calls[1].resolve(result);
  await retry;
  assert.equal(eligibility(getNode(node.id), changed), 'healthy');
});

test('profile changes before a queued probe starts cancel its old task and leave the node due', async t => {
  await db.initDb({ filePath: ':memory:' });
  const { only, extra } = proxyProfiles();
  const { checker, calls } = deferredChecker();
  checker.status.available = false;
  const scheduler = new ProbeScheduler(only, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Waiting race', url: 'https://example.com', is_active: true }, only);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = getNodes(source.id)[0];
  db.run('UPDATE subscription_nodes SET next_check_at = ? WHERE id = ?', [Date.now() + 600000, node.id]);
  const job = scheduler.enqueueCheck({ nodeId: node.id });
  scheduler.config = extra;
  checker.status.available = true;
  scheduler.pump();
  await scheduler.idle();
  assert.equal(calls.length, 0);
  assert.equal(scheduler.job(job.id).state, 'failed');
  assert.equal(getNode(node.id).next_check_at, 0);
});

test('a late old-profile probe cannot overwrite a newer cycle or change its retry schedule', async t => {
  await db.initDb({ filePath: ':memory:' });
  const { only, extra } = proxyProfiles();
  const { checker, calls, result } = deferredChecker();
  const scheduler = new ProbeScheduler(only, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Overlapping race', url: 'https://example.com', is_active: true }, only);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = getNodes(source.id)[0];
  const oldJob = scheduler.enqueueCheck({ nodeId: node.id });
  await Promise.resolve();
  scheduler.config = extra;
  const latest = scheduler.checkNodeNow(node.id);
  calls[1].resolve({ ...result, latencyMs: 90 });
  await latest;
  const saved = getNode(node.id);
  calls[0].resolve(result);
  await scheduler.idle();
  assert.equal(scheduler.job(oldJob.id).state, 'failed');
  assert.equal(getNode(node.id).probe_profile_version, extra.profileVersion);
  assert.equal(getNode(node.id).latency_ms, 90);
  assert.equal(getNode(node.id).next_check_at, saved.next_check_at);
});

test('a runner failure across profiles keeps the last good timestamp but schedules a current-profile retry', async t => {
  await db.initDb({ filePath: ':memory:' });
  const { only, extra } = proxyProfiles();
  const { checker, calls, result } = deferredChecker();
  const scheduler = new ProbeScheduler(only, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Runner race', url: 'https://example.com', is_active: true }, only);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = getNodes(source.id)[0];
  const previous = Date.now() - 1000;
  markStarted(node, 'good', previous - 1);
  recordResult(node, 'good', result, only, null, previous);
  scheduler.enqueueCheck({ nodeId: node.id });
  await Promise.resolve();
  scheduler.config = extra;
  calls[0].resolve({ status: 'runner_error', errorCode: 'xray_missing', errorMessage: 'Xray missing' });
  await scheduler.idle();
  const saved = getNode(node.id);
  assert.equal(saved.last_checked_at, previous);
  assert.equal(saved.probe_profile_version, only.profileVersion);
  assert.equal(eligibility(saved, only), 'healthy');
  assert.equal(eligibility(saved, extra), 'unknown');
  assert.equal(saved.next_check_at, 0);
  assert.equal(saved.runner_error_code, 'xray_missing');
});

test('runner errors do not refresh TTL or overwrite a previous success; later completed failures exclude the node', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config({ healthyTtlMs: 1000 });
  const source = sources.createSource({ name: 'Test', url: 'https://example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = getNodes(source.id)[0];
  markStarted(node, 'good', 1000);
  recordResult(node, 'good', successful, settings, null, 1100);
  markStarted(node, 'runner', 1200);
  recordResult(node, 'runner', { status: 'runner_error', errorCode: 'xray_missing', errorMessage: 'Xray missing' }, settings, null, 1300);
  assert.equal(getNode(node.id).last_checked_at, 1100);
  assert.equal(eligibility(getNode(node.id), settings, 2000), 'healthy');
  assert.equal(eligibility(getNode(node.id), settings, 2100), 'stale');
  markStarted(node, 'failure', 1400);
  recordResult(node, 'failure', { status: 'offline', attempts: [] }, settings, null, 1500);
  assert.equal(eligibility(getNode(node.id), settings, 1600), 'offline');
});

test('300-node catalog has bounded concurrency and history; shutdown interrupts pending jobs', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config();
  let running = 0;
  let maximum = 0;
  const checker = { status: { available: true }, stop: async () => {}, check: async () => {
    maximum = Math.max(maximum, ++running);
    await delay(1);
    running--;
    return { ...successful, attempts: [1, 2, 3].map(attempt => ({ attempt, targetId: 'primary', outcome: 'success', latencyMs: 50, httpStatus: 204 })) };
  } };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: '300 nodes', url: 'https://example.com/300', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(Array.from({ length: 300 }, (_, i) => link(`vpn-${i}.example.com`)).join('\n')));
  const job = scheduler.enqueueCheck({ sourceId: source.id });
  await scheduler.idle();
  assert.equal(scheduler.job(job.id).completed, 300);
  assert.ok(maximum <= settings.concurrency);
  assert.equal(getNodes(source.id).filter(node => eligibility(node, settings) === 'healthy').length, 300);
  assert.equal(db.get('SELECT count(*) AS n FROM subscription_node_checks').n, 900);
  pruneHistory();
  assert.equal(db.get('SELECT count(*) AS n FROM subscription_node_checks').n, 900);
  const cancelled = scheduler.enqueueCheck({ sourceId: source.id });
  assert.deepEqual(scheduler.metrics().progress, { total: 300, completed: 0 });
  await scheduler.stop();
  assert.deepEqual(scheduler.metrics().progress, { total: 300, completed: 300 });
  assert.equal(scheduler.job(cancelled.id).completed, 300);
  assert.ok(scheduler.job(cancelled.id).failed > 0);
  assert.equal(scheduler.tasks.size, 0);
});

test('restart interrupts orphaned jobs and resumes due work without refreshing health', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config();
  const source = sources.createSource({ name: 'Restart', url: 'https://example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()));
  db.run(`INSERT INTO background_jobs (id, type, dedupe_key, source_id, reason, total, state, created_at)
    VALUES ('orphan', 'check_source', 'orphan', ?, 'scheduled', 1, 'running', ?)`, [source.id, Date.now() - 1000]);
  const checker = { status: { available: true }, verifyBinary: async () => {}, cleanup: async () => {}, stop: async () => {}, check: async () => successful };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  await scheduler.start();
  await scheduler.idle();
  assert.equal(scheduler.job('orphan').state, 'interrupted');
  assert.equal(getNodes(source.id)[0].status, 'healthy');
});
