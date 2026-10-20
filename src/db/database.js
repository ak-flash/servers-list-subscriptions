const connection = require('./connection');
const { getDb, saveDb } = connection;

// Existing traffic helpers always use the current connection (also after a failed disk write).
const db = {
  prepare: (...args) => getDb().prepare(...args),
  run: (...args) => getDb().run(...args)
};

// Traffic management functions
function getUserTraffic(userId, serverId = null) {
  let sql = `
    SELECT 
      COALESCE(SUM(upload_bytes), 0) as total_upload,
      COALESCE(SUM(download_bytes), 0) as total_download,
      COALESCE(SUM(total_bytes), 0) as total_traffic
    FROM user_traffic 
    WHERE user_id = ?
  `;
  let params = [userId];

  if (serverId) {
    sql += ' AND server_id = ?';
    params.push(serverId);
  }

  // Use local dbGet function
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return { total_upload: 0, total_download: 0, total_traffic: 0 };
}

function updateUserTraffic(userId, serverId, uploadBytes, downloadBytes) {
  const totalBytes = uploadBytes + downloadBytes;

  // Update current traffic record
  const existingStmt = db.prepare(
    'SELECT id FROM user_traffic WHERE user_id = ? AND server_id = ? AND date(recorded_at) = date(\'now\')'
  );
  existingStmt.bind([userId, serverId]);
  const existing = existingStmt.step() ? existingStmt.getAsObject() : null;
  existingStmt.free();

  if (existing) {
    const updateStmt = db.prepare(
      'UPDATE user_traffic SET upload_bytes = ?, download_bytes = ?, total_bytes = ?, recorded_at = datetime(\'now\') WHERE id = ?'
    );
    updateStmt.run([uploadBytes, downloadBytes, totalBytes, existing.id]);
    updateStmt.free();
  } else {
    const insertStmt = db.prepare(
      'INSERT INTO user_traffic (user_id, server_id, upload_bytes, download_bytes, total_bytes, recorded_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
    );
    insertStmt.run([userId, serverId, uploadBytes, downloadBytes, totalBytes]);
    insertStmt.free();
  }

  saveDb();
}

