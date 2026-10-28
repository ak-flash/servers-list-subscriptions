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
    metrics: { queued: 540, running: { check: 4, sync: 1 }, oldest_wait_ms: 15120001, ...metrics }
  });
}

test('source page combines queue metrics, help and refresh in one localized panel', async () => {
  for (const locale of supportedLocales) {
    const t = createTranslator(locale);
    const html = await renderSources({ locale });
    const panel = html.match(/<section\b[^>]*data-job-region[^>]*>[\s\S]*?<\/section>/)?.[0];
    assert.ok(panel);
    assert.equal((html.match(/data-job-region/g) || []).length, 1);
    for (const key of ['Фоновая очередь', 'В очереди', 'Загружаются', 'Проверяются', 'Максимальное ожидание', 'Обновить результаты', 'Загрузка и VPN-проверки выполняются в фоне.', 'Результаты сохраняются после проверки каждого узла.']) {
      assert.ok(panel.includes(t(key)), `${locale} is missing ${key}`);
    }
    assert.match(panel, />540<\/dd>/);
    assert.match(panel, />4<\/dd>/);
    assert.match(panel, />1<\/dd>/);
    assert.match(panel, />253 <span/);
    assert.ok(panel.includes(`>${t('мин')}</span>`));
    assert.match(panel, /class="[^"]*hidden" data-job-details/);
    assert.match(panel, /data-job-message role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(panel, /href="\/admin\/subscription-sources" data-job-refresh/);
    assert.ok(html.includes(t('Добавьте первый источник')));
    assert.doesNotMatch(html, /status\.[a-z_]+|unit\.ms/);
    if (locale === 'en') assert.doesNotMatch(panel, /[А-Яа-яЁё]/);
  }
});

test('queue panel renders job progress, terminal states, and escaped errors', async () => {
  for (const locale of supportedLocales) {
    for (const state of ['queued', 'running', 'completed', 'failed', 'interrupted']) {
      const html = await renderSources({ locale, job: { id: 'job-id', state, total: 10, completed: 3, error: '<script>alert(1)</script>' } });
      assert.match(html, /data-job-id="job-id"/);
      assert.ok(html.includes(statusLabel(state, locale)));
      assert.match(html, /data-job-progress[^>]*max="10" value="3"/);
      assert.doesNotMatch(html, /class="[^"]*hidden" data-job-details/);
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    }
  }
  const noWork = await renderSources({ job: { id: 'empty-job', state: 'completed', total: 0, completed: 0 } });
  assert.match(noWork, /class="[^"]*hidden" data-job-progress[^>]*max="1" value="0"/);
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
