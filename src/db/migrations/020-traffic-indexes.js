module.exports = {
  version: 20,
  up(db) {
    // Traffic lookups always filter by user/server and order by time, so a
    // composite index lets SQLite satisfy them without a full table scan.
    db.run('CREATE INDEX IF NOT EXISTS idx_user_traffic_user_time ON user_traffic(user_id, recorded_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_user_traffic_server_time ON user_traffic(server_id, recorded_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_server_traffic_server_time ON server_traffic(server_id, recorded_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_traffic_snapshots_user_date ON traffic_snapshots(user_id, snapshot_date)');
  }
};
