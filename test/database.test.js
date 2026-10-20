const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const initSqlJs = require('sql.js');
const db = require('../src/db/database');

test('fresh database, nested rollback, persistence and cascading source/user deletion', async t => {
  const parent = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'subscriptions-db-'));
  const filePath = path.join(directory, 'test.db');
  t.after(() => { db.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
  await db.initDb({ filePath });
  assert.equal(db.get('SELECT count(*) AS n FROM schema_migrations').n, 7);
  db.transaction(() => {
    db.run('INSERT INTO users (id, username) VALUES (?, ?)', ['u', 'user']);
    assert.throws(() => db.transaction(() => {
      db.run('INSERT INTO users (id, username) VALUES (?, ?)', ['rollback', 'rollback']);
      throw new Error('rollback');
    }));
    db.run(`INSERT INTO subscription_sources (id, name, url, created_at, updated_at) VALUES ('s', 'source', 'https://example.com', 1, 1)`);
    db.run(`INSERT INTO user_subscription_sources (user_id, source_id, created_at, updated_at) VALUES ('u', 's', 1, 1)`);
  });
  assert.equal(db.get("SELECT id FROM users WHERE id = 'rollback'"), null);
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw Object.assign(new Error('Disk write failed'), { code: 'ENOSPC' }); };
    assert.throws(() => db.run("UPDATE users SET username = 'unsaved' WHERE id = 'u'"), /Disk write failed/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(db.get("SELECT username FROM users WHERE id = 'u'").username, 'user', 'Failed persistence restores the in-memory state too');
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
  db.closeDb();
  await db.initDb({ filePath });
  assert.equal(db.get('SELECT count(*) AS n FROM schema_migrations').n, 7);
  assert.equal(db.get('SELECT count(*) AS n FROM user_subscription_sources').n, 1);
  db.run("DELETE FROM users WHERE id = 'u'");
  assert.equal(db.get('SELECT count(*) AS n FROM user_subscription_sources').n, 0);
  assert.throws(() => db.run(`INSERT INTO user_subscription_sources (user_id, source_id, created_at, updated_at) VALUES ('missing', 's', 1, 1)`), /FOREIGN KEY/);
});

test('proxy probe results are stored alongside direct measurements', async t => {
  const parent = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'subscriptions-proxy-'));
  const filePath = path.join(directory, 'test.db');
  t.after(() => { db.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
  await db.initDb({ filePath });
  const { loadConfig } = require('../src/config/subscriptions');
  const health = require('../src/services/subscriptionHealth');
  const config = loadConfig({});
  const now = Date.now();
  db.run(`INSERT INTO subscription_sources (id, name, url, created_at, updated_at) VALUES ('s', 'source', 'https://example.com/sub', ?, ?)`, [now, now]);
  db.run(`INSERT INTO subscription_nodes (id, source_id, fingerprint, raw_link, name, protocol, capability_status, first_seen_at, last_seen_at)
    VALUES ('n', 's', 'fprint', 'vless://00000000-0000-4000-8000-000000000001@example.com:443?encryption=none&security=tls&type=tcp#node', 'node', 'vless', 'supported', ?, ?)`, [now, now]);
  const node = { id: 'n', fingerprint: 'fprint', generation: 1, source_revision: 1 };
  health.markStarted(node, 'cycle-1', now);
  const direct = [{ outcome: 'success', attempt: 1, latencyMs: 120, httpStatus: 204, targetId: 'primary' }];
  const applied = health.recordResult(node, 'cycle-1', {
    status: 'healthy', latencyMs: 120, attempts: direct, successCount: 1, attemptCount: 1,
    proxy: { status: 'healthy', latencyMs: 260, httpStatus: 204, attempts: [{ outcome: 'success', attempt: 1, latencyMs: 260, httpStatus: 204, targetId: 'primary' }] }
  }, config, null, now);
  assert.equal(applied, true);
  const row = health.getNode('n');
  assert.equal(row.proxy_status, 'healthy');
  assert.equal(row.proxy_latency_ms, 260);
  assert.equal(row.proxy_http_status, 204);
  assert.equal(row.proxy_checked_at, now);
  assert.deepEqual(db.all(`SELECT via, count(*) AS n FROM subscription_node_checks GROUP BY via ORDER BY via`),
    [{ via: 'direct', n: 1 }, { via: 'proxy', n: 1 }]);
  // A runner-level retry must keep the last proxy reading.
  health.markStarted(node, 'cycle-2', now + 1000);
  health.recordResult(node, 'cycle-2', { status: 'runner_error', errorCode: 'xray_missing', errorMessage: 'Xray не найден.', attempts: [] },
    config, null, now + 1000);
  const after = health.getNode('n');
  assert.equal(after.proxy_status, 'healthy');
});

test('backup retention removes backups older than the configured count', async t => {
  const parent = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'subscriptions-backups-'));
  const filePath = path.join(directory, 'test.db');
  const backupDirectory = path.join(directory, 'backups');
  const previousRetention = process.env.BACKUP_RETENTION_COUNT;
  process.env.BACKUP_RETENTION_COUNT = '2';
  t.after(() => {
    if (previousRetention === undefined) delete process.env.BACKUP_RETENTION_COUNT;
    else process.env.BACKUP_RETENTION_COUNT = previousRetention;
    db.closeDb();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await db.initDb({ filePath });
  db.closeDb();
  fs.mkdirSync(backupDirectory, { recursive: true });
  for (const date of ['2020-01-01', '2020-01-02', '2020-01-03']) fs.copyFileSync(filePath, path.join(backupDirectory, `subscription_${date}.db`));
  await db.initDb({ filePath });
  const backups = fs.readdirSync(backupDirectory).filter(entry => entry.endsWith('.db')).sort();
  assert.equal(backups.length, 2);
  assert.deepEqual(backups, ['subscription_2020-01-03.db', `subscription_${new Date().toISOString().slice(0, 10)}.db`].sort());
});

test('legacy host-based schema migrates without losing IDs, disabled state or assignments', async t => {
  const parent = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'subscriptions-legacy-'));
  const filePath = path.join(directory, 'test.db');
  const SQL = await initSqlJs();
  const old = new SQL.Database();
  old.run(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, is_active INTEGER, created_at TEXT);
    CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT, host TEXT, port INTEGER, uuid TEXT, is_active INTEGER);
    CREATE TABLE user_servers (user_id TEXT, server_id TEXT);
    INSERT INTO users VALUES ('u', 'user', NULL, 1, '2025-01-01');
    INSERT INTO servers VALUES ('s', 'test', 'example.com', 443, '00000000-0000-4000-8000-000000000001', 0);
    INSERT INTO user_servers VALUES ('u', 's');`);
  fs.writeFileSync(filePath, Buffer.from(old.export()));
  old.close();
  t.after(() => { db.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
  await db.initDb({ filePath });
  assert.equal(db.get("SELECT is_active FROM servers WHERE id = 's'").is_active, 0);
  assert.match(db.get("SELECT link FROM servers WHERE id = 's'").link, /^vless:\/\//);
  const uuid = db.get('SELECT uuid FROM user_servers').uuid;
  assert.match(uuid, /^[a-f\d-]{36}$/);
  db.closeDb();
  await db.initDb({ filePath });
  assert.equal(db.get('SELECT uuid FROM user_servers').uuid, uuid);
});
