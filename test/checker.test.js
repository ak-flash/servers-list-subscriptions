const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const https = require('https');
const fs = require('fs');
const childProcess = require('child_process');
const net = require('net');
const { VpnChecker, evaluateTargets } = require('../src/services/vpnChecker');
const { loadConfig, snapshotProbeConfig } = require('../src/config/subscriptions');
const { SubscriptionError } = require('../src/utils/subscriptionErrors');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const health = require('../src/services/subscriptionHealth');
const { saveAssignments } = require('../src/services/subscriptionAssignments');
const { resolveUserSubscription } = require('../src/services/subscriptionResolver');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { config, link } = require('./fixtures');

function attempt(success, latencyMs = 10, errorCode = 'probe_timeout') {
  return { outcome: success ? 'success' : 'failure', latencyMs, httpStatus: success ? 204 : null, errorCode: success ? null : errorCode };
}

test('all three primary attempts run independently and their median is used without fallback', async () => {
  const calls = [];
  const result = await evaluateTargets(loadConfig({}), async (target, number) => {
    calls.push([target.id, number]);
    return attempt(true, [300, 10, 200][number - 1]);
  });
  assert.deepEqual(calls, [['primary', 1], ['primary', 2], ['primary', 3]]);
  assert.equal(result.status, 'healthy');
  assert.equal(result.successCount, 3);
  assert.equal(result.attemptCount, 3);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.latencyMs, 200);
  assert.equal(result.targetId, 'primary');
  assert.equal(result.errorCode, null);
});

test('a two-of-three primary majority completes its cycle and does not use fallback', async () => {
  const result = await evaluateTargets(config(), async (target, number) => {
    assert.equal(target.id, 'primary');
    return attempt(number !== 3, number === 3 ? 9999 : number * 100);
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.successCount, 2);
  assert.equal(result.attemptCount, 3);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.latencyMs, 150);
});

test('fallback runs a complete cycle after insufficient primary success and keeps measurements separate', async () => {
  const result = await evaluateTargets(config(), async (target, number) => {
    return attempt(target.id === 'fallback' ? number !== 3 : number === 1,
      target.id === 'fallback' ? number * 100 : 9999, 'unexpected_http_status');
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.latencyMs, 150);
  assert.equal(result.targetId, 'fallback');
  assert.equal(result.targetPriority, 1);
  assert.equal(result.successCount, 2);
  assert.equal(result.attemptCount, 3);
  assert.equal(result.attempts.length, 6);
  assert.deepEqual(result.attempts.map(item => [item.targetId, item.attempt]), [
    ['primary', 1], ['primary', 2], ['primary', 3], ['fallback', 1], ['fallback', 2], ['fallback', 3]
  ]);
});

test('one transient success on each target stays degraded rather than combining into a majority', async () => {
  const result = await evaluateTargets(config(), async (target, number) => attempt(number === 1, target.id === 'primary' ? 25 : 1));
  assert.equal(result.status, 'degraded');
  assert.equal(result.targetId, 'primary');
  assert.equal(result.successCount, 1);
  assert.equal(result.attemptCount, 3);
  assert.equal(result.attempts.length, 6);
  assert.equal(result.latencyMs, 25);
  assert.equal(result.errorCode, 'probe_timeout');
});

test('healthy verdict respects the configured threshold and reports actual selected attempts', async () => {
  const result = await evaluateTargets(config({ minSuccess: 3 }), async (_target, number) => attempt(number < 3));
  assert.equal(result.status, 'degraded');
  assert.equal(result.successCount, 2);
  assert.equal(result.attemptCount, result.attempts.filter(item => item.targetId === result.targetId).length);
  assert.equal(result.attempts.length, 6);
});

test('zero successes report offline or test_failed from the selected target, without mixing failures', async () => {
  const offline = await evaluateTargets(config(), async () => attempt(false));
  assert.equal(offline.status, 'offline');
  assert.equal(offline.successCount, 0);
  assert.equal(offline.attemptCount, 3);
  assert.equal(offline.latencyMs, null);
  assert.equal(offline.attempts.length, 6);
  const failed = await evaluateTargets(config(), async () => attempt(false, 10, 'unexpected_body'));
  assert.equal(failed.status, 'test_failed');
  assert.equal(failed.errorCode, 'unexpected_body');
  const separate = await evaluateTargets(config(), async target => attempt(false, 10,
    target.id === 'primary' ? 'probe_timeout' : 'unexpected_http_status'));
  assert.equal(separate.targetId, 'primary');
  assert.equal(separate.status, 'offline');
});

test('aborts before and during a target cycle do not return a partial healthy verdict or run fallback', async () => {
  const reason = new SubscriptionError('cancelled');
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(reason);
  let calls = 0;
  await assert.rejects(evaluateTargets(config(), async () => { calls++; return attempt(true); }, alreadyAborted.signal), error => error === reason);
  assert.equal(calls, 0);

  for (const abortAt of [1, 3]) {
    const controller = new AbortController();
    calls = 0;
    await assert.rejects(evaluateTargets(config(), async (target, number) => {
      assert.equal(target.id, 'primary');
      calls++;
      if (number === abortAt) controller.abort(reason);
      return attempt(true);
    }, controller.signal), error => error === reason);
    assert.equal(calls, abortAt);
  }
});

test('abort interrupts an outstanding attempt even when its request stub does not handle the signal', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const reason = new SubscriptionError('superseded');
  const pending = evaluateTargets(config(), () => { started.resolve(); return response.promise; }, controller.signal);
  await started.promise;
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  response.resolve(attempt(true));
});

