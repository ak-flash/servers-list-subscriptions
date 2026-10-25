const crypto = require('crypto');
const net = require('net');
const { TextDecoder } = require('util');
const { domainToASCII } = require('url');
const { SubscriptionError } = require('./subscriptionErrors');

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const KNOWN_PARAMS = new Set(['encryption', 'type', 'security', 'sni', 'alpn', 'fp', 'flow', 'host', 'path', 'headerType', 'allowInsecure', 'insecure', 'extra', 'mode', 'serviceName', 'authority', 'fm', 'x_padding_bytes', 'packetEncoding']);
const METADATA_PARAMS = new Set(['telegram']);
const REALITY_PARAMS = new Set(['pbk', 'sid', 'spx', 'pqv']);
const FINGERPRINTS = new Set(['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized']);
const PACKET_ENCODINGS = new Set(['', 'xudp']);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(config) {
  return crypto.createHash('sha256').update(canonicalJson(config)).digest('hex');
}

function normalizeHost(host) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return new URL(`http://${net.isIP(host) === 6 ? `[${host}]` : host}`).hostname.replace(/^\[|\]$/g, '');
  const ascii = domainToASCII(host.replace(/\.$/, ''));
  if (!ascii || ascii.length > 253 || !ascii.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
    throw new SubscriptionError('invalid_link');
  }
  return ascii;
}

