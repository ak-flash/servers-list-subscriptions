const db = require('../db/database');

const NODE_SELECT = `SELECT n.*, s.revision AS source_revision, s.is_active AS source_active, s.name AS source_name,
  h.status, h.generation AS health_generation, h.config_fingerprint, h.probe_profile_version, h.probe_location,
  h.last_attempt_at, h.last_checked_at, h.last_success_at, h.latency_ms, h.test_target_id, h.target_priority,
  h.successful_attempts, h.total_attempts, h.http_status, h.error_code, h.error_message,
  h.runner_error_code, h.runner_error_message, h.pending_cycle_id,
  h.proxy_status, h.proxy_latency_ms, h.proxy_http_status, h.proxy_error_code, h.proxy_checked_at
  FROM subscription_nodes n JOIN subscription_sources s ON s.id = n.source_id
  LEFT JOIN subscription_node_health h ON h.node_id = n.id`;

function getNode(id) {
  return db.get(`${NODE_SELECT} WHERE n.id = ?`, [id]);
}

function getNodes(sourceId) {
  return db.all(`${NODE_SELECT} WHERE n.source_id = ? ORDER BY n.name, n.id`, [sourceId]);
}

function proxyEligibility(node, config, now = Date.now()) {
  if (!config.httpProxy || config.httpProxyMode !== 'extra') return 'not_required';
  if (node.proxy_status !== 'healthy') return node.proxy_status || 'proxy_unknown';
  if (!Number.isFinite(node.proxy_latency_ms) || node.proxy_latency_ms < 0) return 'proxy_unknown';
  if (!node.proxy_checked_at || now < node.proxy_checked_at || now - node.proxy_checked_at >= config.healthyTtlMs) return 'proxy_stale';
  return 'proxy_ok';
}

function eligibility(node, config, now = Date.now()) {
  if (!node.source_active) return 'source_disabled';
  if (!node.is_present) return 'removed';
  if (!node.is_enabled) return 'disabled';
  if (node.capability_status !== 'supported') return node.capability_status;
  if (node.generation !== node.health_generation || node.fingerprint !== node.config_fingerprint || node.probe_profile_version !== config.profileVersion) return 'unknown';
  if (node.status !== 'healthy') return node.status || 'unknown';
  if (!Number.isFinite(node.latency_ms) || node.latency_ms < 0 || node.successful_attempts < config.minSuccess || node.total_attempts !== config.attempts) return 'unknown';
  if (!node.last_checked_at || now < node.last_checked_at || now - node.last_checked_at >= config.healthyTtlMs) return 'stale';
  return 'healthy';
} 

function safeNode(node, config, now = Date.now()) {
  const { normalized_config_json, fingerprint, config_fingerprint, pending_cycle_id, ...safe } = node;
  const effective = eligibility(node, config, now);
  return { ...safe, effective_status: effective, proxy_effective_status: proxyEligibility(node, config, now) };
}

function markStarted(node, cycleId, now = Date.now()) {
  db.run(`INSERT INTO subscription_node_health (node_id, config_fingerprint, generation, last_attempt_at, pending_cycle_id)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
    pending_cycle_id = excluded.pending_cycle_id, generation = excluded.generation`, [node.id, node.fingerprint, node.generation, now, cycleId]);
}

