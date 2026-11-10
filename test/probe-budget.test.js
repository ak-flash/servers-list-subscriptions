const { test } = require('node:test');
const assert = require('node:assert/strict');
const { probeBudget, probeDeadlineMs } = require('../src/utils/probeBudget');
const { loadConfig } = require('../src/config/subscriptions');

test('budget includes two address cycles, readiness retries and optional extra cycle', () => {
  const base = { ...loadConfig({}), readyTimeoutMs: 1000, attemptTimeoutMs: 1000, deadlineMode: 'auto' };
  const direct = probeBudget(base);
  const extra = probeBudget({ ...base, httpProxy: {}, httpProxyMode: 'extra' });
  const only = probeBudget({ ...base, httpProxy: {}, httpProxyMode: 'only' });
  assert.equal(direct.requiredMs, 5000 + 2 * (3000 + 1000 * base.attempts * base.targets.length));
  assert.equal(only.requiredMs, direct.requiredMs);
  assert.ok(extra.requiredMs > direct.requiredMs);
});
test('legacy numeric limits remain unchanged and auto cap is explicit in diagnostics', () => {
  const base = { ...loadConfig({}), readyTimeoutMs: 30000, attemptTimeoutMs: 30000 };
  assert.equal(probeBudget({ ...base, deadlineMode: 'explicit', deadlineMs: 40000 }).deadlineMs, 40000);
  const auto = probeBudget({ ...base, deadlineMode: 'auto' });
  assert.equal(auto.deadlineMs, 180000);
  assert.equal(auto.constrained, true);
  assert.throws(() => probeBudget({ ...base, deadlineMode: 'explicit', deadlineMs: NaN }), /PROBE_DEADLINE_SECONDS/);
});
test('Fast and Full probes have independent absolute timeout caps', () => {
  const config = loadConfig({});
  assert.equal(config.fastProbeTimeoutMs, 6000);
  assert.equal(config.fullProbeTimeoutMs, 20000);
  assert.equal(probeDeadlineMs(config, 'fast'), 6000);
  assert.equal(probeDeadlineMs(config, 'full'), 20000);
  assert.equal(probeDeadlineMs({ ...config, deadlineMs: 5000 }, 'full'), 5000);
  assert.equal(probeDeadlineMs({ ...config, fullProbeTimeoutMs: 8000 }, 'full'), 8000);
  assert.equal(probeDeadlineMs({ ...config, fastProbeTimeoutMs: 3000, deadlineMs: 10000 }, 'fast'), 3000);
  assert.notEqual(probeDeadlineMs(config, 'full'), config.deadlineMs);
});
