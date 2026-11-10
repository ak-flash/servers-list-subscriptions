const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateScore, calculateStability } = require('../src/utils/probeScore');

test('score rewards reliable low latency probes', () => {
  const good = calculateScore({ latencyMs: 50, throughputBps: 2 * 1024 * 1024, successfulAttempts: 3, totalAttempts: 3, stability: 1 });
  const bad = calculateScore({ latencyMs: 1500, throughputBps: 64 * 1024, successfulAttempts: 0, totalAttempts: 3, stability: 0 });
  assert.ok(good > bad);
  assert.ok(good <= 100 && bad >= 0);
});

test('a bodyless target with unknown throughput is neutral, not a zero-speed penalty', () => {
  const unknown = calculateScore({ latencyMs: 40, throughputBps: null, successfulAttempts: 3, totalAttempts: 3, stability: 0.95 });
  const zero = calculateScore({ latencyMs: 40, throughputBps: 0, successfulAttempts: 3, totalAttempts: 3, stability: 0.95 });
  assert.equal(unknown, zero);
  assert.ok(unknown > 60);
});

test('stability combines success rate with latency jitter', () => {
  const steady = calculateStability({ latencies: [20, 21, 19, 20], successfulAttempts: 4, totalAttempts: 4 });
  const jittery = calculateStability({ latencies: [20, 300, 45, 900], successfulAttempts: 4, totalAttempts: 4 });
  const partial = calculateStability({ latencies: [20, 21], successfulAttempts: 1, totalAttempts: 3 });
  assert.ok(steady > jittery);
  assert.ok(steady > 0.7);
  assert.ok(partial < steady);
  assert.ok(partial >= 0 && partial <= 1);
  assert.equal(calculateStability({ latencies: [], successfulAttempts: 0, totalAttempts: 0 }), 0);
});
