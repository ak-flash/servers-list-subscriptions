const crypto = require('crypto');
const { parseHttpProxy } = require('../config/subscriptions');
const db = require('../db/database');

const KEY_PROXY = 'probe_http_proxy';
const KEY_MODE = 'probe_http_proxy_mode';
const KEY_CHECK_INTERVAL = 'probe_check_interval_seconds';
const KEY_HEALTHY_TTL = 'probe_healthy_ttl_seconds';
const EDITABLE_SETTINGS = [
  ['sourceTimeoutSeconds', 'source_timeout_seconds', 1, 120, 'Таймаут загрузки источника'],
  ['readyTimeoutSeconds', 'probe_ready_timeout_seconds', 1, 30, 'Таймаут запуска Xray'],
  ['attemptTimeoutSeconds', 'probe_attempt_timeout_seconds', 1, 30, 'Таймаут попытки VPN-проверки'],
  ['deadlineSeconds', 'probe_deadline_seconds', 5, 180, 'Общий таймаут VPN-проверки'],
  ['probeConcurrency', 'probe_concurrency', 1, 64, 'Параллельные VPN-проверки'],
  ['syncConcurrency', 'source_sync_concurrency', 1, 8, 'Параллельные загрузки источников'],
  ['maxQueued', 'probe_max_queued', 1, 20000, 'Максимум задач в очереди']
];

function parseInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}: допустимо ${min}–${max}`);
  return number;
}

function parseSeconds(value, fallback, min, max, label) {
  return parseInteger(value, min, max, `${label} секунд`);
}

function parseStoredProxy(row) {
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || !['http', 'https'].includes(parsed.protocol)) return null;
    const auth = parsed.user ? `${encodeURIComponent(parsed.user)}${parsed.pass ? ':' + encodeURIComponent(parsed.pass) : ''}@` : '';
    return parseHttpProxy(`${parsed.protocol}://${auth}${parsed.address}:${parsed.port}`);
  } catch { return null; }
}

function loadSettings(config = {}) {
  const proxyRow = db.get('SELECT value FROM app_state WHERE key = ?', [KEY_PROXY]);
  const modeRow = db.get('SELECT value FROM app_state WHERE key = ?', [KEY_MODE]);
  const checkIntervalRow = db.get('SELECT value FROM app_state WHERE key = ?', [KEY_CHECK_INTERVAL]);
  const healthyTtlRow = db.get('SELECT value FROM app_state WHERE key = ?', [KEY_HEALTHY_TTL]);
  const settingRows = db.all(`SELECT key, value FROM app_state WHERE key IN (${EDITABLE_SETTINGS.map(() => '?').join(',')})`, EDITABLE_SETTINGS.map(([, key]) => key));
  const storedValues = new Map(settingRows.map(row => [row.key, Number(row.value)]));
  const proxy = parseStoredProxy(proxyRow);
  const mode = ['extra', 'only'].includes(modeRow?.value) ? modeRow.value : undefined;
  const checkIntervalSeconds = checkIntervalRow ? parseSeconds(checkIntervalRow.value, config.checkIntervalMs / 1000, 30, 86400, 'Интервал VPN-проверки') : undefined;
  const healthyTtlSeconds = healthyTtlRow ? parseSeconds(healthyTtlRow.value, config.healthyTtlMs / 1000, 60, 604800, 'Срок актуальности VPN-проверки') : undefined;
  const defaults = {
    sourceTimeoutSeconds: config.sourceTimeoutMs === undefined ? undefined : config.sourceTimeoutMs / 1000,
    readyTimeoutSeconds: config.readyTimeoutMs === undefined ? undefined : config.readyTimeoutMs / 1000,
    attemptTimeoutSeconds: config.attemptTimeoutMs === undefined ? undefined : config.attemptTimeoutMs / 1000,
    deadlineSeconds: config.deadlineMs === undefined ? undefined : config.deadlineMs / 1000,
    probeConcurrency: config.concurrency,
    syncConcurrency: config.syncConcurrency,
    maxQueued: config.maxQueued
  };
  const values = {};
  for (const [property, key, min, max, label] of EDITABLE_SETTINGS) {
    const row = storedValues.get(key);
    values[property] = row === undefined ? defaults[property] : parseInteger(row, min, max, label);
  }
  if (!proxyRow && !modeRow && !checkIntervalRow && !healthyTtlRow && !settingRows.length) return { proxy: undefined, mode: undefined, checkIntervalSeconds: undefined, healthyTtlSeconds: undefined, ...values };
  if (!proxy && mode === 'only') return { proxy: null, mode: 'extra', checkIntervalSeconds, healthyTtlSeconds, ...values };
  return { proxy, mode, checkIntervalSeconds, healthyTtlSeconds, ...values };
}

