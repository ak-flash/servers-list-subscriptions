const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const migrate = require('./migrations');

let SQL;
let db;
let dbPath;
let lock;
let persisted;
let transactionDepth = 0;

function acquireLock() {
  const lockPath = `${dbPath}.lock`;
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      lock = { path: lockPath, token };
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {
        fs.unlinkSync(lockPath);
        continue;
      }
      try {
        process.kill(owner.pid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') {
          fs.unlinkSync(lockPath);
          continue;
        }
      }
      throw new Error('БД уже открыта другим процессом. Запускайте один экземпляр приложения.');
    }
  }
  throw new Error('Не удалось получить блокировку БД');
}

function releaseLock() {
  if (!lock) return;
  try {
    if (JSON.parse(fs.readFileSync(lock.path, 'utf8')).token === lock.token) fs.unlinkSync(lock.path);
  } finally {
    lock = null;
  }
}

function backup() {
  if (dbPath === ':memory:' || !fs.existsSync(dbPath)) return;
  const directory = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `subscription_${new Date().toISOString().slice(0, 10)}.db`);
  if (!fs.existsSync(filename)) {
    fs.copyFileSync(dbPath, filename, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(filename, 0o600);
    for (const entry of fs.readdirSync(directory)) {
      if (!/^subscription_\d{4}-\d{2}-\d{2}\.db$/.test(entry)) continue;
      const file = path.join(directory, entry);
      if (fs.statSync(file).mtimeMs < Date.now() - 30 * 86400000) fs.unlinkSync(file);
    }
  }
}

async function initDb(options = {}) {
  if (db) throw new Error('Database is already initialized');
  SQL = SQL || await initSqlJs();
  dbPath = options.filePath || process.env.DB_PATH || path.join(__dirname, '../../data/subscription.db');
  if (dbPath !== ':memory:') {
    dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    acquireLock();
  }
  try {
    const existing = dbPath !== ':memory:' && fs.existsSync(dbPath);
    persisted = existing ? fs.readFileSync(dbPath) : null;
    // Never silently replace a damaged database with an empty catalog.
    if (existing && !persisted.length) throw new Error('Файл БД пуст. Восстановите резервную копию из data/backups.');
    db = new SQL.Database(persisted || undefined);
    const integrity = db.exec('PRAGMA quick_check');
    if (integrity[0]?.values[0]?.[0] !== 'ok') throw new Error('Ошибка проверки целостности БД');
    backup();
    migrate(db);
    saveDb();
    return db;
  } catch (error) {
    if (db) db.close();
    db = null;
    releaseLock();
    throw error;
  }
}

function getDb() {
  if (!db) throw new Error('Database is not initialized');
  return db;
}

function restorePersisted() {
  db.close();
  db = new SQL.Database(persisted || undefined);
  db.run('PRAGMA foreign_keys = ON');
}

function saveDb() {
  if (!db || transactionDepth) return;
  let temporary;
  try {
    const data = Buffer.from(db.export());
    // sql.js export reopens the connection and resets connection-local pragmas.
    db.run('PRAGMA foreign_keys = ON');
    if (dbPath !== ':memory:') {
      backup();
      temporary = `${dbPath}.${crypto.randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, dbPath);
    }
    persisted = data;
  } catch (error) {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    if (persisted) restorePersisted();
    throw error;
  }
}

function all(sql, params = []) {
  const stmt = getDb().prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function run(sql, params = []) {
  getDb().run(sql, params);
  saveDb();
}

function transaction(callback) {
  if (callback.constructor.name === 'AsyncFunction') throw new Error('Database transactions must be synchronous');
  const level = transactionDepth++;
  const savepoint = `transaction_${level}`;
  db.run(level ? `SAVEPOINT ${savepoint}` : 'BEGIN');
  let value;
  try {
    value = callback();
    if (value && typeof value.then === 'function') throw new Error('Do not await inside a database transaction');
    db.run(level ? `RELEASE ${savepoint}` : 'COMMIT');
  } catch (error) {
    db.run(level ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
    throw error;
  } finally {
    transactionDepth--;
  }
  if (!level) saveDb();
  return value;
}

function closeDb() {
  if (db) db.close();
  db = null;
  persisted = null;
  transactionDepth = 0;
  releaseLock();
}

module.exports = { initDb, getDb, saveDb, closeDb, all, get, run, transaction };
