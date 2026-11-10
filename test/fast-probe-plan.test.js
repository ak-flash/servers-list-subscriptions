const test = require('node:test');
const assert = require('node:assert/strict');
const { VpnChecker } = require('../src/services/vpnChecker');
const { config } = require('./fixtures');

const node = { normalized_config_json: JSON.stringify({ protocol: 'vless', host: 'localhost', port: 1, network: 'ws', security: 'tls' }) };
const proxy = { protocol: 'http', address: 'proxy.example.com', port: 3128, user: 'u', pass: 'p' };

test('fast probe exposes a protocol-aware handshake plan', async () => {
  const checker = new VpnChecker(config());
  checker.resolveAddresses = async () => [{ address: '127.0.0.1' }];
  const result = await checker.fastProbe(node, { timeoutMs: 5 });
  assert.equal(result.handshakePlan.protocol, 'vless');
  assert.equal(result.handshakePlan.transport, 'ws');
  assert.equal(result.handshakePlan.requiresXray, true);
  assert.equal(result.profile, 'fast');
});

test('fast probe keeps a proxy-only policy and skips the extra proxy cycle', async () => {
  for (const [mode, expectedMode, expectedProxy] of [['only', 'only', proxy], ['extra', 'disabled', null]]) {
    const checker = new VpnChecker(config({ httpProxy: proxy, httpProxyMode: mode }));
    let captured;
    checker.check = async (_node, options) => {
      captured = options.config;
      return { profile: 'full', status: 'healthy', latencyMs: 12, checkedAddress: '198.51.100.1',
        serviceGates: [{ passed: true }], bytesTransferred: 0, throughputBps: null };
    };
    const result = await checker.fastProbe(node, { timeoutMs: 6000 });
    assert.equal(captured.httpProxyMode, expectedMode, mode);
    assert.deepEqual(captured.httpProxy, expectedProxy, mode);
    assert.equal(captured.targets.length, 1);
    assert.equal(captured.attempts, 1);
    assert.equal(captured.deadlineMs, 6000);
    assert.equal(result.status, 'reachable');
    assert.equal(result.serviceGates.length, 1);
  }
});
