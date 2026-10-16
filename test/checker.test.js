const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateTargets } = require('../src/services/vpnChecker');
const { config } = require('./fixtures');

test('cycle majority and median are calculated for one target, fallback measurements are kept separate', async () => {
  const settings = config();
  const result = await evaluateTargets(settings, async (target, attempt) => ({
    outcome: target.id === 'fallback' && attempt < 3 ? 'success' : 'failure',
    latencyMs: target.id === 'fallback' ? attempt * 100 : 9999,
    httpStatus: target.id === 'fallback' && attempt < 3 ? 204 : 500,
    errorCode: 'unexpected_http_status'
  }));
  assert.equal(result.status, 'healthy');
  assert.equal(result.latencyMs, 150);
  assert.equal(result.targetId, 'fallback');
  assert.equal(result.attempts.length, 6);
  const degraded = await evaluateTargets(settings, async (_target, attempt) => ({
    outcome: attempt === 1 ? 'success' : 'failure', latencyMs: 10, httpStatus: attempt === 1 ? 204 : null, errorCode: 'probe_timeout'
  }));
  assert.equal(degraded.status, 'degraded');
});
