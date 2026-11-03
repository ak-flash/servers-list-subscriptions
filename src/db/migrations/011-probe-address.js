module.exports = {
  version: 11,
  up(db) {
    db.run('ALTER TABLE subscription_node_health ADD COLUMN checked_address TEXT');
  }
};
