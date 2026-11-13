module.exports = {
  version: 17,
  up(db) {
    // NULL preserves the previous behavior: special nodes share the ordinary
    // node limit. A number enables a separate quota for LTE / base-station /
    // white-list nodes.
    db.run(`ALTER TABLE user_subscription_sources ADD COLUMN special_node_limit INTEGER
      CHECK (special_node_limit IS NULL OR special_node_limit BETWEEN 0 AND 10000)`);
  }
};
