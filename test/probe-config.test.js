const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const db = require('../src/db/database');
const { loadConfig, parseHttpProxy, probeProfileVersion, snapshotProbeConfig, PROBE_POLICY_VERSION } = require('../src/config/subscriptions');
const { applySettingsToConfig, applyProxyToConfig, saveSettings } = require('../src/services/proxySettings');

test('production policy requires two of three attempts and invalidates old first-success profiles', () => {
  const config = loadConfig({});
  assert.equal(config.attempts, 3);
  assert.equal(config.minSuccess, 2);
  assert.equal(PROBE_POLICY_VERSION, 3);
  const oldHash = attempts => crypto.createHash('sha256').update(JSON.stringify({
    adapter: 2, version: config.xrayVersion, targets: config.targets, location: config.probeLocation,
    attempts, minSuccess: attempts === 2 ? 1 : 2, timeout: config.attemptTimeoutMs, proxy: ''
  })).digest('hex');
  assert.notEqual(config.profileVersion, oldHash(2));
  assert.notEqual(config.profileVersion, oldHash(3));
  assert.equal(config.profileVersion, probeProfileVersion(config));
});

test('env and runtime settings share a secret-sensitive profile hash', () => {
  const proxyUrl = 'https://probe-user:probe-pass@proxy.example.com:3128';
  const fromEnv = loadConfig({ PROBE_HTTP_PROXY: proxyUrl, PROBE_HTTP_PROXY_MODE: 'only' });
  const fromRuntime = applyProxyToConfig(loadConfig({}), { proxy: parseHttpProxy(proxyUrl), mode: 'only' });
  assert.equal(fromEnv.profileVersion, fromRuntime.profileVersion);
  assert.match(fromEnv.profileVersion, /^[a-f0-9]{64}$/);
  assert.ok(!fromEnv.profileVersion.includes('probe-user'));
  assert.ok(!fromEnv.profileVersion.includes('probe-pass'));
  for (const proxy of [
    { ...fromEnv.httpProxy, user: 'different-user' },
    { ...fromEnv.httpProxy, pass: 'different-pass' },
    { ...fromEnv.httpProxy, address: 'other.example.com' },
    { ...fromEnv.httpProxy, port: 3129 },
    { ...fromEnv.httpProxy, protocol: 'http' },
    null
  ]) {
    assert.notEqual(applyProxyToConfig(fromEnv, { proxy, mode: 'only' }).profileVersion, fromEnv.profileVersion);
  }
  assert.notEqual(applyProxyToConfig(fromEnv, { proxy: fromEnv.httpProxy, mode: 'extra' }).profileVersion, fromEnv.profileVersion);
});

test('every outcome-affecting target, threshold, timeout, and location change invalidates cached checks', () => {
  const config = loadConfig({});
  const changes = [
    { attempts: 4 }, { minSuccess: 3 },
    { readyTimeoutMs: 6000 }, { attemptTimeoutMs: 6000 }, { deadlineMs: 60000 },
    { xrayVersion: '26.11.1' }, { xraySha256: 'f'.repeat(64) }, { probeLocation: 'other-host' },
    ...['url', 'status', 'body', 'priority', 'id'].map(field => ({
      targets: config.targets.map((target, index) => index ? target : { ...target, [field]: {
        url: 'https://other.example.com/ping', status: 200, body: 'ok', priority: 2, id: 'changed'
      }[field] })
    }))
  ];
  for (const change of changes) assert.notEqual(probeProfileVersion({ ...config, ...change }), config.profileVersion, JSON.stringify(change));
  assert.equal(probeProfileVersion({ ...config, concurrency: 8, maxQueued: 10 }), config.profileVersion);
});

test('probe snapshots detach and freeze nested target and proxy configuration', () => {
  const config = {
    ...loadConfig({ PROBE_HTTP_PROXY: 'http://before:secret@proxy.example.com:3128' }),
    targets: [{ id: 'test', url: 'https://example.com/test', status: 204, priority: 0 }],
    httpProxy: { protocol: 'http', address: 'proxy.example.com', port: 3128, user: 'before', pass: 'secret' }
  };
  const snapshot = snapshotProbeConfig(config);
  config.targets[0].status = 500;
  config.targets.push({ id: 'extra' });
  config.httpProxy.user = 'after';
  config.httpProxyMode = 'only';
  assert.equal(snapshot.targets[0].status, 204);
  assert.equal(snapshot.targets.length, 1);
  assert.equal(snapshot.httpProxy.user, 'before');
  assert.equal(snapshot.httpProxyMode, 'extra');
  for (const value of [snapshot, snapshot.targets, snapshot.targets[0], snapshot.httpProxy]) assert.ok(Object.isFrozen(value));
  const loaded = loadConfig({ PROBE_HTTP_PROXY: 'http://proxy.example.com:3128' });
  for (const value of [loaded, loaded.targets, loaded.targets[0], loaded.httpProxy]) assert.ok(Object.isFrozen(value));
});

test('applying stored settings preserves the full configured deadline and rehashes changed timeouts', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const config = loadConfig({});
  const unchanged = applySettingsToConfig(config);
  assert.equal(unchanged.deadlineMs, 40000);
  assert.equal(unchanged.profileVersion, config.profileVersion);
  const explicit = loadConfig({ PROBE_DEADLINE_SECONDS: '75' });
  assert.equal(applySettingsToConfig(explicit).deadlineMs, 75000);
  saveSettings({ readyTimeoutSeconds: 7, attemptTimeoutSeconds: 8 }, config);
  const changed = applySettingsToConfig(config);
  assert.equal(changed.readyTimeoutMs, 7000);
  assert.equal(changed.attemptTimeoutMs, 8000);
  assert.equal(changed.deadlineMs, config.deadlineMs);
  assert.notEqual(changed.profileVersion, config.profileVersion);
  assert.equal(changed.profileVersion, probeProfileVersion(changed));
  assert.ok(Object.isFrozen(changed.targets));
});

test('without an explicit deadline, settings budget all targets and readiness within timeout bounds', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const config = { ...loadConfig({}), deadlineMs: undefined };
  assert.equal(applySettingsToConfig(config).deadlineMs, 35000);
  saveSettings({ readyTimeoutSeconds: 30, attemptTimeoutSeconds: 30 }, config);
  assert.equal(applySettingsToConfig(config).deadlineMs, 180000);
  for (const values of [{ readyTimeoutSeconds: 31 }, { attemptTimeoutSeconds: 0 }]) {
    assert.throws(() => saveSettings(values, config));
  }
  assert.throws(() => loadConfig({ PROBE_DEADLINE_SECONDS: '181' }));
  assert.throws(() => loadConfig({ PROBE_DEADLINE_SECONDS: '4' }));
});
