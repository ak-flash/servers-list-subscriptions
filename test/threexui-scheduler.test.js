const { test } = require('node:test');
const assert = require('node:assert/strict');
const threeXui = require('../src/services/threeXui');
const { ThreeXuiScheduler } = require('../src/services/threeXuiScheduler');

test('3x-ui scheduler syncs due panels with bounded concurrency and isolates failures', async t => {
  const originalList = threeXui.listPanels;
  const originalSync = threeXui.syncPanel;
  t.after(() => { threeXui.listPanels = originalList; threeXui.syncPanel = originalSync; });

  threeXui.listPanels = () => ['p1', 'p2', 'p3', 'p4'].map(id => ({ id, is_active: 1, last_sync_at: null }));
  let active = 0;
  let peak = 0;
  threeXui.syncPanel = async id => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    if (id === 'p2') throw new Error('panel down');
  };

  const scheduler = new ThreeXuiScheduler({ concurrency: 2 });
  const results = await scheduler.tick();
  assert.equal(results.length, 4);
  assert.equal(peak, 2);
  assert.deepEqual(results.map(result => result.status).sort(), ['error', 'ok', 'ok', 'ok']);
  assert.ok(results.every(result => Number.isFinite(result.durationMs)));
});

test('3x-ui scheduler skips a tick while one is already running', async () => {
  const scheduler = new ThreeXuiScheduler();
  scheduler.running = true;
  assert.deepEqual(await scheduler.tick(), []);
});
