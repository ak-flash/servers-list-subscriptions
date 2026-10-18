const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../src/utils/passwords');

test('password hashes verify and are salted', () => {
  const first = hashPassword('correct horse battery staple');
  const second = hashPassword('correct horse battery staple');
  assert.notEqual(first, second);
  assert.equal(verifyPassword('correct horse battery staple', first).valid, true);
  assert.equal(verifyPassword('wrong password', first).valid, false);
  assert.equal(verifyPassword('legacy', 'legacy').legacy, true);
});