test('production config flows from a complete probe through stored health into the subscription', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const settings = loadConfig({});
  assert.equal(settings.attempts, 3);
  assert.equal(settings.minSuccess, 2);
  assert.equal(config().attempts, settings.attempts);
  assert.equal(config().minSuccess, settings.minSuccess);
  db.run("INSERT INTO users (id, username) VALUES ('u', 'User')");
  const source = sources.createSource({ name: 'Production probe', url: 'https://example.com', is_active: true }, settings);
  sources.applySnapshot(source, parseSubscription(link()));
  saveAssignments('u', { sources: [source.id] });
  const node = health.getNodes(source.id)[0];
  const now = Date.now();
  const result = await evaluateTargets(settings, async (_target, number) => attempt(true, number * 10));
  health.markStarted(node, 'majority', now - 2);
  assert.equal(health.recordResult(node, 'majority', { ...result, checkedAddress: '8.8.8.8' }, settings, null, now - 1), true);
  assert.equal(health.eligibility(health.getNode(node.id), settings, now), 'healthy');
  assert.deepEqual(resolveUserSubscription('u', now, settings).servers.map(server => server.host), [node.host]);

  const transient = await evaluateTargets(settings, async (_target, number) => attempt(number === 1));
  health.markStarted(node, 'transient', now);
  assert.equal(health.recordResult(node, 'transient', { ...transient, checkedAddress: '8.8.8.8' }, settings, null, now + 1), true);
  assert.equal(health.eligibility(health.getNode(node.id), settings, now + 2), 'degraded');
  assert.equal(resolveUserSubscription('u', now + 2, settings).servers.length, 0);
});

