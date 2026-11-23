const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/subscription-actions.js'), 'utf8');

function element(hidden = false) {
  const classes = new Set(hidden ? ['hidden'] : []);
  return {
    textContent: '',
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name)
    }
  };
}

function client({ hidden = false, response } = {}) {
  const elements = Object.fromEntries(['progress', 'progress-label', 'percent', 'count', 'running', 'wait', 'error', 'warning']
    .map(name => [name, element(['error', 'warning'].includes(name))]));
  const region = { dataset: {}, querySelector: selector => elements[selector.replace('[data-queue-', '').replace(']', '')] || null };
  const requests = [];
  const timers = new Map();
  const events = {};
  let timerId = 0;
  const setTimer = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  const document = {
    hidden,
    querySelector: selector => selector === '[data-job-region]' ? region : null,
    querySelectorAll: () => [],
    addEventListener: (name, callback) => { events[name] = callback; }
  };
  const window = {
    appTranslations: { queueProgress: 'Обработано задач: {completed} из {total}', queueEmpty: 'Очередь пуста', queueFailed: 'Данные могут быть устаревшими.', sessionExpired: 'Сессия истекла.' },
    addEventListener: (name, callback) => { events[name] = callback; },
    setTimeout: setTimer
  };
  const state = { response, elements, timers, events, document, requests };
  vm.runInNewContext(script, {
    document, window, AbortController, AbortSignal,
    setTimeout: setTimer, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, options }); return state.response(); }
  });
  return state;
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (completed = 7, overrides = {}) => ({ queued: 2, running: { check: 1 }, oldest_wait_ms: 61000, progress: { total: 10, completed }, ...overrides });
const ok = metrics => ({ ok: true, status: 200, json: async () => metrics });

test('source toggle submits in the background and restores state on failure', async () => {
  const notification = element(true);
  const checkbox = { checked: true, setAttribute() {} };
  const label = {};
  const sections = [element(), element()];
  const stat = { textContent: '125', dataset: { emptyValue: '0' } };
  const temporary = { removed: false, remove() { this.removed = true; } };
  const card = { dataset: { sourceActive: '1', sourceOrder: '0' }, querySelector: () => null,
    querySelectorAll: selector => ({ '[data-source-active-only]': sections, '[data-source-stat]': [stat], '[data-source-temporary]': [temporary] }[selector] || []) };
  const other = { dataset: { sourceActive: '1', sourceOrder: '1' } };
  const inactive = { dataset: { sourceActive: '0', sourceOrder: '2' } };
  let cards = [card, other, inactive];
  card.parentElement = {
    querySelectorAll: () => cards,
    appendChild: item => { cards = cards.filter(existing => existing !== item); cards.push(item); }
  };
  let submit;
  const form = {
    action: '/api/subscription-sources/source/settings',
    dataset: { enabledMessage: 'Источник включён', disabledMessage: 'Источник отключён', enableLabel: 'Включить', disableLabel: 'Отключить' },
    elements: { is_active: { value: '1' } },
    querySelector: selector => selector === 'label' ? label : checkbox,
    closest: () => card,
    setAttribute() {}, removeAttribute() {},
    addEventListener: (name, callback) => { submit = callback; }
  };
  let response = ok({ is_active: 0 });
  const requests = [];
  vm.runInNewContext(script, {
    document: {
      querySelector: selector => selector === '[data-source-notification]' ? notification : null,
      querySelectorAll: selector => selector === '[data-source-setting]' ? [form] : []
    },
    window: { addEventListener() {} }, AbortController,
    URLSearchParams, FormData: class { constructor() { return [['is_active', form.elements.is_active.value]]; } },
    fetch: async (url, options) => { requests.push({ url, options }); return response; }
  });
  checkbox.checked = false;
  form.elements.is_active.value = '0';
  let prevented = false;
  await submit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(requests[0].options.body.toString(), 'is_active=0');
  assert.equal(notification.textContent, 'Источник отключён');
  assert.equal(notification.classList.contains('hidden'), false);
  assert.equal(checkbox.checked, false);
  assert.deepEqual(cards, [other, card, inactive]);
  assert.ok(sections.every(section => section.classList.contains('hidden')));
  assert.equal(stat.textContent, '0');
  assert.equal(temporary.removed, true);
  response = { ok: false, json: async () => ({ error: 'Ошибка' }) };
  checkbox.checked = true;
  form.elements.is_active.value = '1';
  await submit({ preventDefault() {} });
  assert.equal(checkbox.checked, false);
  assert.equal(form.elements.is_active.value, '0');
  assert.equal(checkbox.disabled, false);
  assert.equal(notification.textContent, 'Ошибка');
  assert.deepEqual(cards, [other, card, inactive]);
  response = ok({ is_active: 1 });
  checkbox.checked = true;
  form.elements.is_active.value = '1';
  await submit({ preventDefault() {} });
  assert.deepEqual(cards, [card, other, inactive]);
  assert.equal(notification.textContent, 'Источник включён');
  assert.ok(sections.every(section => !section.classList.contains('hidden')));
});

