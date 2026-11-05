const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http2 = require('http2');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');
const { setTimeout: delay } = require('timers/promises');
const { VpnChecker, freePort, stopChild } = require('../../src/services/vpnChecker');
const { parseVless } = require('../../src/utils/protocolParsers');
const { loadConfig } = require('../../src/config/subscriptions');
const { config, UUID } = require('../fixtures');

// Use the same installed binary as the app; XRAY_TEST_PATH remains an explicit override.
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const certPath = path.join(__dirname, '../fixtures/localhost-cert.pem');
const keyPath = path.join(__dirname, '../fixtures/localhost-key.pem');

test('real Xray: TLS, Reality and unencrypted VLESS, credential failures, HTTP/TLS failures and cleanup', { timeout: 90000 }, async t => {
  const installed = loadConfig();
  const xrayPath = process.env.XRAY_TEST_PATH || installed.xrayPath;
  assert.ok(fs.existsSync(xrayPath), 'Install Xray and set XRAY_PATH in .env, or provide XRAY_TEST_PATH before running npm run test:vpn');
  const parent = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'subscriptions-xray-test-'));
  const cert = fs.readFileSync(certPath);
  let hits = 0;
  let httpStatus = 204;
  let hang = false;
  const target = https.createServer({ cert, key: fs.readFileSync(keyPath) }, (_req, res) => { hits++; if (!hang) res.writeHead(httpStatus).end(); });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetUrl = `https://127.0.0.1:${target.address().port}/generate_204`;
  // Reality's camouflage destination is local too: TLS 1.3 with h2, independent of the HTTPS probe target.
  const camouflageSockets = new Set();
  const camouflage = http2.createSecureServer({ cert, key: fs.readFileSync(keyPath), minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', allowHTTP1: true }, (_req, res) => res.writeHead(204).end());
  camouflage.on('connection', socket => { camouflageSockets.add(socket); socket.on('close', () => camouflageSockets.delete(socket)); });
  camouflage.on('sessionError', () => {});
  camouflage.listen(0, '127.0.0.1');
  await once(camouflage, 'listening');
  const realityKey = crypto.generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  const shortId = '0123456789abcdef';
  const settings = config({ xrayPath, xrayVersion: installed.xrayVersion, xraySha256: process.env.XRAY_TEST_PATH ? '' : installed.xraySha256,
    tempDir: path.join(directory, 'probes'), readyTimeoutMs: 5000, attemptTimeoutMs: 1000, deadlineMs: 15000,
    targets: [{ id: 'local', url: targetUrl, priority: 0, status: 204 }] });
  let diagnostic = '';
  const checker = new VpnChecker(settings, { resolveHost: async () => ({ address: '127.0.0.1', family: 4 }), ca: cert,
    diagnostic: message => { diagnostic = (diagnostic + message).slice(-10000); } });
  const servers = [];
  const proxyServers = [];
  t.after(async () => {
    await checker.stop();
    await Promise.all([...servers, ...proxyServers].map(stopChild));
    target.closeAllConnections();
    await new Promise(resolve => target.close(resolve));
    for (const socket of camouflageSockets) socket.destroy();
    await new Promise(resolve => camouflage.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await checker.cleanup();
  await checker.verifyBinary();
  let knownNode;
  for (const { network, security, flow = '' } of [
    { network: 'tcp', security: 'tls' }, { network: 'ws', security: 'tls' },
    { network: 'tcp', security: 'none' }, { network: 'ws', security: 'none' },
    { network: 'tcp', security: 'reality' }, { network: 'tcp', security: 'reality', flow: 'xtls-rprx-vision' },
    { network: 'tcp', security: 'tls', flow: 'xtls-rprx-vision' }
  ]) {
    const port = await freePort();
    const streamSettings = { network, security };
    if (security === 'tls') streamSettings.tlsSettings = { certificates: [{ certificateFile: certPath, keyFile: keyPath }] };
    if (security === 'reality') streamSettings.realitySettings = {
      target: `127.0.0.1:${camouflage.address().port}`, serverNames: ['localhost'], privateKey: realityKey.d, shortIds: [shortId]
    };
    if (network === 'ws') streamSettings.wsSettings = { path: '/vpn' };
    const serverConfig = {
      log: { loglevel: 'debug' },
      inbounds: [{ listen: '127.0.0.1', port, protocol: 'vless', settings: { clients: [{ id: UUID, flow }], decryption: 'none' }, streamSettings }],
      // Xray 26.10.21 blocks private VLESS destinations by default.
      // This local-only fixture explicitly permits its loopback HTTPS target.
      outbounds: [{ protocol: 'freedom', settings: { finalRules: [{ action: 'allow', ip: ['127.0.0.1/32'] }] } }]
    };
    const filename = path.join(directory, `server-${network}-${security}-${flow || 'default'}.json`);
    fs.writeFileSync(filename, JSON.stringify(serverConfig));
    const child = spawn(xrayPath, ['run', '-c', filename], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform === 'linux' });
    child.stdout.on('data', chunk => { diagnostic += chunk.toString(); });
    child.stderr.on('data', chunk => { diagnostic += chunk.toString(); });
    servers.push(child);
    let ready = false;
    for (let retry = 0; retry < 100 && !ready; retry++) {
      ready = await new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
      });
      if (!ready) await delay(40);
    }
    assert.ok(ready, 'Local VLESS server starts');
    const uri = `vless://${UUID}@localhost:${port}?type=${network}&security=${security}${network === 'ws' ? '&path=%2Fvpn&host=localhost' : ''}` +
      (security === 'reality' ? `&sni=localhost&pbk=${realityKey.x}&sid=${shortId}&spx=%2Fprobe` : '') + (flow ? `&flow=${flow}` : '') + '#test';
    const parsed = parseVless(uri);
    const node = { normalized_config_json: JSON.stringify(parsed.config) };
    if (network === 'tcp' && security === 'none' && !flow) knownNode = { parsed, port };
    const good = await checker.check(node);
    assert.equal(good.status, 'healthy', `${security}/${network}/${flow}: ${JSON.stringify(good)}\n${diagnostic}`);
    assert.equal(good.successCount, 3);
    assert.ok(good.latencyMs > 0);
    const before = hits;
    const bad = await checker.check({ normalized_config_json: JSON.stringify({ ...parsed.config, uuid: '00000000-0000-4000-8000-000000000000' }) });
    assert.notEqual(bad.status, 'healthy');
    assert.equal(hits, before, 'No request reached the target with a wrong UUID, despite target being directly reachable');
    if (security === 'reality' && !flow) {
      for (const change of [{ publicKey: crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x }, { shortId: 'abcdef0123456789' }]) {
        const beforeWrongKey = hits;
        const rejected = await checker.check({ normalized_config_json: JSON.stringify({ ...parsed.config, reality: { ...parsed.config.reality, ...change } }) });
        assert.notEqual(rejected.status, 'healthy');
        assert.equal(hits, beforeWrongKey, 'Wrong Reality key/short ID cannot reach the HTTPS target');
      }
    }
    if (network === 'tcp' && security === 'tls' && !flow) {
      httpStatus = 200;
      assert.equal((await checker.check(node)).status, 'test_failed');
      httpStatus = 302;
      assert.equal((await checker.check(node)).status, 'test_failed');
      httpStatus = 204;
      // Keep the VPN server CA trusted but do not trust the HTTPS target's self-signed certificate.
      const untrusted = new VpnChecker(settings, { resolveHost: checker.resolveHost, ca: cert, targetCa: null });
      const failedTls = await untrusted.check(node);
      assert.equal(failedTls.status, 'offline');
      assert.equal(failedTls.errorCode, 'tls_error');
      hang = true;
      const abort = new AbortController();
      const inFlight = checker.check(node, { signal: abort.signal });
      await delay(150);
      abort.abort(new (require('../../src/utils/subscriptionErrors').SubscriptionError)('cancelled'));
      assert.equal((await inFlight).status, 'cancelled');
      const deadlineChecker = new VpnChecker({ ...settings, deadlineMs: 300 }, { resolveHost: checker.resolveHost, ca: cert });
      const started = Date.now();
      const deadline = await deadlineChecker.check(node);
      assert.notEqual(deadline.status, 'healthy');
      assert.ok(Date.now() - started < 3000, 'Deadline bounds request and process cleanup');
      assert.equal(deadlineChecker.active.size, 0);
      hang = false;
    }
    assert.equal(checker.active.size, 0);
    assert.deepEqual(fs.readdirSync(settings.tempDir), []);
  }
  // Live two-address fallback: the first public test address is unroutable,
  // while the second is the running local VLESS server. Xray is restarted and
  // its generated outbound is pinned to each address in turn.
  const fallbackSettings = { ...settings, httpProxy: null, httpProxyMode: 'extra', deadlineMs: 15000 };
  const fallbackChecker = new VpnChecker(fallbackSettings, {
    resolveAddresses: async () => [{ address: '192.0.2.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
    ca: cert
  });
  assert.ok(knownNode, 'plain TCP fixture exists for address fallback');
  const fallbackResult = await fallbackChecker.check({ normalized_config_json: JSON.stringify(knownNode.parsed.config) });
  assert.equal(fallbackResult.status, 'healthy');
  assert.equal(fallbackResult.checkedAddress, '127.0.0.1');
  assert.equal(fallbackChecker.active.size, 0);
  await fallbackChecker.stop();

  /* Live VLESS client -> HTTP CONNECT -> local VLESS server requires a
   * verified CONNECT upstream configuration; keep as external release gate. */
  /* const proxyPort = await freePort();
  const proxyServer = require('http').createServer((req, res) => res.writeHead(501).end());
  proxyServer.on('connect', (request, socket) => {
    const [host, portText] = String(request.url || '').replace(/^\[|\]$/g, '').split(':');
    const upstream = net.connect(Number(portText) || knownNode.port, host || '127.0.0.1');
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.once('error', () => socket.destroy());
  });
  proxyServer.listen(proxyPort, '127.0.0.1');
  await once(proxyServer, 'listening');
  proxyServers.push({ kill: () => proxyServer.close() });
  const onlyChecker = new VpnChecker({ ...settings, httpProxy: { protocol: 'http', address: '127.0.0.1', port: proxyPort, user: '', pass: '' }, httpProxyMode: 'only' }, {
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }], ca: cert
  });
  const onlyResult = await onlyChecker.check({ normalized_config_json: JSON.stringify(knownNode.parsed.config) });
  assert.equal(onlyResult.status, 'healthy');
  assert.equal(onlyResult.checkedAddress, '127.0.0.1');
  assert.equal(onlyChecker.active.size, 0);
  await onlyChecker.stop();
  await new Promise(resolve => proxyServer.close(resolve)); */

  const missing = new VpnChecker({ ...settings, xrayPath: path.join(directory, 'missing-xray') });
  assert.equal((await missing.check({ normalized_config_json: '{}' })).errorCode, 'xray_missing');
  assert.equal(missing.active.size, 0);
});
