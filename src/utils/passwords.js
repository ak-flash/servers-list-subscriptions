const crypto = require('crypto');

const SCRYPT_PREFIX = 'scrypt';
const KEY_LENGTH = 64;
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;

function hashPassword(password) {
  if (typeof password !== 'string' || !password) throw new Error('Пароль не может быть пустым');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, { N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: 32 * 1024 * 1024 });
  return `${SCRYPT_PREFIX}$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || !password || !stored) return { valid: false, legacy: false };
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return { valid: password === stored, legacy: true };
  const [, cost, blockSize, parallelization, saltValue, hashValue] = parts;
  const salt = Buffer.from(saltValue, 'base64url');
  const expected = Buffer.from(hashValue, 'base64url');
  if (!salt.length || !expected.length) return { valid: false, legacy: false };
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number(cost), r: Number(blockSize), p: Number(parallelization), maxmem: 32 * 1024 * 1024
  });
  return { valid: actual.length === expected.length && crypto.timingSafeEqual(actual, expected), legacy: false };
}

module.exports = { hashPassword, verifyPassword };
