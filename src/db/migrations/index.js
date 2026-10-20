const migrations = [require('./001-base'), require('./002-subscriptions'), require('./003-unlimited-source-nodes'), require('./004-app-state'), require('./005-password-change'), require('./006-proxy-probe'), require('./007-threexui')];

module.exports = function migrate(db) {
  db.run('PRAGMA foreign_keys = OFF');
  db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const migration of migrations) {
    if (db.exec(`SELECT version FROM schema_migrations WHERE version = ${migration.version}`).length) continue;
    db.run('BEGIN');
    try {
      migration.up(db);
      db.run('INSERT INTO schema_migrations VALUES (?, ?)', [migration.version, new Date().toISOString()]);
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }
  db.run('PRAGMA foreign_keys = ON');
};
