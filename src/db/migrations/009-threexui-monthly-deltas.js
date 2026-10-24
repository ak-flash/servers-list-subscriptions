module.exports = {
  version: 9,
  up(db) {
    db.run(`
      ALTER TABLE threexui_client_monthly_traffic ADD COLUMN last_up_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threexui_client_monthly_traffic ADD COLUMN last_down_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threexui_client_monthly_traffic ADD COLUMN last_total_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threexui_inbound_monthly_traffic ADD COLUMN last_up_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threexui_inbound_monthly_traffic ADD COLUMN last_down_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threexui_inbound_monthly_traffic ADD COLUMN last_total_bytes INTEGER NOT NULL DEFAULT 0;
      DELETE FROM threexui_client_monthly_traffic;
      DELETE FROM threexui_inbound_monthly_traffic;
    `);
  }
};