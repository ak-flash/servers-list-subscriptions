module.exports = {
  version: 3,
  up(db) {
    db.run('ALTER TABLE user_subscription_sources RENAME TO user_subscription_sources_old');
    db.run(`CREATE TABLE user_subscription_sources (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES subscription_sources(id) ON DELETE CASCADE,
      is_active INTEGER NOT NULL DEFAULT 1, node_limit INTEGER NOT NULL DEFAULT 10000 CHECK (node_limit BETWEEN 1 AND 10000),
      max_latency_ms INTEGER CHECK (max_latency_ms > 0), priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, source_id)
    )`);
    db.run(`INSERT INTO user_subscription_sources (user_id, source_id, is_active, node_limit, max_latency_ms, priority, created_at, updated_at)
      SELECT user_id, source_id, is_active, node_limit, max_latency_ms, priority, created_at, updated_at
      FROM user_subscription_sources_old`);
    db.run('DROP TABLE user_subscription_sources_old');
    db.run('CREATE INDEX idx_bindings_source ON user_subscription_sources(source_id)');
  }
};
