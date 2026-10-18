module.exports = {
  version: 4,
  up(db) {
    db.run(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }
};
