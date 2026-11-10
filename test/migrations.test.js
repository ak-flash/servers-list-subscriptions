const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db/database');

test('fresh and existing databases apply all migrations idempotently', async t => {
  await db.initDb({ filePath: ':memory:' });
  t.after(db.closeDb);
  const first = db.all('SELECT version FROM schema_migrations ORDER BY version').map(row => row.version);
  assert.deepEqual(first, Array.from({ length: 16 }, (_, i) => i + 1));
  db.closeDb();
  await db.initDb({ filePath: ':memory:' });
  const second = db.all('SELECT version FROM schema_migrations ORDER BY version').map(row => row.version);
  assert.deepEqual(second, first);
});
