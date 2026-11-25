// Bounded, self-cleaning rate limiter.
//
// Entries expire after their window, and the map is pruned periodically so a
// flood of distinct keys cannot grow memory without limit. When the maximum
// number of tracked keys is reached, the oldest entries are evicted first.
class RateLimiter {
  constructor({ maxKeys = 10000, sweepIntervalMs = 60 * 1000 } = {}) {
    this.maxKeys = Math.max(1, maxKeys);
    this.entries = new Map();
    this.sweepIntervalMs = sweepIntervalMs;
    this.sweepTimer = null;
  }

  hit(key, windowMs, max, now = Date.now()) {
    this.prune(now);
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= max) return false;
    entry.count++;
    this.evictOverflow();
    return true;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }

  evictOverflow() {
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  start() {
    if (this.sweepTimer || !this.sweepIntervalMs) return this;
    this.sweepTimer = setInterval(() => this.prune(), this.sweepIntervalMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
    return this;
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { RateLimiter };
