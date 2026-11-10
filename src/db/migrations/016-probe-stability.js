module.exports = {
  version: 16,
  up(db) {
    db.run('ALTER TABLE subscription_node_health ADD COLUMN stability REAL');
  }
};
