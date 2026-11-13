module.exports = {
  version: 19,
  up(db) {
    db.run(`CREATE TABLE subscription_source_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES subscription_sources(id) ON DELETE CASCADE,
      recorded_at INTEGER NOT NULL,
      total_nodes INTEGER NOT NULL DEFAULT 0,
      healthy_nodes INTEGER NOT NULL DEFAULT 0,
      healthy_percent REAL NOT NULL DEFAULT 0,
      average_latency_ms REAL,
      successful_attempts INTEGER NOT NULL DEFAULT 0,
      total_attempts INTEGER NOT NULL DEFAULT 0
    )`);
    db.run('CREATE INDEX idx_source_history_source_time ON subscription_source_history(source_id, recorded_at)');
  }
};