async function nextPoll(state, delay) {
  const [id, timer] = [...state.timers][0];
  assert.equal(timer.delay, delay);
  state.timers.delete(id);
  await timer.callback();
}

test('queue polling updates counters and progress without a selected job, including completion', async () => {
  const state = client({ response: () => ok(snapshot()) });
  await settle();
  assert.equal(state.requests[0].url, '/api/background-queue');
  assert.equal(state.requests[0].options.cache, 'no-store');
  assert.equal(state.elements.progress.max, 10);
  assert.equal(state.elements.progress.value, 7);
  assert.equal(state.elements.percent.textContent, '70%');
  assert.equal(state.elements['progress-label'].textContent, 'Обработано задач: 7 из 10');
  assert.equal(String(state.elements.count.textContent), '2');
  assert.equal(String(state.elements.running.textContent), '1');
  assert.equal(String(state.elements.wait.textContent), '2');
  state.response = () => ok(snapshot(10, { queued: 0, running: { check: 0 }, oldest_wait_ms: 0 }));
  await nextPoll(state, 1500);
  assert.equal(state.elements.progress.value, 10);
  assert.equal(state.elements.percent.textContent, '100%');
  state.events.pagehide();
  assert.equal(state.timers.size, 0);
  assert.equal(state.requests[0].options.signal.aborted, true);
});

test('queue polling keeps the last known progress on network errors and recovers', async () => {
  const state = client({ response: () => ok(snapshot()) });
  await settle();
  state.response = () => { throw new Error('Offline'); };
  await nextPoll(state, 1500);
  assert.equal(state.elements.progress.value, 7);
  assert.equal(state.elements.error.classList.contains('hidden'), false);
  assert.equal(state.elements.error.textContent, 'Данные могут быть устаревшими.');
  state.response = () => ok(snapshot(8, { runner: { error: 'Runner unavailable' } }));
  await nextPoll(state, 5000);
  assert.equal(state.elements.progress.value, 8);
  assert.equal(state.elements.error.classList.contains('hidden'), true);
  assert.equal(state.elements.warning.classList.contains('hidden'), false);
  assert.match(state.elements.warning.textContent, /Runner unavailable/);
  state.response = () => ok(snapshot(8));
  await nextPoll(state, 1500);
  assert.equal(state.elements.warning.classList.contains('hidden'), true);
  state.events.pagehide();
});

test('queue polling stops after the session expires', async () => {
  const state = client({ response: () => ({ ok: false, status: 401 }) });
  await settle();
  assert.equal(state.elements.error.textContent, 'Сессия истекла.');
  assert.equal(state.timers.size, 0);
  state.events.visibilitychange();
  await settle();
  assert.equal(state.requests.length, 1);
});

test('queue polling resumes when returning to a page from the back-forward cache', async () => {
  const state = client({ response: () => ok(snapshot()) });
  await settle();
  state.events.pagehide();
  assert.equal(state.timers.size, 0);
  state.response = () => ok(snapshot(9));
  state.events.pageshow({ persisted: true });
  await settle();
  assert.equal(state.requests.length, 2);
  assert.equal(state.elements.progress.value, 9);
  assert.equal(state.requests[1].options.signal.aborted, false);
  state.events.pagehide();
  assert.equal(state.timers.size, 0);
  assert.equal(state.requests[1].options.signal.aborted, true);
});

test('queue polling ignores a stale request after restoring a page from the back-forward cache', async () => {
  let resolve;
  const state = client({ response: () => new Promise(done => { resolve = done; }) });
  state.events.pagehide();
  state.response = () => ok(snapshot(8));
  state.events.pageshow({ persisted: true });
  await settle();
  assert.equal(state.elements.progress.value, 8);
  resolve(ok(snapshot(2)));
  await settle();
  assert.equal(state.elements.progress.value, 8);
  assert.equal(state.timers.size, 1);
  state.events.pagehide();
});

test('queue polling pauses in a hidden tab and ignores results after leaving the page', async () => {
  let resolve;
  const state = client({ hidden: true, response: () => new Promise(done => { resolve = done; }) });
  assert.equal(state.requests.length, 0);
  state.document.hidden = false;
  state.events.visibilitychange();
  state.events.visibilitychange();
  assert.equal(state.requests.length, 1);
  state.events.pagehide();
  resolve(ok(snapshot()));
  await settle();
  assert.equal(state.elements.progress.value, undefined);
  assert.equal(state.timers.size, 0);
});
