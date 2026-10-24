const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVless, serializeVless } = require('../src/utils/protocolParsers');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { buildXrayConfig } = require('../src/utils/xrayConfigBuilder');
const { UUID, link } = require('./fixtures');

test('Hysteria2 subscription links are parsed', () => {
  const raw = 'hysteria2://46785352-db89-4839-8079-d4c69ad87996@80.90.189.93:443?sni=rugiig.cryposikel.ru#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20%5B%2ACIDR%5D';
  const parsed = parseSubscription(raw);
  assert.equal(parsed.report.supported, 1);
  assert.equal(parsed.nodes[0].protocol, 'hysteria2');
  assert.equal(parsed.nodes[0].config.password, '46785352-db89-4839-8079-d4c69ad87996');
  assert.equal(parsed.nodes[0].config.sni, 'rugiig.cryposikel.ru');
  assert.equal(parsed.nodes[0].name, '🇩🇪 Germany [*CIDR]');
  const built = buildXrayConfig(parsed.nodes[0].config, '80.90.189.93', 12000, { user: 'test', password: 'test' });
  assert.equal(built.outbounds[0].protocol, 'hysteria');
  assert.equal(built.outbounds[0].streamSettings.network, 'hysteria');
  assert.deepEqual(built.outbounds[0].settings, { version: 2, address: '80.90.189.93', port: 443 });
  assert.deepEqual(built.outbounds[0].streamSettings.hysteriaSettings, { auth: parsed.nodes[0].config.password });
});

test('VLESS XHTTP accepts downloadSettings', () => {
  const raw = 'Vless://9c5ad05d-d807-0031-bf48-cfad48af6dec@135.106.142.209:443?type=xhttp&headerType=none&security=reality&encryption=none&sni=alfastat.ru&pbk=fz_xpZfQks3oa9c_d1OSokmTgmJuGbvFMkyK0Qt8w3I&sid=0066a7326f06d426&path=%2Fassets&mode=packet-up&extra=%7B%22xmux%22%3A+%7B%22cMaxReuseTimes%22%3A+0%2C+%22maxConnections%22%3A+%221-2%22%2C+%22hKeepAlivePeriod%22%3A+0%2C+%22hMaxRequestTimes%22%3A+%22900-1400%22%2C+%22hMaxReusableSecs%22%3A+%223600-5400%22%7D%2C+%22downloadSettings%22%3A+%7B%22port%22%3A+443%2C+%22address%22%3A+%22135.106.142.209%22%2C+%22network%22%3A+%22xhttp%22%2C+%22security%22%3A+%22reality%22%2C+%22xhttpSettings%22%3A+%7B%22path%22%3A+%22%2Fassets%22%7D%2C+%22realitySettings%22%3A+%7B%22shortId%22%3A+%2275a0c0e236b0a436%22%2C%22publicKey%22%3A+%22fz_xpZfQks3oa9c_d1OSokmTgmJuGbvFMkyK0Qt8w3I%22%2C%22serverName%22%3A+%22seo.alfastat.ru%22%2C%22fingerprint%22%3A+%22firefox%22%7D%7D%7D&fp=ios#Sweden';
  const parsed = parseSubscription(raw);
  assert.equal(parsed.report.supported, 1);
  const settings = buildXrayConfig(parsed.nodes[0].config, '135.106.142.209', 12000, { user: 'test', password: 'test' }).outbounds[0].streamSettings.xhttpSettings;
  assert.equal(settings.downloadSettings.address, '135.106.142.209');
  assert.equal(settings.downloadSettings.xhttpSettings.path, '/assets');
});

test('VLESS Reality TCP accepts packetEncoding=xudp', () => {
  const raw = 'Vless://9a0e84f8-4b58-477f-99da-5fac5a2e58e8@3f8efdt.fi1.h1clayd.click:443?security=reality&type=tcp&packetEncoding=xudp&sni=3f8efdt.fi1.h1clayd.click&sid=023a1e6ffc32be10&pbk=1D_o1pqfVoReg9zLPKNy1wCL7aGWytbmbYPbbJGaozY&fp=firefox#%F0%9F%87%AB%F0%9F%87%AE%20Finland%20%5B%2ACIDR%5D';
  const parsed = parseSubscription(raw);
  assert.equal(parsed.report.supported, 1);
  assert.equal(parsed.nodes[0].capability, 'supported');
  assert.equal(parsed.nodes[0].config.extra.packetEncoding, undefined);
});

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
  assert.equal(parseVless(link().replace('type=tcp', 'type=grpc')).capability, 'supported');
  assert.equal(parseVless(link('example.com', '&allowInsecure=1')).capability, 'supported');
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

