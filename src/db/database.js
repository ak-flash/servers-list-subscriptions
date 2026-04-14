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
  } else {
    db = new SQL.Database();
  }

  db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            link TEXT NOT NULL,
            remark TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS user_servers (
            user_id TEXT NOT NULL,
            server_id TEXT NOT NULL,
            PRIMARY KEY (user_id, server_id),
            FOREIGN KEY (user_id) REFERENCES users(id),
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

module.exports = { initDb, getDb, saveDb };
