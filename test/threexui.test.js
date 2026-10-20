const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/database');
const threeXui = require('../src/services/threeXui');

function resetDatabase() {
  db.closeDb();
}

test('3x-ui panels persist safely and store client/inbound traffic from API responses', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(resetDatabase);

  const panel = threeXui.createPanel({
    name: 'Основная панель',
    base_url: 'https://panel.example.com/secret-path/?token=drop#fragment',
    token: 'api-token',
    sync_interval_seconds: '60',
    is_active: '1'
  });

  assert.equal(panel.base_url, 'https://panel.example.com/secret-path/');
  assert.equal(panel.sync_interval_seconds, 60);

  threeXui.updatePanel(panel.id, {
    name: 'Панель Европа',
    base_url: 'https://panel.example.com/secret-path',
    token: 'new-api-token',
    sync_interval_seconds: '120',
    is_active: '1'
  });

  const saved = threeXui.getPanel(panel.id);
  assert.equal(saved.name, 'Панель Европа');
  assert.equal(saved.token, 'new-api-token');

  db.run("INSERT INTO users (id, username, is_active) VALUES ('u1', 'alice', 1)");

  db.transaction(() => {
    db.upsertThreeXuiInboundTraffic(panel.id, {
      id: 7,
      remark: 'VLESS-443',
      tag: 'in-443-tcp',
      protocol: 'vless',
      port: 443,
      up: 100,
      down: 400,
      total: 1000
    });
    db.upsertThreeXuiClientTraffic(panel.id, 'alice', 100, 400, 1000, '2026-01-01T00:00:00.000Z');
    db.upsertThreeXuiInboundClientTraffic(panel.id, 7, 'alice', 100, 400, 1000, '2026-01-01T00:00:00.000Z');
  });

  assert.deepEqual(db.getThreeXuiClientTraffic('alice'), {
    total_upload: 100,
    total_download: 400,
    total_traffic: 1000,
    updated_at: '2026-01-01T00:00:00.000Z'
  });

  const clients = db.getThreeXuiUsersTraffic();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].user_id, 'u1');
  assert.equal(clients[0].panel_name, 'Панель Европа');

  const connections = db.getThreeXuiInboundClientTraffic();
  assert.equal(connections.length, 1);
  assert.equal(connections[0].remark, 'VLESS-443');
  assert.equal(connections[0].tag, 'in-443-tcp');

  assert.throws(() => threeXui.createPanel({ name: 'x', base_url: 'ftp://panel.example.com', token: 'token' }), /HTTP или HTTPS/);
  assert.throws(() => threeXui.createPanel({ name: 'x', base_url: 'https://panel.example.com', token: '' }), /API token/);
});
