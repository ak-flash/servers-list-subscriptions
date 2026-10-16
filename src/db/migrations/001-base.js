const crypto = require('crypto');

function columns(db, table) {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result.length ? result[0].values.map(row => row[1]) : [];
}

function addColumn(db, table, name, definition) {
  if (!columns(db, table).includes(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

module.exports = {
  version: 1,
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT,
        is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        first_request_at TEXT, last_request_at TEXT
      );
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, link TEXT NOT NULL, remark TEXT,
        tag TEXT, traffic_limit INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_servers (
        user_id TEXT NOT NULL, server_id TEXT NOT NULL, uuid TEXT NOT NULL,
        PRIMARY KEY (user_id, server_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (server_id) REFERENCES servers(id)
      );
      CREATE TABLE IF NOT EXISTS subscription_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
        requested_at TEXT DEFAULT CURRENT_TIMESTAMP, ip_address TEXT, user_agent TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS user_traffic (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, server_id TEXT NOT NULL,
        upload_bytes INTEGER DEFAULT 0, download_bytes INTEGER DEFAULT 0, total_bytes INTEGER DEFAULT 0,
        recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (server_id) REFERENCES servers(id)
      );
      CREATE TABLE IF NOT EXISTS traffic_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, server_id TEXT NOT NULL,
        upload_bytes INTEGER DEFAULT 0, download_bytes INTEGER DEFAULT 0, total_bytes INTEGER DEFAULT 0,
        snapshot_date TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (server_id) REFERENCES servers(id)
      );
      CREATE TABLE IF NOT EXISTS server_traffic (
        id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL,
        upload_bytes INTEGER DEFAULT 0, download_bytes INTEGER DEFAULT 0, total_bytes INTEGER DEFAULT 0,
        recorded_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (server_id) REFERENCES servers(id)
      );
    `);

    // Older installations stored a host/UUID rather than a complete link. Keep IDs and assignments.
    if (!columns(db, 'servers').includes('link')) {
      const result = db.exec('SELECT * FROM servers');
      db.run(`CREATE TABLE servers_migrated (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, link TEXT NOT NULL, remark TEXT,
        tag TEXT, traffic_limit INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      for (const values of result[0]?.values || []) {
        const row = Object.fromEntries(result[0].columns.map((key, index) => [key, values[index]]));
        if (!row.host || !row.uuid || !row.port) throw new Error('Cannot migrate a legacy server without host, port and UUID');
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries({
          flow: row.flow, type: row.network, sni: row.sni, security: row.tls, fp: row.fp, path: row.path
        })) {
          if (value) params.set(key, value);
        }
        const host = row.host.includes(':') && !row.host.startsWith('[') ? `[${row.host}]` : row.host;
        const name = row.remark || row.name || '';
        const link = `${row.protocol || 'vless'}://${encodeURIComponent(row.uuid)}@${host}:${row.port}?${params}#${encodeURIComponent(name)}`;
        db.run('INSERT INTO servers_migrated VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [row.id, row.name, link, name, row.tag || null, row.traffic_limit || 0, row.is_active ?? 1, row.created_at || new Date().toISOString()]);
      }
      db.run('DROP TABLE servers; ALTER TABLE servers_migrated RENAME TO servers');
    }
    addColumn(db, 'servers', 'tag', 'TEXT');
    addColumn(db, 'servers', 'traffic_limit', 'INTEGER DEFAULT 0');
    addColumn(db, 'users', 'first_request_at', 'TEXT');
    addColumn(db, 'users', 'last_request_at', 'TEXT');
    if (!columns(db, 'user_servers').includes('uuid')) {
      addColumn(db, 'user_servers', 'uuid', 'TEXT');
      const rows = db.exec('SELECT user_id, server_id FROM user_servers');
      for (const [userId, serverId] of rows[0]?.values || []) {
        db.run('UPDATE user_servers SET uuid = ? WHERE user_id = ? AND server_id = ?', [crypto.randomUUID(), userId, serverId]);
      }
    }
  }
};
