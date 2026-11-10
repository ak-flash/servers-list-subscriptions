const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('timers/promises');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const health = require('../src/services/subscriptionHealth');
const { ProbeScheduler } = require('../src/services/probeScheduler');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { config, link } = require('./fixtures');

const fastReachable = { profile: 'fast', status: 'reachable', latencyMs: 5, checkedAddress: '198.51.100.1',
  serviceGates: [{ targetId: 'primary', passed: true, status: 204, errorCode: null }] };
const fullSuccess = { profile: 'full', status: 'healthy', successCount: 3, attemptCount: 3, targetId: 'primary',
  targetPriority: 0, latencyMs: 20, httpStatus: 204, checkedAddress: '198.51.100.1', throughputBps: 1024 * 1024,
  serviceGates: [{ targetId: 'primary', passed: true, status: 204, errorCode: null }],
  attempts: [1, 2, 3].map(attempt => ({ attempt, targetId: 'primary', outcome: 'success',
    latencyMs: 20, httpStatus: 204, bytesTransferred: 1024, throughputBps: 1024 * 1024 })) };

test('a scheduled source check runs Fast then Full in one admission and stores both profiles', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config({ fastProbeConcurrency: 4, concurrency: 2 });
  const calls = [];
  const checker = {
    status: { available: true },
    stop: async () => {},
    check: async (node, options) => {
      calls.push({ node, profile: options.profile, skipFast: options.skipFast });
      return options.profile === 'fast' ? { ...fastReachable } : { ...fullSuccess };
    }
  };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Pipeline', url: 'https://pipeline.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription([link('one.example.com'), link('two.example.com')].join('\n')));
  const job = scheduler.enqueueCheck({ sourceId: source.id, pipeline: true });
  await scheduler.idle();
  assert.equal(calls.length, 4, 'two nodes, one Fast and one Full call each');
  assert.deepEqual(calls.map(call => call.profile), ['fast', 'fast', 'full', 'full']);
  assert.equal(calls.filter(call => call.profile === 'full').every(call => call.skipFast === true), true);
  assert.equal(scheduler.job(job.id).total, 2, 'the composite cycle is one queued job per node');
  assert.equal(scheduler.job(job.id).completed, 2);
  for (const node of health.getNodes(source.id)) {
    assert.equal(node.status, 'healthy');
    assert.equal(node.probe_profile, 'full');
    assert.equal(node.fast_status, 'reachable');
    assert.equal(node.throughput_bps, 1024 * 1024);
    assert.ok(Number.isFinite(node.score));
    assert.ok(node.stability > 0 && node.stability <= 1);
    assert.deepEqual(JSON.parse(node.service_gates_json), fastReachable.serviceGates);
    const rows = db.all('SELECT profile, outcome FROM subscription_node_checks WHERE node_id = ? ORDER BY id', [node.id]);
    assert.equal(rows.filter(row => row.profile === 'fast').length, 1);
    assert.equal(rows.filter(row => row.profile === 'full').length, 3);
    assert.ok(rows.every(row => row.outcome === 'success'));
  }
});

test('a successful Fast observation is visible during Full and is recorded exactly once', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config();
  const fullStarted = Promise.withResolvers();
  const releaseFull = Promise.withResolvers();
  let duringFull = null;
  const checker = {
    status: { available: true },
    stop: async () => {},
    check: async (node, options) => {
      if (options.profile === 'fast') return { ...fastReachable };
      duringFull = health.getNode(node.id);
      fullStarted.resolve();
      await releaseFull.promise;
      return { ...fullSuccess };
    }
  };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Fast visible', url: 'https://fast-visible.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = health.getNodes(source.id)[0];
  const fastRows = () => db.get("SELECT count(*) AS n FROM subscription_node_checks WHERE node_id = ? AND profile = 'fast'", [node.id]).n;
  scheduler.enqueueCheck({ sourceId: source.id, pipeline: true });
  await fullStarted.promise;
  assert.ok(duringFull);
  assert.equal(duringFull.fast_status, 'reachable', 'Fast reachability is visible while Full runs');
  assert.equal(duringFull.status, 'unknown');
  assert.equal(duringFull.score, null);
  assert.equal(fastRows(), 1, 'the Fast observation is written before Full completes');
  releaseFull.resolve();
  await scheduler.idle();
  const saved = health.getNode(node.id);
  assert.equal(saved.status, 'healthy');
  assert.equal(saved.fast_status, 'reachable');
  assert.equal(saved.fast_checked_at, duringFull.fast_checked_at, 'Full must not rewrite the Fast observation timestamp');
  assert.equal(fastRows(), 1, 'Fast history is written exactly once');
  assert.equal(db.get("SELECT count(*) AS n FROM subscription_node_checks WHERE node_id = ? AND profile = 'full'", [node.id]).n, 3);
});

