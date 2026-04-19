const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', '..', 'data', 'subscription.db');

let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);

    migrateServersTable(db);
    migrateUsersTable(db);
    migrateSubscriptionRequestsTable(db);
    migrateUserServersTable(db);
    migrateServersTag(db);
    migrateServersTrafficLimit(db);
  } else {
    db = new SQL.Database();
  }

  db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            first_request_at TEXT,
            last_request_at TEXT
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            link TEXT NOT NULL,
            remark TEXT,
            tag TEXT,
            traffic_limit INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS user_servers (
            user_id TEXT NOT NULL,
            server_id TEXT NOT NULL,
            uuid TEXT NOT NULL,
            PRIMARY KEY (user_id, server_id),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (server_id) REFERENCES servers(id)
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS subscription_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
            ip_address TEXT,
            user_agent TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS user_traffic (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            server_id TEXT NOT NULL,
            upload_bytes INTEGER DEFAULT 0,
            download_bytes INTEGER DEFAULT 0,
            total_bytes INTEGER DEFAULT 0,
            recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (server_id) REFERENCES servers(id)
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS traffic_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            server_id TEXT NOT NULL,
            upload_bytes INTEGER DEFAULT 0,
            download_bytes INTEGER DEFAULT 0,
            total_bytes INTEGER DEFAULT 0,
            snapshot_date TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (server_id) REFERENCES servers(id)
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS server_traffic (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id TEXT NOT NULL,
            upload_bytes INTEGER DEFAULT 0,
            download_bytes INTEGER DEFAULT 0,
            total_bytes INTEGER DEFAULT 0,
            recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (server_id) REFERENCES servers(id)
        )
    `);

  saveDb();
  return db;
}

function migrateServersTable(db) {
  try {
    db.exec("SELECT link FROM servers LIMIT 1");
    return;
  } catch (e) {
    // link column doesn't exist, need to migrate
  }

  try {
    const result = db.exec("SELECT * FROM servers LIMIT 1");
    if (result.length === 0 || !result[0].columns.includes('host')) {
      return;
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS servers_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        link TEXT NOT NULL,
        remark TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const oldServers = db.exec("SELECT * FROM servers");
    if (oldServers.length > 0) {
      const columns = oldServers[0].columns;
      const hasHost = columns.includes('host');
      const hasUuid = columns.includes('uuid');

      for (const row of oldServers[0].values) {
        const rowObj = {};
        columns.forEach((col, i) => rowObj[col] = row[i]);

        if (hasHost && hasUuid) {
          let protocol = rowObj.protocol || 'vless';
          let link = `${protocol}://${rowObj.uuid}@${rowObj.host}:${rowObj.port}`;

          const params = [];
          if (rowObj.flow) params.push(`flow=${rowObj.flow}`);
          if (rowObj.network && rowObj.network !== 'tcp') params.push(`type=${rowObj.network}`);
          if (rowObj.sni) params.push(`sni=${rowObj.sni}`);
          if (rowObj.tls && rowObj.tls !== 'none') params.push(`security=${rowObj.tls}`);
          if (rowObj.fp) params.push(`fp=${rowObj.fp}`);
          if (rowObj.path) params.push(`path=${encodeURIComponent(rowObj.path)}`);

          if (params.length > 0) {
            link += '?' + params.join('&');
          }

          const remark = rowObj.remark || rowObj.name || '';
          link += '#' + encodeURIComponent(remark);

          db.run("INSERT INTO servers_new (id, name, link, remark, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [rowObj.id, rowObj.name, link, remark, rowObj.is_active || 1, rowObj.created_at]);
        }
      }
    }

    db.run("DROP TABLE servers");
    db.run("ALTER TABLE servers_new RENAME TO servers");
    saveDb();
  } catch (e) {
    console.log('Migration error:', e.message);
  }
}

function migrateUsersTable(db) {
  try {
    db.exec("SELECT first_request_at FROM users LIMIT 1");
    return;
  } catch (e) {
    db.run("ALTER TABLE users ADD COLUMN first_request_at TEXT");
    db.run("ALTER TABLE users ADD COLUMN last_request_at TEXT");
    saveDb();
  }
}

