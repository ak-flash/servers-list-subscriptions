module.exports = {
  version: 10,
  up(db) {
    db.run(`
      UPDATE threexui_inbound_monthly_traffic AS current
      SET up_bytes = MAX(0, current.last_up_bytes - COALESCE((
            SELECT previous.last_up_bytes
            FROM threexui_inbound_monthly_traffic AS previous
            WHERE previous.panel_id = current.panel_id
              AND previous.inbound_id = current.inbound_id
              AND previous.month < current.month
            ORDER BY previous.month DESC LIMIT 1
          ), 0)),
          down_bytes = MAX(0, current.last_down_bytes - COALESCE((
            SELECT previous.last_down_bytes
            FROM threexui_inbound_monthly_traffic AS previous
            WHERE previous.panel_id = current.panel_id
              AND previous.inbound_id = current.inbound_id
              AND previous.month < current.month
            ORDER BY previous.month DESC LIMIT 1
          ), 0)),
          total_bytes = MAX(0, current.last_up_bytes - COALESCE((
            SELECT previous.last_up_bytes
            FROM threexui_inbound_monthly_traffic AS previous
            WHERE previous.panel_id = current.panel_id
              AND previous.inbound_id = current.inbound_id
              AND previous.month < current.month
            ORDER BY previous.month DESC LIMIT 1
          ), 0)) + MAX(0, current.last_down_bytes - COALESCE((
            SELECT previous.last_down_bytes
            FROM threexui_inbound_monthly_traffic AS previous
            WHERE previous.panel_id = current.panel_id
              AND previous.inbound_id = current.inbound_id
              AND previous.month < current.month
            ORDER BY previous.month DESC LIMIT 1
          ), 0));

      UPDATE threexui_client_monthly_traffic AS current
      SET up_bytes = MAX(0, current.last_up_bytes - COALESCE((
            SELECT previous.last_up_bytes
            FROM threexui_client_monthly_traffic AS previous
            WHERE previous.panel_id = current.panel_id
              AND previous.email = current.email
              AND previous.month < current.month
            ORDER BY previous.month DESC LIMIT 1
          ), 0)),
          down_bytes = MAX(0, current.last_down_bytes - COALESCE((
            SELECT previous.last_down_bytes
            FROM threexui_client_monthly_traffic AS previous
            WHERE previous.panel_id = current.panel_id
              AND previous.email = current.email
              AND previous.month < current.month
            ORDER BY previous.month DESC LIMIT 1
          ), 0)),
          total_bytes = MAX(0, current.last_up_bytes - COALESCE((
            SELECT previous.last_up_bytes
            FROM threexui_client_monthly_traffic AS previous
            WHERE previous.panel_id = current.panel_id
              AND previous.email = current.email
              AND previous.month < current.month
            ORDER BY previous.month DESC LIMIT 1
          ), 0)) + MAX(0, current.last_down_bytes - COALESCE((
            SELECT previous.last_down_bytes
            FROM threexui_client_monthly_traffic AS previous
            WHERE previous.panel_id = current.panel_id
              AND previous.email = current.email
              AND previous.month < current.month
            ORDER BY previous.month DESC LIMIT 1
          ), 0));
    `);
  }
};