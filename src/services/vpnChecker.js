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
const { resolvePublicAddresses, resolvePublicHost, abortable } = require('../utils/safeHttp');
const { SubscriptionError, safeError, messages } = require('../utils/subscriptionErrors');
const { snapshotProbeConfig } = require('../config/subscriptions');
const { probeDeadlineMs } = require('../utils/probeBudget');

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

function fastHandshakePlan(parsed) {
  const transport = parsed.network || 'tcp';
  const security = parsed.security || 'none';
  return {
    protocol: parsed.protocol || 'unknown', transport, security,
    mode: security === 'none' ? 'tcp-connect' : 'tls-clienthello',
    // The current Fast Probe still launches a reduced Xray cycle for every
    // supported transport, so the plan must not claim a direct socket path.
    requiresXray: true
  };
}

function startupDetail(output) {
  // Redact before truncation and cover URI credentials plus common Xray
  // credential-bearing fields. Startup diagnostics must remain bounded and
  // must never echo raw proxy/node secrets.
  let detail = String(output || '')
    .replace(/(?:vless|vmess|trojan|hysteria2|ss):\/\/\S+/gi, '[redacted-uri]')
    .replace(/(config|settings|payload|stream|json)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]')
    .replace(/(password|pass|secret|uuid|id|token|authorization|proxy-authorization)\s*[:=]\s*[^,;\s}]+/gi, '$1=[redacted]')
    .replace(/\b(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\b/gi, '[redacted-uuid]')
    .replace(/\s+/g, ' ').trim();
  return detail ? detail.slice(-240) : null;
}

async function evaluateTargets(config, request, signal) {
  const attempts = [];
  const started = performance.now();
  const targets = [];
  for (const target of config.targets) {
    const results = [];
    for (let i = 1; i <= config.attempts; i++) {
      signal?.throwIfAborted();
      const result = await abortable(Promise.resolve().then(() => request(target, i)), signal);
      signal?.throwIfAborted();
      results.push(result);
      attempts.push({ ...result, targetId: target.id, attempt: i });
    }
    const successes = results.filter(result => result.outcome === 'success');
    targets.push({ target, results, successes });
    if (successes.length >= config.minSuccess) break;
  }
  const selected = [...targets].sort((a, b) => b.successes.length - a.successes.length || a.target.priority - b.target.priority)[0];
  const successCount = selected.successes.length;
  const status = successCount >= config.minSuccess ? 'healthy' : successCount > 0 ? 'degraded' :
    selected.results.some(result => ['unexpected_http_status', 'unexpected_body'].includes(result.errorCode)) ? 'test_failed' : 'offline';
  const last = selected.successes.at(-1) || selected.results.at(-1);
  const failure = status === 'healthy' ? null : selected.results.find(result => result.outcome !== 'success');
  const throughputSamples = selected.successes
    .map(item => Number(item.throughputBps))
    .filter(value => Number.isFinite(value) && value > 0);
  return {
    status, attempts, targetId: selected.target.id, durationMs: performance.now() - started, targetPriority: selected.target.priority,
    successCount, attemptCount: selected.results.length,
    latencyMs: successCount ? median(selected.successes.map(result => result.latencyMs)) : null,
    httpStatus: last.httpStatus ?? null, errorCode: failure?.errorCode || null,
    bytesTransferred: selected.successes.reduce((sum, item) => sum + (item.bytesTransferred || 0), 0),
    // Bodyless probes (e.g. generate_204) transfer no payload. Unknown speed
    // must stay null instead of being reported as a real 0 B/s measurement.
    throughputBps: throughputSamples.length ? throughputSamples.reduce((sum, value) => sum + value, 0) / throughputSamples.length : null,
    serviceGates: selected.results.map(item => ({ targetId: selected.target.id, passed: item.outcome === 'success', status: item.httpStatus ?? null, errorCode: item.errorCode || null })),
    errorMessage: failure ? messages[failure.errorCode] || messages.connection_error : null
  };
}