function saveSettings(values, config = {}) {
  const { proxyUrl, mode, checkIntervalSeconds, healthyTtlSeconds } = values;
  const proxy = parseHttpProxy(proxyUrl || '');
  const proxyMode = ['extra', 'only'].includes(mode) ? mode : 'extra';
  const checkSeconds = parseSeconds(checkIntervalSeconds ?? config.checkIntervalMs / 1000 ?? 300, 300, 30, 86400, 'Интервал VPN-проверки');
  const ttlSeconds = parseSeconds(healthyTtlSeconds ?? config.healthyTtlMs / 1000 ?? 1200, 1200, 60, 604800, 'Срок актуальности VPN-проверки');
  const parsed = {};
  const defaults = {
    sourceTimeoutSeconds: config.sourceTimeoutMs / 1000,
    readyTimeoutSeconds: config.readyTimeoutMs / 1000,
    attemptTimeoutSeconds: config.attemptTimeoutMs / 1000,
    deadlineSeconds: config.deadlineMs / 1000,
    probeConcurrency: config.concurrency,
    syncConcurrency: config.syncConcurrency,
    maxQueued: config.maxQueued
  };
  for (const [property, , min, max, label] of EDITABLE_SETTINGS) parsed[property] = parseInteger(values[property] ?? defaults[property], min, max, label);
  if (ttlSeconds <= checkSeconds) throw new Error('Срок актуальности VPN-проверки должен быть больше интервала проверки');
  if (!proxy && proxyMode === 'only') throw new Error('PROBE_HTTP_PROXY_MODE=only требует заданный PROBE_HTTP_PROXY');
  db.transaction(() => {
    db.run('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY_PROXY, proxy ? JSON.stringify(proxy) : '']);
    db.run('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY_MODE, proxyMode]);
    db.run('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY_CHECK_INTERVAL, String(checkSeconds)]);
    db.run('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY_HEALTHY_TTL, String(ttlSeconds)]);
    for (const [property, key] of EDITABLE_SETTINGS) db.run('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(parsed[property])]);
  });
  return { proxy, mode: proxyMode, checkIntervalSeconds: checkSeconds, healthyTtlSeconds: ttlSeconds, ...parsed };
}

function effectiveHttpProxy(envProxy, envMode, config = {}) {
  const stored = loadSettings(config);
  const proxy = stored.proxy === undefined ? envProxy : stored.proxy;
  const mode = stored.mode === undefined ? envMode : stored.mode;
  if (!proxy && mode === 'only') return { proxy: null, mode: 'extra', checkIntervalSeconds: stored.checkIntervalSeconds, healthyTtlSeconds: stored.healthyTtlSeconds };
  return { proxy, mode, checkIntervalSeconds: stored.checkIntervalSeconds, healthyTtlSeconds: stored.healthyTtlSeconds };
}

function applySettingsToConfig(config) {
  const stored = loadSettings(config);
  const next = { ...config };
  if (stored.checkIntervalSeconds !== undefined) next.checkIntervalMs = stored.checkIntervalSeconds * 1000;
  if (stored.healthyTtlSeconds !== undefined) next.healthyTtlMs = stored.healthyTtlSeconds * 1000;
  for (const [property] of EDITABLE_SETTINGS) {
    if (stored[property] !== undefined) next[property] = stored[property];
  }
  next.sourceTimeoutSeconds ??= config.sourceTimeoutMs / 1000;
  next.readyTimeoutSeconds ??= config.readyTimeoutMs / 1000;
  next.attemptTimeoutSeconds ??= config.attemptTimeoutMs / 1000;
  next.deadlineSeconds ??= config.deadlineMs / 1000;
  next.probeConcurrency ??= config.concurrency;
  next.syncConcurrency ??= config.syncConcurrency;
  next.maxQueued ??= config.maxQueued;
  next.sourceTimeoutMs = next.sourceTimeoutSeconds * 1000;
  next.readyTimeoutMs = next.readyTimeoutSeconds * 1000;
  next.attemptTimeoutMs = next.attemptTimeoutSeconds * 1000;
  next.deadlineMs = next.deadlineSeconds * 1000;
  next.concurrency = next.probeConcurrency;
  if (next.healthyTtlMs <= next.checkIntervalMs) throw new Error('Срок актуальности VPN-проверки должен быть больше интервала проверки');
  if (next.deadlineMs < next.readyTimeoutMs + next.attemptTimeoutMs * next.attempts * next.targets.length) throw new Error('Общий таймаут VPN-проверки слишком мал для заданных таймаутов');
  return Object.freeze(next);
}

function applyProxyToConfig(config, { proxy, mode }) {
  const next = { ...config, httpProxy: proxy, httpProxyMode: mode };
  next.profileVersion = crypto.createHash('sha256').update(JSON.stringify({
    adapter: 2, version: config.xrayVersion, targets: config.targets, location: config.probeLocation,
    attempts: config.attempts, minSuccess: config.minSuccess, timeout: config.attemptTimeoutMs,
    proxy: proxy ? `${mode}:${proxy.protocol}://${proxy.address}:${proxy.port}` : ''
  })).digest('hex');
  return Object.freeze(next);
}

function proxyUrlForDisplay(proxy) {
  if (!proxy) return '';
  const auth = proxy.user ? `${encodeURIComponent(proxy.user)}${proxy.pass ? ':' + encodeURIComponent(proxy.pass) : ''}@` : '';
  return `${proxy.protocol}://${auth}${proxy.address}:${proxy.port}`;
}

module.exports = { loadSettings, saveSettings, effectiveHttpProxy, applySettingsToConfig, applyProxyToConfig, proxyUrlForDisplay, EDITABLE_SETTINGS };
