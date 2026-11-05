const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const health = require('../src/services/subscriptionHealth');
const { saveAssignments } = require('../src/services/subscriptionAssignments');
const { parseSubscription } = require('../src/utils/subscriptionParser');
const { app, subscriptionConfig } = require('../src/index');
const { UUID } = require('./fixtures');

test('imported links reach both /join responses unchanged except for names, never using probe IPs or user credentials', async t => {
  await db.initDb({ filePath: ':memory:' });
  db.run("INSERT INTO users (id, username) VALUES ('original-links-user', 'Original links')");
  const source = sources.createSource({ name: 'Source / name', url: 'https://source.example.com', is_active: true }, subscriptionConfig);
  const vmess = { v: '2', ps: 'VMess', add: 'vmess.example.com', port: '443', id: UUID, aid: '0', net: 'ws', type: 'none',
    tls: 'tls', sni: 'tls.example.com', host: 'ws.example.com', path: '/ws', fp: 'chrome', custom: { preserve: true } };
  const vmessQuery = '?fp=firefox&custom=a%2fb+value&custom=&empty';
  const links = [
    `vless://${UUID}@VLESS.Example.com:0443?type=ws&security=tls&encryption=none&sni=TLS.Example.com&path=%2fws%3Fed%3D2048&host=WS.Example.com#VLESS`,
    'Trojan://original%40password@trojan.example.com:443/?security=tls&sni=TLS.Example.com&fp=firefox&type=tcp#Trojan',
    'hysteria2://original%2Fpassword@hysteria.example.com:443?security=tls&sni=TLS.Example.com&alpn=h3#Hysteria',
    'Vmess://' + Buffer.from(JSON.stringify(vmess)).toString('base64') + vmessQuery
  ];
  const snapshot = parseSubscription(links.join('\n'));
  assert.equal(snapshot.report.supported, links.length);
  sources.applySnapshot(source, snapshot);
  saveAssignments('original-links-user', { sources: [source.id], source_limits: { [source.id]: '20' } });
  const now = Date.now();
  const nodes = health.getNodes(source.id);
  for (const [index, node] of nodes.entries()) {
    assert.equal(node.raw_link, links.find(link => link === node.raw_link));
    health.markStarted(node, node.id, now - 200);
    health.recordResult(node, node.id, { status: 'healthy', successCount: subscriptionConfig.attempts, attemptCount: subscriptionConfig.attempts,
      targetId: 'primary', targetPriority: 0, latencyMs: 50, checkedAddress: `198.51.100.${index + 1}`, httpStatus: 204, attempts: [] }, subscriptionConfig, null, now - 100);
  }
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.closeDb(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/join/original-links-user`);
  assert.equal(response.status, 200);
  const raw = await response.text();
  const emitted = Buffer.from(raw, 'base64').toString('utf8').split('\n').filter(line => !line.startsWith('#'));
  assert.equal(emitted.length, links.length);
  const jsonResponse = await fetch(`${base}/join/original-links-user/json`);
  assert.equal(jsonResponse.status, 200);
  const json = await jsonResponse.json();
  assert.equal(json.raw, raw);
  assert.deepEqual(json.servers.map(server => server.link), emitted);
  for (const node of nodes) {
    const item = json.servers.find(server => server.id === node.id);
    assert.ok(item);
    const name = `${source.name} - ${node.name}`;
    assert.equal(item.name, name);
    if (node.protocol === 'vmess') {
      assert.equal(item.link.slice(0, 8), 'Vmess://');
      assert.deepEqual(JSON.parse(Buffer.from(item.link.slice(8).split('?')[0], 'base64').toString('utf8')), { ...vmess, ps: name });
      assert.equal(item.link.slice(item.link.indexOf('?')), vmessQuery);
    } else {
      assert.equal(item.link, `${node.raw_link.split('#')[0]}#${encodeURIComponent(name)}`);
    }
    assert.ok(!item.link.includes('198.51.100.'));
  }
});