function isBase64UrlKey(value, bytes) {
  if (typeof value !== 'string' || !/^[a-z\d_-]+$/i.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value;
}

function vlessCapability(config) {
  const unsupported = error => ({ capability: 'unsupported', error });
  const invalid = error => ({ capability: 'invalid', error });
  if (config.protocol !== 'vless' || !['tls', 'reality', 'none'].includes(config.security)) {
    return unsupported('Поддерживаются VLESS с security=tls, reality или none.');
  }
  if (!['tcp', 'ws', 'xhttp', 'grpc', 'httpupgrade'].includes(config.network)) return unsupported('Поддерживаются транспорты TCP/RAW, WebSocket, XHTTP, gRPC и HTTPUpgrade.');
  if (config.security === 'reality' && !['tcp', 'xhttp', 'grpc'].includes(config.network)) return unsupported('Reality поддерживается с транспортами TCP/RAW, XHTTP и gRPC.');
  if (!PACKET_ENCODINGS.has(config.packetEncoding || '')) return unsupported('Неизвестный packetEncoding.');
  if (config.encryption !== 'none' || config.headerType !== 'none' || Object.keys(config.extra || {}).length) {
    return unsupported('Ссылка содержит неподдерживаемые параметры подключения.');
  }
  if (!FINGERPRINTS.has(config.fingerprint)) return unsupported('Неизвестный TLS fingerprint.');
  if (config.flow && (config.flow !== 'xtls-rprx-vision' || config.network !== 'tcp' || config.security === 'none')) {
    return unsupported('Flow xtls-rprx-vision поддерживается только с TCP/RAW и TLS или Reality.');
  }
  if (config.ws && (!config.ws.path.startsWith('/') || /[\r\n]/.test(config.ws.host))) return unsupported('Неподдерживаемые параметры WebSocket.');
  if (config.httpupgrade && (!config.httpupgrade.path.startsWith('/') || /[\r\n]/.test(config.httpupgrade.host))) return unsupported('Неподдерживаемые параметры HTTPUpgrade.');
  if (config.xhttp && (!config.xhttp.path.startsWith('/') || /[\r\n]/.test(config.xhttp.host) || !['auto', 'packet-up', 'stream-up', 'stream-one'].includes(config.xhttp.mode))) return invalid('Неподдерживаемые параметры XHTTP.');
  if (config.grpc && (/[\r\n]/.test(config.grpc.serviceName) || /[\r\n]/.test(config.grpc.authority || '') || !['gun', 'multi'].includes(config.grpc.mode))) return invalid('Для gRPC нужен mode=gun или mode=multi.');
  if (config.finalmask) {
    if (!Array.isArray(config.finalmask.tcp)) return invalid('FinalMask tcp должен быть массивом.');
    for (const mask of config.finalmask.tcp) {
      if (!mask || mask.type !== 'fragment' || !mask.settings || !Array.isArray(mask.settings.delays) || !Array.isArray(mask.settings.lengths) || !['tlshello', ''].includes(mask.settings.packets || '')) return unsupported('Поддерживается только TCP fragment FinalMask для tlshello.');
      const settings = mask.settings;
      if (!settings.delays.every(value => /^\d+(?:-\d+)?$/.test(String(value))) || !settings.lengths.every(value => /^\d+(?:-\d+)?$/.test(String(value))) || (settings.maxSplit !== undefined && !/^\d+(?:-\d+)?$/.test(String(settings.maxSplit)))) return invalid('Некорректные диапазоны TCP fragment FinalMask.');
    }
  }
  if (config.xhttp?.extra && typeof config.xhttp.extra !== 'object') return invalid('Параметр XHTTP extra должен быть JSON-объектом.');
  if (config.xhttp?.extra?.downloadSettings) {
    const download = config.xhttp.extra.downloadSettings;
    if (!download || typeof download !== 'object' || Array.isArray(download) || typeof download.address !== 'string' || !Number.isInteger(Number(download.port)) || Number(download.port) < 1 || Number(download.port) > 65535 || !['xhttp', 'splithttp'].includes(download.network)) {
      return invalid('Некорректные XHTTP downloadSettings.');
    }
  }
  if (config.security === 'reality') {
    if (!config.reality || !isBase64UrlKey(config.reality.publicKey, 32)) return invalid('Для Reality требуется корректный публичный ключ pbk: 32 байта в Base64URL без padding.');
    if (!/^(?:[a-f\d]{2}){0,8}$/.test(config.reality.shortId)) return invalid('Reality sid должен содержать от 0 до 16 шестнадцатеричных символов, с чётной длиной.');
    if (!config.reality.spiderX.startsWith('/')) return invalid('Параметр Reality spx должен начинаться с /.');
    if (config.reality.mldsa65Verify && !isBase64UrlKey(config.reality.mldsa65Verify, 1952)) return invalid('Некорректный ключ проверки Reality pqv.');
    if (config.alpn.length) return unsupported('Явная настройка ALPN для Reality не поддерживается закреплённой версией Xray.');
  }
  return { capability: 'supported', error: null };
}

function parseHysteria2(raw) {
  if (typeof raw !== 'string' || raw.length > 16384 || /[\s\u0000-\u001f\u007f]/u.test(raw)) throw new SubscriptionError('invalid_link');
  let url;
  let name;
  try {
    if (/%(?![a-f\d]{2})/i.test(raw)) throw new Error();
    url = new URL(raw);
    name = decodeURIComponent(url.hash.slice(1));
    decodeURIComponent(url.username);
    decodeURIComponent(url.search.replace(/\+/g, ' '));
  } catch {
    throw new SubscriptionError('invalid_link');
  }
  if (url.protocol !== 'hysteria2:' || !url.username || url.password || !url.port || !['', '/'].includes(url.pathname)) {
    throw new SubscriptionError('invalid_link');
  }
  const host = normalizeHost(url.hostname);
  const port = Number(url.port);
  const sni = url.searchParams.get('sni') || host;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new SubscriptionError('invalid_link');
  }
  if (!sni || /[\r\n]/.test(sni)) throw new SubscriptionError('invalid_link');
  const config = { schema_version: 1, protocol: 'hysteria2', host, port, password: decodeURIComponent(url.username), sni,
    insecure: ['1', 'true'].includes(url.searchParams.get('insecure') || ''), obfs: url.searchParams.get('obfs') || '', obfsPassword: url.searchParams.get('obfs-password') || '' };
  const supported = !config.obfs && ![...url.searchParams.keys()].some(key => !['sni', 'insecure', 'obfs', 'obfs-password'].includes(key));
  return { config, name: name || `${host}:${port}`, fingerprint: fingerprint(config), capability: supported ? 'supported' : 'unsupported', error: supported ? null : 'Ссылка содержит неподдерживаемые параметры Hysteria2.' };
}

