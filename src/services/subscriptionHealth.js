const db = require('../db/database');
const { calculateScore, calculateStability, SCORE_VERSION } = require('../utils/probeScore');

const NODE_SELECT = `SELECT n.*, s.revision AS source_revision, s.is_active AS source_active, s.name AS source_name,
  h.status, h.generation AS health_generation, h.config_fingerprint, h.probe_profile_version, h.probe_location,
  h.last_attempt_at, h.last_checked_at, h.last_success_at, h.checked_address, h.latency_ms, h.test_target_id, h.target_priority,
  h.probe_profile, h.fast_status, h.fast_latency_ms, h.fast_checked_at, h.fast_error_code, h.throughput_bps, h.score, h.score_version, h.score_updated_at, h.service_gates_json,
  h.stability, h.successful_attempts, h.total_attempts, h.http_status, h.error_code, h.error_message,
  h.runner_error_code, h.runner_error_message, h.pending_cycle_id,
  h.proxy_status, h.proxy_latency_ms, h.proxy_http_status, h.proxy_error_code, h.proxy_checked_at, h.proxy_checked_address
  FROM subscription_nodes n JOIN subscription_sources s ON s.id = n.source_id
  LEFT JOIN subscription_node_health h ON h.node_id = n.id`;

function parseServiceGates(value) {
  let parsed = value;
  if (!Array.isArray(parsed)) {
    if (!value) return [];
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  // Never let malformed persisted JSON crash the catalog/API renderer.
  return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
}

function viaForConfig(config) {
  return config.httpProxy && config.httpProxyMode === 'only' ? 'proxy' : 'direct';
}

function ownsCycle(current, node, cycleId) {
  return Boolean(current && current.source_active && current.is_present && current.is_enabled &&
    current.source_revision === node.source_revision && current.generation === node.generation &&
    current.fingerprint === node.fingerprint && current.pending_cycle_id === cycleId);
}

function insertCheck({ jobId = null, cycleId, node, config, profile, targetId = null, attempt = null,
  outcome, latencyMs = null, httpStatus = null, errorCode = null, bytes = null, throughput = null,
  via = null, now = Date.now() }) {
  db.run(`INSERT INTO subscription_node_checks (job_id, cycle_id, node_id, config_fingerprint, generation,
    probe_profile_version, test_target_id, attempt, outcome, latency_ms, http_status, error_code, checked_at, via, profile, bytes_transferred, throughput_bps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [jobId, cycleId, node.id, node.fingerprint, node.generation, config.profileVersion, targetId, attempt, outcome,
    latencyMs ?? null, httpStatus ?? null, errorCode || null, now, via || viaForConfig(config), profile,
    bytes ?? null, throughput ?? null]);
}

function getNode(id) {
  return db.get(`${NODE_SELECT} WHERE n.id = ?`, [id]);
}

function getNodes(sourceId) {
  return db.all(`${NODE_SELECT} WHERE n.source_id = ? ORDER BY n.name, n.id`, [sourceId]);
}

function proxyEligibility(node, config, now = Date.now()) {
  if (!config.httpProxy || config.httpProxyMode !== 'extra') return 'not_required';
  if (node.generation !== node.health_generation || node.fingerprint !== node.config_fingerprint || node.probe_profile_version !== config.profileVersion) return 'proxy_unknown';
  if (node.proxy_status !== 'healthy') return node.proxy_status || 'proxy_unknown';
  if (!node.proxy_checked_address || node.proxy_checked_address !== node.checked_address) return 'proxy_unknown';
  if (!Number.isFinite(node.proxy_latency_ms) || node.proxy_latency_ms < 0) return 'proxy_unknown';
  if (!node.proxy_checked_at || now < node.proxy_checked_at || now - node.proxy_checked_at >= config.healthyTtlMs) return 'proxy_stale';
  return 'proxy_ok';
}

function eligibility(node, config, now = Date.now()) {
  if (!node.source_active) return 'source_disabled';
  if (node.capability_status !== 'supported') return node.capability_status;
  if (!node.is_present) return 'removed';
  if (!node.is_enabled) return 'disabled';
  if (node.generation !== node.health_generation || node.fingerprint !== node.config_fingerprint || node.probe_profile_version !== config.profileVersion) return 'unknown';
  if (node.status !== 'healthy') return node.status || 'unknown';
  if (!Number.isFinite(node.latency_ms) || node.latency_ms < 0 || !Number.isInteger(node.successful_attempts) ||
      node.successful_attempts < config.minSuccess || node.successful_attempts > node.total_attempts || node.total_attempts !== config.attempts) return 'unknown';
  if (!node.last_checked_at || now < node.last_checked_at) return 'unknown';
  if (now - node.last_checked_at >= config.healthyTtlMs) return 'stale';
  if (!String(node.checked_address || '').trim()) return 'unknown_address';
  return 'healthy';
} 

function compareNodes(a, b, config, now = Date.now()) {
  const aHealthy = deliveryState(a, config, now) === 'fresh';
  const bHealthy = deliveryState(b, config, now) === 'fresh';
  if (aHealthy !== bHealthy) return aHealthy ? -1 : 1;
  if (aHealthy) {
    const aProxy = proxyEligibility(a, config, now) === 'proxy_ok';
    const bProxy = proxyEligibility(b, config, now) === 'proxy_ok';
    if (aProxy !== bProxy) return aProxy ? -1 : 1;
    // Reliability comes before latency: a single fast request is not a stable connection.
    const quality = b.successful_attempts / b.total_attempts - a.successful_attempts / a.total_attempts ||
      (a.target_priority ?? Number.MAX_SAFE_INTEGER) - (b.target_priority ?? Number.MAX_SAFE_INTEGER) ||
      (Number(b.score ?? -1) - Number(a.score ?? -1)) ||
      (aProxy ? a.proxy_latency_ms - b.proxy_latency_ms : a.latency_ms - b.latency_ms);
    if (quality) return quality;
    const identity = String(a.fingerprint || '').localeCompare(String(b.fingerprint || ''));
    if (identity) return identity;
  }
  // Old latency values must not promote unavailable nodes in the catalog.
  return String(a.name || '').localeCompare(String(b.name || ''), 'ru') || String(a.id).localeCompare(String(b.id));
}

function checkedAddressKey(node) {
  let address = String(node.checked_address || '').trim().toLowerCase();
  // Canonicalize IPv4-mapped IPv6 so equivalent endpoints dedupe identically.
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return address;
}

function deliveryState(node, config, now = Date.now()) {
  const state = eligibility(node, config, now);
  if (state === 'healthy') return 'fresh';
  if (state !== 'stale') return state;
  if (node.generation !== node.health_generation || node.fingerprint !== node.config_fingerprint ||
      node.probe_profile_version !== config.profileVersion || !node.checked_address ||
      !Number.isFinite(node.latency_ms) || node.latency_ms < 0 || !node.last_success_at ||
      now < node.last_success_at || now - node.last_success_at >= (config.hardExpiryMs || config.healthyTtlMs * 2)) return 'hard_expired';
  return 'stale';
}

function rankNodes(nodes, config, now = Date.now()) {
  const preferred = [];
  const remaining = [];
  const addresses = new Set();
  for (const node of [...nodes].sort((a, b) => compareNodes(a, b, config, now))) {
    const key = checkedAddressKey(node);
    if (deliveryState(node, config, now) === 'fresh' && !addresses.has(key)) {
      addresses.add(key);
      preferred.push(node);
    } else remaining.push(node);
  }
  // Keep duplicates visible in the catalog, but after the unique candidates a user can receive.
  const deliverable = new Set(preferred.map(node => node.id));
  return [...preferred, ...remaining].map(node => ({ ...node, delivery_candidate: deliverable.has(node.id) }));
}

function safeNode(node, config, now = Date.now()) {
  const { normalized_config_json, fingerprint, config_fingerprint, pending_cycle_id, service_gates_json, ...safe } = node;
  const effective = eligibility(node, config, now);
  return {
    ...safe,
    service_gates: parseServiceGates(service_gates_json),
    effective_status: effective,
    proxy_effective_status: proxyEligibility(node, config, now)
  };
}

function markStarted(node, cycleId, now = Date.now()) {
  db.run(`INSERT INTO subscription_node_health (node_id, config_fingerprint, generation, last_attempt_at, pending_cycle_id)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
    pending_cycle_id = excluded.pending_cycle_id, generation = excluded.generation`, [node.id, node.fingerprint, node.generation, now, cycleId]);
}

// A successful Fast phase is persisted right away so the catalog can show
// reachability while Full is still running, and a crash mid-Full keeps it.
// It deliberately leaves the main verdict, score, gates and schedule alone.
function recordFastObservation(node, cycleId, fast, config, jobId = null, now = Date.now()) {
  if (!fast || !['reachable', 'healthy'].includes(fast.status)) return false;
  if (!ownsCycle(getNode(node.id), node, cycleId)) return false;
  db.transaction(() => {
    insertCheck({ jobId, cycleId, node, config, profile: 'fast', attempt: 1, outcome: 'success',
      latencyMs: fast.latencyMs, httpStatus: fast.httpStatus, errorCode: fast.errorCode,
      bytes: fast.bytesTransferred, throughput: fast.throughputBps, now });
    db.run(`UPDATE subscription_node_health SET fast_status = 'reachable', fast_latency_ms = ?,
      fast_checked_at = ?, fast_error_code = NULL, runner_error_code = NULL, runner_error_message = NULL WHERE node_id = ?`,
    [fast.latencyMs ?? null, now, node.id]);
  });
  return true;
}

function recordResult(node, cycleId, result, config, jobId = null, now = Date.now()) {
  const current = getNode(node.id);
  if (!ownsCycle(current, node, cycleId)) return false;
  const hasProxyResult = Object.hasOwn(result, 'proxy');
  const fast = result.fast || null;
  const fastRecorded = Boolean(fast) && result.fastRecorded === true;
  // A standalone Fast Probe reports profile=fast and has no nested full result.
  // A pipeline reports the successful Fast phase as result.fast next to the
  // Full Probe measurements. A Full check can also stop at its embedded Fast
  // phase; until Full actually ran, it is still just a Fast observation.
  const fastOnly = !fast && result.profile === 'fast';
  const fastStoppedFull = !fastRecorded && Boolean(fast) && !['reachable', 'healthy'].includes(fast.status) && !(result.attempts || []).length;
  const fastObservationOnly = fastOnly || fastStoppedFull;
  const fastRow = fastRecorded ? null : fast || (fastOnly ? result : null);
  const runnerFailure = ['runner_error', 'cancelled'].includes(result.status);
  const via = viaForConfig(config);
  const addCheck = (profile, targetId, attempt, outcome, latencyMs, httpStatus, errorCode, bytes, throughput, viaOverride = null) =>
    insertCheck({ jobId, cycleId, node, config, profile, targetId, attempt, outcome, latencyMs, httpStatus,
      errorCode, bytes, throughput, via: viaOverride || via, now });
  db.transaction(() => {
    if (fastRow) {
      const reachable = ['reachable', 'healthy'].includes(fastRow.status);
      addCheck('fast', null, 1, reachable ? 'success' : 'failure', fastRow.latencyMs,
        fastRow.httpStatus, fastRow.errorCode, fastRow.bytesTransferred, fastRow.throughputBps);
    }
    if (!fastOnly) {
      for (const attempt of result.attempts || []) {
        addCheck('full', attempt.targetId || null, attempt.attempt ?? null, attempt.outcome, attempt.latencyMs,
          attempt.httpStatus, attempt.errorCode, attempt.bytesTransferred, attempt.throughputBps);
      }
    }
    if (fastObservationOnly) {
      if (runnerFailure) {
        // The runner failed before any node measurement. It must not turn a
        // previously healthy node offline or overwrite its last good score.
        db.run(`UPDATE subscription_node_health SET pending_cycle_id = NULL, runner_error_code = ?, runner_error_message = ?,
          fast_status = ?, fast_error_code = ?, fast_checked_at = ? WHERE node_id = ?`,
        [result.errorCode, result.errorMessage, fastRow.status, fastRow.errorCode || null, now, node.id]);
      } else if (fastRow.status === 'reachable' || fastRow.status === 'healthy') {
        // Fast success only proves reachability. It deliberately does not
        // refresh the main health verdict, latency, score, gates or TTL.
        db.run(`UPDATE subscription_node_health SET pending_cycle_id = NULL, fast_status = 'reachable', fast_latency_ms = ?,
          fast_checked_at = ?, fast_error_code = NULL, runner_error_code = NULL, runner_error_message = NULL WHERE node_id = ?`,
        [fastRow.latencyMs ?? null, now, node.id]);
      } else {
        const status = ['offline', 'test_failed', 'degraded', 'unsupported', 'invalid'].includes(fastRow.status) ? fastRow.status : 'offline';
        db.run(`UPDATE subscription_node_health SET status = ?, config_fingerprint = ?, generation = ?,
          probe_profile_version = ?, probe_profile = 'fast', probe_location = ?, checked_address = ?, cycle_id = ?,
          pending_cycle_id = NULL, last_checked_at = ?, latency_ms = NULL, test_target_id = NULL, target_priority = NULL,
          http_status = NULL, successful_attempts = 0, total_attempts = 1, error_code = ?, error_message = ?,
          fast_status = ?, fast_latency_ms = ?, fast_checked_at = ?, fast_error_code = ?,
          runner_error_code = NULL, runner_error_message = NULL WHERE node_id = ?`,
        [status, node.fingerprint, node.generation, config.profileVersion, config.probeLocation,
          fastRow.checkedAddress || node.host || null, cycleId, now, fastRow.errorCode || null,
          fastRow.status === 'offline' ? 'Fast Probe не достиг узла.' : (fastRow.errorMessage || null),
          fastRow.status, fastRow.latencyMs ?? null, now, fastRow.errorCode || null, node.id]);
      }
    } else if (runnerFailure) {
      db.run(`UPDATE subscription_node_health SET pending_cycle_id = NULL, runner_error_code = ?, runner_error_message = ? WHERE node_id = ?`,
        [result.errorCode, result.errorMessage, node.id]);
      if (fast && !fastRecorded) {
        // The Fast phase completed, but the Full Probe did not produce a
        // verdict. Keep the Fast observation while preserving last good health.
        db.run(`UPDATE subscription_node_health SET fast_status = ?, fast_latency_ms = ?, fast_checked_at = ?, fast_error_code = ? WHERE node_id = ?`,
          [fast.status, fast.latencyMs ?? null, now, fast.errorCode || null, node.id]);
      }
    } else {
      const history = db.all(`SELECT latency_ms FROM subscription_node_checks
        WHERE node_id = ? AND profile = 'full' AND outcome = 'success' AND latency_ms IS NOT NULL
        ORDER BY id DESC LIMIT 20`, [node.id]);
      const stability = calculateStability({
        latencies: history.map(row => row.latency_ms),
        successfulAttempts: result.successCount,
        totalAttempts: result.attemptCount
      });
      const score = calculateScore({ latencyMs: result.latencyMs, throughputBps: result.throughputBps,
        successfulAttempts: result.successCount, totalAttempts: result.attemptCount, stability });
      db.run(`UPDATE subscription_node_health SET status = ?, config_fingerprint = ?, generation = ?,
        probe_profile_version = ?, probe_profile = 'full', probe_location = ?, checked_address = ?, cycle_id = ?, pending_cycle_id = NULL, last_checked_at = ?,
        last_success_at = CASE WHEN ? = 'healthy' THEN ? ELSE last_success_at END, latency_ms = ?, test_target_id = ?,
        target_priority = ?, http_status = ?, successful_attempts = ?, total_attempts = ?, error_code = ?, error_message = ?,
        throughput_bps = ?, score = ?, score_version = ?, score_updated_at = ?, stability = ?,
        runner_error_code = NULL, runner_error_message = NULL WHERE node_id = ?`,
      [result.status, node.fingerprint, node.generation, config.profileVersion, config.probeLocation, result.checkedAddress || node.host || null, cycleId, now,
        result.status, now, result.latencyMs ?? null, result.targetId || null, result.targetPriority ?? null,
        result.httpStatus ?? null, result.successCount || 0, result.attemptCount || 0, result.errorCode || null, result.errorMessage || null,
        result.throughputBps ?? null, score, SCORE_VERSION, now, stability, node.id]);
      db.run('UPDATE subscription_node_health SET service_gates_json = ? WHERE node_id = ?', [JSON.stringify(result.serviceGates || []), node.id]);
      if (fast && !fastRecorded) {
        db.run(`UPDATE subscription_node_health SET fast_status = ?, fast_latency_ms = ?, fast_checked_at = ?, fast_error_code = ? WHERE node_id = ?`,
          [fast.status, fast.latencyMs ?? null, now, fast.errorCode || null, node.id]);
      }
    }
    // A successful standalone Fast observation must not postpone the Full
    // check schedule; only a real Full result (or a Fast failure, which makes
    // the node unavailable) advances the next check.
    const fastSuccessOnly = fastObservationOnly && ['reachable', 'healthy'].includes(fastRow.status);
    if (!fastSuccessOnly) {
      const interval = result.status === 'degraded' ? Math.min(60000, config.checkIntervalMs) : config.checkIntervalMs;
      db.run('UPDATE subscription_nodes SET next_check_at = ? WHERE id = ?', [now + interval + Math.floor(Math.random() * Math.min(interval * 0.05, 10000)), node.id]);
    }
    // Proxy measurements live in their own columns; a runner-level retry keeps the last valid proxy reading.
    if (hasProxyResult && !runnerFailure) {
      const proxy = result.proxy || null;
      for (const attempt of proxy?.attempts || []) {
        addCheck('proxy', attempt.targetId || null, attempt.attempt ?? null, attempt.outcome, attempt.latencyMs,
          attempt.httpStatus, attempt.errorCode, attempt.bytesTransferred, attempt.throughputBps, 'proxy');
      }
      db.run(`UPDATE subscription_node_health SET proxy_status = ?, proxy_latency_ms = ?, proxy_http_status = ?,
        proxy_error_code = ?, proxy_checked_at = ?, proxy_checked_address = ? WHERE node_id = ?`,
      [proxy ? proxy.status || null : null, proxy ? proxy.latencyMs ?? null : null, proxy ? proxy.httpStatus ?? null : null,
        proxy ? proxy.errorCode ?? null : null, proxy ? now : null, proxy ? proxy.checkedAddress || null : null, node.id]);
    } else if (!hasProxyResult && config.httpProxyMode === 'only') {
      // In "only" mode the proxy path IS the main measurement; stale extra-readings are cleared.
      db.run(`UPDATE subscription_node_health SET proxy_status = NULL, proxy_latency_ms = NULL,
        proxy_http_status = NULL, proxy_error_code = NULL, proxy_checked_at = NULL, proxy_checked_address = NULL WHERE node_id = ?`, [node.id]);
    }
  });
  return true;
}

function pruneHistory(now = Date.now(), config = {}) {
  const historyDays = Number.isInteger(config.historyDays) ? config.historyDays : 7;
  const maxHistoryRows = Number.isInteger(config.maxHistoryRows) ? config.maxHistoryRows : 50000;
  const before = db.get('SELECT count(*) AS n FROM subscription_node_checks').n;
  db.transaction(() => {
    db.run('DELETE FROM subscription_node_checks WHERE checked_at < ?', [now - historyDays * 86400000]);
    db.run(`DELETE FROM subscription_node_checks WHERE id < COALESCE(
      (SELECT id FROM subscription_node_checks ORDER BY id DESC LIMIT 1 OFFSET ?), 0)`, [Math.max(0, maxHistoryRows - 1)]);
    db.run(`DELETE FROM background_jobs WHERE state NOT IN ('queued', 'running') AND id NOT IN (
      SELECT id FROM background_jobs ORDER BY created_at DESC LIMIT 100)`);
    db.run('DELETE FROM subscription_nodes WHERE is_present = 0 AND removed_at < ?', [now - 30 * 86400000]);
  });
  const after = db.get('SELECT count(*) AS n FROM subscription_node_checks').n;
  return { before, after, deleted: before - after, historyDays, maxHistoryRows };
}

module.exports = { NODE_SELECT, getNode, getNodes, safeNode, parseServiceGates, eligibility, deliveryState, proxyEligibility, compareNodes, checkedAddressKey, rankNodes, markStarted, recordFastObservation, recordResult, pruneHistory };
