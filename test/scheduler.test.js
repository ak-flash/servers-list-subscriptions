const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('timers/promises');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const { getNodes, getNode, eligibility, markStarted, recordResult, pruneHistory } = require('../src/services/subscriptionHealth');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { ProbeScheduler } = require('../src/services/probeScheduler');
const { config, link } = require('./fixtures');

const successful = { status: 'healthy', successCount: 3, attemptCount: 3, targetId: 'primary', targetPriority: 0, latencyMs: 50, httpStatus: 204, attempts: [] };

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
