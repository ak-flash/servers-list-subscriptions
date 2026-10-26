const express = require('express');
const { requireCsrf } = require('../middleware/csrf');
const proxySettings = require('../services/proxySettings');
const { requestThroughHttpProxy } = require('../services/vpnChecker');

module.exports = function createAdminRoutes({ requireAuth, dbGet, dbAll, dbRun, appName, scheduler, refreshProxyConfig, csrfToken }) {
  const router = express.Router();
  router.post('/admin/stats/clear', requireAuth, requireCsrf, (req, res) => {
    dbRun('DELETE FROM subscription_requests');
    dbRun('UPDATE users SET first_request_at = NULL, last_request_at = NULL');
    res.json({ success: true, message: req.t('Статистика успешно очищена') });
  });

  function proxyStats(config, now = Date.now()) {
    const nodes = dbAll(`SELECT h.proxy_status, h.proxy_latency_ms, h.proxy_checked_at, n.is_present, n.is_enabled
      FROM subscription_nodes n JOIN subscription_node_health h ON h.node_id = n.id
      WHERE n.is_present = 1 AND n.is_enabled = 1 AND n.capability_status = 'supported'`);
    const configured = !!(config.httpProxy && config.httpProxyMode === 'extra');
    if (!configured || !nodes.length) return { configured, total: nodes.length, healthy: 0, failed: 0, unchecked: 0, stale: 0 };
    let healthy = 0, failed = 0, unchecked = 0, stale = 0;
    for (const node of nodes) {
      if (!node.proxy_checked_at) unchecked++;
      else if (now - node.proxy_checked_at >= config.healthyTtlMs) stale++;
      else if (node.proxy_status === 'healthy') healthy++;
      else failed++;
    }
    return { configured, total: nodes.length, healthy, failed, unchecked, stale };
  }

  router.get('/admin/settings', requireAuth, (req, res) => {
      const config = scheduler.config;
      const settings = proxySettings.effectiveHttpProxy(config.httpProxy, config.httpProxyMode, config);
      const { proxy, mode } = settings;
      res.render('settings', {
        ...settings, appName, proxy, proxyMode: mode, proxyUrl: proxySettings.proxyUrlForDisplay(proxy),
        checkIntervalSeconds: settings.checkIntervalSeconds ?? config.checkIntervalMs / 1000,
        sourceTimeoutSeconds: settings.sourceTimeoutSeconds ?? config.sourceTimeoutMs / 1000,
        readyTimeoutSeconds: settings.readyTimeoutSeconds ?? config.readyTimeoutMs / 1000,
        attemptTimeoutSeconds: settings.attemptTimeoutSeconds ?? config.attemptTimeoutMs / 1000,
        probeConcurrency: settings.probeConcurrency ?? config.concurrency,
        syncConcurrency: settings.syncConcurrency ?? config.syncConcurrency,
        maxQueued: settings.maxQueued ?? config.maxQueued,
        runner: scheduler.checker.status, proxyStats: proxyStats({ ...config, httpProxy: proxy, httpProxyMode: mode }),
        error: null, success: req.query.saved === '1', recheckJobs: null
      });
  });

  router.post('/admin/settings', requireAuth, requireCsrf, (req, res) => {
    try {
      const { proxyUrl, proxyMode, checkIntervalSeconds, sourceTimeoutSeconds, readyTimeoutSeconds, attemptTimeoutSeconds, probeConcurrency, syncConcurrency, maxQueued } = req.body;
      proxySettings.saveSettings({ proxyUrl, mode: proxyMode, checkIntervalSeconds, sourceTimeoutSeconds, readyTimeoutSeconds, attemptTimeoutSeconds, probeConcurrency, syncConcurrency, maxQueued }, scheduler.config);
      refreshProxyConfig();
      res.redirect('/admin/settings?saved=1');
    } catch (error) {
      const config = scheduler.config;
      const settings = proxySettings.effectiveHttpProxy(config.httpProxy, config.httpProxyMode, config);
      const { proxy, mode } = settings;
      res.render('settings', {
        ...settings, appName, proxy, proxyMode: mode, proxyUrl: req.body.proxyUrl || '',
        checkIntervalSeconds: req.body.checkIntervalSeconds || config.checkIntervalMs / 1000,
        sourceTimeoutSeconds: req.body.sourceTimeoutSeconds || config.sourceTimeoutMs / 1000,
        readyTimeoutSeconds: req.body.readyTimeoutSeconds || config.readyTimeoutMs / 1000,
        attemptTimeoutSeconds: req.body.attemptTimeoutSeconds || config.attemptTimeoutMs / 1000,
        deadlineSeconds: req.body.deadlineSeconds || config.deadlineMs / 1000,
        probeConcurrency: req.body.probeConcurrency || config.concurrency,
        syncConcurrency: req.body.syncConcurrency || config.syncConcurrency,
        maxQueued: req.body.maxQueued || config.maxQueued,
        runner: scheduler.checker.status, proxyStats: proxyStats({ ...config, httpProxy: proxy, httpProxyMode: mode }),
        error: error.message, success: false, recheckJobs: null
      });
    }
  });

  router.post('/admin/settings/recheck', requireAuth, requireCsrf, (req, res) => {
    const jobs = scheduler.enqueueAllChecks({ reason: 'manual_recheck' });
    const config = scheduler.config;
    const settings = proxySettings.effectiveHttpProxy(config.httpProxy, config.httpProxyMode, config);
    const { proxy, mode } = settings;
    res.render('settings', {
      ...settings, appName, proxy, proxyMode: mode, proxyUrl: proxySettings.proxyUrlForDisplay(proxy),
      checkIntervalSeconds: settings.checkIntervalSeconds ?? config.checkIntervalMs / 1000,
      sourceTimeoutSeconds: settings.sourceTimeoutSeconds ?? config.sourceTimeoutMs / 1000,
      readyTimeoutSeconds: settings.readyTimeoutSeconds ?? config.readyTimeoutMs / 1000,
      attemptTimeoutSeconds: settings.attemptTimeoutSeconds ?? config.attemptTimeoutMs / 1000,
      deadlineSeconds: settings.deadlineSeconds ?? config.deadlineMs / 1000,
      probeConcurrency: settings.probeConcurrency ?? config.concurrency,
      syncConcurrency: settings.syncConcurrency ?? config.syncConcurrency,
      maxQueued: settings.maxQueued ?? config.maxQueued,
      runner: scheduler.checker.status, proxyStats: proxyStats({ ...config, httpProxy: proxy, httpProxyMode: mode }),
      error: null, success: false, recheckJobs: jobs.length
    });
  });

  router.post('/api/settings/proxy/check', requireAuth, requireCsrf, async (req, res) => {
    const { proxy } = proxySettings.effectiveHttpProxy(scheduler.config.httpProxy, scheduler.config.httpProxyMode);
    if (!proxy) return res.status(400).json({ error: req.t('HTTP-прокси не настроен') });
    const target = scheduler.config.targets[0];
    const result = await requestThroughHttpProxy(target, proxy, scheduler.config.attemptTimeoutMs, new AbortController().signal, scheduler.checker.targetCa);
    res.json({ status: result.outcome === 'success' ? 'healthy' : 'proxy_error', latencyMs: result.latencyMs ?? null, httpStatus: result.httpStatus, errorCode: result.errorCode });
  });

  return router;
};
