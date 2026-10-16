const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const ipaddr = require('ipaddr.js');
const zlib = require('zlib');
const { Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const { normalizeHost } = require('./protocolParsers');
const { SubscriptionError } = require('./subscriptionErrors');

function isPublicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

function validateSourceUrl(value) {
  let url;
  try {
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error();
    url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    const host = normalizeHost(url.hostname);
    if (net.isIP(host) && !isPublicAddress(host)) throw new SubscriptionError('blocked_address');
  } catch (error) {
    if (error instanceof SubscriptionError && error.code === 'blocked_address') throw error;
    throw new SubscriptionError('invalid_url');
  }
  return url;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new SubscriptionError('cancelled'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function resolvePublicHost(host, { signal, lookup = dns.lookup.bind(dns) } = {}) {
  host = normalizeHost(host);
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await abortable(lookup(host, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new SubscriptionError('dns_error');
  }
  if (!addresses.length) throw new SubscriptionError('dns_error');
  if (addresses.some(entry => !isPublicAddress(entry.address))) throw new SubscriptionError('blocked_address');
  return addresses[0];
}

function pinnedLookup(address) {
  return (_host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

function byteLimit(limit) {
  let size = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(size > limit ? new SubscriptionError('response_too_large') : null, chunk);
    }
  });
}

async function readBody(response, maxBytes, signal) {
  const encoding = (response.headers['content-encoding'] || 'identity').toLowerCase();
  const decoder = {
    gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress
  }[encoding];
  if (!decoder && encoding !== 'identity') {
    response.destroy();
    throw new SubscriptionError('unsupported_format');
  }
  const parts = [];
  const streams = [response, byteLimit(maxBytes)];
  if (decoder) streams.push(decoder(), byteLimit(maxBytes));
  streams.push(new Writable({ write(chunk, _encoding, callback) { parts.push(chunk); callback(); } }));
  await pipeline(streams, { signal });
  return Buffer.concat(parts);
}

async function downloadSource(source, config, { signal, resolveHost = resolvePublicHost } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new SubscriptionError('download_timeout')), config.sourceTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    let url = validateSourceUrl(source.url);
    const originalOrigin = url.origin;
    let headers = {
      accept: 'text/plain, */*;q=0.5', 'accept-encoding': 'gzip, deflate, br',
      'user-agent': 'VPN-Subscription-Service/1.0', ...JSON.parse(source.headers_json || '{}')
    };
    if (source.etag) headers['if-none-match'] = source.etag;
    if (source.last_modified) headers['if-modified-since'] = source.last_modified;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const address = await resolveHost(url.hostname, { signal: combined });
      combined.throwIfAborted();
      const response = await new Promise((resolve, reject) => {
        const req = (url.protocol === 'https:' ? https : http).get(url, {
          headers, agent: false, lookup: pinnedLookup(address), signal: combined,
          rejectUnauthorized: true, maxHeaderSize: 16384
        }, resolve);
        req.on('error', reject);
      });
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (redirects === 5) throw new SubscriptionError('too_many_redirects');
        let next;
        try { next = validateSourceUrl(new URL(response.headers.location, url).href); }
        catch (error) { throw error instanceof SubscriptionError ? error : new SubscriptionError('invalid_url'); }
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new SubscriptionError('insecure_redirect');
        if (next.origin !== url.origin || next.origin !== originalOrigin) {
          // Credentials and conditional validators belong to the origin that supplied them.
          headers = { accept: headers.accept, 'accept-encoding': headers['accept-encoding'], 'user-agent': 'VPN-Subscription-Service/1.0' };
        }
        url = next;
        continue;
      }
      if (status === 304) {
        response.destroy();
        if (!source.last_success_at || (!source.etag && !source.last_modified)) throw new SubscriptionError('http_error');
        return { status, headers: response.headers, body: null };
      }
      if (status !== 200) {
        response.destroy();
        throw new SubscriptionError('http_error');
      }
      const body = await readBody(response, config.maxSourceBytes, combined);
      return { status, body, headers: response.headers };
    }
  } catch (error) {
    if (combined.aborted) throw combined.reason;
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError('download_failed');
  } finally {
    clearTimeout(timeout);
  }
}

function maskSourceUrl(value) {
  try { return `${new URL(value).origin}/…`; }
  catch { return 'Некорректный URL'; }
}

module.exports = { isPublicAddress, validateSourceUrl, resolvePublicHost, pinnedLookup, abortable, downloadSource, maskSourceUrl };
