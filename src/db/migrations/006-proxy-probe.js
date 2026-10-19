const version = 6;

module.exports = {
  version,
  up(db) {
    db.exec(`
      ALTER TABLE subscription_node_health ADD COLUMN proxy_status TEXT;
      ALTER TABLE subscription_node_health ADD COLUMN proxy_latency_ms REAL;
      ALTER TABLE subscription_node_health ADD COLUMN proxy_http_status INTEGER;
      ALTER TABLE subscription_node_health ADD COLUMN proxy_error_code TEXT;
      ALTER TABLE subscription_node_health ADD COLUMN proxy_checked_at INTEGER;
      ALTER TABLE subscription_node_checks ADD COLUMN via TEXT NOT NULL DEFAULT 'direct';
    `);
  }
};
