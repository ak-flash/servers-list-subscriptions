const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSpecialNodeName } = require('../src/utils/specialNodes');

test('special node names match LTE, base-station and white-list markers', () => {
  for (const name of ['LTE Москва', 'Москва-LTE-1', 'БС-777', 'БС1', 'белые списки #1', 'БЕЛЫЙ СПИСОК', 'Белых списков']) {
    assert.equal(isSpecialNodeName(name), true, name);
  }
  for (const name of ['Обычный узел', 'Москва', 'ULTEGRA', 'СБС', 'Whitelist', '']) {
    assert.equal(isSpecialNodeName(name), false, name);
  }
  assert.equal(isSpecialNodeName(null), false);
});
