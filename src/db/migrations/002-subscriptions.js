module.exports = {
  version: 2,
  up(db) {
    db.run(`
      CREATE TABLE subscription_sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
        headers_json TEXT NOT NULL DEFAULT '{}', is_active INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1, sync_interval_seconds INTEGER NOT NULL DEFAULT 1800,
        next_sync_at INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER, last_success_at INTEGER,
        last_error TEXT, sync_status TEXT NOT NULL DEFAULT 'pending', failure_count INTEGER NOT NULL DEFAULT 0,
        etag TEXT, last_modified TEXT, metadata_json TEXT, report_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE subscription_nodes (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES subscription_sources(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, raw_link TEXT NOT NULL, normalized_config_json TEXT,
        name TEXT NOT NULL, protocol TEXT NOT NULL, host TEXT, port INTEGER,
        is_present INTEGER NOT NULL DEFAULT 1, is_enabled INTEGER NOT NULL DEFAULT 1,
        capability_status TEXT NOT NULL, parse_error TEXT, generation INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, removed_at INTEGER,
        next_check_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE (source_id, fingerprint)
      );
      CREATE TABLE subscription_node_health (
        node_id TEXT PRIMARY KEY REFERENCES subscription_nodes(id) ON DELETE CASCADE,
        config_fingerprint TEXT NOT NULL, generation INTEGER NOT NULL,
        probe_profile_version TEXT, probe_location TEXT, cycle_id TEXT, pending_cycle_id TEXT,
        status TEXT NOT NULL DEFAULT 'unknown', last_attempt_at INTEGER, last_checked_at INTEGER,
        last_success_at INTEGER, latency_ms REAL, test_target_id TEXT, target_priority INTEGER,
        http_status INTEGER, successful_attempts INTEGER NOT NULL DEFAULT 0,
        total_attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT,
        runner_error_code TEXT, runner_error_message TEXT
      );
      CREATE TABLE subscription_node_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, cycle_id TEXT NOT NULL,
        node_id TEXT NOT NULL REFERENCES subscription_nodes(id) ON DELETE CASCADE,
        config_fingerprint TEXT NOT NULL, generation INTEGER NOT NULL, probe_profile_version TEXT NOT NULL,
        test_target_id TEXT, attempt INTEGER, outcome TEXT NOT NULL, latency_ms REAL,
        http_status INTEGER, error_code TEXT, checked_at INTEGER NOT NULL
      );
      CREATE TABLE user_subscription_sources (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES subscription_sources(id) ON DELETE CASCADE,
        is_active INTEGER NOT NULL DEFAULT 1, node_limit INTEGER NOT NULL DEFAULT 3 CHECK (node_limit BETWEEN 1 AND 20),
        max_latency_ms INTEGER CHECK (max_latency_ms > 0), priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, source_id)
      );
      CREATE TABLE background_jobs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        source_id TEXT REFERENCES subscription_sources(id) ON DELETE CASCADE,
        node_id TEXT REFERENCES subscription_nodes(id) ON DELETE CASCADE,
        reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
        total INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        error TEXT, result_json TEXT
      );
      CREATE INDEX idx_nodes_source_present ON subscription_nodes(source_id, is_present, is_enabled);
      CREATE INDEX idx_nodes_due ON subscription_nodes(next_check_at);
      CREATE INDEX idx_health_status_checked ON subscription_node_health(status, last_checked_at);
      CREATE INDEX idx_checks_node_time ON subscription_node_checks(node_id, checked_at);
      CREATE INDEX idx_checks_time ON subscription_node_checks(checked_at);
      CREATE INDEX idx_bindings_source ON user_subscription_sources(source_id);
      CREATE INDEX idx_jobs_state ON background_jobs(state, created_at);
      CREATE UNIQUE INDEX idx_jobs_live_key ON background_jobs(dedupe_key) WHERE state IN ('queued', 'running');
    `);
  }
};