function recordResult(node, cycleId, result, config, jobId = null, now = Date.now()) {
  const current = getNode(node.id);
  if (!current || !current.source_active || !current.is_present || !current.is_enabled ||
      current.source_revision !== node.source_revision || current.generation !== node.generation ||
      current.fingerprint !== node.fingerprint || current.pending_cycle_id !== cycleId) return false;
  const hasProxyResult = Object.hasOwn(result, 'proxy');
  db.transaction(() => {
    for (const attempt of result.attempts || []) {
      db.run(`INSERT INTO subscription_node_checks (job_id, cycle_id, node_id, config_fingerprint, generation,
        probe_profile_version, test_target_id, attempt, outcome, latency_ms, http_status, error_code, checked_at, via)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'direct')`,
      [jobId, cycleId, node.id, node.fingerprint, node.generation, config.profileVersion, attempt.targetId || null,
        attempt.attempt ?? null, attempt.outcome, attempt.latencyMs ?? null, attempt.httpStatus ?? null, attempt.errorCode || null, now]);
    }
    if (result.status === 'runner_error' || result.status === 'cancelled') {
      db.run(`UPDATE subscription_node_health SET pending_cycle_id = NULL, runner_error_code = ?, runner_error_message = ? WHERE node_id = ?`,
        [result.errorCode, result.errorMessage, node.id]);
    } else {
      db.run(`UPDATE subscription_node_health SET status = ?, config_fingerprint = ?, generation = ?,
        probe_profile_version = ?, probe_location = ?, cycle_id = ?, pending_cycle_id = NULL, last_checked_at = ?,
        last_success_at = CASE WHEN ? = 'healthy' THEN ? ELSE last_success_at END, latency_ms = ?, test_target_id = ?,
        target_priority = ?, http_status = ?, successful_attempts = ?, total_attempts = ?, error_code = ?, error_message = ?,
        runner_error_code = NULL, runner_error_message = NULL WHERE node_id = ?`,
      [result.status, node.fingerprint, node.generation, config.profileVersion, config.probeLocation, cycleId, now,
        result.status, now, result.latencyMs ?? null, result.targetId || null, result.targetPriority ?? null,
        result.httpStatus ?? null, result.successCount || 0, result.attemptCount || 0, result.errorCode || null, result.errorMessage || null, node.id]);
    }
    const interval = result.status === 'degraded' ? Math.min(60000, config.checkIntervalMs) : config.checkIntervalMs;
    db.run('UPDATE subscription_nodes SET next_check_at = ? WHERE id = ?', [now + interval + Math.floor(Math.random() * Math.min(interval * 0.05, 10000)), node.id]);
    // Proxy measurements live in their own columns; a runner-level retry keeps the last valid proxy reading.
    if (hasProxyResult && !(result.status === 'runner_error' || result.status === 'cancelled')) {
      const proxy = result.proxy || null;
      for (const attempt of proxy?.attempts || []) {
        db.run(`INSERT INTO subscription_node_checks (job_id, cycle_id, node_id, config_fingerprint, generation,
          probe_profile_version, test_target_id, attempt, outcome, latency_ms, http_status, error_code, checked_at, via)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proxy')`,
        [jobId, cycleId, node.id, node.fingerprint, node.generation, config.profileVersion, attempt.targetId || null,
          attempt.attempt ?? null, attempt.outcome, attempt.latencyMs ?? null, attempt.httpStatus ?? null, attempt.errorCode || null, now]);
      }
      db.run(`UPDATE subscription_node_health SET proxy_status = ?, proxy_latency_ms = ?, proxy_http_status = ?,
        proxy_error_code = ?, proxy_checked_at = ? WHERE node_id = ?`,
      [proxy ? proxy.status || null : null, proxy ? proxy.latencyMs ?? null : null, proxy ? proxy.httpStatus ?? null : null,
        proxy ? proxy.errorCode ?? null : null, proxy ? now : null, node.id]);
    } else if (!hasProxyResult && config.httpProxyMode === 'only') {
      // In "only" mode the proxy path IS the main measurement; stale extra-readings are cleared.
      db.run(`UPDATE subscription_node_health SET proxy_status = NULL, proxy_latency_ms = NULL,
        proxy_http_status = NULL, proxy_error_code = NULL, proxy_checked_at = NULL WHERE node_id = ?`, [node.id]);
    }
  });
  return true;
}

function pruneHistory(config, now = Date.now()) {
  db.transaction(() => {
    db.run('DELETE FROM subscription_node_checks WHERE checked_at < ?', [now - config.historyDays * 86400000]);
    db.run(`DELETE FROM subscription_node_checks WHERE id < COALESCE(
      (SELECT id FROM subscription_node_checks ORDER BY id DESC LIMIT 1 OFFSET ?), 0)`, [config.maxHistoryRows - 1]);
    db.run(`DELETE FROM background_jobs WHERE state NOT IN ('queued', 'running') AND
      (created_at < ? OR id NOT IN (SELECT id FROM background_jobs ORDER BY created_at DESC LIMIT 1000))`, [now - config.historyDays * 86400000]);
    db.run('DELETE FROM subscription_nodes WHERE is_present = 0 AND removed_at < ?', [now - config.historyDays * 86400000]);
  });
}

module.exports = { NODE_SELECT, getNode, getNodes, safeNode, eligibility, proxyEligibility, markStarted, recordResult, pruneHistory };
