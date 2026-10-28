const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { createTranslator, dictionaries, supportedLocales } = require('../src/i18n');
const { createView, statusLabel } = require('../src/utils/subscriptionView');

const sourceLabels = {
  ru: { pending: 'Ожидает загрузки', success: 'Обновлён', partial: 'Частично обновлён', error: 'Ошибка загрузки' },
  en: { pending: 'Waiting to load', success: 'Updated', partial: 'Partially updated', error: 'Load error' }
};

test('source, node and job statuses are localized in every supported language', () => {
  const keys = Object.keys(dictionaries.en).filter(key => key.startsWith('status.'));
  for (const locale of supportedLocales) {
    const view = createView(locale);
    for (const key of keys) {
      assert.ok(dictionaries[locale][key], `${locale} is missing ${key}`);
      assert.equal(view.statusLabel(key.slice('status.'.length)), dictionaries[locale][key]);
    }
    for (const [state, label] of Object.entries(sourceLabels[locale])) {
      assert.equal(statusLabel(state, locale), label);
    }
    assert.equal(view.statusLabel(null), '—');
    assert.equal(view.statusLabel('future_status'), 'future_status');
  }
  assert.equal(createView('ru').latency(42.4), '42 мс');
  assert.equal(createView('en').latency(42.4), '42 ms');
});

const template = path.join(__dirname, '../src/views/subscription-sources.ejs');

function renderSources({ locale = 'ru', job = null, metrics = {}, sources = [] } = {}) {
  return ejs.renderFile(template, {
    locale,
    t: createTranslator(locale),
    ...createView(locale),
    appName: 'Subscriptions',
    csrfToken: 'test-token',
    languageUrl: language => `/admin/subscription-sources?lang=${language}`,
    sources,
    job,
    metrics: { queued: 540, running: { check: 4, sync: 1 }, progress: { total: 550, completed: 6 }, oldest_wait_ms: 15120001, ...metrics }
  });
}

test('source summary cards sit between the heading and add-source action', async () => {
  const sources = Array.from({ length: 3 }, (_, index) => ({
    id: `source-${index}`, name: `Source ${index}`, masked_url: 'https://example.com',
    is_active: true, sync_status: 'success', count: 57, healthy: 31, users: 0
  }));
  for (const locale of supportedLocales) {
    const t = createTranslator(locale);
    const html = await renderSources({ locale, sources });
    const header = html.match(/<main\b[^>]*>\s*(<section\b[\s\S]*?<\/section>)/)?.[1];
    assert.ok(header);
    const summary = header.match(/<dl\b[^>]*>[\s\S]*?<\/dl>/)?.[0];
    assert.ok(summary);
    assert.ok(header.indexOf('<dl') > header.indexOf('</h2>'));
    assert.ok(header.indexOf('href="/admin/subscription-sources/new"') > header.indexOf('</dl>'));
    assert.match(summary, /grid-cols-3/);
    const cards = [...summary.matchAll(/<div\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/div>/g)];
    assert.equal(cards.length, 3);
    const expected = [['Источники', 3], ['Рабочие узлы', 93], ['В каталоге', 171]];
    for (const [index, [, classes, content]] of cards.entries()) {
      assert.match(classes, /rounded-xl/);
      assert.match(classes, /bg-white\/10/);
      assert.ok(content.includes(t(expected[index][0])));
      assert.ok(content.includes(`>${expected[index][1]}</dd>`));
    }
  }
});

