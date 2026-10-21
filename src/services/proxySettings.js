const crypto = require('crypto');
const { parseHttpProxy } = require('../config/subscriptions');
const db = require('../db/database');

const KEY_PROXY = 'probe_http_proxy';
const KEY_MODE = 'probe_http_proxy_mode';

function parseStoredProxy(row) {
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || !['http', 'https'].includes(parsed.protocol)) return null;
    const auth = parsed.user ? `${encodeURIComponent(parsed.user)}${parsed.pass ? ':' + encodeURIComponent(parsed.pass) : ''}@` : '';
    return parseHttpProxy(`${parsed.protocol}://${auth}${parsed.address}:${parsed.port}`);
  } catch { return null; }
}

function loadSettings() {
  const proxyRow = db.get('SELECT value FROM app_state WHERE key = ?', [KEY_PROXY]);
  const modeRow = db.get('SELECT value FROM app_state WHERE key = ?', [KEY_MODE]);
  if (!proxyRow && !modeRow) return { proxy: undefined, mode: undefined };
  const proxy = parseStoredProxy(proxyRow);
  const mode = ['extra', 'only'].includes(modeRow?.value) ? modeRow.value : 'extra';
  if (!proxy && mode === 'only') return { proxy: null, mode: 'extra' };
  return { proxy, mode };
}

function saveSettings({ proxyUrl, mode }) {
  const proxy = parseHttpProxy(proxyUrl || '');
  const proxyMode = ['extra', 'only'].includes(mode) ? mode : 'extra';
  if (!proxy && proxyMode === 'only') throw new Error('PROBE_HTTP_PROXY_MODE=only требует заданный PROBE_HTTP_PROXY');
  db.run('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY_PROXY, proxy ? JSON.stringify(proxy) : '']);
  db.run('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY_MODE, proxyMode]);
  return { proxy, mode: proxyMode };
}

function effectiveHttpProxy(envProxy, envMode) {
  const stored = loadSettings();
  const proxy = stored.proxy === undefined ? envProxy : stored.proxy;
  const mode = stored.mode === undefined ? envMode : stored.mode;
  if (!proxy && mode === 'only') return { proxy: null, mode: 'extra' };
  return { proxy, mode };
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

module.exports = { loadSettings, saveSettings, effectiveHttpProxy, applyProxyToConfig, proxyUrlForDisplay };
