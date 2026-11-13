module.exports = {
  version: 18,
  up(db) {
    // How the remaining traffic is shown in the subscription remark:
    // 'full' — "remaining/total GB", 'remaining' — "remaining GB" only.
    db.run(`ALTER TABLE servers ADD COLUMN traffic_display TEXT NOT NULL DEFAULT 'full'
      CHECK (traffic_display IN ('full', 'remaining'))`);
  }
};