test('a Fast failure stops the cycle, records fast history, and leaves the Full measurement alone', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config();
  let fullCalls = 0;
  const checker = {
    status: { available: true },
    stop: async () => {},
    check: async (_node, options) => {
      if (options.profile === 'full') { fullCalls++; return { ...fullSuccess }; }
      return { profile: 'fast', status: 'offline', latencyMs: 6000, checkedAddress: '198.51.100.1',
        errorCode: 'probe_timeout', serviceGates: [] };
    }
  };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Fast failure', url: 'https://fast-failure.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = health.getNodes(source.id)[0];
  const previous = Date.now() - 1000;
  health.markStarted(node, 'previous', previous - 1);
  health.recordResult(node, 'previous', { ...fullSuccess, score: 77, throughputBps: 2 * 1024 * 1024 }, settings, null, previous);
  const before = health.getNode(node.id);
  scheduler.enqueueCheck({ sourceId: source.id, pipeline: true });
  await scheduler.idle();
  assert.equal(fullCalls, 0, 'Full Probe must not run after Fast fails');
  const saved = health.getNode(node.id);
  assert.equal(saved.status, 'offline');
  assert.equal(saved.probe_profile, 'fast');
  assert.equal(saved.fast_status, 'offline');
  assert.equal(saved.fast_error_code, 'probe_timeout');
  assert.equal(saved.score, before.score, 'Fast failure must not overwrite Score');
  assert.equal(saved.throughput_bps, before.throughput_bps, 'Fast failure must not overwrite throughput');
  assert.equal(saved.service_gates_json, before.service_gates_json, 'Fast failure must not overwrite service gates');
  assert.equal(saved.last_success_at, before.last_success_at);
  assert.equal(db.all('SELECT profile FROM subscription_node_checks WHERE node_id = ?', [node.id]).filter(row => row.profile === 'fast').length >= 1, true);
  assert.equal(db.all("SELECT count(*) AS n FROM subscription_node_checks WHERE node_id = ? AND profile = 'full'", [node.id])[0].n, 3);
});

test('Fast and Full phases have independent concurrency limits', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config({ fastProbeConcurrency: 2, concurrency: 1, maxQueued: 20 });
  const running = { fast: 0, full: 0 };
  const maximum = { fast: 0, full: 0 };
  const checker = {
    status: { available: true },
    stop: async () => {},
    check: async (_node, options) => {
      const profile = options.profile;
      running[profile]++;
      maximum[profile] = Math.max(maximum[profile], running[profile]);
      await delay(15);
      running[profile]--;
      return profile === 'fast' ? { ...fastReachable } : { ...fullSuccess };
    }
  };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Limits', url: 'https://limits.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(Array.from({ length: 4 }, (_, index) => link(`limit-${index}.example.com`)).join('\n')));
  scheduler.enqueueCheck({ sourceId: source.id, pipeline: true });
  await scheduler.idle();
  assert.equal(maximum.fast, 2);
  assert.equal(maximum.full, 1);
  assert.equal(scheduler.counts.fast, 0);
  assert.equal(scheduler.counts.full, 0);
  assert.equal(scheduler.counts.check, 0);
});

test('a standalone Fast Probe reports reachability without upgrading the main health verdict', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config();
  const calls = [];
  const checker = {
    status: { available: true },
    stop: async () => {},
    check: async (_node, options) => {
      calls.push(options.profile);
      return { ...fastReachable };
    }
  };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Fast only', url: 'https://fast-only.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = health.getNodes(source.id)[0];
  const result = await scheduler.fastProbeNow(node.id);
  await scheduler.idle();
  assert.equal(result.status, 'reachable');
  assert.deepEqual(calls, ['fast'], 'a manual fast check must not trigger a Full Probe');
  const saved = health.getNode(node.id);
  assert.equal(saved.fast_status, 'reachable');
  assert.equal(saved.status, 'unknown');
  assert.equal(saved.score, null);
  assert.equal(saved.next_check_at, 0, 'a successful Fast probe must not postpone the Full check');
});

