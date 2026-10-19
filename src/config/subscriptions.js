const path = require('path');
const crypto = require('crypto');
const { normalizeHost } = require('../utils/protocolParsers');

function integer(env, key, fallback, min, max) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) throw new Error(`${key}: ожидается целое число`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key}: допустимо ${min}–${max}`);
  return value;
}

function parseHttpProxy(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw new Error('PROBE_HTTP_PROXY: ожидается URL вида http://host:port'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PROBE_HTTP_PROXY: ожидается URL http(s)://host:port без пути и параметров');
  }
  if (!url.port) throw new Error('PROBE_HTTP_PROXY: требуется порт');
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PROBE_HTTP_PROXY: некорректный порт');
  let address;
  try { address = normalizeHost(url.hostname); } catch { throw new Error('PROBE_HTTP_PROXY: некорректный адрес прокси'); }
  const user = url.username ? decodeURIComponent(url.username) : '';
  const pass = url.password ? decodeURIComponent(url.password) : '';
  if (/[\r\n\u0000-\u001f]/.test(user) || /[\r\n\u0000-\u001f]/.test(pass) || user.length > 128 || pass.length > 256) {
    throw new Error('PROBE_HTTP_PROXY: некорректные учётные данные прокси');
  }
  return { protocol: url.protocol === 'https:' ? 'https' : 'http', address, port, user, pass };
}

function loadConfig(env = process.env) {
  let publicDomain = '';
  if (env.PUBLIC_DOMAIN) {
    try {
      const parsed = new URL(`https://${env.PUBLIC_DOMAIN}`);
      if (parsed.hostname !== env.PUBLIC_DOMAIN || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error();
      publicDomain = parsed.hostname;
    } catch {
      throw new Error('PUBLIC_DOMAIN: ожидается доменное имя без протокола, порта или пути');
    }
  }
  const targets = [
    { id: 'primary', url: env.PROBE_PRIMARY_URL || 'https://www.gstatic.com/generate_204', priority: 0, status: 204 },
    { id: 'fallback', url: env.PROBE_FALLBACK_URL || 'https://cp.cloudflare.com/generate_204', priority: 1, status: 204 }
  ];
  for (const target of targets) {
    const url = new URL(target.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('PROBE_*_URL: требуется HTTPS URL без credentials/fragment');
  }
  const config = {
    publicDomain,
    httpProxy: parseHttpProxy(env.PROBE_HTTP_PROXY),
    xrayPath: env.XRAY_PATH || (process.platform === 'win32' ? path.join(__dirname, '../../tools/xray/xray.exe') : '/usr/local/bin/xray'),
    xrayVersion: env.XRAY_VERSION || '26.3.27',
    xraySha256: env.XRAY_SHA256 || '',
    tempDir: path.resolve(env.PROBE_TEMP_DIR || path.join(__dirname, '../../data/probes')),
    probeLocation: env.PROBE_LOCATION || 'subscription-host',
    targets,
    syncIntervalMs: integer(env, 'SOURCE_SYNC_INTERVAL_SECONDS', 1800, 60, 604800) * 1000,
    checkIntervalMs: integer(env, 'PROBE_INTERVAL_SECONDS', 300, 30, 86400) * 1000,
    healthyTtlMs: integer(env, 'PROBE_HEALTH_TTL_SECONDS', 1200, 60, 604800) * 1000,
    sourceTimeoutMs: integer(env, 'SOURCE_TIMEOUT_SECONDS', 15, 1, 120) * 1000,
    maxSourceBytes: integer(env, 'SOURCE_MAX_BYTES', 5 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    maxNodes: integer(env, 'SOURCE_MAX_NODES', 1000, 1, 10000),
    readyTimeoutMs: integer(env, 'PROBE_READY_TIMEOUT_SECONDS', 5, 1, 30) * 1000,
    attemptTimeoutMs: integer(env, 'PROBE_ATTEMPT_TIMEOUT_SECONDS', 5, 1, 30) * 1000,
    deadlineMs: integer(env, 'PROBE_DEADLINE_SECONDS', 40, 5, 180) * 1000,
    concurrency: integer(env, 'PROBE_CONCURRENCY', 4, 1, 64),
    syncConcurrency: integer(env, 'SOURCE_SYNC_CONCURRENCY', 2, 1, 8),
    maxQueued: integer(env, 'PROBE_MAX_QUEUED', 2000, 1, 20000),
    historyDays: integer(env, 'PROBE_HISTORY_DAYS', 7, 1, 30),
    maxHistoryRows: integer(env, 'PROBE_HISTORY_MAX_ROWS', 50000, 100, 200000),
    profileUpdateHours: integer(env, 'PROFILE_UPDATE_INTERVAL_HOURS', 1, 1, 168),
    attempts: 3,
    minSuccess: 2
  };
  const proxyMode = env.PROBE_HTTP_PROXY_MODE === undefined || env.PROBE_HTTP_PROXY_MODE === '' ? 'extra' : env.PROBE_HTTP_PROXY_MODE;
  if (!['extra', 'only'].includes(proxyMode)) throw new Error('PROBE_HTTP_PROXY_MODE: допустимо extra или only');
  if (!config.httpProxy && proxyMode === 'only') throw new Error('PROBE_HTTP_PROXY_MODE=only требует заданный PROBE_HTTP_PROXY');
  config.httpProxyMode = proxyMode;
  if (!path.isAbsolute(config.xrayPath)) throw new Error('XRAY_PATH должен быть абсолютным путём');
  if (!/^\d+\.\d+\.\d+$/.test(config.xrayVersion)) throw new Error('XRAY_VERSION: ожидается версия вида 26.3.27');
  if (config.xraySha256 && !/^[a-f\d]{64}$/i.test(config.xraySha256)) throw new Error('XRAY_SHA256: ожидается SHA-256 бинарника');
  if (config.healthyTtlMs <= config.checkIntervalMs) throw new Error('PROBE_HEALTH_TTL_SECONDS должен быть больше PROBE_INTERVAL_SECONDS');
  if (config.deadlineMs < config.readyTimeoutMs + config.attemptTimeoutMs * config.attempts * targets.length) {
    throw new Error('PROBE_DEADLINE_SECONDS должен вмещать запуск ядра и попытки к обеим целям');
  }
  config.profileVersion = crypto.createHash('sha256').update(JSON.stringify({
    adapter: 2, version: config.xrayVersion, targets, location: config.probeLocation,
    attempts: config.attempts, minSuccess: config.minSuccess, timeout: config.attemptTimeoutMs,
    proxy: config.httpProxy ? `${config.httpProxyMode}:${config.httpProxy.protocol}://${config.httpProxy.address}:${config.httpProxy.port}` : ''
  })).digest('hex');
  return Object.freeze(config);
}

module.exports = { loadConfig, integer };