function parseVmess(raw) {
  if (typeof raw !== 'string' || raw.length > 16384 || /[\s\u0000-\u001f\u007f]/u.test(raw)) throw new SubscriptionError('invalid_link');
  let data;
  try {
    const match = /^vmess:\/\/(.+)$/i.exec(raw);
    if (!match) throw new Error();
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(match[1].split('#')[0], 'base64')));
  } catch {
    throw new SubscriptionError('invalid_link');
  }
  const host = normalizeHost(String(data.add || ''));
  const port = Number(data.port);
  const uuid = String(data.id || '').toLowerCase();
  const name = typeof data.ps === 'string' ? data.ps : '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !UUID.test(uuid) || name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new SubscriptionError('invalid_link');
  }
  const network = String(data.net || 'tcp') === 'raw' ? 'tcp' : String(data.net || 'tcp');
  const security = String(data.tls || 'none');
  const type = String(data.type || 'none');
  const alpn = String(data.alpn || '').split(',').filter(Boolean);
  const path = String(data.path || '');
  if (!['tcp', 'ws'].includes(network) || !['tls', 'none', ''].includes(security) || type !== 'none' || alpn.length && security === 'none') {
    return { config: null, name: name || `${host}:${port}`, fingerprint: fingerprint(data), capability: 'unsupported', error: 'Поддерживаются VMess TCP/WebSocket с TLS или без TLS.' };
  }
  if (network === 'ws' && (!path.startsWith('/') || /[\r\n]/.test(String(data.host || '')))) {
    return { config: null, name: name || `${host}:${port}`, fingerprint: fingerprint(data), capability: 'unsupported', error: 'Неподдерживаемые параметры WebSocket.' };
  }
  const config = { schema_version: 1, protocol: 'vmess', host, port, uuid, security: security || 'none', network, sni: String(data.sni || host), alpn, fingerprint: String(data.fp || ''), hostHeader: String(data.host || ''), path: path || '/', alterId: Number.parseInt(data.aid, 10) || 0, scy: String(data.scy || 'auto') };
  return { config, name: name || `${host}:${port}`, fingerprint: fingerprint(config), capability: 'supported', error: null };
}

function parseVless(raw) {
  if (typeof raw !== 'string' || raw.length > 16384 || /[\s\u0000-\u001f\u007f]/u.test(raw)) throw new SubscriptionError('invalid_link');
  let url;
  let name;
  let uuid;
  try {
    if (/%(?![a-f\d]{2})/i.test(raw)) throw new Error();
    url = new URL(raw);
    name = decodeURIComponent(url.hash.slice(1));
    uuid = decodeURIComponent(url.username).toLowerCase();
    // URLSearchParams replaces invalid UTF-8 silently; reject it before normalizing.
    decodeURIComponent(url.search.replace(/\+/g, ' '));
  } catch {
    throw new SubscriptionError('invalid_link');
  }
  if (url.protocol !== 'vless:' || url.password || !uuid || uuid.length > 256 || /[\u0000-\u001f\u007f]/u.test(uuid) || !url.port || !['', '/'].includes(url.pathname)) {
    throw new SubscriptionError('invalid_link');
  }
  const host = normalizeHost(url.hostname);
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new SubscriptionError('invalid_link');
  }
  const params = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(params, key) || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new SubscriptionError('invalid_link');
    params[key] = value;
  }
  const insecureValues = [params.allowInsecure, params.insecure].filter(value => value !== undefined);
  if (insecureValues.some(value => !['0', '1', 'true', 'false'].includes(value))) throw new SubscriptionError('invalid_link');
  const insecure = insecureValues.map(value => ['1', 'true'].includes(value));
  if (insecure.length === 2 && insecure[0] !== insecure[1]) throw new SubscriptionError('invalid_link');
  const network = params.type === 'raw' ? 'tcp' : (params.type || 'tcp');
  const security = params.security || 'none';
  const alpn = params.alpn ? params.alpn.split(',') : [];
  if (alpn.some(value => !value || value.length > 255)) throw new SubscriptionError('invalid_link');
  const config = {
    schema_version: 1, protocol: 'vless', host, port, uuid,
    encryption: params.encryption || 'none', network, security,
    sni: params.sni ? normalizeHost(params.sni) : host,
     alpn, fingerprint: params.fp || (security === 'reality' ? 'chrome' : ''), flow: params.flow || '', packetEncoding: params.packetEncoding === 'none' ? '' : (params.packetEncoding || ''),
     allowInsecure: insecure[0] === true,
    headerType: params.headerType || 'none',
     ws: network === 'ws' ? { host: params.host || host, path: params.path ? (params.path.startsWith('/') ? params.path : `/${params.path}`) : '/' } : null,
     httpupgrade: network === 'httpupgrade' ? { host: params.host || host, path: params.path || '/' } : null,
     xhttp: network === 'xhttp' ? { host: params.host || host, path: params.path || '/', mode: params.mode || 'auto', extra: null } : null,
    grpc: network === 'grpc' ? { serviceName: params.serviceName || '', ...(params.authority ? { authority: params.authority } : {}), mode: params.mode || 'gun' } : null,
     extra: Object.fromEntries(Object.entries(params).filter(([key]) =>
       !METADATA_PARAMS.has(key.toLowerCase()) &&
       ((!KNOWN_PARAMS.has(key) && !(security === 'reality' && REALITY_PARAMS.has(key))) ||
       (network !== 'ws' && network !== 'xhttp' && network !== 'httpupgrade' && network !== 'tcp' && ['host', 'path'].includes(key)))))
  };
  if (network === 'grpc' && params.mode === 'multi') config.grpc.mode = 'multi';
  if (params.fm) {
    try {
      config.finalmask = JSON.parse(params.fm);
      if (!config.finalmask || typeof config.finalmask !== 'object' || Array.isArray(config.finalmask)) throw new Error();
    } catch {
      throw new SubscriptionError('invalid_link');
    }
  }
  if (network === 'xhttp' && params.extra) {
    try {
      config.xhttp.extra = JSON.parse(params.extra);
      if (config.xhttp.extra !== null && (typeof config.xhttp.extra !== 'object' || Array.isArray(config.xhttp.extra))) throw new Error();
    } catch {
      throw new SubscriptionError('invalid_link');
    }
  }
  if (network === 'xhttp' && params.x_padding_bytes) {
    if (config.xhttp.extra === null) config.xhttp.extra = {};
    if (config.xhttp.extra.xPaddingBytes === undefined) config.xhttp.extra.xPaddingBytes = params.x_padding_bytes;
  }
  if (security === 'reality') {
    config.reality = { publicKey: params.pbk || '', shortId: (params.sid || '').toLowerCase(), spiderX: params.spx || '/', mldsa65Verify: params.pqv || '' };
  }
  return { config, name: name || `${host}:${port}`, fingerprint: fingerprint(config), ...vlessCapability(config) };
}

