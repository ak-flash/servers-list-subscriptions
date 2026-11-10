const SCORE_VERSION = '2';

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function ratio(successfulAttempts, totalAttempts) {
  const attempts = Math.max(0, Number(totalAttempts) || 0);
  const successes = Math.max(0, Math.min(attempts, Number(successfulAttempts) || 0));
  // Small-sample smoothing keeps a single lucky probe from looking perfect.
  return attempts > 0 ? (successes + 2) / (attempts + 4) : 0;
}

// Stability combines the success rate with latency consistency (coefficient of
// variation). A node that is always reachable with a steady latency is more
// stable than one with the same success count but wildly varying responses.
function calculateStability({ latencies = [], successfulAttempts = 0, totalAttempts = 0 } = {}) {
  const attempts = Math.max(0, Number(totalAttempts) || 0);
  const successes = Math.max(0, Math.min(attempts, Number(successfulAttempts) || 0));
  const successRate = attempts > 0 ? successes / attempts : 0;
  const samples = latencies.map(Number).filter(value => Number.isFinite(value) && value >= 0);
  if (samples.length < 2) return Math.round(clamp(successRate, 0, 1) * 1000) / 1000;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const variation = mean > 0 ? Math.sqrt(variance) / mean : 0;
  const consistency = 1 / (1 + variation);
  return Math.round(clamp(successRate * (0.75 + 0.25 * consistency), 0, 1) * 1000) / 1000;
}

function calculateScore({ latencyMs, throughputBps, successfulAttempts = 0, totalAttempts = 0, stability } = {}) {
  const reliability = ratio(successfulAttempts, totalAttempts) * 100;
  const latency = Number(latencyMs);
  const latencyScore = Number.isFinite(latency) && latency >= 0 ? 100 * Math.exp(-latency / 800) : 0;
  const throughput = Number(throughputBps);
  // 0/null means "not measurable" (typically a bodyless 204 target), not a
  // measured zero speed. Neutral scoring avoids punishing such nodes.
  const throughputScore = Number.isFinite(throughput) && throughput > 0 ? clamp(throughput / 1024 / 1024 * 100) : 50;
  const stabilityValue = Number(stability);
  const stabilityScore = Number.isFinite(stabilityValue) ? clamp(stabilityValue, 0, 1) * 100 : reliability;
  return Math.round(clamp(reliability * 0.4 + latencyScore * 0.25 + throughputScore * 0.2 + stabilityScore * 0.15) * 100) / 100;
}

module.exports = { SCORE_VERSION, calculateScore, calculateStability };
