const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');

// Minimal file-backed session store. Sessions survive process restarts, are
// written atomically, and expired entries are swept on a timer so the
// directory cannot grow without bound.
class FileSessionStore extends session.Store {
  constructor({ directory, ttlMs = 24 * 60 * 60 * 1000, sweepIntervalMs = 10 * 60 * 1000 } = {}) {
    super();
    if (!directory) throw new Error('FileSessionStore requires a directory');
    this.directory = path.resolve(directory);
    this.ttlMs = ttlMs;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  file(sid) {
    return path.join(this.directory, `${crypto.createHash('sha256').update(String(sid)).digest('hex')}.json`);
  }

  get(sid, callback) {
    fs.readFile(this.file(sid), 'utf8', (error, data) => {
      if (error) return callback(null, null);
      try {
        const record = JSON.parse(data);
        if (!record.expiresAt || record.expiresAt <= Date.now()) {
          fs.unlink(this.file(sid), () => {});
          return callback(null, null);
        }
        callback(null, record.session);
      } catch (parseError) {
        callback(parseError);
      }
    });
  }

  set(sid, value, callback = () => {}) {
    const expiresAt = value?.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + this.ttlMs;
    const target = this.file(sid);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFile(temporary, JSON.stringify({ expiresAt, session: value }), { mode: 0o600 }, error => {
      if (error) return callback(error);
      fs.rename(temporary, target, callback);
    });
  }

  touch(sid, value, callback = () => {}) {
    this.get(sid, (error, existing) => {
      if (error || !existing) return callback(error || null);
      this.set(sid, { ...existing, cookie: value.cookie }, callback);
    });
  }

  destroy(sid, callback = () => {}) {
    fs.unlink(this.file(sid), () => callback(null));
  }

  sweep() {
    fs.readdir(this.directory, (error, entries) => {
      if (error) return;
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const target = path.join(this.directory, entry);
        fs.readFile(target, 'utf8', (readError, data) => {
          if (readError) return;
          try {
            const record = JSON.parse(data);
            if (!record.expiresAt || record.expiresAt <= Date.now()) fs.unlink(target, () => {});
          } catch {
            fs.unlink(target, () => {});
          }
        });
      }
    });
  }

  close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

module.exports = { FileSessionStore };
