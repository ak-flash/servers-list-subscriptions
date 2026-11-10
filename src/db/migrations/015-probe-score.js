module.exports = {
  version: 15,
  up(db) {
    db.run(`
      ALTER TABLE subscription_node_health ADD COLUMN probe_profile TEXT NOT NULL DEFAULT 'full';
      ALTER TABLE subscription_node_health ADD COLUMN fast_status TEXT;
      ALTER TABLE subscription_node_health ADD COLUMN fast_latency_ms REAL;
      ALTER TABLE subscription_node_health ADD COLUMN fast_checked_at INTEGER;
      ALTER TABLE subscription_node_health ADD COLUMN fast_error_code TEXT;
      ALTER TABLE subscription_node_health ADD COLUMN throughput_bps REAL;
      ALTER TABLE subscription_node_health ADD COLUMN score REAL;
      ALTER TABLE subscription_node_health ADD COLUMN score_version TEXT;
      ALTER TABLE subscription_node_health ADD COLUMN score_updated_at INTEGER;
      ALTER TABLE subscription_node_health ADD COLUMN service_gates_json TEXT;
      ALTER TABLE subscription_node_checks ADD COLUMN profile TEXT NOT NULL DEFAULT 'full';
      ALTER TABLE subscription_node_checks ADD COLUMN bytes_transferred INTEGER;
      ALTER TABLE subscription_node_checks ADD COLUMN throughput_bps REAL;
    `);
  }
};
