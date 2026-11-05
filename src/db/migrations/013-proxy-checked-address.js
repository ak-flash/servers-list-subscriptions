module.exports = {
  version: 13,
  up(db) {
    db.run('ALTER TABLE subscription_node_health ADD COLUMN proxy_checked_address TEXT');
  }
};
