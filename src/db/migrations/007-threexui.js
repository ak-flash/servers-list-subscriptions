module.exports = {
  version: 7,
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS threexui_panels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        token TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        sync_interval_seconds INTEGER NOT NULL DEFAULT 300,
        last_sync_at TEXT,
        last_sync_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS threexui_inbounds (
        id TEXT PRIMARY KEY,
        panel_id TEXT NOT NULL,
        inbound_id INTEGER NOT NULL,
        remark TEXT,
        tag TEXT,
        protocol TEXT,
        port INTEGER,
        up_bytes INTEGER NOT NULL DEFAULT 0,
        down_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        UNIQUE (panel_id, inbound_id),
        FOREIGN KEY (panel_id) REFERENCES threexui_panels(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS threexui_client_traffic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id TEXT NOT NULL,
        email TEXT NOT NULL,
        up_bytes INTEGER NOT NULL DEFAULT 0,
        down_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        UNIQUE (panel_id, email),
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

      CREATE TABLE IF NOT EXISTS threexui_inbound_client_traffic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id TEXT NOT NULL,
        inbound_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        up_bytes INTEGER NOT NULL DEFAULT 0,
        down_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT,
        UNIQUE (panel_id, inbound_id, email),
        FOREIGN KEY (panel_id) REFERENCES threexui_panels(id) ON DELETE CASCADE
      );
    `);
  }
};