test('VLESS subscription nodes accept Reality TCP links with host parameter', () => {
  const raw = 'vless://36fb6650-8a50-42b5-9f66-06538806f32c@de15.h1cloud.net:25362?type=tcp&security=reality&pbk=hFee7zTreqlv_wccK_8zxN5v23hj9u-DshByvGf-KAA&sid=23732d14a527990d&sni=www.chip.de&host=www.chip.de&fp=firefox#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20%5B%2ACIDR%5D';
  const parsed = parseSubscription(raw);
  assert.equal(parsed.report.supported, 1);
  assert.equal(parsed.nodes[0].name, '🇩🇪 Germany [*CIDR]');
  assert.equal(parsed.nodes[0].config.extra.host, undefined);
});

test('VLESS XHTTP with Reality preserves transport settings and builds Xray config', () => {
  const raw = 'Vless://1e2b9c0c-4f9b-56f5-a062-1c4f2d2aa200@84.201.180.13:443?encryption=none&extra=null&fp=safari&host=api-maps.yandex.ru&pbk=DuxQy3KWEZTU_sBhXSfeo_1Q0-0lMcSnx21bWvUi5hQ&security=reality&sni=api-maps.yandex.ru&type=xhttp#%F0%9F%87%B3%F0%9F%87%B1%20The%20Netherlands%20%E2%80%94%20%23117';
  const parsed = parseVless(raw);
  assert.equal(parsed.capability, 'supported');
  assert.equal(parsed.name, '🇳🇱 The Netherlands — #117');
  assert.deepEqual(parsed.config.xhttp, { host: 'api-maps.yandex.ru', path: '/', mode: 'auto', extra: null });
  assert.equal(parsed.config.reality.publicKey, 'DuxQy3KWEZTU_sBhXSfeo_1Q0-0lMcSnx21bWvUi5hQ');
  assert.deepEqual(parseVless(serializeVless(parsed.config, parsed.name)).config, parsed.config);
  const built = buildXrayConfig(parsed.config, '84.201.180.13', 12000, { user: 'test', password: 'test' });
  assert.deepEqual(built.outbounds[0].streamSettings.xhttpSettings, { host: 'api-maps.yandex.ru', path: '/', mode: 'auto' });
  assert.equal(built.outbounds[0].streamSettings.network, 'xhttp');
  assert.equal(built.outbounds[0].streamSettings.realitySettings.password, parsed.config.reality.publicKey);
  assert.equal(parseVless(raw.replace('type=xhttp', 'type=grpc')).capability, 'unsupported');
  const richExtra = { xPaddingBytes: '100-1000', xPaddingObfsMode: false, xPaddingKey: '', xPaddingHeader: '', xPaddingPlacement: '', xPaddingMethod: '', uplinkHTTPMethod: '', sessionIDPlacement: '', sessionIDKey: '', sessionIDTable: '', sessionIDLength: '0', seqPlacement: '', seqKey: '', uplinkDataPlacement: '', uplinkDataKey: '', uplinkChunkSize: '0', noGRPCHeader: false, noSSEHeader: false, scMaxEachPostBytes: '0', scMinPostsIntervalMs: '0', scMaxBufferedPosts: 0, scStreamUpServerSecs: '0', serverMaxHeaderBytes: 0, xmux: { maxConcurrency: '16-32', maxConnections: '0', cMaxReuseTimes: '64-128', hMaxRequestTimes: '0', hMaxReusableSecs: '0', hKeepAlivePeriod: 0 }, downloadSettings: null, extra: null };
  const rich = parseVless(raw.replace('extra=null', `extra=${encodeURIComponent(JSON.stringify(richExtra))}`));
  assert.equal(rich.capability, 'supported');
  assert.deepEqual(rich.config.xhttp.extra.xmux, richExtra.xmux);
  const richConfig = buildXrayConfig(rich.config, '84.201.180.13', 12000, { user: 'test', password: 'test' });
  assert.equal(typeof richConfig.outbounds[0].streamSettings.xhttpSettings.extra, 'object');
  assert.equal(richConfig.outbounds[0].streamSettings.xhttpSettings.xPaddingBytes, '100-1000');
  assert.equal(richConfig.outbounds[0].streamSettings.xhttpSettings.xmux.maxConcurrency, richExtra.xmux.maxConcurrency);
  assert.equal(richConfig.outbounds[0].streamSettings.xhttpSettings.xmux.cMaxReuseTimes, richExtra.xmux.cMaxReuseTimes);
  assert.deepEqual(rich.config.alpn, []);
  assert.throws(() => parseVless(raw.replace('extra=null', 'extra=%7Bbad%7D')), { code: 'invalid_link' });
  const invalidExtra = parseVless(raw.replace('extra=null', 'extra=%7B%22downloadSettings%22%3A%7B%7D%7D'));
  assert.equal(invalidExtra.capability, 'invalid');
});