test('a Full result without a Fast phase does not fabricate Fast diagnostics', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Full only', url: 'https://full-only.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = health.getNodes(source.id)[0];
  health.markStarted(node, 'full-only', Date.now() - 2);
  health.recordResult(node, 'full-only', { ...fullSuccess }, settings, null, Date.now() - 1);
  const saved = health.getNode(node.id);
  assert.equal(saved.status, 'healthy');
  assert.equal(saved.probe_profile, 'full');
  assert.equal(saved.fast_status, null);
  assert.equal(saved.fast_checked_at, null);
  assert.ok(Number.isFinite(saved.score));
});

test('a Full-phase runner failure keeps the Fast observation without scoring the node', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config();
  const checker = {
    status: { available: true },
    stop: async () => {},
    check: async (_node, options) => {
      if (options.profile === 'fast') return { ...fastReachable };
      throw new Error('xray exited');
    }
  };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Full crash', url: 'https://full-crash.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()));
  scheduler.enqueueCheck({ sourceId: source.id, pipeline: true });
  await scheduler.idle();
  const saved = health.getNode(health.getNodes(source.id)[0].id);
  assert.equal(saved.fast_status, 'reachable');
  assert.notEqual(saved.status, 'healthy');
  assert.equal(saved.score, null);
  assert.equal(saved.throughput_bps, null);
});

test('a Full check stopped by its Fast phase preserves the last Score, throughput and gates', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = config();
  const source = sources.createSource({ name: 'Fast stop', url: 'https://fast-stop.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = health.getNodes(source.id)[0];
  health.markStarted(node, 'good-cycle', Date.now() - 10);
  health.recordResult(node, 'good-cycle', { ...fullSuccess }, settings, null, Date.now() - 9);
  const before = health.getNode(node.id);
  health.markStarted(node, 'stopped-cycle', Date.now() - 2);
  health.recordResult(node, 'stopped-cycle', {
    profile: 'full', status: 'offline', attempts: [], successCount: 0, attemptCount: 0, latencyMs: 6000,
    fast: { profile: 'fast', status: 'offline', latencyMs: 6000, errorCode: 'probe_timeout' }
  }, settings, null, Date.now() - 1);
  const saved = health.getNode(node.id);
  assert.equal(saved.status, 'offline');
  assert.equal(saved.probe_profile, 'fast');
  assert.equal(saved.fast_status, 'offline');
  assert.equal(saved.score, before.score, 'a Fast failure must not overwrite Score');
  assert.equal(saved.throughput_bps, before.throughput_bps, 'a Fast failure must not overwrite throughput');
  assert.equal(saved.service_gates_json, before.service_gates_json, 'a Fast failure must not overwrite service gates');
});

test('a standalone Fast and a source check for the same node never probe concurrently', async t => {
  await db.initDb({ filePath: ':memory:' });
  const settings = config({ fastProbeConcurrency: 4, concurrency: 2 });
  let running = 0;
  let maximum = 0;
  const checker = {
    status: { available: true },
    stop: async () => {},
    check: async (_node, options) => {
      maximum = Math.max(maximum, ++running);
      await delay(20);
      running--;
      return options.profile === 'fast' ? { ...fastReachable } : { ...fullSuccess };
    }
  };
  const scheduler = new ProbeScheduler(settings, { checker });
  t.after(async () => { await scheduler.stop(); db.closeDb(); });
  const source = sources.createSource({ name: 'Serial', url: 'https://serial.example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()));
  const node = health.getNodes(source.id)[0];
  const fast = scheduler.fastProbeNow(node.id);
  scheduler.enqueueCheck({ sourceId: source.id, pipeline: true });
  await fast;
  await scheduler.idle();
  assert.equal(maximum, 1, 'two probes for one node must never overlap');
  assert.equal(health.getNode(node.id).status, 'healthy');
  assert.equal(health.getNode(node.id).probe_profile, 'full');
});
