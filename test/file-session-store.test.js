const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileSessionStore } = require('../src/utils/fileSessionStore');

const promisify = (store, method, ...args) => new Promise((resolve, reject) => {
  store[method](...args, (error, value) => error ? reject(error) : resolve(value));
});

test('file session store round-trips, expires and destroys sessions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-'));
  const store = new FileSessionStore({ directory, ttlMs: 50, sweepIntervalMs: 0 });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  const value = { userId: 'u1', cookie: { expires: new Date(Date.now() + 50) } };
  await promisify(store, 'set', 'sid-1', value);
  const loaded = await promisify(store, 'get', 'sid-1');
  assert.equal(loaded.userId, 'u1');
  assert.equal(new Date(loaded.cookie.expires).getTime(), value.cookie.expires.getTime());
  assert.equal(fs.readdirSync(directory).length, 1);
  assert.ok(!fs.readdirSync(directory)[0].includes('sid-1'), 'session ids are hashed on disk');

  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await promisify(store, 'get', 'sid-1'), null);

  await promisify(store, 'set', 'sid-2', value);
  await promisify(store, 'destroy', 'sid-2');
  assert.equal(await promisify(store, 'get', 'sid-2'), null);
});
