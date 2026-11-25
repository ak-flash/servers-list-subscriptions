const threeXui = require('./threeXui');
const logger = require('../utils/logger');

class ThreeXuiScheduler {
  constructor(options = {}) {
    this.disabled = Boolean(options.disabled);
    this.intervalMs = Math.max(5000, options.intervalMs || Number(process.env.THREEXUI_POLL_INTERVAL_MS) || 30000);
    this.concurrency = Math.max(1, options.concurrency || Number(process.env.THREEXUI_SYNC_CONCURRENCY) || 3);
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
      // Sync a bounded number of panels at once so one slow panel cannot hold
      // up the rest, while still avoiding an unbounded burst of requests.
      const concurrency = Math.max(1, Number(options.concurrency) || this.concurrency);
      for (let index = 0; index < panels.length; index += concurrency) {
        const batch = panels.slice(index, index + concurrency);
        const settled = await Promise.all(batch.map(panel => this.syncOne(panel, options)));
        results.push(...settled);
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  async syncOne(panel, options) {
    const startedAt = Date.now();
    try {
      await threeXui.syncPanel(panel.id, { timeoutMs: options.timeoutMs });
      return { panelId: panel.id, status: 'ok', durationMs: Date.now() - startedAt };
    } catch (error) {
      logger.warn('threexui_panel_sync_failed', { panelId: panel.id, error: error.message, durationMs: Date.now() - startedAt });
      return { panelId: panel.id, status: 'error', error: error.message, durationMs: Date.now() - startedAt };
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
