const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVless, serializeVless } = require('../src/utils/protocolParsers');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { buildXrayConfig } = require('../src/utils/xrayConfigBuilder');
const { UUID, link } = require('./fixtures');

test('VLESS canonical identity, original UUID, IPv6, Unicode name and WS round-trip', () => {
  const a = parseVless(link('EXAMPLE.com', '&sni=example.com', 'Первый'));
  const b = parseVless(`vless://${UUID}@example.com:443?type=raw&security=tls#%D0%94%D1%80%D1%83%D0%B3%D0%BE%D0%B9`);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, parseVless(link().replace(UUID, '00000000-0000-4000-8000-000000000001')).fingerprint);
  const ws = parseVless(`vless://${UUID}@[2001:4860:4860::8888]:443?type=ws&security=tls&sni=example.com&path=%2Fvpn%3Fed%3D2048&host=cdn.example.com&alpn=http%2F1.1&fp=chrome#%D0%95%D0%B2%D1%80%D0%BE%D0%BF%D0%B0`);
  assert.equal(ws.capability, 'supported');
  assert.equal(ws.name, 'Европа');
  assert.equal(ws.config.uuid, UUID);
  assert.equal(ws.config.ws.path, '/vpn?ed=2048');
  assert.deepEqual(parseVless(serializeVless(ws.config, ws.name)).config, ws.config);
});

test('unsupported connection parameters are retained and never silently discarded', () => {
  for (const extra of ['&type=grpc', '&security=reality', '&pbk=secret', '&unknown=required']) {
    const raw = link().replace('&type=tcp', '').replace('&security=tls', '') + '';
    const uri = raw.split('#')[0] + '&type=tcp&security=tls' + extra + '#x';
    if (extra.startsWith('&type=') || extra.startsWith('&security=')) {
      assert.throws(() => parseVless(uri)); // Ambiguous duplicated query parameters.
    } else {
      assert.equal(parseVless(uri).capability, 'unsupported');
    }
  }
  assert.equal(parseVless(link().replace('security=tls', 'security=reality')).capability, 'invalid'); // pbk is required.
  assert.equal(parseVless(link().replace('type=tcp', 'type=grpc')).capability, 'unsupported');
  assert.equal(parseVless(link('example.com', '&allowInsecure=1')).capability, 'unsupported');
  for (const raw of [link().replace(UUID, 'bad'), link().replace(':443', ':70000'), link() + '%XX', link().replace('#', '&sni=a&sni=b#')]) {
    assert.throws(() => parseVless(raw), { code: 'invalid_link' });
  }
});

