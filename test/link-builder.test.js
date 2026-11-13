const { test } = require('node:test');
const assert = require('node:assert/strict');
const { effectiveLink, updateLinkRemark, buildFullSubscription, publicServer } = require('../src/utils/linkBuilder');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { parseVmess } = require('../src/utils/protocolParsers');
const { UUID } = require('./fixtures');

const newName = 'Источник / 🇷🇺 — узел #1 & тест';
const sourceServer = link => ({ id: 'source-node', name: newName, link, origin: 'source', credential_mode: 'original',
  user_server_uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', traffic_limit: 1, total_traffic: 999 });
const subscriptionLinks = server => Buffer.from(buildFullSubscription([server], 'user-id'), 'base64').toString('utf8').split('\n').filter(line => !line.startsWith('#'));

const uriLinks = [
  `vless://${UUID.toUpperCase()}@VPN.Example.com:0443/?type=raw&security=tls&encryption=none&sni=TLS.Example.com&alpn=h2%2chttp%2f1.1&fp=chrome&host=TCP.Example.com#original`,
  `VLESS://${UUID}@vpn.example.com:443?security=reality&type=tcp&encryption=none&sni=www.example.com&fp=chrome&pbk=${Buffer.alloc(32, 1).toString('base64url')}&sid=aB12&spx=%2fhello%3Fx%3D1&packetEncoding=xudp#original`,
  `vless://${UUID}@vpn.example.com:443?type=ws&security=tls&encryption=none&path=%2fwebsocket%3Fed%3D2048&host=WS.Example.com&headers=%7b%22X-Test%22%3a%22a%2Bb%22%7d#original`,
  'Trojan://p%40ss%3Aword%2F%25@vpn.example.com:443/?type=tcp&security=tls&sni=TLS.Example.com&insecure=1&fp=chrome#original',
  'hysteria2://p%40ss%3Aword@vpn.example.com:443?security=tls&sni=TLS.Example.com&alpn=h3&fp=firefox#original'
];

test('source URI output changes only the fragment name, never credentials, address, query spelling or parameter order', () => {
  for (const input of uriLinks) {
    for (const raw of [input, input.split('#')[0]]) {
      const imported = parseSubscription(raw).nodes[0];
      assert.equal(imported.capability, 'supported', `${raw}: ${imported.error}`);
      assert.equal(imported.rawLink, raw);
      const expected = `${raw.split('#')[0]}#${encodeURIComponent(newName)}`;
      const server = sourceServer(imported.rawLink);
      assert.equal(effectiveLink(server), expected);
      assert.equal(publicServer(server).link, expected);
      assert.deepEqual(subscriptionLinks(server), [expected]);
      assert.equal(updateLinkRemark(expected, newName), expected);
    }
  }
});

const vmessData = { v: '2', ps: 'Original node', add: 'VPN.Example.com', port: '00443', id: UUID.toUpperCase(), aid: '0',
  scy: 'auto', net: 'ws', type: 'none', tls: 'tls', alpn: 'h2,http/1.1', host: 'WS.Example.com', path: '/test?ed=2048',
  sni: 'TLS.Example.com', fp: 'chrome', custom: { array: [false, 0, null, 'unknown provider field'] } };
const vmessPayload = link => JSON.parse(Buffer.from(link.slice(8).split(/[?#]/)[0], 'base64').toString('utf8'));

test('VMess source output preserves every payload field except ps and retains query parameters verbatim', () => {
  for (const scheme of ['vmess://', 'Vmess://', 'VMESS://']) {
    for (const encoding of ['base64', 'base64url']) {
      for (const query of ['', '?fp=ios&custom=a%2fb+value&custom=&empty']) {
        const raw = scheme + Buffer.from(JSON.stringify(vmessData)).toString(encoding) + query;
        const imported = parseSubscription(raw).nodes[0];
        assert.equal(imported.capability, 'supported');
        assert.equal(imported.rawLink, raw);
        const server = sourceServer(raw);
        const output = effectiveLink(server);
        assert.equal(output.slice(0, 8), scheme);
        assert.deepEqual(vmessPayload(output), { ...vmessData, ps: newName });
        assert.equal(output.includes('?') ? output.slice(output.indexOf('?')) : '', query);
        assert.deepEqual(subscriptionLinks(server), [output]);
        const json = publicServer(server);
        assert.equal(json.link, output);
        assert.equal(json.name, newName);
        assert.equal(json.host, vmessData.add);
        assert.equal(json.uuid, vmessData.id);
        assert.equal(updateLinkRemark(output, newName), output);
      }
    }
  }
});

test('VMess query suffix survives repeated renaming even when followed by a fragment', () => {
  const raw = 'vmess://' + Buffer.from(JSON.stringify(vmessData)).toString('base64') + '?fp=ios&extra=a%2Fb#Original';
  const output = updateLinkRemark(raw, newName);
  assert.equal(output.slice(output.indexOf('?')), `?fp=ios&extra=a%2Fb#${encodeURIComponent(newName)}`);
  assert.deepEqual(vmessPayload(output), { ...vmessData, ps: newName });
  assert.equal(parseVmess(raw).config.fingerprint, 'ios');
  assert.deepEqual(parseVmess(output).config, parseVmess(raw).config);
  assert.equal(updateLinkRemark(output, newName), output);
  const fragmentName = 'vmess://' + Buffer.from(JSON.stringify(vmessData)).toString('base64') + '#fp=ios';
  assert.equal(parseVmess(fragmentName).config.fingerprint, 'chrome');
});

test('VMess renaming is lossless for raw JSON numbers, nested fields, escapes and duplicate keys', () => {
  const originalJson = '{ "ps" : "Old", "large":9007199254740993, "huge":1e400, "precise":0.12345678901234567890, "nested":{"ps":"Nested","array":[1,{"ps":"Keep"}]}, "duplicate":1, "duplicate":2, "escaped":"quote \\\" slash \\\\" }';
  const raw = 'vmess://' + Buffer.from(originalJson).toString('base64') + '?fp=ios';
  const output = updateLinkRemark(raw, newName);
  const json = Buffer.from(output.slice(8).split('?')[0], 'base64').toString('utf8');
  assert.equal(json, originalJson.replace('"Old"', JSON.stringify(newName)));
  assert.equal(updateLinkRemark(output, newName), output);
  for (const original of ['{}', '{ "add":"host","nested":{"ps":"Do not rename"} }']) {
    const renamed = updateLinkRemark('vmess://' + Buffer.from(original).toString('base64'), newName);
    const result = JSON.parse(Buffer.from(renamed.slice(8), 'base64').toString('utf8'));
    assert.deepEqual(result, { ...JSON.parse(original), ps: newName });
  }
  const duplicateNames = '{"ps":"First","nested":{"ps":"Keep"},"p\\u0073":"Last"}';
  const renamed = updateLinkRemark('vmess://' + Buffer.from(duplicateNames).toString('base64'), newName);
  const decoded = Buffer.from(renamed.slice(8), 'base64').toString('utf8');
  assert.equal(decoded, duplicateNames.replace('"First"', JSON.stringify(newName)).replace('"Last"', JSON.stringify(newName)));
});

test('manual UUID overrides still apply without leaking into original source credentials', () => {
  const raw = uriLinks[0];
  const original = sourceServer(raw);
  const manual = { ...original, origin: 'manual', credential_mode: 'user_override', traffic_limit: 0 };
  assert.equal(new URL(effectiveLink(original)).username, UUID.toUpperCase());
  assert.equal(new URL(effectiveLink(manual)).username, original.user_server_uuid);
});

test('traffic remark shows remaining over the total limit or remaining only', () => {
  const base = { ...sourceServer(uriLinks[0]), name: 'Node', origin: 'manual', credential_mode: 'user_override',
    traffic_limit: 10, total_traffic: 4 * 1024 ** 3 };
  const remark = server => decodeURIComponent(new URL(effectiveLink(server)).hash.slice(1));
  assert.equal(remark({ ...base, traffic_display: 'full' }), 'Node | 6.0/10 GB');
  assert.equal(remark(base), 'Node | 6.0/10 GB');
  assert.equal(remark({ ...base, traffic_display: 'remaining' }), 'Node | 6.0 GB');
  assert.equal(remark({ ...base, traffic_display: 'remaining', total_traffic: 12 * 1024 ** 3 }), 'Node | 0.0 GB');
  assert.equal(remark({ ...base, traffic_display: 'remaining', traffic_limit: 0 }), 'Node');
});

