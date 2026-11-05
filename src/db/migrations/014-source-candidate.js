module.exports = {
  version: 14,
  up(db) {
    db.run('ALTER TABLE subscription_sources ADD COLUMN candidate_json TEXT');
  }
};
