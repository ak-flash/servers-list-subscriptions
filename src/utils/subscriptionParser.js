const { TextDecoder } = require('util');
const { parseVless, parseHysteria2, parseVmess, fingerprint } = require('./protocolParsers');
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
    const isVless = /^vless:\/\//i.test(rawLink);
    const isHysteria2 = /^hysteria2:\/\//i.test(rawLink);
    const isVmess = /^vmess:\/\//i.test(rawLink);
    if (!isVless && !isHysteria2 && !isVmess) throw new SubscriptionError('unsupported');
    const parsed = isVless ? parseVless(rawLink) : isHysteria2 ? parseHysteria2(rawLink) : parseVmess(rawLink);
    if (!parsed.config) return { ...parsed, rawLink, protocol: isVmess ? 'vmess' : parsed.protocol, host: null, port: null };
    return { ...parsed, rawLink, protocol: parsed.config.protocol, host: parsed.config.host, port: parsed.config.port };
  } catch (error) {
    const unsupported = error.code === 'unsupported';
    return {
      rawLink: rawLink.slice(0, 16384), config: null, fingerprint: fingerprint({ raw: rawLink }),
      name: unsupported ? 'Неподдерживаемая ссылка' : 'Некорректная ссылка',
      protocol: unsupported ? 'other' : (/^hysteria2:\/\//i.test(rawLink) ? 'hysteria2' : /^vmess:\/\//i.test(rawLink) ? 'vmess' : 'vless'), host: null, port: null,
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
  if (!text) throw new SubscriptionError('empty_source');
  let format = 'plain';
  if (!/(?:^|\n)\s*[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    if (/^[<{\[]/.test(text) || text.includes(':')) throw new SubscriptionError('unsupported_format');
    text = decodeBase64Strict(text).replace(/^\uFEFF/, '').trim();
    format = 'base64';
  }
  if (/^\s*</.test(text)) throw new SubscriptionError('unsupported_format');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length) throw new SubscriptionError('empty_source');
  if (lines.length > maxNodes) throw new SubscriptionError('too_many_nodes');
  const nodes = new Map();
  const report = { format, total: lines.length, duplicates: 0, supported: 0, unsupported: 0, invalid: 0 };
  let parsedNodes = 0;
  for (const rawLink of lines) {
    const node = parseSubscriptionNode(rawLink);
    if (node.config) parsedNodes++;
    report[node.capability === 'supported' ? 'supported' : node.capability]++;
    if (nodes.has(node.fingerprint)) report.duplicates++;
    else nodes.set(node.fingerprint, node);
  }
  if (!parsedNodes) throw new SubscriptionError('unsupported_format');
  // Structurally parsed but unsupported VLESS remains part of a complete snapshot.
  // Unparseable lines could hide an existing node, so a partial snapshot must not remove anything.
  const complete = !report.invalid && ![...nodes.values()].some(node => !node.config);
  return { nodes: [...nodes.values()], report, complete, maxNodes };
}

module.exports = { parseSubscription, parseSubscriptionNode, decodeBase64Strict };