async function requestThroughHttpProxy(target, proxy, timeoutMs, signal, ca) {
  signal?.throwIfAborted?.();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new SubscriptionError('probe_timeout')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const targetUrl = new URL(target.url);
  const auth = proxy.user ? `Basic ${Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64')}` : null;
  const connectOptions = {
    host: proxy.address, port: proxy.port, method: 'CONNECT', path: `${targetUrl.hostname}:443`,
    headers: { host: `${targetUrl.hostname}:443` }, timeout: timeoutMs
  };
  if (auth) connectOptions.headers['proxy-authorization'] = auth;
  const started = performance.now();
  return new Promise(resolve => {
    let settled = false;
    let socket = null;
    let secure = null;
    let httpReq = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const cleanup = () => {
      for (const resource of [httpReq, secure, socket, req]) {
        try { resource?.destroy?.(); } catch {}
      }
    };
    const module = proxy.protocol === 'https' ? https : require('http');
    const req = module.request(connectOptions);
    req.once('connect', (res, connectedSocket) => {
      socket = connectedSocket;
      if (res.statusCode !== 200) { cleanup(); return finish({ outcome: 'failure', latencyMs: performance.now() - started, httpStatus: res.statusCode, errorCode: 'unexpected_http_status' }); }
      const tls = require('tls');
      secure = tls.connect({ socket, servername: targetUrl.hostname, ca, rejectUnauthorized: true }, () => {
        httpReq = https.get({ host: targetUrl.hostname, path: targetUrl.pathname + targetUrl.search, port: 443, createConnection: () => secure, agent: false, headers: { 'cache-control': 'no-cache, no-store', connection: 'close' } }, response => {
          let size = 0;
          const chunks = [];
          response.on('data', chunk => { size += chunk.length; if (size > 4096) httpReq.destroy(new SubscriptionError('unexpected_body')); else chunks.push(chunk); });
          response.once('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const correctStatus = response.statusCode === target.status;
            const correctBody = target.body === undefined ? (target.status !== 204 || size === 0) : body === target.body;
            const elapsedMs = performance.now() - started;
            finish({ outcome: correctStatus && correctBody ? 'success' : 'failure', latencyMs: elapsedMs, httpStatus: response.statusCode,
              bytesTransferred: size, throughputBps: size > 0 ? size / (elapsedMs / 1000) : null,
              errorCode: !correctStatus ? 'unexpected_http_status' : !correctBody ? 'unexpected_body' : null });
          });
        });
        httpReq.once('error', () => finish({ outcome: 'failure', latencyMs: performance.now() - started, httpStatus: null, errorCode: 'connection_error' }));
      });
      secure.once('error', () => finish({ outcome: 'failure', latencyMs: performance.now() - started, httpStatus: null, errorCode: 'tls_error' }));
    });
    req.once('error', () => finish({ outcome: 'failure', latencyMs: performance.now() - started, httpStatus: null, errorCode: 'connection_error' }));
    req.once('timeout', () => { cleanup(); finish({ outcome: 'failure', latencyMs: performance.now() - started, httpStatus: null, errorCode: 'probe_timeout' }); });
    req.end();
    combined.addEventListener('abort', () => {
      cleanup();
      const errorCode = signal?.aborted ? 'cancelled' : 'probe_timeout';
      finish({ outcome: 'failure', latencyMs: performance.now() - started, httpStatus: null, errorCode });
    }, { once: true });
  }).finally(() => clearTimeout(timer));
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
          const elapsedMs = performance.now() - started;
          resolve({
            outcome: correctStatus && correctBody ? 'success' : 'failure',
            latencyMs: elapsedMs, bytesTransferred: size,
            throughputBps: size > 0 ? size / (elapsedMs / 1000) : null,
            httpStatus: res.statusCode,
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
    this.resolveAddresses = dependencies.resolveAddresses || (dependencies.resolveHost
      ? async (host, options) => [await dependencies.resolveHost(host, options)]
      : resolvePublicAddresses);
    this.ca = dependencies.ca; // Local integration-test CA; not configurable by a subscription source.
    this.targetCa = dependencies.targetCa === undefined ? this.ca : dependencies.targetCa;
    this.diagnostic = dependencies.diagnostic;
    this.active = new Map();
    this.verified = null;
    this.status = { available: null, error: null, version: config.xrayVersion };
  }

  // Additional probe cycle: the connection to the VPN node is dialed through the configured HTTP proxy.
  // Failures here never affect the node's main health verdict; they are stored alongside as proxy_* fields.
  async runProxyCycle(parsed, address, parentSignal, config = snapshotProbeConfig(this.config), deadlineMs = probeDeadlineMs(config, 'full')) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new SubscriptionError('probe_timeout')), deadlineMs);
    const combined = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    let directory = null;
    let child = null;
    let port = null;
    try {
      await fs.promises.mkdir(config.tempDir, { recursive: true, mode: 0o700 });
      directory = await fs.promises.mkdtemp(path.join(config.tempDir, 'probe-'));
      const credentials = { user: crypto.randomBytes(12).toString('hex'), password: crypto.randomBytes(24).toString('hex') };
      for (let attempt = 0; attempt < 3; attempt++) {
        combined.throwIfAborted();
        port = await freePort();
        const filename = path.join(directory, 'config-proxy.json');
        const xrayConfig = buildXrayConfig(parsed, address.address, port, credentials, this.ca, config.httpProxy);
        if (this.diagnostic) xrayConfig.log.loglevel = 'debug';
        await fs.promises.writeFile(filename, JSON.stringify(xrayConfig), { mode: 0o600 });
        child = spawn(config.xrayPath, ['run', '-c', filename], {
          cwd: directory, shell: false, windowsHide: true, detached: process.platform === 'linux',
          env: cleanEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe']
        });
        child.on('error', error => { child.spawnError = true; child.spawnErrorDetail = error.code || error.message; });
        const inspect = data => {
          const text = data.toString();
          if (/address already in use|Only one usage of each socket/i.test(text)) child.portConflict = true;
          child.startupOutput = `${child.startupOutput || ''}${text}`.slice(-2048);
          if (this.diagnostic) this.diagnostic(startupDetail(text));
        };
        child.stdout.on('data', inspect);
        child.stderr.on('data', inspect);
        try {
          await waitForPort(port, child, config.readyTimeoutMs, combined);
          break;
        } catch (error) {
          await stopChild(child);
          if (!child.portConflict || attempt === 2) throw error;
          child = null;
        }
      }
      const socksUrl = `socks5h://${credentials.user}:${credentials.password}@127.0.0.1:${port}`;
      const result = await evaluateTargets(config, async target => {
        if (!child || child.exitCode !== null || child.spawnError) throw new SubscriptionError('xray_exit');
        return requestThroughSocks(target, socksUrl, config.attemptTimeoutMs, combined, this.targetCa);
      }, combined);
      return { ...result, checkedAddress: address.address };
    } catch (error) {
      const safe = safeError(error);
      return { status: 'proxy_error', errorCode: safe.code, errorMessage: safe.message, attempts: [], latencyMs: null, httpStatus: null };
    } finally {
      clearTimeout(timer);
      controller.abort(new SubscriptionError('cancelled'));
      await stopChild(child);
      if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }

  async verifyBinary(config = this.config) {
    const { xrayPath, xrayVersion, xraySha256, tempDir } = config;
    try {
      const stat = await fs.promises.stat(xrayPath);
      const signature = `${xrayPath}:${stat.size}:${stat.mtimeMs}:${xraySha256}:${xrayVersion}`;
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
      // A failed verification must invalidate the cache. Otherwise a later
      // same-signature fast path can return while status.available is false.
      this.verified = null;
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

  async fastProbe(node, { signal, timeoutMs = 6000, config: requestedConfig = this.config } = {}) {
    const started = performance.now();
    const parsed = JSON.parse(node.normalized_config_json);
    const plan = fastHandshakePlan(parsed);
    const base = snapshotProbeConfig(requestedConfig);
    const fastTimeoutMs = Math.max(1, Math.min(Number(timeoutMs) || base.fastProbeTimeoutMs || 6000, base.fastProbeTimeoutMs || 6000));
    // A proxy-only policy is a connectivity requirement, not an optional extra
    // cycle. Keep the chained proxy for "only", but never launch the extra
    // proxy measurement from the fast path.
    const proxyOnly = Boolean(base.httpProxy && base.httpProxyMode === 'only');
    const fastConfig = snapshotProbeConfig({ ...base, targets: base.targets.slice(0, 1), attempts: 1, minSuccess: 1,
      readyTimeoutMs: Math.min(base.readyTimeoutMs, fastTimeoutMs), attemptTimeoutMs: Math.min(base.attemptTimeoutMs, fastTimeoutMs),
      deadlineMs: fastTimeoutMs, deadlineMode: 'explicit',
      httpProxyMode: proxyOnly ? 'only' : 'disabled', httpProxy: proxyOnly ? base.httpProxy : null });
    const result = await this.check(node, { signal, config: fastConfig, profile: 'full', skipFast: true });
    return { profile: 'fast', status: result.status === 'healthy' ? 'reachable' : result.status,
      latencyMs: result.latencyMs ?? performance.now() - started, checkedAddress: result.checkedAddress,
      handshake: result.status === 'healthy', handshakePlan: plan, serviceGates: result.serviceGates || [],
      bytesTransferred: result.bytesTransferred, throughputBps: result.throughputBps, errorCode: result.errorCode,
      errorMessage: result.errorMessage || null };
  }

  async check(node, { signal, config: requestedConfig = this.config, profile = 'full', skipFast = true } = {}) {
    const config = snapshotProbeConfig(requestedConfig);
    signal?.throwIfAborted();
    if (!node?.normalized_config_json) {
      try { await abortable(this.verifyBinary(config), signal); }
      catch (error) { return { profile: 'full', status: 'cancelled', errorCode: signal?.aborted ? 'cancelled' : 'runner_error', attempts: [] }; }
      return { profile: 'full', status: 'runner_error', errorCode: 'validation', attempts: [] };
    }
    if (profile === 'fast') return this.fastProbe(node, { signal, timeoutMs: config.fastProbeTimeoutMs });
    let fast = skipFast ? { status: 'reachable', handshake: true, skipped: true } : await this.fastProbe(node, { signal, timeoutMs: config.fastProbeTimeoutMs });
    if (fast.status !== 'reachable') {
      const runnerFailure = ['runner_error', 'cancelled'].includes(fast.status);
      return {
        profile: 'full', fast,
        status: runnerFailure ? fast.status : 'offline', attempts: [], targetId: null, durationMs: fast.latencyMs,
        successCount: 0, attemptCount: 0, latencyMs: fast.latencyMs ?? null,
        checkedAddress: fast.checkedAddress || node.host || null,
        httpStatus: null, errorCode: fast.errorCode || 'connection_error',
        errorMessage: runnerFailure ? fast.errorMessage || null
          : fast.status === 'timeout' ? 'Fast Probe timeout.' : 'Fast Probe не достиг узла.'
      };
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const deadlineMs = probeDeadlineMs(config, 'full');
    const timer = setTimeout(() => controller.abort(new SubscriptionError('probe_timeout')), deadlineMs);
    const started = performance.now();
    let directory;
    let child;
    let networkStarted = false;
    const token = crypto.randomUUID();
    this.active.set(token, { controller, children: [] });
    try {
      await abortable(this.verifyBinary(config), combined);
      const parsed = JSON.parse(node.normalized_config_json);
      const addresses = await this.resolveAddresses(parsed.host, { signal: combined });
      if (!addresses.length) throw new SubscriptionError('dns_error');
      await fs.promises.mkdir(config.tempDir, { recursive: true, mode: 0o700 });
      directory = await fs.promises.mkdtemp(path.join(config.tempDir, 'probe-'));
      const credentials = { user: crypto.randomBytes(12).toString('hex'), password: crypto.randomBytes(24).toString('hex') };
      const chainedProxy = config.httpProxy && config.httpProxyMode === 'only' ? config.httpProxy : null;
      let port;
      let result;
      let selectedAddress = null;
      let lastError;
      let startupMs = 0;
      const addressList = addresses.slice(0, 2);
      for (let addressIndex = 0; addressIndex < addressList.length; addressIndex++) {
        const address = addressList[addressIndex];
        combined.throwIfAborted();
        const remainingAddresses = addressList.length - addressIndex;
        const remainingMs = Math.max(1, deadlineMs - (performance.now() - started));
        // Reserve an equal share for every remaining address so a blackholed
        // first IP cannot consume the complete absolute deadline.
        const addressController = new AbortController();
        const addressTimer = setTimeout(() => addressController.abort(new SubscriptionError('address_timeout')), Math.max(1, Math.floor(remainingMs / remainingAddresses)));
        const addressSignal = AbortSignal.any([combined, addressController.signal]);
        try {
      for (let attempt = 0; attempt < 3; attempt++) {
        combined.throwIfAborted();
        port = await freePort();
        const filename = path.join(directory, 'config.json');
        const xrayConfig = buildXrayConfig(parsed, address.address, port, credentials, this.ca, chainedProxy);
        if (this.diagnostic) xrayConfig.log.loglevel = 'debug';
        await fs.promises.writeFile(filename, JSON.stringify(xrayConfig), { mode: 0o600 });
        child = spawn(config.xrayPath, ['run', '-c', filename], {
          cwd: directory, shell: false, windowsHide: true, detached: process.platform === 'linux',
          env: cleanEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe']
        });
        this.active.get(token).children.push(child);
        child.on('error', error => { child.spawnError = true; child.spawnErrorDetail = error.code || error.message; });
        const inspect = data => {
          const text = data.toString();
          if (/address already in use|Only one usage of each socket/i.test(text)) child.portConflict = true;
          child.startupOutput = `${child.startupOutput || ''}${text}`.slice(-2048);
          if (this.diagnostic) this.diagnostic(startupDetail(text));
        };
        child.stdout.on('data', inspect);
        child.stderr.on('data', inspect);
        try {
          await waitForPort(port, child, config.readyTimeoutMs, addressSignal);
          break;
        } catch (error) {
          await stopChild(child);
          if (!child.portConflict || attempt === 2) throw error;
        }
      }
      startupMs = performance.now() - started;
      const socksUrl = `socks5h://${credentials.user}:${credentials.password}@127.0.0.1:${port}`;
      networkStarted = true;
          const candidate = await evaluateTargets(config, async target => {
            if (child.exitCode !== null || child.spawnError) throw new SubscriptionError('xray_exit');
            return requestThroughSocks(target, socksUrl, config.attemptTimeoutMs, addressSignal, this.targetCa);
          }, addressSignal);
          if (candidate.status === 'healthy' || !result || candidate.successCount > result.successCount) {
            result = candidate;
            selectedAddress = address;
          }
          if (candidate.status === 'healthy') break;
        } catch (error) {
          lastError = error;
          if (combined.aborted) throw combined.reason;
        } finally {
          clearTimeout(addressTimer);
          await stopChild(child);
          child = null;
        }
      }
      if (!result) throw lastError || new SubscriptionError('dns_error');
      let proxy = null;
      if (config.httpProxy && config.httpProxyMode === 'extra') {
        // The deadline is an absolute budget for the complete check, including
        // address fallback and the optional proxy cycle. Never reset it here.
        const proxySignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const remainingMs = Math.max(1, deadlineMs - (performance.now() - started));
        proxy = await this.runProxyCycle(parsed, selectedAddress, proxySignal, config, remainingMs);
      }
      return { profile: 'full', ...result, checkedAddress: selectedAddress.address, proxy, startupMs, durationMs: performance.now() - started,
        ...(fast.skipped ? {} : { fast }) };
    } catch (error) {
      const actual = combined.aborted ? combined.reason : error;
      const safe = safeError(actual);
      let status = 'runner_error';
      if (['cancelled', 'superseded'].includes(safe.code)) status = 'cancelled';
      else if (safe.code === 'unsupported' || safe.code === 'blocked_address') status = 'unsupported';
      else if (safe.code === 'invalid_link') status = 'invalid';
      else if (safe.code === 'dns_error' || (safe.code === 'probe_timeout' && networkStarted)) status = 'offline';
      else if (safe.code === 'probe_timeout') safe.code = 'xray_start';
      const errorDetail = ['xray_start', 'xray_exit'].includes(safe.code)
        ? startupDetail(child?.startupOutput) || child?.spawnErrorDetail || null
        : null;
      return { profile: 'full', status, errorCode: safe.code, errorMessage: safe.message, errorDetail, attempts: [], durationMs: performance.now() - started,
        ...(fast && !fast.skipped ? { fast } : {}) };
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
    await Promise.all([...this.active.values()].flatMap(entry => entry.children.map(stopChild)));
  }
}

module.exports = { VpnChecker, evaluateTargets, requestThroughSocks, requestThroughHttpProxy, freePort, stopChild };
