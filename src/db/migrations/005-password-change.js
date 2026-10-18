module.exports = {
  version: 5,
  up(db) {
    const columns = db.exec('PRAGMA table_info(users)')[0]?.values.map(row => row[1]) || [];
    if (!columns.includes('must_change_password')) db.run('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }
};
