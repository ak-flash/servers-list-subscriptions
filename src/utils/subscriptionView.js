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
function time(value) { return formatDate(value); }
function date(value) { return formatDate(value, { dateStyle: 'short' }); }
function ago(value, now = Date.now()) {
  if (!value) return 'нет данных';
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} ${minutes % 10 === 1 && minutes % 100 !== 11 ? 'минуту' : minutes % 10 >= 2 && minutes % 10 <= 4 && (minutes % 100 < 10 || minutes % 100 >= 20) ? 'минуты' : 'минут'} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours % 10 === 1 && hours % 100 !== 11 ? 'час' : hours % 10 >= 2 && hours % 10 <= 4 && (hours % 100 < 10 || hours % 100 >= 20) ? 'часа' : 'часов'} назад`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'день' : days >= 2 && days <= 4 ? 'дня' : 'дней'} назад`;
}
function latency(value) { return value === null || value === undefined ? '—' : `${Math.round(value)} мс`; }

module.exports = { statusLabel, time, date, ago, latency, timezone };
