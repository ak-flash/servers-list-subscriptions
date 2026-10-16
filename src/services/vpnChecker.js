const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { performance } = require('perf_hooks');
const { setTimeout: delay } = require('timers/promises');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { buildXrayConfig } = require('../utils/xrayConfigBuilder');
const { resolvePublicHost, abortable } = require('../utils/safeHttp');
const { SubscriptionError, safeError, messages } = require('../utils/subscriptionErrors');

const exec = promisify(execFile);

function cleanEnvironment(directory) {
  return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, HOME: directory, TMPDIR: directory, TEMP: directory, TMP: directory };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForPort(port, child, timeoutMs, signal) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null || child.spawnError) throw new SubscriptionError('xray_start');
    const ready = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const finish = value => { socket.destroy(); resolve(value); };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(150, () => finish(false));
    });
    if (ready && child.exitCode === null && !child.spawnError) return;
    await delay(40, undefined, { signal });
  }
  throw new SubscriptionError('xray_start');
}

function signalChild(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'linux') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise(resolve => {
    let killTimer;
    let finalTimer;
    const finish = () => { clearTimeout(killTimer); clearTimeout(finalTimer); child.removeListener('exit', finish); resolve(); };
    child.once('exit', finish);
    signalChild(child, 'SIGTERM');
    killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), 500);
    finalTimer = setTimeout(finish, 1500);
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function evaluateTargets(config, request, signal) {
  const attempts = [];
  const targets = [];
  for (const target of config.targets) {
    const results = [];
    for (let i = 1; i <= config.attempts; i++) {
      signal?.throwIfAborted();
      const result = await request(target, i);
      results.push(result);
      attempts.push({ ...result, targetId: target.id, attempt: i });
    }
    const successes = results.filter(result => result.outcome === 'success');
    targets.push({ target, results, successes });
    if (successes.length >= config.minSuccess) break;
  }
  const selected = [...targets].sort((a, b) => b.successes.length - a.successes.length || a.target.priority - b.target.priority)[0];
  const successCount = selected.successes.length;
  const status = successCount >= config.minSuccess ? 'healthy' : successCount ? 'degraded' :
    attempts.some(a => ['unexpected_http_status', 'unexpected_body'].includes(a.errorCode)) ? 'test_failed' : 'offline';
  const last = selected.successes.at(-1) || selected.results.at(-1);
  const failure = status === 'healthy' ? null : selected.results.find(result => result.outcome !== 'success');
  return {
    status, attempts, targetId: selected.target.id, targetPriority: selected.target.priority,
    successCount, attemptCount: config.attempts,
    latencyMs: successCount ? median(selected.successes.map(result => result.latencyMs)) : null,
    httpStatus: last.httpStatus ?? null, errorCode: failure?.errorCode || null,
    errorMessage: failure ? messages[failure.errorCode] || messages.connection_error : null
  };
}

async function requestThroughSocks(target, socksUrl, timeoutMs, signal, ca) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new SubscriptionError('probe_timeout')), timeoutMs);
  const combined = AbortSignal.any([signal, controller.signal]);
  const agent = new SocksProxyAgent(socksUrl, { timeout: timeoutMs, keepAlive: false });
  const started = performance.now();
  try {
    return await new Promise((resolve, reject) => {
      const req = https.get(target.url, {
        agent, signal: combined, rejectUnauthorized: true, ca,
        headers: { 'cache-control': 'no-cache, no-store', connection: 'close' }
      }, res => {
        let size = 0;
        const chunks = [];
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 4096) req.destroy(new SubscriptionError('unexpected_body'));
          else chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const correctStatus = res.statusCode === target.status;
          const correctBody = target.body === undefined ? (target.status !== 204 || size === 0) : body === target.body;
          resolve({
            outcome: correctStatus && correctBody ? 'success' : 'failure',
            latencyMs: performance.now() - started, httpStatus: res.statusCode,
            errorCode: !correctStatus ? 'unexpected_http_status' : !correctBody ? 'unexpected_body' : null
          });
        });
      });
      req.once('error', reject);
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const code = combined.aborted ? 'probe_timeout' : error instanceof SubscriptionError ? error.code :
      /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code || '') ? 'tls_error' : 'connection_error';
    return { outcome: 'failure', latencyMs: performance.now() - started, httpStatus: null, errorCode: code };
  } finally {
    clearTimeout(timer);
    agent.destroy();
  }
}