test('VLESS gRPC with Reality preserves serviceName and multi mode', () => {
  const raw = 'Vless://03ca8c3f-e777-45b5-a1b1-592094ca99ee@82.202.178.132:443?encryption=none&fp=chrome&mode=multi&pbk=1A9loATtqTbKfErpj24clMebWdbmBRDgUIADwtlvtAw&security=reality&serviceName=google.storage.v2.Storage&sid=70c20a2f5a7d542e&sni=mobile-api-12.sova.toys&type=grpc#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20%E2%80%94%20%23167';
  const parsed = parseVless(raw);
  assert.equal(parsed.capability, 'supported');
  assert.equal(parsed.name, '🇩🇪 Germany — #167');
  assert.deepEqual(parsed.config.grpc, { serviceName: 'google.storage.v2.Storage', mode: 'multi' });
  assert.deepEqual(parseVless(serializeVless(parsed.config, parsed.name)).config, parsed.config);
  const built = buildXrayConfig(parsed.config, '82.202.178.132', 12000, { user: 'test', password: 'test' });
  assert.deepEqual(built.outbounds[0].streamSettings.grpcSettings, { serviceName: 'google.storage.v2.Storage', multiMode: true });
  assert.equal(built.outbounds[0].streamSettings.realitySettings.password, parsed.config.reality.publicKey);
  assert.equal(parseVless(raw.replace('serviceName=google.storage.v2.Storage', 'serviceName=')).capability, 'supported');
  const emptyServiceName = parseVless('vless://1bb2af63-4472-44ed-9c70-8f316258b68b@62.152.58.90:443?encryption=none&fp=random&mode=gun&pbk=JBKJlzuJH1YzDHAoz28wEKbzWTGpDpKjgtSq0oT0a0k&security=reality&sid=27e53bbcab7593d7&sni=360.yandex.ru&type=grpc#Poland');
  assert.equal(emptyServiceName.capability, 'supported');
  assert.deepEqual(emptyServiceName.config.grpc, { serviceName: '', mode: 'gun' });
});

test('VLESS gRPC Reality with TCP fragment FinalMask is preserved and accepted by Xray', () => {
  const fm = { tcp: [{ type: 'fragment', settings: { delays: ['10-20'], lengths: ['122', '2-3', '2-3', '2-3'], maxSplit: '5', packets: 'tlshello' } }], udp: null, quicParams: null };
  const raw = `Vless://ebc90732-ab04-4cfa-8a19-c15c5c8f37d8@194.55.239.113:443?encryption=none&fm=${encodeURIComponent(JSON.stringify(fm))}&fp=firefox&mode=gun&pbk=1vSZjvhZO01oAEH3b7eebR1qF5dLU1Dq2E7xu8pwGSs&security=reality&serviceName=grpc-vk&sid=428ef87fd47a3a33&sni=api-maps.yandex.ru&spx=%2F&type=grpc#test`;
  const parsed = parseVless(raw);
  assert.equal(parsed.capability, 'supported');
  assert.deepEqual(parsed.config.finalmask, fm);
  assert.deepEqual(parseVless(serializeVless(parsed.config, parsed.name)).config.finalmask, fm);
  const built = buildXrayConfig(parsed.config, '194.55.239.113', 12000, { user: 'test', password: 'test' });
  assert.equal(built.outbounds[0].streamSettings.finalmask.tcp[0].type, 'fragment');
  assert.deepEqual(built.outbounds[0].streamSettings.finalmask.tcp[0].settings, { packets: 'tlshello', length: '122', delay: '10-20', maxSplit: '5' });
  assert.deepEqual(built.outbounds[0].streamSettings.grpcSettings, { serviceName: 'grpc-vk', multiMode: false });
  assert.equal(parseVless(raw.replace('packets%22%3A%22tlshello', 'packets%22%3A%22bad')).capability, 'unsupported');
});

