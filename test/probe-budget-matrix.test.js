const { test } = require('node:test');
const assert = require('node:assert/strict');
const { probeBudget } = require('../src/utils/probeBudget');

test('address budget is shared, bounded, and extra adds one cycle', () => {
  const base = { readyTimeoutMs: 10000, attemptTimeoutMs: 10000, attempts: 3,
    targets: [{ id: 'a' }, { id: 'b' }], deadlineMode: 'auto', httpProxy: null };
  const noProxy = probeBudget(base);
  const only = probeBudget({ ...base, httpProxy: { address: 'proxy' }, httpProxyMode: 'only' });
  const extra = probeBudget({ ...base, httpProxy: { address: 'proxy' }, httpProxyMode: 'extra' });
  assert.equal(noProxy.requiredMs, only.requiredMs);
  assert.ok(extra.requiredMs > noProxy.requiredMs);
  assert.equal(noProxy.deadlineMs, 180000);
  assert.equal(noProxy.constrained, true);
  assert.ok(extra.requiredMs > 2 * (base.readyTimeoutMs * 3));
});

test('explicit deadline is never silently expanded for two addresses', () => {
  const config = { readyTimeoutMs: 1000, attemptTimeoutMs: 1000, attempts: 3,
    targets: [{ id: 'a' }], deadlineMode: 'explicit', deadlineMs: 5000, httpProxy: null };
  const budget = probeBudget(config);
  assert.equal(budget.deadlineMs, 5000);
  assert.equal(budget.constrained, true);
});