test('Reality parameters are validated, included in identity and mapped to the pinned Xray version', () => {
  const publicKey = Buffer.alloc(32, 7).toString('base64url');
  const uri = `vless://${UUID}@vpn.example.com:443?encryption=none&type=raw&security=reality&sni=cover.example.com&flow=xtls-rprx-vision&pbk=${publicKey}&sid=A1B2&spx=%2Fcheck%3Ffoo%3Dbar#Reality`;
  const parsed = parseVless(uri);
  assert.equal(parsed.capability, 'supported');
  assert.equal(parsed.config.fingerprint, 'chrome');
  assert.deepEqual(parsed.config.reality, { publicKey, shortId: 'a1b2', spiderX: '/check?foo=bar', mldsa65Verify: '' });
  assert.deepEqual(parseVless(serializeVless(parsed.config, parsed.name)).config, parsed.config);
  assert.equal(parseVless(uri.replace('&sid=A1B2', '&sid=a1b2').replace('&flow=', '&fp=chrome&flow=')).fingerprint, parsed.fingerprint);
  assert.notEqual(parseVless(uri.replace(publicKey, Buffer.alloc(32, 8).toString('base64url'))).fingerprint, parsed.fingerprint);
  assert.notEqual(parseVless(uri.replace('sid=A1B2', 'sid=A1B3')).fingerprint, parsed.fingerprint);
  const built = buildXrayConfig(parsed.config, '8.8.8.8', 12000, { user: 'test', password: 'test' });
  assert.equal(built.outbounds.length, 1);
  assert.equal(built.outbounds[0].settings.vnext[0].address, '8.8.8.8');
  assert.equal(built.outbounds[0].settings.vnext[0].users[0].id, UUID);
  assert.equal(built.outbounds[0].settings.vnext[0].users[0].flow, 'xtls-rprx-vision');
  assert.deepEqual(built.outbounds[0].streamSettings.realitySettings, {
    serverName: 'cover.example.com', fingerprint: 'chrome', password: publicKey, shortId: 'a1b2', spiderX: '/check?foo=bar'
  });
  assert.equal(built.outbounds[0].streamSettings.tlsSettings, undefined);
  for (const invalid of [uri.replace(publicKey, 'bad-key'), uri.replace(publicKey, publicKey + '='), uri.replace('sid=A1B2', 'sid=abc'),
    uri.replace('sid=A1B2', 'sid=123456789012345678'), uri.replace('spx=%2Fcheck%3Ffoo%3Dbar', 'spx=bad')]) {
    const result = parseVless(invalid);
    assert.equal(result.capability, 'invalid');
    assert.throws(() => buildXrayConfig(result.config, '8.8.8.8', 12000, { user: 'test', password: 'test' }), { code: 'invalid_link' });
  }
  const pqv = Buffer.alloc(1952, 1).toString('base64url');
  const postQuantum = parseVless(uri.replace('#Reality', `&pqv=${pqv}#Reality`));
  assert.equal(postQuantum.capability, 'supported');
  assert.equal(buildXrayConfig(postQuantum.config, '8.8.8.8', 12000, { user: 'test', password: 'test' }).outbounds[0].streamSettings.realitySettings.mldsa65Verify, pqv);
  assert.equal(parseVless(uri.replace('type=raw', 'type=ws')).capability, 'unsupported');
});

test('VLESS security=none supports TCP/WS without adding TLS and rejects Vision without TLS/Reality', () => {
  for (const network of ['tcp', 'ws']) {
    const parsed = parseVless(link().replace('security=tls', 'security=none').replace('type=tcp', `type=${network}`));
    assert.equal(parsed.capability, 'supported');
    assert.deepEqual(parseVless(serializeVless(parsed.config, parsed.name)).config, parsed.config);
    const stream = buildXrayConfig(parsed.config, '8.8.8.8', 12000, { user: 'test', password: 'test' }).outbounds[0].streamSettings;
    assert.equal(stream.security, 'none');
    assert.equal(stream.tlsSettings, undefined);
    assert.equal(stream.realitySettings, undefined);
  }
  assert.equal(parseVless(link().replace('security=tls&', '')).config.security, 'none');
  assert.equal(parseVless(link('vpn.example.com', '&flow=xtls-rprx-vision').replace('security=tls', 'security=none')).capability, 'unsupported');
});

test('plain, Base64/Base64URL, BOM, CRLF, duplicates, partial and limits', () => {
  const plain = `\uFEFF#profile-title: test\r\n${link()}\r\n${link()}\r\n${link('other.example.com')}`;
  for (const input of [plain, Buffer.from(plain).toString('base64'), Buffer.from(plain).toString('base64url')]) {
    const result = parseSubscription(input);
    assert.equal(result.nodes.length, 2);
    assert.equal(result.report.duplicates, 1);
    assert.equal(result.complete, true);
  }
  assert.equal(parseSubscription(link() + '\ninvalid').complete, false);
  assert.throws(() => parseSubscription(plain, { maxNodes: 2 }), { code: 'too_many_nodes' });
  for (const raw of ['', '<html>Error</html>', 'e30=', '!!!!', 'abcd=', 'proxies:\n  - name: test']) {
    assert.throws(() => parseSubscription(raw));
  }
});