test('checker passes its immutable start config to binary verification and the additional proxy cycle', async t => {
  // Stub local process/HTTPS I/O, so this race needs neither Xray nor a network listener.
  t.mock.method(fs.promises, 'mkdir', async () => {});
  t.mock.method(fs.promises, 'mkdtemp', async () => '/tmp/opencode/probe-config-test');
  const written = [];
  t.mock.method(fs.promises, 'writeFile', async (filename, content) => { written.push({ filename, config: JSON.parse(content) }); });
  t.mock.method(fs.promises, 'rm', async () => {});
  t.mock.method(net, 'createServer', () => {
    const server = new EventEmitter();
    server.listen = (_port, _host, ready) => queueMicrotask(ready);
    server.address = () => ({ port: 32100 });
    server.close = closed => queueMicrotask(closed);
    return server;
  });
  t.mock.method(net, 'connect', () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.setTimeout = () => {};
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  const spawned = [];
  const children = [];
  t.mock.method(childProcess, 'spawn', binary => {
    spawned.push(binary);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = 123000 + children.length;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit')); };
    children.push(child);
    return child;
  });
  t.mock.method(process, 'kill', pid => { children.find(child => child.pid === Math.abs(pid)).kill(); });
  t.mock.method(https, 'get', (_url, _options, receive) => {
    const req = new EventEmitter();
    queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = 204;
      receive(res);
      res.emit('end');
    });
    return req;
  });
  // vpnChecker captures spawn at import time; reload only for this fully stubbed test.
  const checkerPath = require.resolve('../src/services/vpnChecker');
  const originalModule = require.cache[checkerPath];
  delete require.cache[checkerPath];
  t.after(() => { require.cache[checkerPath] = originalModule; });
  const { VpnChecker: StubbedChecker } = require(checkerPath);
  const initial = config({ httpProxy: { protocol: 'http', address: 'proxy.example.com', port: 3128, user: 'old-user', pass: 'old-pass' } });
  const supplied = snapshotProbeConfig(initial);
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const checker = new StubbedChecker(config({ httpProxyMode: 'only', xrayPath: '/new/xray' }), {
    resolveHost: async () => ({ address: '8.8.8.8', family: 4 })
  });
  let verifiedConfig;
  checker.verifyBinary = async captured => { verifiedConfig = captured; started.resolve(); await resume.promise; };
  let proxyConfig;
  checker.runProxyCycle = async (_parsed, _address, _signal, captured) => { proxyConfig = captured; return { status: 'healthy' }; };
  const parsed = parseSubscription(link()).nodes[0];
  const pending = checker.check({ normalized_config_json: JSON.stringify(parsed.config) }, { config: supplied });
  await started.promise;
  initial.httpProxy.pass = 'changed-pass';
  initial.httpProxyMode = 'only';
  checker.config = config({ httpProxy: null });
  resume.resolve();
  const result = await pending;
  assert.equal(result.status, 'healthy');
  assert.equal(result.successCount, 3);
  assert.equal(result.proxy.status, 'healthy');
  assert.equal(proxyConfig, verifiedConfig);
  assert.equal(proxyConfig.httpProxyMode, 'extra');
  assert.equal(proxyConfig.httpProxy.pass, 'old-pass');
  assert.ok(Object.isFrozen(proxyConfig));
  assert.ok(Object.isFrozen(proxyConfig.targets[0]));
  assert.ok(Object.isFrozen(proxyConfig.httpProxy));
  assert.deepEqual(spawned, [supplied.xrayPath]);
  assert.equal(checker.active.size, 0);
  assert.equal(children[0].exitCode, 0);

  // The real additional-cycle implementation must also use that supplied config,
  // not the newer checker.config (which no longer has a proxy).
  const proxyResult = await StubbedChecker.prototype.runProxyCycle.call(checker, parsed.config,
    { address: '8.8.8.8' }, undefined, supplied);
  assert.equal(proxyResult.status, 'healthy');
  assert.equal(proxyResult.successCount, 3);
  assert.deepEqual(spawned, [supplied.xrayPath, supplied.xrayPath]);
  const chained = written.at(-1).config.outbounds.find(outbound => outbound.tag === 'probe-http-proxy');
  assert.deepEqual(chained.settings.servers[0].users, [{ user: 'old-user', pass: 'old-pass' }]);
  assert.equal(children[1].exitCode, 0);
});

test('checker abort keeps cancellation semantics and removes its active run', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const checker = new VpnChecker(config());
  checker.verifyBinary = async () => { started.resolve(); await resume.promise; };
  const pending = checker.check({}, { signal: controller.signal });
  await started.promise;
  controller.abort(new SubscriptionError('cancelled'));
  const result = await pending;
  resume.resolve();
  assert.equal(result.status, 'cancelled');
  assert.equal(result.errorCode, 'cancelled');
  assert.deepEqual(result.attempts, []);
  assert.equal(checker.active.size, 0);
});