test('source page combines queue metrics, help and refresh in one localized panel', async () => {
  for (const locale of supportedLocales) {
    const t = createTranslator(locale);
    const html = await renderSources({ locale });
    const summary = html.match(/<dl\b[^>]*>[\s\S]*?<\/dl>/)?.[0];
    assert.ok(summary);
    assert.equal((summary.match(/<dt\b/g) || []).length, 3);
    assert.ok(!summary.includes(t('Привязки')));
    const panel = html.match(/<section\b[^>]*data-job-region[^>]*>[\s\S]*?<\/section>/)?.[0];
    assert.ok(panel);
    assert.equal((html.match(/data-job-region/g) || []).length, 1);
    for (const key of ['Фоновая очередь', 'В очереди', 'Проверяются', 'Максимальное ожидание', 'Обновить результаты', 'Загрузка и VPN-проверки выполняются в фоне.', 'Результаты сохраняются после проверки каждого узла.']) {
      assert.ok(panel.includes(t(key)), `${locale} is missing ${key}`);
    }
    assert.equal((panel.match(/<dt\b/g) || []).length, 3);
    assert.ok(!panel.includes(t('Загружаются')));
    assert.match(panel, />540<\/dd>/);
    assert.match(panel, />4<\/dd>/);
    assert.match(panel, /data-queue-wait>253<\/span>/);
    assert.ok(panel.includes(`</span> ${t('мин')}</dd>`));
    assert.match(panel, /data-queue-progress[^>]*max="550" value="6"/);
    assert.ok(panel.includes(t('Обработано задач: {completed} из {total}', { completed: 6, total: 550 })));
    assert.match(panel, /data-queue-percent>1%<\/span>/);
    const queueStats = panel.match(/<dl\b[^>]*>[\s\S]*?<\/dl>/)?.[0];
    assert.match(queueStats, /flex flex-wrap/);
    assert.doesNotMatch(queueStats, /bg-white|text-3xl|shadow-sm/);
    assert.match(panel, /class="[^"]*hidden" data-job-details/);
    assert.match(panel, /data-job-message role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(panel, /href="\/admin\/subscription-sources" data-job-refresh/);
    assert.ok(html.includes(t('Добавьте первый источник')));
    assert.doesNotMatch(html, /status\.[a-z_]+|unit\.ms/);
    if (locale === 'en') assert.doesNotMatch(panel, /[А-Яа-яЁё]/);
  }
});

test('source cards have larger actions and hide background actions for disabled sources', async () => {
  for (const locale of supportedLocales) {
    for (const active of [true, false]) {
      const source = { id: 'test-source', name: 'Test source', masked_url: 'https://example.com', is_active: active, sync_status: 'success', count: 12, healthy: 8, users: 2 };
      const html = await renderSources({ locale, sources: [source] });
      const card = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/)?.[0];
      assert.ok(card);
      const actions = [...card.matchAll(/<(?:a|button)\b[^>]*class="([^"]*min-h-\[48px\][^"]*)"[^>]*>/g)];
      assert.equal(actions.length, active ? 4 : 2);
      for (const [, classes] of actions) {
        assert.match(classes, /\btext-base\b/);
        assert.match(classes, /\bpx-4 py-3\b/);
      }
      assert.equal((card.match(/data-background-action/g) || []).length, active ? 2 : 0);
      assert.ok(card.includes(createTranslator(locale)('Открыть узлы')));
      assert.ok(card.includes(createTranslator(locale)('Настроить')));
      assert.match(card, /class="[^"]*\bh-full\b[^"]*\bflex-col\b[^"]*"/);
      assert.match(card, /<div class="flex items-center gap-2">\s*<span class="h-2\.5 w-2\.5 rounded-full/);
      assert.match(card, /<div class="flex-1" aria-hidden="true"><\/div>\s*<div class="mt-5 grid[^"]*border-t/);
    }
  }
});

test('queue progress stays visible without a selected job and handles empty and finished queues', async () => {
  for (const locale of supportedLocales) {
    const t = createTranslator(locale);
    for (const [total, completed, percent] of [[0, 0, 0], [10, 3, 30], [10, 10, 100]]) {
      const html = await renderSources({ locale, metrics: { progress: { total, completed } } });
      assert.match(html, new RegExp(`data-queue-progress[^>]*max="${total || 1}" value="${completed}"`));
      assert.ok(html.includes(`data-queue-percent>${percent}%</span>`));
      assert.doesNotMatch(html, /class="[^"]*hidden" data-queue-progress/);
      assert.ok(html.includes(total ? t('Обработано задач: {completed} из {total}', { completed, total }) : t('Очередь пуста')));
    }
    const html = await renderSources({ locale });
    assert.match(html, /"queueProgress":"[^"]*\{completed\}[^\"]*\{total\}[^"]*"/);
  }
});

test('queue panel renders job states alongside queue progress and escapes errors', async () => {
  for (const locale of supportedLocales) {
    for (const state of ['queued', 'running', 'completed', 'failed', 'interrupted']) {
      const html = await renderSources({ locale, job: { id: 'job-id', state, total: 10, completed: 3, error: '<script>alert(1)</script>' } });
      assert.match(html, /data-job-id="job-id"/);
      assert.ok(html.includes(statusLabel(state, locale)));
      assert.match(html, /data-queue-progress[^>]*max="550" value="6"/);
      assert.doesNotMatch(html, /data-job-progress/);
      assert.doesNotMatch(html, /class="[^"]*hidden" data-job-details/);
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    }
  }
});

test('node catalog job panel preserves individual job progress without queue counters', async () => {
  const partial = path.join(__dirname, '../src/views/partials/subscription-job.ejs');
  for (const total of [0, 10]) {
    const html = await ejs.renderFile(partial, {
      t: createTranslator('ru'), ...createView('ru'),
      job: { id: 'job-id', state: total ? 'running' : 'completed', total, completed: total ? 3 : 0 },
      metrics: {}, refreshUrl: '/admin/subscription-sources/test/nodes'
    });
    assert.match(html, new RegExp(`data-job-progress[^>]*max="${total || 1}" value="${total ? 3 : 0}"`));
    assert.doesNotMatch(html, /data-queue-progress|data-queue-count/);
    if (!total) assert.match(html, /class="[^"]*hidden" data-job-progress/);
  }
});

test('queue panel keeps storage and runner warnings inside the panel', async () => {
  for (const metrics of [{ storage_error: 'Storage unavailable' }, { runner: { error: 'Runner unavailable' } }]) {
    const html = await renderSources({ metrics });
    const panel = html.match(/<section\b[^>]*data-job-region[^>]*>[\s\S]*?<\/section>/)?.[0];
    assert.match(panel, /role="alert"/);
    assert.ok(panel.includes(metrics.storage_error || metrics.runner.error));
    assert.ok(panel.includes('Последний успешный VPN-тест действует до истечения срока актуальности.'));
  }
});
