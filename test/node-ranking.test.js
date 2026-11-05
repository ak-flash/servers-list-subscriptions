const { test } = require('node:test');
const assert = require('node:assert/strict');
const health = require('../src/services/subscriptionHealth');
const { config } = require('./fixtures');

test('checked address key canonicalizes IPv4-mapped IPv6', () => {
  assert.equal(health.checkedAddressKey({ checked_address: '::FFFF:198.51.100.1' }), '198.51.100.1');
  assert.equal(health.checkedAddressKey({ checked_address: '198.51.100.1' }), '198.51.100.1');
});

function node(settings, overrides = {}) {
  return { id: 'node', name: 'Node', source_active: 1, capability_status: 'supported', is_present: 1, is_enabled: 1,
    generation: 1, health_generation: 1, fingerprint: 'node-fingerprint', config_fingerprint: 'node-fingerprint',
    probe_profile_version: settings.profileVersion, status: 'healthy', successful_attempts: settings.attempts,
    total_attempts: settings.attempts, target_priority: 0, latency_ms: 50, checked_address: '198.51.100.1', last_checked_at: 100000,
    ...overrides };
}

const now = 100001;

test('node ranking prioritizes current eligibility, then reliability, target and latency with stable ties', () => {
  const settings = config();
  const ranked = [
    node(settings, { id: 'unreliable', successful_attempts: settings.minSuccess, latency_ms: 1 }),
    node(settings, { id: 'fallback', target_priority: 1, latency_ms: 1 }),
    node(settings, { id: 'reliable', latency_ms: 100 }),
    node(settings, { id: 'quick-reliable', latency_ms: 90 })
  ];
  const unavailable = [
    { id: 'offline', status: 'offline', latency_ms: 0 },
    { id: 'degraded', status: 'degraded', latency_ms: 0 },
    { id: 'stale', last_checked_at: now - settings.healthyTtlMs },
    { id: 'future', last_checked_at: now + 1 },
    { id: 'disabled', is_enabled: 0 },
    { id: 'removed', is_present: 0 },
    { id: 'unsupported', capability_status: 'unsupported' },
    { id: 'changed-config', config_fingerprint: 'old' },
    { id: 'changed-generation', health_generation: 0 },
    { id: 'changed-profile', probe_profile_version: 'old' },
    { id: 'unchecked-address', checked_address: null },
    { id: 'source-disabled', source_active: 0 }
  ].map(overrides => node(settings, { latency_ms: 0, ...overrides }));
  const all = [...unavailable, ...ranked];
  const expected = ['quick-reliable', 'reliable', 'fallback', 'unreliable'];
  for (const input of [all, all.toReversed()]) {
    const sorted = input.sort((a, b) => health.compareNodes(a, b, settings, now));
    assert.deepEqual(sorted.slice(0, 4).map(node => node.id), expected);
    assert.ok(sorted.slice(4).every(node => health.eligibility(node, settings, now) !== 'healthy'));
  }
  const a = node(settings, { id: 'a', fingerprint: 'aaa', config_fingerprint: 'aaa' });
  const b = node(settings, { id: 'b', fingerprint: 'bbb', config_fingerprint: 'bbb' });
  assert.ok(health.compareNodes(a, b, settings, now) < 0);
  assert.ok(health.compareNodes(b, a, settings, now) > 0);
  assert.equal(health.compareNodes(a, a, settings, now), 0);
});

test('rankNodes marks only healthy nodes with a unique checked address as deliverable', () => {
  const settings = config();
  const first = node(settings, { id: 'first', name: 'First', checked_address: '198.51.100.1' });
  const duplicate = node(settings, { id: 'duplicate', name: 'Duplicate', checked_address: '198.51.100.1', latency_ms: 100 });
  const offline = node(settings, { id: 'offline', name: 'Offline', status: 'offline', checked_address: '198.51.100.2' });
  const ranked = health.rankNodes([duplicate, offline, first], settings, now);
  assert.deepEqual(ranked.map(node => node.id), ['first', 'duplicate', 'offline']);
  assert.deepEqual(ranked.map(node => node.delivery_candidate), [true, false, false]);
  assert.equal(first.delivery_candidate, undefined);
});

test('proxy ranking only prefers fresh successes from the current profile; extra failures do not veto direct health', () => {
  const settings = config({ httpProxy: { protocol: 'http', address: 'proxy.example.com', port: 3128 }, httpProxyMode: 'extra' });
  const direct = node(settings, { id: 'direct', latency_ms: 20 });
  const fresh = node(settings, { id: 'fresh', proxy_status: 'healthy', proxy_latency_ms: 300, proxy_checked_at: now - 1, proxy_checked_address: '198.51.100.1' });
  assert.ok(health.compareNodes(fresh, direct, settings, now) < 0);
  const invalid = [
    { proxy_checked_at: now - settings.healthyTtlMs },
    { proxy_checked_at: now + 1 },
    { proxy_checked_at: null },
    { proxy_latency_ms: -1 },
    { proxy_latency_ms: null },
    { proxy_status: 'offline' },
    { proxy_status: 'degraded' }
  ];
  for (const overrides of invalid) {
    const candidate = { ...fresh, proxy_latency_ms: 1, ...overrides };
    assert.notEqual(health.proxyEligibility(candidate, settings, now), 'proxy_ok');
    assert.equal(health.eligibility(candidate, settings, now), 'healthy');
    assert.ok(health.compareNodes(direct, candidate, settings, now) < 0);
  }
  assert.equal(health.proxyEligibility({ ...fresh, probe_profile_version: 'old' }, settings, now), 'proxy_unknown');
  for (const overrides of [{ httpProxy: null }, { httpProxyMode: 'only' }]) {
    const noExtra = { ...settings, ...overrides };
    assert.equal(health.proxyEligibility(fresh, noExtra, now), 'not_required');
    assert.ok(health.compareNodes(direct, fresh, noExtra, now) < 0);
  }
});

test('healthy labels cannot override incomplete or corrupt probe counts', () => {
  const settings = config();
  for (const overrides of [
    { successful_attempts: 1 }, { successful_attempts: null }, { successful_attempts: NaN },
    { successful_attempts: 4 }, { successful_attempts: 2.5 }, { total_attempts: 2 },
    { latency_ms: -1 }, { latency_ms: null }
  ]) assert.equal(health.eligibility(node(settings, overrides), settings, now), 'unknown');
  assert.equal(health.eligibility(node(settings, { checked_address: ' ' }), settings, now), 'unknown_address');
});
