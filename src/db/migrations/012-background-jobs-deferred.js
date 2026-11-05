module.exports = {
  version: 12,
  up(db) {
    db.run('ALTER TABLE background_jobs ADD COLUMN deferred INTEGER NOT NULL DEFAULT 0');
  }
};
