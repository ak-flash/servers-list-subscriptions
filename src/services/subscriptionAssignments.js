const crypto = require('crypto');
const db = require('../db/database');
const { SubscriptionError } = require('../utils/subscriptionErrors');

function ids(value) {
  const result = value === undefined || value === '' ? [] : typeof value === 'string' ? [value] : value;
  if (!Array.isArray(result) || result.length > 1000 || result.some(id => typeof id !== 'string') || new Set(result).size !== result.length) {
    throw new SubscriptionError('validation', 'Выберите существующие серверы и источники без повторений.');
  }
  return result;
}

function fieldNumber(value, fallback, min, max, label) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw new SubscriptionError('validation', `Проверьте поле «${label}».`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new SubscriptionError('validation', `${label}: допустимо от ${min} до ${max}.`);
  return number;
}

function saveAssignments(userId, input) {
  if (!db.get('SELECT id FROM users WHERE id = ?', [userId])) throw new SubscriptionError('not_found', 'Пользователь не найден.', 404);
  for (const field of ['uuids', 'source_limits', 'max_latency', 'priorities']) {
    if (input[field] !== undefined && (!input[field] || typeof input[field] !== 'object' || Array.isArray(input[field]))) {
      throw new SubscriptionError('validation', 'Проверьте параметры назначений.');
    }
  }
  const serverIds = ids(input.servers);
  const sourceIds = ids(input.sources);
  const existing = new Map(db.getUserServerAssignments(userId).map(row => [row.server_id, row.uuid]));
  const submittedUuids = input.uuids || {};
  const manual = serverIds.map(id => {
    const server = db.get('SELECT * FROM servers WHERE id = ? AND is_active = 1', [id]);
    if (!server) throw new SubscriptionError('validation', 'Один из выбранных серверов не найден или отключён. Обновите страницу.');
    const requested = submittedUuids[id];
    if (requested !== undefined && typeof requested !== 'string') throw new SubscriptionError('validation', 'Проверьте UUID сервера.');
    const entered = typeof requested === 'string' ? requested.trim() : '';
    const existingUuid = existing.get(id);
    const uuid = entered || existingUuid || crypto.randomUUID();
    if (uuid.length > 256 || /[\r\n\u0000]/.test(uuid) || /[@\s]/.test(uuid)) {
      throw new SubscriptionError('validation', 'Укажите credential без пробелов и символов @.');
    }
    return { id, uuid };
  });
  const bindings = sourceIds.map(id => {
    if (!db.get('SELECT id FROM subscription_sources WHERE id = ?', [id])) throw new SubscriptionError('validation', 'Один из выбранных источников удалён. Обновите страницу.');
    return {
      id, limit: fieldNumber(input.source_limits?.[id], 10000, 1, 10000, 'Лимит узлов'),
      latency: fieldNumber(input.max_latency?.[id], null, 1, 60000, 'Максимальная задержка'),
      priority: fieldNumber(input.priorities?.[id], 0, 0, 1000, 'Приоритет')
    };
  });
  db.transaction(() => {
    for (const server of manual) {
      db.run(`INSERT INTO user_servers (user_id, server_id, uuid) VALUES (?, ?, ?)
        ON CONFLICT(user_id, server_id) DO UPDATE SET uuid = excluded.uuid`, [userId, server.id, server.uuid]);
    }
    for (const old of existing.keys()) if (!serverIds.includes(old)) db.run('DELETE FROM user_servers WHERE user_id = ? AND server_id = ?', [userId, old]);
    const now = Date.now();
    for (const binding of bindings) {
      db.run(`INSERT INTO user_subscription_sources (user_id, source_id, node_limit, max_latency_ms, priority, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, source_id) DO UPDATE SET node_limit = excluded.node_limit,
        max_latency_ms = excluded.max_latency_ms, priority = excluded.priority, is_active = 1, updated_at = excluded.updated_at`,
      [userId, binding.id, binding.limit, binding.latency, binding.priority, now, now]);
    }
    for (const old of db.all('SELECT source_id FROM user_subscription_sources WHERE user_id = ?', [userId])) {
      if (!sourceIds.includes(old.source_id)) db.run('DELETE FROM user_subscription_sources WHERE user_id = ? AND source_id = ?', [userId, old.source_id]);
    }
  });
}

function deleteUser(userId) {
  db.transaction(() => {
    db.run('DELETE FROM user_servers WHERE user_id = ?', [userId]);
    db.run('DELETE FROM subscription_requests WHERE user_id = ?', [userId]);
    db.run('DELETE FROM user_traffic WHERE user_id = ?', [userId]);
    db.run('DELETE FROM traffic_snapshots WHERE user_id = ?', [userId]);
    db.run('DELETE FROM users WHERE id = ?', [userId]);
  });
}

function deleteServer(serverId) {
  db.transaction(() => {
    db.run('DELETE FROM user_servers WHERE server_id = ?', [serverId]);
    db.run('DELETE FROM user_traffic WHERE server_id = ?', [serverId]);
    db.run('DELETE FROM traffic_snapshots WHERE server_id = ?', [serverId]);
    db.run('DELETE FROM server_traffic WHERE server_id = ?', [serverId]);
    db.run('DELETE FROM servers WHERE id = ?', [serverId]);
  });
}

module.exports = { saveAssignments, deleteUser, deleteServer };
