const statusLabels = {
  healthy: 'Работает через VPN', unknown: 'Ожидает VPN-проверки', offline: 'Недоступен через VPN',
  degraded: 'Нестабильное соединение', test_failed: 'Тест не пройден', stale: 'Проверка устарела',
  unsupported: 'Не поддерживается', invalid: 'Некорректная ссылка', disabled: 'Исключён',
  source_disabled: 'Источник отключён', removed: 'Удалён из источника', latency: 'Выше порога задержки', duplicate: 'Дубликат',
  queued: 'В очереди', running: 'Выполняется', completed: 'Завершена', failed: 'Ошибка',
  interrupted: 'Прервана', pending: 'Ожидает загрузки', success: 'Обновлён', partial: 'Частично обновлён', error: 'Ошибка загрузки'
};

const timezone = process.env.APP_TIMEZONE || 'UTC';

function formatDate(value, options = {}) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ru-RU', { timeZone: timezone, ...options });
}
function statusLabel(value) { return statusLabels[value] || value || 'Нет данных'; }
function time(value) { return value ? `${formatDate(value)} ${timezone}` : '—'; }
function date(value) { return formatDate(value, { dateStyle: 'short' }); }
function latency(value) { return value === null || value === undefined ? '—' : `${Math.round(value)} мс`; }

module.exports = { statusLabel, time, date, latency, timezone };