function migrateSubscriptionRequestsTable(db) {
  try {
    db.exec("SELECT id FROM subscription_requests LIMIT 1");
    return;
  } catch (e) {
    db.run(`
      CREATE TABLE IF NOT EXISTS subscription_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
        ip_address TEXT,
        user_agent TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    saveDb();
  }
}

function migrateUserServersTable(db) {
  try {
    db.exec("SELECT uuid FROM user_servers LIMIT 1");
    return;
  } catch (e) {
    try {
      db.run("ALTER TABLE user_servers ADD COLUMN uuid TEXT");
      const crypto = require('crypto');
      const rows = db.exec("SELECT user_id, server_id FROM user_servers");
      if (rows.length > 0) {
        for (const row of rows[0].values) {
          const userId = row[0];
          const serverId = row[1];
          const newUuid = crypto.randomUUID();
          db.run("UPDATE user_servers SET uuid = ? WHERE user_id = ? AND server_id = ?", [newUuid, userId, serverId]);
        }
      }
      saveDb();
    } catch (err) {
      console.log('Migration user_servers error:', err.message);
    }
  }
}

function migrateServersTag(db) {
  try {
    db.exec("SELECT tag FROM servers LIMIT 1");
    return;
  } catch (e) {
    try {
      db.run("ALTER TABLE servers ADD COLUMN tag TEXT");
      saveDb();
    } catch (err) {
      console.log('Migration servers tag error:', err.message);
    }
  }
}

function migrateServersTrafficLimit(db) {
  try {
    db.exec("SELECT traffic_limit FROM servers LIMIT 1");
    return;
  } catch (e) {
    try {
      db.run("ALTER TABLE servers ADD COLUMN traffic_limit INTEGER DEFAULT 0");
      saveDb();
    } catch (err) {
      console.log('Migration servers traffic_limit error:', err.message);
    }
  }
}

function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(dbPath, buffer);
  }
}

function getDb() {
  return db;
}

// Traffic management functions
function getUserTraffic(userId, serverId = null) {
  let sql = `
    SELECT 
      COALESCE(SUM(upload_bytes), 0) as total_upload,
      COALESCE(SUM(download_bytes), 0) as total_download,
      COALESCE(SUM(total_bytes), 0) as total_traffic
    FROM user_traffic 
    WHERE user_id = ?
  `;
  let params = [userId];

  if (serverId) {
    sql += ' AND server_id = ?';
    params.push(serverId);
  }

  // Use local dbGet function
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return { total_upload: 0, total_download: 0, total_traffic: 0 };
}

function updateUserTraffic(userId, serverId, uploadBytes, downloadBytes) {
  const totalBytes = uploadBytes + downloadBytes;

  // Update current traffic record
  const existingStmt = db.prepare(
    'SELECT id FROM user_traffic WHERE user_id = ? AND server_id = ? AND date(recorded_at) = date(\'now\')'
  );
  existingStmt.bind([userId, serverId]);
  const existing = existingStmt.step() ? existingStmt.getAsObject() : null;
  existingStmt.free();

  if (existing) {
    const updateStmt = db.prepare(
      'UPDATE user_traffic SET upload_bytes = ?, download_bytes = ?, total_bytes = ?, recorded_at = datetime(\'now\') WHERE id = ?'
    );
    updateStmt.run([uploadBytes, downloadBytes, totalBytes, existing.id]);
    updateStmt.free();
  } else {
    const insertStmt = db.prepare(
      'INSERT INTO user_traffic (user_id, server_id, upload_bytes, download_bytes, total_bytes, recorded_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
    );
    insertStmt.run([userId, serverId, uploadBytes, downloadBytes, totalBytes]);
    insertStmt.free();
  }

  saveDb();
}

function getTrafficSnapshots(userId, days = 30) {
  const stmt = db.prepare(
    'SELECT * FROM traffic_snapshots WHERE user_id = ? AND snapshot_date >= date(\'now\', ? || \' days\') ORDER BY snapshot_date DESC'
  );
  stmt.bind([userId, `-${days}`]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function createTrafficSnapshot(userId, serverId) {
  const traffic = getUserTraffic(userId, serverId);
  const today = new Date().toISOString().split('T')[0];

  const stmt = db.prepare(
    'INSERT OR REPLACE INTO traffic_snapshots (user_id, server_id, upload_bytes, download_bytes, total_bytes, snapshot_date) VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmt.run([userId, serverId, traffic.total_upload, traffic.total_download, traffic.total_traffic, today]);
  stmt.free();

  saveDb();
}

function getAllUsersTraffic() {
  const stmt = db.prepare(`
    SELECT 
      u.id,
      u.username,
      COALESCE(SUM(ut.upload_bytes), 0) as total_upload,
      COALESCE(SUM(ut.download_bytes), 0) as total_download,
      COALESCE(SUM(ut.total_bytes), 0) as total_traffic,
      MAX(ut.recorded_at) as last_traffic_update
    FROM users u
    LEFT JOIN user_traffic ut ON u.id = ut.user_id
    GROUP BY u.id, u.username
    ORDER BY total_traffic DESC
  `);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function getUserServerUuid(userId, serverId) {
  const stmt = db.prepare('SELECT uuid FROM user_servers WHERE user_id = ? AND server_id = ?');
  stmt.bind([userId, serverId]);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject().uuid;
  }
  stmt.free();
  return result;
}

function getUserServersWithUuid(userId) {
  const stmt = db.prepare(`
    SELECT s.*, us.uuid as user_server_uuid,
      COALESCE(SUM(st.upload_bytes), 0) as total_upload,
      COALESCE(SUM(st.download_bytes), 0) as total_download,
      COALESCE(SUM(st.total_bytes), 0) as total_traffic
    FROM servers s
    INNER JOIN user_servers us ON s.id = us.server_id
    LEFT JOIN server_traffic st ON s.id = st.server_id
    WHERE us.user_id = ? AND s.is_active = 1
    GROUP BY s.id, s.name, s.link, s.remark, s.tag, s.traffic_limit, s.is_active, s.created_at, us.uuid
  `);
  stmt.bind([userId]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function getUserServerAssignments(userId) {
  const stmt = db.prepare('SELECT server_id, uuid FROM user_servers WHERE user_id = ?');
  stmt.bind([userId]);
  const rows = [];
  while (stmt.step()) {
    const obj = stmt.getAsObject();
    rows.push({ server_id: obj.server_id, uuid: obj.uuid });
  }
  stmt.free();
  return rows;
}

function getServerByTag(tag) {
  const stmt = db.prepare('SELECT * FROM servers WHERE tag = ?');
  stmt.bind([tag]);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function updateServerTraffic(serverId, uploadBytes, downloadBytes) {
  const today = new Date().toISOString().split('T')[0];

  const existingStmt = db.prepare(
    "SELECT id, upload_bytes, download_bytes FROM server_traffic WHERE server_id = ? AND date(recorded_at) = date('now')"
  );
  existingStmt.bind([serverId]);
  const existing = existingStmt.step() ? existingStmt.getAsObject() : null;
  existingStmt.free();

  if (existing) {
    const newUpload = existing.upload_bytes + uploadBytes;
    const newDownload = existing.download_bytes + downloadBytes;
    const newTotal = newUpload + newDownload;
    const updateStmt = db.prepare(
      "UPDATE server_traffic SET upload_bytes = ?, download_bytes = ?, total_bytes = ?, recorded_at = datetime('now') WHERE id = ?"
    );
    updateStmt.run([newUpload, newDownload, newTotal, existing.id]);
    updateStmt.free();
  } else {
    const insertStmt = db.prepare(
      "INSERT INTO server_traffic (server_id, upload_bytes, download_bytes, total_bytes, recorded_at) VALUES (?, ?, ?, ?, datetime('now'))"
    );
    insertStmt.run([serverId, uploadBytes, downloadBytes, uploadBytes + downloadBytes]);
    insertStmt.free();
  }

  saveDb();
}

function getServerTraffic(serverId) {
  const stmt = db.prepare(`
    SELECT
      COALESCE(SUM(upload_bytes), 0) as total_upload,
      COALESCE(SUM(download_bytes), 0) as total_download,
      COALESCE(SUM(total_bytes), 0) as total_traffic
    FROM server_traffic
    WHERE server_id = ?
  `);
  stmt.bind([serverId]);
  let result = { total_upload: 0, total_download: 0, total_traffic: 0 };
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function getAllServersTraffic() {
  const stmt = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.tag,
      COALESCE(SUM(st.upload_bytes), 0) as total_upload,
      COALESCE(SUM(st.download_bytes), 0) as total_download,
      COALESCE(SUM(st.total_bytes), 0) as total_traffic
    FROM servers s
    LEFT JOIN server_traffic st ON s.id = st.server_id
    GROUP BY s.id, s.name, s.tag
    ORDER BY total_traffic DESC
  `);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function getAvailableMonths() {
  const stmt = db.prepare(`
    SELECT DISTINCT strftime('%Y-%m', recorded_at) as month
    FROM server_traffic
    WHERE recorded_at IS NOT NULL
    ORDER BY month DESC
    LIMIT 12
  `);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject().month);
  }
  stmt.free();
  return rows;
}

function getServersTrafficByMonth(yearMonth) {
  const stmt = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.tag,
      COALESCE(SUM(st.upload_bytes), 0) as total_upload,
      COALESCE(SUM(st.download_bytes), 0) as total_download,
      COALESCE(SUM(st.total_bytes), 0) as total_traffic
    FROM servers s
    LEFT JOIN server_traffic st ON s.id = st.server_id
      AND strftime('%Y-%m', st.recorded_at) = ?
    GROUP BY s.id, s.name, s.tag
    ORDER BY total_traffic DESC
  `);
  stmt.bind([yearMonth]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

module.exports = {
  initDb,
  getDb,
  saveDb,
  getUserTraffic,
  updateUserTraffic,
  getTrafficSnapshots,
  createTrafficSnapshot,
  getAllUsersTraffic,
  getUserServerUuid,
  getUserServersWithUuid,
  getUserServerAssignments,
  getServerByTag,
  updateServerTraffic,
  getServerTraffic,
  getAllServersTraffic,
  getAvailableMonths,
  getServersTrafficByMonth
};
