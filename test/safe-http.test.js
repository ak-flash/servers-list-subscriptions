const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const { once } = require('events');
const { isPublicAddress, validateSourceUrl, resolvePublicHost, downloadSource } = require('../src/utils/safeHttp');
const { link, config } = require('./fixtures');

test('SSRF: private/metadata/mapped addresses, unusual numeric IPs and mixed DNS answers', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  for (const url of ['http://2130706433', 'http://0x7f000001', 'file:///x', 'https://user:pass@example.com', 'http://[::ffff:127.0.0.1]']) assert.throws(() => validateSourceUrl(url));
  await assert.rejects(resolvePublicHost('dns.example.com', { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), { code: 'blocked_address' });
});

test('bounded HTTP loader, gzip, redirect protection, conditional headers and absolute timeout', async t => {
  let authorization;
  const server = http.createServer((req, res) => {
    authorization = req.headers.authorization;
    if (req.url === '/redirect') return res.writeHead(302, { location: 'http://127.0.0.1/private' }).end();
    if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    if (req.url === '/slow') return;
    if (req.url === '/conditional' && req.headers['if-none-match'] === 'v1') return res.writeHead(304).end();
    res.writeHead(200, { 'content-encoding': 'gzip', etag: 'v1' });
    res.end(zlib.gzipSync(req.url === '/big' ? 'a'.repeat(5000) : link()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://source.example.com:${server.address().port}`;
  // Test-only injected resolver; production always uses the public-address resolver.
  const deps = { resolveHost: async () => ({ address: '127.0.0.1', family: 4 }) };
  const settings = config({ maxSourceBytes: 1024, sourceTimeoutMs: 100 });
  const source = { url: base, headers_json: JSON.stringify({ authorization: 'Bearer test' }) };
  assert.equal((await downloadSource(source, settings, deps)).body.toString(), link());
  assert.equal(authorization, 'Bearer test');
  await assert.rejects(downloadSource({ ...source, url: base + '/big' }, settings, deps), { code: 'response_too_large' });
  await assert.rejects(downloadSource({ ...source, url: base + '/redirect' }, settings, deps), { code: 'blocked_address' });
  await assert.rejects(downloadSource({ ...source, url: base + '/loop' }, settings, deps), { code: 'too_many_redirects' });
  await assert.rejects(downloadSource({ ...source, url: base + '/slow' }, settings, deps), { code: 'download_timeout' });
  assert.equal((await downloadSource({ ...source, url: base + '/conditional', etag: 'v1', last_success_at: 1 }, settings, deps)).status, 304);
});
