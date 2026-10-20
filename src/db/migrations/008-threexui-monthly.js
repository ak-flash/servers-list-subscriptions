module.exports = {
  version: 8,
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS threexui_client_monthly_traffic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id TEXT NOT NULL,
        email TEXT NOT NULL,
        month TEXT NOT NULL,
        up_bytes INTEGER NOT NULL DEFAULT 0,
        down_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (panel_id, email, month),
        FOREIGN KEY (panel_id) REFERENCES threexui_panels(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS threexui_inbound_monthly_traffic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id TEXT NOT NULL,
        inbound_id INTEGER NOT NULL,
        month TEXT NOT NULL,
        up_bytes INTEGER NOT NULL DEFAULT 0,
        down_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (panel_id, inbound_id, month),
        FOREIGN KEY (panel_id) REFERENCES threexui_panels(id) ON DELETE CASCADE
      );
    `);
  }
};
