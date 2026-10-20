const crypto = require('crypto');
const db = require('../db/database');
const { SubscriptionError } = require('../utils/subscriptionErrors');
const logger = require('../utils/logger');

const MAX_PANELS = 50;
const MIN_SYNC_SECONDS = 30;
const MAX_SYNC_SECONDS = 86400;
const MAX_PANEL_NAME = 120;
const DEFAULT_TIMEOUT_MS = 15000;
const runningPanels = new Set();

function normalizeText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeName(value) {
  const name = normalizeText(value);
  if (!name || name.length > MAX_PANEL_NAME) throw new SubscriptionError('validation', `Укажите название панели длиной до ${MAX_PANEL_NAME} символов.`);
  return name;
}

function normalizeSyncSeconds(value, fallback = 300) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < MIN_SYNC_SECONDS || number > MAX_SYNC_SECONDS) {
    throw new SubscriptionError('validation', `Интервал синхронизации должен быть от ${MIN_SYNC_SECONDS} до ${MAX_SYNC_SECONDS} секунд.`);
  }
  return number;
}

function normalizeToken(value) {
  const token = normalizeText(value);
  if (!token || token.length > 2048 || /[\r\n\u0000]/.test(token)) throw new SubscriptionError('validation', 'Укажите корректный API token.');
  return token;
}

function normalizeBaseUrl(value) {
  const raw = normalizeText(value);
  if (!raw || raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw)) throw new SubscriptionError('validation', 'Укажите корректный URL панели 3x-ui.');
  let url;
  try { url = new URL(raw); }
  catch { throw new SubscriptionError('validation', 'Укажите корректный URL панели 3x-ui.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new SubscriptionError('validation', 'URL панели должен использовать HTTP или HTTPS.');
  url.hash = '';
  url.search = '';
  return url;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function resolveEndpoint(baseUrl, path) {
  const url = new URL(baseUrl.href);
  url.pathname = `${stripTrailingSlash(url.pathname)}${path.startsWith('/') ? path : `/${path}`}`;
  return url;
}

function trafficValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function toIsoTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number).toISOString();
}