test('VLESS HTTPUpgrade with TLS preserves host/path and builds Xray config', () => {
  const raw = 'vless://6eca8bc3-c4e1-48d1-bf15-1eb016dd6272@178.176.128.128:443?encryption=none&fp=firefox&host=edge3.statiqedge.com&path=%2Fassets%2Fv1&security=tls&sni=edge3.statiqedge.com&type=httpupgrade#%F0%9F%87%B3%F0%9F%87%B1%20The%20Netherlands%20%E2%80%94%20%2394';
  const parsed = parseVless(raw);
  assert.equal(parsed.capability, 'supported');
  assert.equal(parsed.name, '🇳🇱 The Netherlands — #94');
  assert.deepEqual(parsed.config.httpupgrade, { host: 'edge3.statiqedge.com', path: '/assets/v1' });
  assert.deepEqual(parseVless(serializeVless(parsed.config, parsed.name)).config, parsed.config);
  const built = buildXrayConfig(parsed.config, '178.176.128.128', 12000, { user: 'test', password: 'test' });
  assert.equal(built.outbounds[0].streamSettings.network, 'httpupgrade');
  assert.deepEqual(built.outbounds[0].streamSettings.httpupgradeSettings, { host: 'edge3.statiqedge.com', path: '/assets/v1' });
  assert.equal(built.outbounds[0].streamSettings.tlsSettings.serverName, 'edge3.statiqedge.com');
  assert.equal(parseVless(raw.replace('path=%2Fassets%2Fv1', 'path=assets')).capability, 'unsupported');
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

test('buildXrayConfig dials the node through the configured HTTP proxy', () => {
  const node = parseVless(link()).config;
  const credentialed = buildXrayConfig(node, '8.8.8.8', 12000, { user: 'test', password: 'test' },
    null, { protocol: 'http', address: 'proxy.example.com', port: 3128, user: 'puser', pass: 'ppass' });
  assert.equal(credentialed.outbounds.length, 2);
  assert.equal(credentialed.outbounds[1].tag, 'probe-http-proxy');
  assert.equal(credentialed.outbounds[1].protocol, 'http');
  assert.deepEqual(credentialed.outbounds[1].settings.servers[0], { address: 'proxy.example.com', port: 3128, users: [{ user: 'puser', pass: 'ppass' }] });
  assert.equal(credentialed.outbounds[1].streamSettings, undefined);
  assert.equal(credentialed.outbounds[0].streamSettings.sockopt.dialerProxy, 'probe-http-proxy');
  assert.equal(credentialed.routing.rules[0].outboundTag, 'probe-vpn');
  const authless = buildXrayConfig(node, '8.8.8.8', 12000, { user: 'test', password: 'test' },
    null, { protocol: 'https', address: '10.0.0.2', port: 443, user: '', pass: '' });
  assert.equal('users' in authless.outbounds[1].settings.servers[0], false);
  assert.equal(authless.outbounds[1].streamSettings.security, 'tls');
  assert.equal(authless.outbounds[1].streamSettings.tlsSettings.serverName, '10.0.0.2');
  const plain = buildXrayConfig(node, '8.8.8.8', 12000, { user: 'test', password: 'test' });
  assert.equal(plain.outbounds.length, 1);
  assert.equal(plain.outbounds[0].streamSettings.sockopt, undefined);
});