function getTrafficSnapshots(userId, days = 30) {
  const stmt = db.prepare(
    'SELECT * FROM traffic_snapshots WHERE user_id = ? AND snapshot_date >= date(\'now\', ? || \' days\') ORDER BY snapshot_date DESC'
  );
  stmt.bind([userId, `-${days}`]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function createTrafficSnapshot(userId, serverId) {
  const traffic = getUserTraffic(userId, serverId);
  const today = new Date().toISOString().split('T')[0];

  const stmt = db.prepare(
    'INSERT OR REPLACE INTO traffic_snapshots (user_id, server_id, upload_bytes, download_bytes, total_bytes, snapshot_date) VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmt.run([userId, serverId, traffic.total_upload, traffic.total_download, traffic.total_traffic, today]);
  stmt.free();

  saveDb();
}

function resetAllTraffic() {
  db.run('DELETE FROM user_traffic');
  db.run('DELETE FROM server_traffic');
  db.run('DELETE FROM traffic_snapshots');
  saveDb();
}

function getAllUsersTraffic(yearMonth = null) {
  const monthFilter = yearMonth ? 'AND strftime(\'%Y-%m\', ut.recorded_at) = ?' : '';
  const stmt = db.prepare(`
    SELECT
      u.id,
      u.username,
      COALESCE(SUM(ut.upload_bytes), 0) as total_upload,
      COALESCE(SUM(ut.download_bytes), 0) as total_download,
      COALESCE(SUM(ut.total_bytes), 0) as total_traffic,
      MAX(ut.recorded_at) as last_traffic_update
    FROM users u
    LEFT JOIN user_traffic ut ON u.id = ut.user_id ${monthFilter}
    GROUP BY u.id, u.username
    ORDER BY total_traffic DESC
  `);
  if (yearMonth) stmt.bind([yearMonth]);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function getUserServerUuid(userId, serverId) {
  const stmt = db.prepare('SELECT uuid FROM user_servers WHERE user_id = ? AND server_id = ?');
  stmt.bind([userId, serverId]);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject().uuid;
  }
  stmt.free();
  return result;
}

function getUserServersWithUuid(userId) {
  const stmt = db.prepare(`
    SELECT s.*, us.uuid as user_server_uuid,
      COALESCE(SUM(st.upload_bytes), 0) as total_upload,
      COALESCE(SUM(st.download_bytes), 0) as total_download,
      COALESCE(SUM(st.total_bytes), 0) as total_traffic
    FROM servers s
    INNER JOIN user_servers us ON s.id = us.server_id
    LEFT JOIN server_traffic st ON s.id = st.server_id
    WHERE us.user_id = ? AND s.is_active = 1
    GROUP BY s.id, s.name, s.link, s.remark, s.tag, s.traffic_limit, s.is_active, s.created_at, us.uuid
  `);
  stmt.bind([userId]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function getUserServerAssignments(userId) {
  const stmt = db.prepare('SELECT server_id, uuid FROM user_servers WHERE user_id = ?');
  stmt.bind([userId]);
  const rows = [];
  while (stmt.step()) {
    const obj = stmt.getAsObject();
    rows.push({ server_id: obj.server_id, uuid: obj.uuid });
  }
  stmt.free();
  return rows;
}

function getServerByTag(tag) {
  const stmt = db.prepare('SELECT * FROM servers WHERE tag = ?');
  stmt.bind([tag]);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function updateServerTraffic(serverId, uploadBytes, downloadBytes) {
  const today = new Date().toISOString().split('T')[0];

  const existingStmt = db.prepare(
    "SELECT id, upload_bytes, download_bytes FROM server_traffic WHERE server_id = ? AND date(recorded_at) = date('now')"
  );
  existingStmt.bind([serverId]);
  const existing = existingStmt.step() ? existingStmt.getAsObject() : null;
  existingStmt.free();

  if (existing) {
    const newUpload = existing.upload_bytes + uploadBytes;
    const newDownload = existing.download_bytes + downloadBytes;
    const newTotal = newUpload + newDownload;
    const updateStmt = db.prepare(
      "UPDATE server_traffic SET upload_bytes = ?, download_bytes = ?, total_bytes = ?, recorded_at = datetime('now') WHERE id = ?"
    );
    updateStmt.run([newUpload, newDownload, newTotal, existing.id]);
    updateStmt.free();
  } else {
    const insertStmt = db.prepare(
      "INSERT INTO server_traffic (server_id, upload_bytes, download_bytes, total_bytes, recorded_at) VALUES (?, ?, ?, ?, datetime('now'))"
    );
    insertStmt.run([serverId, uploadBytes, downloadBytes, uploadBytes + downloadBytes]);
    insertStmt.free();
  }

  saveDb();
}

function getServerTraffic(serverId) {
  const stmt = db.prepare(`
    SELECT
      COALESCE(SUM(upload_bytes), 0) as total_upload,
      COALESCE(SUM(download_bytes), 0) as total_download,
      COALESCE(SUM(total_bytes), 0) as total_traffic
    FROM server_traffic
    WHERE server_id = ?
  `);
  stmt.bind([serverId]);
  let result = { total_upload: 0, total_download: 0, total_traffic: 0 };
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function getAllServersTraffic() {
  const stmt = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.tag,
      COALESCE(SUM(st.upload_bytes), 0) as total_upload,
      COALESCE(SUM(st.download_bytes), 0) as total_download,
      COALESCE(SUM(st.total_bytes), 0) as total_traffic
    FROM servers s
    LEFT JOIN server_traffic st ON s.id = st.server_id
    GROUP BY s.id, s.name, s.tag
    ORDER BY total_traffic DESC
  `);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function getAvailableMonths() {
  const stmt = db.prepare(`
    SELECT DISTINCT strftime('%Y-%m', recorded_at) as month
    FROM server_traffic
    WHERE recorded_at IS NOT NULL
    ORDER BY month DESC
    LIMIT 12
  `);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject().month);
  }
  stmt.free();
  return rows;
}

function getServersTrafficByMonth(yearMonth) {
  const stmt = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.tag,
      COALESCE(SUM(st.upload_bytes), 0) as total_upload,
      COALESCE(SUM(st.download_bytes), 0) as total_download,
      COALESCE(SUM(st.total_bytes), 0) as total_traffic
    FROM servers s
    LEFT JOIN server_traffic st ON s.id = st.server_id
      AND strftime('%Y-%m', st.recorded_at) = ?
    GROUP BY s.id, s.name, s.tag
    ORDER BY total_traffic DESC
  `);
  stmt.bind([yearMonth]);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function normalizeTrafficValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.trunc(number);
}

function upsertThreeXuiClientTraffic(panelId, email, upBytes, downBytes, totalBytes = null, updatedAt = null) {
  const up = normalizeTrafficValue(upBytes);
  const down = normalizeTrafficValue(downBytes);
  const total = totalBytes === null || totalBytes === undefined ? up + down : normalizeTrafficValue(totalBytes);
  const stmt = db.prepare(`INSERT INTO threexui_client_traffic (panel_id, email, up_bytes, down_bytes, total_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(panel_id, email) DO UPDATE SET
      up_bytes = excluded.up_bytes,
      down_bytes = excluded.down_bytes,
      total_bytes = excluded.total_bytes,
      updated_at = excluded.updated_at`);
  stmt.run([panelId, email, up, down, total, updatedAt]);
  stmt.free();
}

function upsertThreeXuiInboundTraffic(panelId, inbound) {
  const inboundId = Number.parseInt(inbound.id, 10);
  if (!Number.isInteger(inboundId) || inboundId < 0) return;
  const up = normalizeTrafficValue(inbound.up);
  const down = normalizeTrafficValue(inbound.down);
  const stmt = db.prepare(`INSERT INTO threexui_inbounds (id, panel_id, inbound_id, remark, tag, protocol, port, up_bytes, down_bytes, total_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(panel_id, inbound_id) DO UPDATE SET
      remark = excluded.remark,
      tag = excluded.tag,
      protocol = excluded.protocol,
      port = excluded.port,
      up_bytes = excluded.up_bytes,
      down_bytes = excluded.down_bytes,
      total_bytes = excluded.total_bytes,
      updated_at = excluded.updated_at`);
  stmt.run([`${panelId}:${inboundId}`, panelId, inboundId, inbound.remark || null, inbound.tag || null,
    inbound.protocol || null, Number.parseInt(inbound.port, 10) || null, up, down, normalizeTrafficValue(inbound.total ?? up + down)]);
  stmt.free();
}

function getThreeXuiClientTraffic(email) {
  const row = connection.get(`SELECT COALESCE(SUM(up_bytes), 0) as total_upload, COALESCE(SUM(down_bytes), 0) as total_download,
    COALESCE(SUM(total_bytes), 0) as total_traffic, MAX(updated_at) as updated_at
    FROM threexui_client_traffic WHERE email = ?`, [email]);
  return row || { total_upload: 0, total_download: 0, total_traffic: 0, updated_at: null };
}

function getThreeXuiClientsTraffic() {
  return connection.all(`SELECT email, COALESCE(SUM(up_bytes), 0) as total_upload, COALESCE(SUM(down_bytes), 0) as total_download,
    COALESCE(SUM(total_bytes), 0) as total_traffic, MAX(updated_at) as updated_at
    FROM threexui_client_traffic GROUP BY email ORDER BY total_traffic DESC`);
}

function getThreeXuiInboundTraffic() {
  return connection.all(`SELECT i.*, p.name as panel_name
    FROM threexui_inbounds i
    JOIN threexui_panels p ON p.id = i.panel_id
    WHERE p.is_active = 1
    ORDER BY i.total_bytes DESC, i.remark, i.id`);
}

function upsertThreeXuiClientMonthlyTraffic(panelId, email, month, upBytes, downBytes, totalBytes) {
  if (!email || !/^\d{4}-\d{2}$/.test(month)) return;
  const stmt = db.prepare(`INSERT INTO threexui_client_monthly_traffic (panel_id, email, month, up_bytes, down_bytes, total_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(panel_id, email, month) DO UPDATE SET
      up_bytes = excluded.up_bytes,
      down_bytes = excluded.down_bytes,
      total_bytes = excluded.total_bytes,
      updated_at = excluded.updated_at`);
  stmt.run([panelId, email, month, normalizeTrafficValue(upBytes), normalizeTrafficValue(downBytes), normalizeTrafficValue(totalBytes)]);
  stmt.free();
}

function upsertThreeXuiInboundMonthlyTraffic(panelId, inboundId, month, upBytes, downBytes, totalBytes) {
  const id = Number.parseInt(inboundId, 10);
  if (!Number.isInteger(id) || id < 0 || !/^\d{4}-\d{2}$/.test(month)) return;
  const stmt = db.prepare(`INSERT INTO threexui_inbound_monthly_traffic (panel_id, inbound_id, month, up_bytes, down_bytes, total_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(panel_id, inbound_id, month) DO UPDATE SET
      up_bytes = excluded.up_bytes,
      down_bytes = excluded.down_bytes,
      total_bytes = excluded.total_bytes,
      updated_at = excluded.updated_at`);
  stmt.run([panelId, id, month, normalizeTrafficValue(upBytes), normalizeTrafficValue(downBytes), normalizeTrafficValue(totalBytes)]);
  stmt.free();
}

function getThreeXuiInboundMonthlyTraffic(month = null) {
  const params = month ? [month] : [];
  const filter = month ? ' AND m.month = ?' : '';
  return connection.all(`SELECT m.panel_id, p.name as panel_name, m.inbound_id,
      COALESCE(i.remark, m.inbound_id) as remark, COALESCE(i.tag, '') as tag,
      COALESCE(i.protocol, '') as protocol, COALESCE(i.port, 0) as port,
      m.up_bytes, m.down_bytes, m.total_bytes, m.month, m.updated_at
    FROM threexui_inbound_monthly_traffic m
    JOIN threexui_panels p ON p.id = m.panel_id
    LEFT JOIN threexui_inbounds i ON i.panel_id = m.panel_id AND i.inbound_id = m.inbound_id
    WHERE p.is_active = 1${filter}
    ORDER BY m.total_bytes DESC, p.name, m.inbound_id`, params);
}

function getThreeXuiInboundTrafficTotals(month = null) {
  if (month) return connection.get(`SELECT COALESCE(SUM(up_bytes), 0) as total_upload, COALESCE(SUM(down_bytes), 0) as total_download,
    COALESCE(SUM(total_bytes), 0) as total_traffic FROM threexui_inbound_monthly_traffic m
    JOIN threexui_panels p ON p.id = m.panel_id WHERE p.is_active = 1 AND m.month = ?`, [month]);
  return connection.get(`SELECT COALESCE(SUM(up_bytes), 0) as total_upload, COALESCE(SUM(down_bytes), 0) as total_download,
    COALESCE(SUM(total_bytes), 0) as total_traffic
    FROM threexui_inbounds i JOIN threexui_panels p ON p.id = i.panel_id WHERE p.is_active = 1`);
}

function upsertThreeXuiInboundClientTraffic(panelId, inboundId, email, upBytes, downBytes, totalBytes = null, updatedAt = null) {
  const id = Number.parseInt(inboundId, 10);
  if (!Number.isInteger(id) || id < 0) return;
  const up = normalizeTrafficValue(upBytes);
  const down = normalizeTrafficValue(downBytes);
  const total = totalBytes === null || totalBytes === undefined ? up + down : normalizeTrafficValue(totalBytes);
  const stmt = db.prepare(`INSERT INTO threexui_inbound_client_traffic (panel_id, inbound_id, email, up_bytes, down_bytes, total_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
    ON CONFLICT(panel_id, inbound_id, email) DO UPDATE SET
      up_bytes = excluded.up_bytes,
      down_bytes = excluded.down_bytes,
      total_bytes = excluded.total_bytes,
      updated_at = excluded.updated_at`);
  stmt.run([panelId, id, email, up, down, total, updatedAt]);
  stmt.free();
}

function getThreeXuiInboundClientTraffic() {
  return connection.all(`SELECT
      t.panel_id,
      p.name as panel_name,
      t.inbound_id,
      COALESCE(i.remark, t.inbound_id) as remark,
      COALESCE(i.tag, '') as tag,
      COALESCE(i.protocol, '') as protocol,
      COALESCE(i.port, 0) as port,
      t.email,
      t.up_bytes,
      t.down_bytes,
      t.total_bytes,
      t.updated_at
    FROM threexui_inbound_client_traffic t
    JOIN threexui_panels p ON p.id = t.panel_id
    LEFT JOIN threexui_inbounds i ON i.panel_id = t.panel_id AND i.inbound_id = t.inbound_id
    WHERE p.is_active = 1
    ORDER BY t.total_bytes DESC, p.name, t.inbound_id, t.email`);
}

function getThreeXuiUsersTraffic() {
  return connection.all(`SELECT
      t.panel_id,
      p.name as panel_name,
      t.email,
      u.id as user_id,
      COALESCE(u.username, t.email) as username,
      t.up_bytes,
      t.down_bytes,
      t.total_bytes,
      t.updated_at
    FROM threexui_client_traffic t
    JOIN threexui_panels p ON p.id = t.panel_id
    LEFT JOIN users u ON u.username = t.email
    WHERE p.is_active = 1
    ORDER BY t.total_bytes DESC, p.name, t.email`);
}

module.exports = {
  ...connection,
  getUserTraffic,
  updateUserTraffic,
  getTrafficSnapshots,
  createTrafficSnapshot,
  getAllUsersTraffic,
  getUserServerUuid,
  getUserServersWithUuid,
  getUserServerAssignments,
  getServerByTag,
  updateServerTraffic,
  getServerTraffic,
  getAllServersTraffic,
  getAvailableMonths,
  getServersTrafficByMonth,
  upsertThreeXuiClientTraffic,
  upsertThreeXuiInboundTraffic,
  getThreeXuiClientTraffic,
  getThreeXuiClientsTraffic,
  getThreeXuiInboundTraffic,
  getThreeXuiInboundTrafficTotals,
  upsertThreeXuiClientMonthlyTraffic,
  upsertThreeXuiInboundMonthlyTraffic,
  getThreeXuiInboundMonthlyTraffic,
  upsertThreeXuiInboundClientTraffic,
  getThreeXuiInboundClientTraffic,
  getThreeXuiUsersTraffic,
  resetAllTraffic
};
