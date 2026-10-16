const messages = {
  invalid_url: 'Укажите корректную HTTP(S)-ссылку без имени пользователя и пароля в адресе.',
  blocked_address: 'Адрес ведёт в локальную, служебную или непубличную сеть.',
  dns_error: 'Не удалось определить адрес сервера.',
  download_failed: 'Не удалось загрузить источник.',
  download_timeout: 'Источник не ответил за отведённое время.',
  http_error: 'Источник вернул неуспешный HTTP-статус.',
  too_many_redirects: 'Источник превысил лимит перенаправлений.',
  insecure_redirect: 'Источник перенаправляет HTTPS-запрос на HTTP.',
  response_too_large: 'Ответ источника превышает допустимый размер.',
  too_many_nodes: 'В источнике превышен лимит узлов.',
  unsupported_format: 'Формат источника не поддерживается. Нужен список VLESS-ссылок или его Base64-кодировка.',
  empty_source: 'Источник вернул пустой список. Предыдущий каталог сохранён.',
  invalid_link: 'Некорректная VLESS-ссылка.',
  unsupported: 'Эта конфигурация не поддерживается проверяющим адаптером.',
  cancelled: 'Задача прервана.',
  superseded: 'Настройки изменились. Устаревший результат не применён.',
  runner_error: 'Не удалось выполнить проверку через Xray.',
  xray_missing: 'Xray не найден. Проверьте XRAY_PATH и права на запуск.',
  xray_version: 'Версия Xray не совпадает с XRAY_VERSION.',
  xray_checksum: 'Контрольная сумма Xray не совпадает с XRAY_SHA256.',
  xray_start: 'Xray не запустил локальный SOCKS-вход.',
  xray_exit: 'Xray завершился во время проверки.',
  probe_timeout: 'Превышено время проверки VPN-подключения.',
  tls_error: 'Ошибка проверки TLS-сертификата тестовой цели.',
  connection_error: 'Не удалось выполнить HTTPS-запрос через VPN.',
  unexpected_http_status: 'Тестовая цель вернула неожиданный HTTP-статус.',
  unexpected_body: 'Ответ тестовой цели не соответствует ожидаемому.',
  queue_full: 'Очередь заполнена. Повторите действие после завершения текущих задач.'
};

class SubscriptionError extends Error {
  constructor(code, message = messages[code], status = 400) {
    super(message || messages.runner_error);
    this.code = code;
    this.status = status;
  }
}

// Never expose upstream URLs, Xray output, request options or credentials through error.message.
function safeError(error, fallback = 'runner_error') {
  const code = error instanceof SubscriptionError ? error.code : fallback;
  return { code, message: messages[code] || messages[fallback] };
}

module.exports = { SubscriptionError, safeError, messages };
