const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter } = require('../src/utils/rateLimiter');

test('rate limiter enforces the limit inside a window and resets afterwards', () => {
  const limiter = new RateLimiter();
  const now = 1_000_000;
  assert.equal(limiter.hit('a', 1000, 2, now), true);
  assert.equal(limiter.hit('a', 1000, 2, now), true);
  assert.equal(limiter.hit('a', 1000, 2, now), false);
  assert.equal(limiter.hit('a', 1000, 2, now + 1001), true);
});

test('rate limiter drops expired keys and never exceeds maxKeys', () => {
  const limiter = new RateLimiter({ maxKeys: 3 });
  const now = 5_000_000;
  for (let i = 0; i < 10; i++) limiter.hit(`key-${i}`, 60_000, 5, now);
  assert.equal(limiter.size, 3);
  assert.equal(limiter.entries.has('key-9'), true);
  limiter.prune(now + 61_000);
  assert.equal(limiter.size, 0);
});

test('rate limiter sweep timer is unrefed and can be stopped', () => {
  const limiter = new RateLimiter({ sweepIntervalMs: 10 }).start();
  assert.ok(limiter.sweepTimer);
  limiter.stop();
  assert.equal(limiter.sweepTimer, null);
});
