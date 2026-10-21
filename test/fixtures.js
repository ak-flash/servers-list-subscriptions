const { loadConfig } = require('../src/config/subscriptions');

const UUID = '11111111-2222-4333-8444-555555555555';
function link(host = 'vpn.example.com', extra = '', name = 'Тест') {
  return `vless://${UUID}@${host}:443?encryption=none&security=tls&type=tcp${extra}#${encodeURIComponent(name)}`;
}
function config(overrides = {}) {
  return { ...loadConfig({}), attempts: 3, minSuccess: 2, ...overrides };
}

module.exports = { UUID, link, config };