function toIsoFromSql(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function publicPanel(panel) {
  if (!panel) return null;
  return {
    id: panel.id,
    name: panel.name,
    baseUrl: panel.base_url,
    isActive: Boolean(panel.is_active),
    syncIntervalSeconds: panel.sync_interval_seconds,
    lastSyncAt: toIsoFromSql(panel.last_sync_at),
    lastSyncError: panel.last_sync_error,
    createdAt: toIsoFromSql(panel.created_at),
    updatedAt: toIsoFromSql(panel.updated_at)
  };
}

function listPanels() {
  return db.all('SELECT * FROM threexui_panels ORDER BY created_at ASC, id ASC');
}

function getPanel(id) {
  return db.get('SELECT * FROM threexui_panels WHERE id = ?', [id]);
}

function createPanel(input) {
  if (listPanels().length >= MAX_PANELS) throw new SubscriptionError('validation', `Допустимо не более ${MAX_PANELS} панелей.`);
  const panel = {
    id: crypto.randomBytes(8).toString('hex'),
    name: normalizeName(input.name),
    base_url: normalizeBaseUrl(input.base_url || input.baseUrl).href,
    token: normalizeToken(input.token),
    is_active: ['1', 1, true, 'on'].includes(input.is_active) ? 1 : 0,
    sync_interval_seconds: normalizeSyncSeconds(input.sync_interval_seconds)
  };
  db.run(`INSERT INTO threexui_panels (id, name, base_url, token, is_active, sync_interval_seconds, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  [panel.id, panel.name, panel.base_url, panel.token, panel.is_active, panel.sync_interval_seconds]);
  return getPanel(panel.id);
}

function updatePanel(id, input) {
  const current = getPanel(id);
  if (!current) throw new SubscriptionError('not_found', 'Панель не найдена.', 404);
  const next = {
    name: normalizeName(input.name),
    base_url: normalizeBaseUrl(input.base_url || input.baseUrl).href,
    token: normalizeToken(input.token),
    is_active: ['1', 1, true, 'on'].includes(input.is_active) ? 1 : 0,
    sync_interval_seconds: normalizeSyncSeconds(input.sync_interval_seconds, current.sync_interval_seconds)
  };
  db.run(`UPDATE threexui_panels SET name = ?, base_url = ?, token = ?, is_active = ?, sync_interval_seconds = ?, updated_at = datetime('now') WHERE id = ?`,
    [next.name, next.base_url, next.token, next.is_active, next.sync_interval_seconds, id]);
  return getPanel(id);
}

function deletePanel(id) {
  db.transaction(() => {
    db.run('DELETE FROM threexui_panels WHERE id = ?', [id]);
  });
}

function markSyncSuccess(id, timestamp) {
  db.run(`UPDATE threexui_panels SET last_sync_at = datetime('now'), last_sync_error = NULL, updated_at = datetime('now') WHERE id = ?`, [id]);
  return timestamp;
}

function markSyncError(id, error) {
  db.run(`UPDATE threexui_panels SET last_sync_error = ?, updated_at = datetime('now') WHERE id = ?`, [normalizeText(error?.message || String(error)).slice(0, 500)]);
}

function saveInboundTraffic(panelId, inbound) {
  db.upsertThreeXuiInboundTraffic(panelId, inbound);
  const inboundId = Number.parseInt(inbound.id, 10);
  const clients = Array.isArray(inbound.clientStats) ? inbound.clientStats : [];
  for (const client of clients) {
    const email = normalizeText(client?.email || client?.client?.email);
    if (!email) continue;
    const up = trafficValue(client.up);
    const down = trafficValue(client.down);
    const total = trafficValue(client.total) || up + down;
    const updatedAt = toIsoTimestamp(client.lastOnline);
    db.upsertThreeXuiClientTraffic(panelId, email, up, down, total, updatedAt);
    if (Number.isInteger(inboundId) && inboundId >= 0) db.upsertThreeXuiInboundClientTraffic(panelId, inboundId, email, up, down, total, updatedAt);
  }
}

async function requestJson(panel, path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = resolveEndpoint(panel.base_url, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new SubscriptionError('timeout', 'Таймаут запроса к 3x-ui.')), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${panel.token}` },
      redirect: 'error',
      signal: controller.signal
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; }
    catch { throw new SubscriptionError('invalid_response', '3x-ui вернул не-JSON ответ.'); }
    if (!response.ok || !payload || payload.success === false) {
      throw new SubscriptionError('api_error', `3x-ui API вернул ошибку ${response.status}${payload?.msg ? `: ${payload.msg}` : ''}`, response.status);
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason || error;
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError('request_failed', 'Не удалось подключиться к 3x-ui API.');
  } finally {
    clearTimeout(timer);
  }
}

async function syncPanel(id, options = {}) {
  if (runningPanels.has(id)) return { skipped: true };
  runningPanels.add(id);
  try {
    const panel = getPanel(id);
    if (!panel) throw new SubscriptionError('not_found', 'Панель не найдена.', 404);
    if (!panel.is_active && !options.force) return { skipped: true };
    const response = await requestJson(panel, '/panel/api/inbounds/list', { timeoutMs: options.timeoutMs });
    const inbounds = Array.isArray(response.obj) ? response.obj : [];
    db.transaction(() => {
      for (const inbound of inbounds) saveInboundTraffic(id, inbound);
    });
    markSyncSuccess(id, new Date().toISOString());
    logger.info('threexui_sync_completed', { panelId: id, inbounds: inbounds.length });
    return { inbounds: inbounds.length };
  } catch (error) {
    try { markSyncError(id, error); } catch (dbError) { logger.error('threexui_sync_error_save_failed', { panelId: id, error: dbError.message }); }
    logger.error('threexui_sync_failed', { panelId: id, error: error.message });
    throw error;
  } finally {
    runningPanels.delete(id);
  }
}

async function syncAll(options = {}) {
  const panels = listPanels().filter(panel => options.includeInactive || panel.is_active);
  const results = [];
  for (const panel of panels) {
    try {
      const result = await syncPanel(panel.id, { force: options.force, timeoutMs: options.timeoutMs });
      results.push({ panelId: panel.id, status: 'ok', ...result });
    } catch (error) {
      results.push({ panelId: panel.id, status: 'error', error: error.message });
    }
  }
  return results;
}

function inboundSummary() {
  return db.getThreeXuiInboundTrafficTotals();
}

module.exports = {
  createPanel,
  updatePanel,
  deletePanel,
  getPanel,
  listPanels,
  publicPanel,
  syncPanel,
  syncAll,
  inboundSummary
};
