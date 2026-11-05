const path = require('path');
const crypto = require('crypto');
const { normalizeHost } = require('../utils/protocolParsers');

const PROBE_POLICY_VERSION = 3;

function probeProfileVersion(config) {
  const proxy = config.httpProxy;
  return crypto.createHash('sha256').update(JSON.stringify({
    policy: PROBE_POLICY_VERSION, adapter: 2, version: config.xrayVersion, checksum: config.xraySha256 || '',
    targets: config.targets, location: config.probeLocation,
    attempts: config.attempts, minSuccess: config.minSuccess,
    readyTimeoutMs: config.readyTimeoutMs, attemptTimeoutMs: config.attemptTimeoutMs, deadlineMs: config.deadlineMs,
    proxyMode: config.httpProxyMode || 'extra',
    // Credentials affect connectivity, but only their contribution to this digest is persisted with checks.
    proxy: proxy ? { protocol: proxy.protocol, address: proxy.address, port: proxy.port, user: proxy.user || '', pass: proxy.pass || '' } : null
  })).digest('hex');
}

function snapshotProbeConfig(config) {
  return Object.freeze({
    ...config,
    targets: Object.freeze(config.targets.map(target => Object.freeze({ ...target }))),
    httpProxy: config.httpProxy ? Object.freeze({ ...config.httpProxy }) : null
  });
}

function deadlineMode(env, key = 'PROBE_DEADLINE_SECONDS') {
  const raw = env[key];
  if (raw === undefined) return { mode: 'explicit', seconds: 90 };
  if (raw === '') return { mode: 'auto', seconds: null };
  if (String(raw).toLowerCase() === 'auto') return { mode: 'auto', seconds: null };
  return { mode: 'explicit', seconds: integer(env, key, 5, 5, 180) };
}

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
  const deadline = deadlineMode(env);
  const config = {
    publicDomain,
    httpProxy: parseHttpProxy(env.PROBE_HTTP_PROXY),
    xrayPath: env.XRAY_PATH || (process.platform === 'win32' ? path.join(__dirname, '../../tools/xray/xray.exe') : '/usr/local/bin/xray'),
    xrayVersion: env.XRAY_VERSION || '26.10.21',
    xraySha256: env.XRAY_SHA256 || '',
    tempDir: path.resolve(env.PROBE_TEMP_DIR || path.join(__dirname, '../../data/probes')),
    probeLocation: env.PROBE_LOCATION || 'subscription-host',
    targets,
    syncIntervalMs: integer(env, 'SOURCE_SYNC_INTERVAL_SECONDS', 1800, 60, 604800) * 1000,
    // Checks are intentionally not allowed more often than every 5 minutes:
    // this leaves the queue time to drain and prevents probing storms.
    checkIntervalMs: integer(env, 'PROBE_INTERVAL_SECONDS', 300, 300, 86400) * 1000,
    healthyTtlMs: 0,
    hardExpiryMs: 0,
    sourceTimeoutMs: integer(env, 'SOURCE_TIMEOUT_SECONDS', 15, 1, 120) * 1000,
    maxSourceBytes: integer(env, 'SOURCE_MAX_BYTES', 5 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    maxNodes: integer(env, 'SOURCE_MAX_NODES', 1000, 1, 10000),
    sourceMinRetainRatio: env.SOURCE_MIN_RETAIN_RATIO === undefined || env.SOURCE_MIN_RETAIN_RATIO === '' ? 0 : Number(env.SOURCE_MIN_RETAIN_RATIO),
    sourceMinRetainNodes: integer(env, 'SOURCE_MIN_RETAIN_NODES', 20, 1, 10000),
    sourceConfirmationIntervalMs: integer(env, 'SOURCE_CONFIRMATION_INTERVAL_SECONDS', 60, 1, 86400) * 1000,
    sourceConfirmations: integer(env, 'SOURCE_CONFIRMATIONS', 2, 1, 10),
    // Defaults are sized for a three-attempt, two-target cycle with margin.
    readyTimeoutMs: integer(env, 'PROBE_READY_TIMEOUT_SECONDS', 10, 1, 30) * 1000,
    attemptTimeoutMs: integer(env, 'PROBE_ATTEMPT_TIMEOUT_SECONDS', 10, 1, 30) * 1000,
    deadlineMs: deadline.seconds === null ? null : deadline.seconds * 1000,
    deadlineMode: deadline.mode,
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
  if (!['disabled', 'extra', 'only'].includes(proxyMode)) throw new Error('PROBE_HTTP_PROXY_MODE: допустимо disabled, extra или only');
  if (!Number.isFinite(config.sourceMinRetainRatio) || config.sourceMinRetainRatio < 0 || config.sourceMinRetainRatio > 1) throw new Error('SOURCE_MIN_RETAIN_RATIO: допустимо 0–1');
  if (!config.httpProxy && proxyMode === 'only') throw new Error('PROBE_HTTP_PROXY_MODE=only требует заданный PROBE_HTTP_PROXY');
  config.httpProxyMode = proxyMode;
  if (!path.isAbsolute(config.xrayPath)) throw new Error('XRAY_PATH должен быть абсолютным путём');
  if (!/^\d+\.\d+\.\d+$/.test(config.xrayVersion)) throw new Error('XRAY_VERSION: ожидается версия вида 26.3.27');
  if (config.xraySha256 && !/^[a-f\d]{64}$/i.test(config.xraySha256)) throw new Error('XRAY_SHA256: ожидается SHA-256 бинарника');
  config.healthyTtlMs = config.checkIntervalMs + 900000;
  config.hardExpiryMs = config.healthyTtlMs * 2;
  config.deadlineMs = require('../utils/probeBudget').probeBudget(config).deadlineMs;
  config.profileVersion = probeProfileVersion(config);
  return snapshotProbeConfig(config);
}

module.exports = { loadConfig, integer, deadlineMode, parseHttpProxy, probeProfileVersion, snapshotProbeConfig, PROBE_POLICY_VERSION };
