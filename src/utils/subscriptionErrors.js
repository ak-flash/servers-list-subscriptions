const englishMessages = {
  invalid_url: 'Enter a valid HTTP(S) URL without username or password.', blocked_address: 'Address points to a local, reserved, or private network.', dns_error: 'Could not resolve server address.', download_failed: 'Could not load source.', download_timeout: 'Source did not respond in time.', http_error: 'Source returned an unsuccessful HTTP status.', too_many_redirects: 'Source exceeded redirect limit.', insecure_redirect: 'Source redirects HTTPS to HTTP.', response_too_large: 'Source response exceeds allowed size.', too_many_nodes: 'Source exceeds node limit.', unsupported_format: 'Source format is not supported.', empty_source: 'Source returned an empty list. Previous catalog was preserved.', invalid_link: 'Invalid VLESS link.', unsupported: 'This configuration is not supported by checker.', cancelled: 'Task interrupted.', superseded: 'Settings changed. Stale result was not applied.', runner_error: 'VPN check failed.', xray_missing: 'Xray not found.', xray_version: 'Xray version does not match XRAY_VERSION.', xray_checksum: 'Xray checksum does not match XRAY_SHA256.', xray_start: 'Xray did not start local SOCKS input.', xray_exit: 'Xray exited during check.', probe_timeout: 'VPN connection check timed out.', tls_error: 'Test target TLS certificate check failed.', connection_error: 'HTTPS request through VPN failed.', unexpected_http_status: 'Test target returned unexpected HTTP status.', unexpected_body: 'Test target response did not match expected response.', queue_full: 'Queue is full. Retry after current tasks finish.', hysteria_unsupported: 'The link contains unsupported Hysteria2 parameters.', vmess_unsupported: 'VMess TCP/WebSocket with or without TLS is supported.', websocket_unsupported: 'Unsupported WebSocket parameters.'
};

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
  queue_full: 'Очередь заполнена. Повторите действие после завершения текущих задач.',
  hysteria_unsupported: 'Ссылка содержит неподдерживаемые параметры Hysteria2.',
  vmess_unsupported: 'Поддерживаются VMess TCP/WebSocket с TLS или без TLS.',
  websocket_unsupported: 'Неподдерживаемые параметры WebSocket.'
};

class SubscriptionError extends Error {
  constructor(code, message = messages[code], status = 400) {
    super(message || messages.runner_error);
    this.code = code;
    this.status = status;
  }
}

function safeError(error, fallback = 'runner_error') {
  const code = error instanceof SubscriptionError ? error.code : fallback;
  return { code, message: messages[code] || messages[fallback] };
}

function translateError(error, t, fallback = 'runner_error') {
  const safe = safeError(error, fallback);
  return t(`error.${safe.code}`) === `error.${safe.code}` ? safe.message : t(`error.${safe.code}`);
}

module.exports = { SubscriptionError, safeError, translateError, messages };
