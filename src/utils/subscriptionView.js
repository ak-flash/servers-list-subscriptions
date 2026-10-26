const russianStatusLabels = {
  healthy: 'Работает через VPN', unknown: 'Ожидает VPN-проверки', offline: 'Недоступен через VPN', degraded: 'Нестабильное соединение',
  test_failed: 'Тест не пройден', stale: 'Проверка устарела', unsupported: 'Не поддерживается', invalid: 'Некорректная ссылка',
  disabled: 'Исключён', source_disabled: 'Источник отключён', removed: 'Удалён из источника', latency: 'Выше порога задержки', duplicate: 'Дубликат',
  queued: 'В очереди', running: 'Выполняется', completed: 'Завершена', failed: 'Ошибка', interrupted: 'Прервана', pending: 'Ожидает загрузки',
  success: 'Обновлён', partial: 'Частично обновлён', error: 'Ошибка загрузки'
};

const statusKeys = {
  healthy: 'status.healthy', unknown: 'status.unknown', offline: 'status.offline', degraded: 'status.degraded',
  test_failed: 'status.test_failed', stale: 'status.stale', unsupported: 'status.unsupported', invalid: 'status.invalid',
  disabled: 'status.disabled', source_disabled: 'status.source_disabled', removed: 'status.removed', latency: 'status.latency',
  duplicate: 'status.duplicate', queued: 'status.queued', running: 'status.running', completed: 'status.completed',
  failed: 'status.failed', interrupted: 'status.interrupted', pending: 'status.pending', success: 'status.success',
  partial: 'status.partial', error: 'status.error'
};

const timezone = process.env.APP_TIMEZONE || 'UTC';

function translator(locale) {
  try {
    return require('../i18n').createTranslator(locale);
  } catch {
    return value => value;
  }
}

function formatDate(value, options = {}, locale = 'en') {
  if (!value) return translator(locale)('—');
  return new Date(value).toLocaleString(locale, { timeZone: timezone, ...options });
}

function statusLabel(value, locale = 'en') {
  const t = translator(locale);
  if (locale === 'ru') return russianStatusLabels[value] || value || 'Нет данных';
  return t(statusKeys[value] || value || '—');
}

function time(value, locale = 'en') { return formatDate(value, {}, locale); }
function date(value, locale = 'en') { return formatDate(value, { dateStyle: 'short' }, locale); }

function ago(value, now = Date.now(), locale = 'en') {
  const t = translator(locale);
  if (!value) return locale === 'ru' ? 'нет данных' : t('relative.no_data');
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60000));
  if (minutes < 1) return locale === 'ru' ? 'только что' : t('relative.just_now');
  const unit = minutes < 60 ? 'minute' : minutes < 1440 ? 'hour' : 'day';
  const amount = unit === 'minute' ? minutes : unit === 'hour' ? Math.floor(minutes / 60) : Math.floor(minutes / 1440);
  return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(-amount, unit);
}

function latency(value, locale = 'en') {
  const t = translator(locale);
  return value === null || value === undefined ? t('—') : `${Math.round(value)} ${t('unit.ms')}`;
}

function createView(locale = 'en') {
  return {
    timezone,
    formatDate: (value, options) => formatDate(value, options, locale),
    statusLabel: value => statusLabel(value, locale),
    time: value => time(value, locale),
    date: value => date(value, locale),
    ago: value => ago(value, Date.now(), locale),
    latency: value => latency(value, locale)
  };
}

module.exports = { statusLabel, time, date, ago, latency, timezone, formatDate, createView };
