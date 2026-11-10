const test = require('node:test');
const assert = require('node:assert/strict');
const { subscriptionPreview } = require('../src/services/subscriptionResolver');

test('subscription preview exposes probe diagnostics', () => {
  const result = subscriptionPreview({ user: null, sources: [], resolved_at: 1, servers: [{
    id: 'node-1', name: 'node', origin: 'source', host: 'example.com', port: 443,
    latency_ms: 20, probe_profile: 'full', score: 91, throughput_bps: 1000,
    fast_status: 'reachable', fast_latency_ms: 5, fast_checked_at: 10,
    service_gates: [{ passed: true }], stability: 0.9
  }] });
  assert.deepEqual(result.servers[0].probe_profile, 'full');
  assert.equal(result.servers[0].score, 91);
  assert.equal(result.servers[0].throughput_bps, 1000);
  assert.equal(result.servers[0].fast_status, 'reachable');
  assert.equal(result.servers[0].fast_latency_ms, 5);
  assert.equal(result.servers[0].fast_checked_at, 10);
  assert.deepEqual(result.servers[0].service_gates, [{ passed: true }]);
  assert.equal(result.servers[0].stability, 0.9);
});
