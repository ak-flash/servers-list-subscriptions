// One absolute check deadline. Explicit legacy limits remain valid even when
// they cannot accommodate the worst-case plan; no silent migration of numbers.
function probeBudget(config) {
  const cycles = 2 + (config.httpProxy && config.httpProxyMode === 'extra' ? 1 : 0);
  const perCycleMs = 3 * config.readyTimeoutMs + config.attemptTimeoutMs * config.attempts * config.targets.length;
  const requiredMs = 5000 + cycles * perCycleMs;
  const deadlineMs = config.deadlineMode === 'auto' || config.deadlineMs == null
    ? Math.min(180000, Math.max(5000, requiredMs)) : config.deadlineMs;
  // Runtime callers may use sub-5-second deadlines for cancellation tests;
  // persisted/env validation applies the user-facing 5–180 second bounds.
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 180000) {
    throw new Error('PROBE_DEADLINE_SECONDS: допустимо положительное значение до 180 секунд или auto');
  }
  return { deadlineMs, requiredMs, constrained: deadlineMs < requiredMs };
}
module.exports = { probeBudget };