class VpnChecker {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.resolveHost = dependencies.resolveHost || resolvePublicHost;
    this.ca = dependencies.ca; // Local integration-test CA; not configurable by a subscription source.
    this.targetCa = dependencies.targetCa === undefined ? this.ca : dependencies.targetCa;
    this.diagnostic = dependencies.diagnostic;
    this.active = new Map();
    this.verified = null;
    this.status = { available: null, error: null, version: config.xrayVersion };
  }

  async verifyBinary() {
    const { xrayPath, xrayVersion, xraySha256, tempDir } = this.config;
    try {
      const stat = await fs.promises.stat(xrayPath);
      const signature = `${stat.size}:${stat.mtimeMs}:${xraySha256}:${xrayVersion}`;
      if (signature === this.verified) return;
      if (xraySha256) {
        const digest = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(xrayPath)) digest.update(chunk);
        if (digest.digest('hex') !== xraySha256.toLowerCase()) throw new SubscriptionError('xray_checksum');
      }
      const { stdout } = await exec(xrayPath, ['version'], { timeout: 5000, maxBuffer: 65536, windowsHide: true, env: cleanEnvironment(tempDir) });
      const match = /Xray\s+(\d+\.\d+\.\d+)/.exec(stdout);
      if (match?.[1] !== xrayVersion) throw new SubscriptionError('xray_version');
      this.verified = signature;
      this.status = { available: true, error: null, version: xrayVersion };
    } catch (error) {
      const code = error instanceof SubscriptionError ? error.code : ['ENOENT', 'EACCES'].includes(error.code) ? 'xray_missing' : 'runner_error';
      this.status = { available: false, error: messages[code], version: xrayVersion };
      throw new SubscriptionError(code);
    }
  }

  async cleanup() {
    await fs.promises.mkdir(this.config.tempDir, { recursive: true, mode: 0o700 });
    // A single app process owns this private directory. systemd kills the previous cgroup on restart.
    for (const entry of await fs.promises.readdir(this.config.tempDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^probe-[a-z\d_-]+$/i.test(entry.name)) {
        await fs.promises.rm(path.join(this.config.tempDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  async check(node, { signal } = {}) {
    const config = this.config;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new SubscriptionError('probe_timeout')), config.deadlineMs);
    const started = performance.now();
    let directory;
    let child;
    let networkStarted = false;
    const token = crypto.randomUUID();
    this.active.set(token, { controller, child: null });
    try {
      await abortable(this.verifyBinary(), combined);
      const parsed = JSON.parse(node.normalized_config_json);
      const address = await this.resolveHost(parsed.host, { signal: combined });
      await fs.promises.mkdir(config.tempDir, { recursive: true, mode: 0o700 });
      directory = await fs.promises.mkdtemp(path.join(config.tempDir, 'probe-'));
      const credentials = { user: crypto.randomBytes(12).toString('hex'), password: crypto.randomBytes(24).toString('hex') };
      let port;
      for (let attempt = 0; attempt < 3; attempt++) {
        combined.throwIfAborted();
        port = await freePort();
        const filename = path.join(directory, 'config.json');
        const xrayConfig = buildXrayConfig(parsed, address.address, port, credentials, this.ca);
        if (this.diagnostic) xrayConfig.log.loglevel = 'debug';
        await fs.promises.writeFile(filename, JSON.stringify(xrayConfig), { mode: 0o600 });
        child = spawn(config.xrayPath, ['run', '-c', filename], {
          cwd: directory, shell: false, windowsHide: true, detached: process.platform === 'linux',
          env: cleanEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe']
        });
        this.active.get(token).child = child;
        child.on('error', () => { child.spawnError = true; });
        const inspect = data => {
          if (/address already in use|Only one usage of each socket/i.test(data.toString())) child.portConflict = true;
          if (this.diagnostic) this.diagnostic(data.toString());
        };
        child.stdout.on('data', inspect);
        child.stderr.on('data', inspect);
        try {
          await waitForPort(port, child, config.readyTimeoutMs, combined);
          break;
        } catch (error) {
          await stopChild(child);
          if (!child.portConflict || attempt === 2) throw error;
        }
      }
      const startupMs = performance.now() - started;
      const socksUrl = `socks5h://${credentials.user}:${credentials.password}@127.0.0.1:${port}`;
      networkStarted = true;
      const result = await evaluateTargets(config, async target => {
        if (child.exitCode !== null || child.spawnError) throw new SubscriptionError('xray_exit');
        return requestThroughSocks(target, socksUrl, config.attemptTimeoutMs, combined, this.targetCa);
      }, combined);
      return { ...result, startupMs, durationMs: performance.now() - started };
    } catch (error) {
      const actual = combined.aborted ? combined.reason : error;
      const safe = safeError(actual);
      let status = 'runner_error';
      if (['cancelled', 'superseded'].includes(safe.code)) status = 'cancelled';
      else if (safe.code === 'unsupported' || safe.code === 'blocked_address') status = 'unsupported';
      else if (safe.code === 'invalid_link') status = 'invalid';
      else if (safe.code === 'dns_error' || (safe.code === 'probe_timeout' && networkStarted)) status = 'offline';
      return { status, errorCode: safe.code, errorMessage: safe.message, attempts: [], durationMs: performance.now() - started };
    } finally {
      clearTimeout(timer);
      controller.abort(new SubscriptionError('cancelled'));
      await stopChild(child);
      this.active.delete(token);
      if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }

  async stop() {
    for (const entry of this.active.values()) entry.controller.abort(new SubscriptionError('cancelled'));
    await Promise.all([...this.active.values()].map(entry => stopChild(entry.child)));
  }
}

module.exports = { VpnChecker, evaluateTargets, requestThroughSocks, freePort, stopChild };
