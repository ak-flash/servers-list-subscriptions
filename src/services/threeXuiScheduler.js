const threeXui = require('./threeXui');
const logger = require('../utils/logger');

class ThreeXuiScheduler {
  constructor(options = {}) {
    this.disabled = Boolean(options.disabled);
    this.intervalMs = Math.max(5000, options.intervalMs || Number(process.env.THREEXUI_POLL_INTERVAL_MS) || 30000);
    this.timer = null;
    this.running = false;
  }

  due(now = Date.now()) {
    return threeXui.listPanels().filter(panel => {
      if (!panel.is_active) return false;
      const interval = Math.max(30, Number(panel.sync_interval_seconds) || 300) * 1000;
      if (!panel.last_sync_at) return true;
      const synced = new Date(String(panel.last_sync_at).replace(' ', 'T') + 'Z').getTime();
      return !Number.isFinite(synced) || now - synced >= interval;
    });
  }

  async tick(options = {}) {
    if (this.running) return [];
    this.running = true;
    try {
      const panels = this.due(options.now ?? Date.now());
      const results = [];
      for (const panel of panels) {
        try {
          await threeXui.syncPanel(panel.id, { timeoutMs: options.timeoutMs });
          results.push({ panelId: panel.id, status: 'ok' });
        } catch (error) {
          results.push({ panelId: panel.id, status: 'error', error: error.message });
        }
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  async start(options = {}) {
    if (this.timer || this.disabled) return;
    const tick = () => this.tick(options).catch(error => logger.error('threexui_tick_failed', { error: error.message }));
    this.timer = setInterval(tick, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    await tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { ThreeXuiScheduler };
