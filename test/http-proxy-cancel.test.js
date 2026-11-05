const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { requestThroughHttpProxy } = require('../src/services/vpnChecker');

function proxyServer(handler) {
  const server = net.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('HTTP proxy request observes an already-aborted signal without opening I/O', async () => {
  let connections = 0;
  const sockets = new Set();
  const { server, port } = await proxyServer(socket => { connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(requestThroughHttpProxy(
    { url: 'https://example.com/', status: 204 },
    { protocol: 'http', address: '127.0.0.1', port }, 1000, controller.signal
  ), /cancelled/);
  assert.equal(connections, 0);
  await new Promise(resolve => server.close(resolve));
  for (const socket of sockets) socket.destroy();
});

test('HTTP proxy timeout destroys a CONNECT socket and settles once', async () => {
  let sockets = 0;
  const openSockets = new Set();
  const { server, port } = await proxyServer(socket => {
    sockets++;
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
    socket.on('error', () => {});
  });
  const result = await requestThroughHttpProxy(
    { url: 'https://example.com/', status: 204 },
    { protocol: 'http', address: '127.0.0.1', port }, 40
  );
  assert.equal(result.errorCode, 'probe_timeout');
  assert.equal(sockets, 1);
  for (const socket of openSockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
});