function serializeVless(config, name = '') {
  const params = new URLSearchParams({ encryption: config.encryption, type: config.network, security: config.security });
  for (const [key, value] of Object.entries({ sni: config.sni, fp: config.fingerprint, flow: config.flow })) {
    if (value) params.set(key, value);
  }
  if (config.alpn.length) params.set('alpn', config.alpn.join(','));
  if (config.allowInsecure) params.set('allowInsecure', '1');
  if (config.headerType !== 'none') params.set('headerType', config.headerType);
  if (config.ws) {
    params.set('host', config.ws.host);
    params.set('path', config.ws.path);
  }
  if (config.httpupgrade) {
    params.set('host', config.httpupgrade.host);
    params.set('path', config.httpupgrade.path);
  }
  if (config.xhttp) {
    params.set('host', config.xhttp.host);
    params.set('path', config.xhttp.path);
    params.set('mode', config.xhttp.mode);
    if (config.xhttp.extra) params.set('extra', JSON.stringify(config.xhttp.extra));
  }
  if (config.grpc) {
    if (config.grpc.authority) params.set('authority', config.grpc.authority);
    params.set('serviceName', config.grpc.serviceName);
    params.set('mode', config.grpc.mode);
  }
  if (config.finalmask) params.set('fm', JSON.stringify(config.finalmask));
  if (config.reality) {
    params.set('pbk', config.reality.publicKey);
    params.set('sid', config.reality.shortId);
    params.set('spx', config.reality.spiderX);
    if (config.reality.mldsa65Verify) params.set('pqv', config.reality.mldsa65Verify);
  }
  for (const [key, value] of Object.entries(config.extra || {})) params.set(key, value);
  const host = net.isIP(config.host) === 6 ? `[${config.host}]` : config.host;
  return `vless://${config.uuid}@${host}:${config.port}?${params}#${encodeURIComponent(name)}`;
}

function effectiveFingerprint(link) {
  try {
    if (link.startsWith('vless://')) return parseVless(link).fingerprint;
    if (link.startsWith('vmess://')) {
      const config = JSON.parse(Buffer.from(link.slice(8).split('#')[0], 'base64').toString('utf8'));
      delete config.ps;
      return fingerprint({ protocol: 'vmess', config });
    }
  } catch { /* Legacy manual links remain deliverable; only exact connection strings deduplicate. */ }
  return fingerprint({ raw: link.split('#')[0] });
}

module.exports = { parseVless, parseHysteria2, parseVmess, serializeVless, fingerprint, effectiveFingerprint, normalizeHost, canonicalJson, vlessCapability, UUID };
