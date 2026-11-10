const { TextDecoder } = require('util');
const { parseVless, parseHysteria2, parseVmess, parseTrojan, fingerprint } = require('./protocolParsers');
const { SubscriptionError, safeError } = require('./subscriptionErrors');

function decodeBase64Strict(text) {
  const compact = text.replace(/\s/g, '');
  if (!/^[a-z\d+/_-]+={0,2}$/i.test(compact) || compact.replace(/=+$/, '').length % 4 === 1) throw new SubscriptionError('unsupported_format');
  if (compact.includes('=') && compact.length % 4 !== 0) throw new SubscriptionError('unsupported_format');
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64url') !== compact.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')) throw new SubscriptionError('unsupported_format');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SubscriptionError('unsupported_format');
  }
}

function parseSubscriptionNode(rawLink) {
  try {
    if (typeof rawLink !== 'string' || rawLink.length > 16384 || /[\u0000-\u001f\u007f]/u.test(rawLink)) throw new SubscriptionError('invalid_link');
    const isVless = /^vless:\/\//i.test(rawLink);
    const isHysteria2 = /^hysteria2:\/\//i.test(rawLink);
    const isVmess = /^vmess:\/\//i.test(rawLink);
    const isTrojan = /^trojan:\/\//i.test(rawLink);
    if (!isVless && !isHysteria2 && !isVmess && !isTrojan) {
      if (!/^[a-z][a-z\d+.-]*:\/\/[^\s]+$/i.test(rawLink)) throw new SubscriptionError('invalid_link');
      throw new SubscriptionError('unsupported');
    }
    const parsed = isVless ? parseVless(rawLink) : isHysteria2 ? parseHysteria2(rawLink) : isVmess ? parseVmess(rawLink) : parseTrojan(rawLink);
    if (!parsed.config) return { ...parsed, rawLink, protocol: isVmess ? 'vmess' : parsed.protocol, host: null, port: null };
    return { ...parsed, rawLink, protocol: parsed.config.protocol, host: parsed.config.host, port: parsed.config.port };
  } catch (error) {
    const hasUriScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(rawLink);
    const unsupported = error.code === 'unsupported' && hasUriScheme;
    return {
      rawLink: rawLink.slice(0, 16384), config: null, fingerprint: fingerprint({ raw: rawLink }),
      name: unsupported ? 'Неподдерживаемая ссылка' : 'Некорректная ссылка',
      protocol: unsupported ? 'other' : (/^hysteria2:\/\//i.test(rawLink) ? 'hysteria2' : /^vmess:\/\//i.test(rawLink) ? 'vmess' : /^trojan:\/\//i.test(rawLink) ? 'trojan' : 'vless'), host: null, port: null,
      capability: unsupported ? 'unsupported' : 'invalid', error: safeError(error, 'invalid_link').message
    };
  }
}

function parseSubscription(body, { maxNodes = 1000 } = {}) {
  let text;
  try {
    text = Buffer.isBuffer(body) ? new TextDecoder('utf-8', { fatal: true }).decode(body) : String(body);
  } catch {
    throw new SubscriptionError('unsupported_format');
  }
  text = text.replace(/^\uFEFF/, '').trim();
  // Some providers concatenate URI records with a space instead of a newline.
  // Split only at a new protocol scheme so encoded/name spaces remain untouched.
  text = text.replace(/\s+(?=(?:vless|vmess|trojan|hysteria2):\/\/)/gi, '\n');
  if (!text) throw new SubscriptionError('empty_source');
  let format = 'plain';
  if (!/(?:^|\n)\s*[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    if (/^[<{\[]/.test(text) || text.includes(':')) throw new SubscriptionError('unsupported_format');
    text = decodeBase64Strict(text).replace(/^\uFEFF/, '').trim();
    // Providers may encode URI records separated by spaces inside Base64.
    // Split only before a new known scheme; preserve spaces in names/payloads.
    text = text.replace(/\s+(?=(?:vless|vmess|trojan|hysteria2):\/\/)/gi, '\n');
    format = 'base64';
  }
  if (/^\s*</.test(text)) throw new SubscriptionError('unsupported_format');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  // Subscription providers often include human-readable metadata lines between
  // URI records (for example Telegram/contact notices). They are not node
  // records and must not turn an otherwise complete snapshot into a partial
  // import, which would retain stale nodes forever.
  const records = lines.filter(line => /^[a-z][a-z\d+.-]*:\/\//i.test(line));
  const metadataOnly = lines.length > 0 && records.length < lines.length &&
    lines.filter(line => !/^[a-z][a-z\d+.-]*:\/\//i.test(line)).every(line => /^[^\w]*(?:➡️|👉|📣|📆|剩余|剩余流量)/u.test(line));
  if (!records.length) throw new SubscriptionError('empty_source');
  const sourceLines = (metadataOnly ? records : lines).filter(line => {
    // Some providers encode account notices as deliberately non-connectable
    // VLESS placeholders. Match the complete sentinel shape, never arbitrary
    // private/local nodes or unsupported connection parameters.
    try {
      const url = new URL(line);
      return !(url.protocol === 'vless:' && url.hostname === 'localhost' &&
        /^x+\d+$/.test(url.username) && url.search === '?...' &&
        ['80', '444', '8443'].includes(url.port) && url.hash);
    } catch { return true; }
  });
  if (!sourceLines.length) throw new SubscriptionError('empty_source');
  if (sourceLines.length > maxNodes) throw new SubscriptionError('too_many_nodes');
  const nodes = new Map();
  const report = { format, total: sourceLines.length, duplicates: 0, supported: 0, unsupported: 0, invalid: 0, unparseable: 0 };
  let parsedNodes = 0;
  for (const rawLink of sourceLines) {
    const node = parseSubscriptionNode(rawLink);
    if (node.config) parsedNodes++;
    const reportKey = node.capability === 'supported' ? 'supported' : node.capability;
    report[reportKey]++;
    if (node.capability === 'invalid') report.unparseable++;
    if (nodes.has(node.fingerprint)) report.duplicates++;
    else nodes.set(node.fingerprint, node);
  }
  // A document containing only structurally valid unsupported links is still a
  // usable catalog snapshot: those nodes are retained for identity but are not
  // eligible for probing or delivery. Only invalid records make the snapshot
  // partial. Empty/HTML/undecodable documents are rejected above.
  if (!parsedNodes && report.invalid > 0) throw new SubscriptionError('unsupported_format');
  const complete = !report.invalid;
  return { nodes: [...nodes.values()], report, complete, parseComplete: complete, acceptance: complete ? 'accepted' : 'partial', maxNodes };
}

module.exports = { parseSubscription, parseSubscriptionNode, decodeBase64Strict };
