module.exports = {
  version: 19,
  up(db) {
    db.run('CREATE INDEX IF NOT EXISTS idx_checks_node_profile_time ON subscription_node_checks(node_id, profile, checked_at)');
  }
};
