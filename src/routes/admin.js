const express = require('express');
const { requireCsrf } = require('../middleware/csrf');
const proxySettings = require('../services/proxySettings');
const { requestThroughHttpProxy } = require('../services/vpnChecker');

module.exports = function createAdminRoutes({ requireAuth, dbGet, dbAll, dbRun, appName, scheduler, refreshProxyConfig }) {
  const router = express.Router();
  router.post('/admin/stats/clear', requireAuth, requireCsrf, (_req, res) => {
    dbRun('DELETE FROM subscription_requests');
    dbRun('UPDATE users SET first_request_at = NULL, last_request_at = NULL');
    res.json({ success: true, message: 'Статистика успешно очищена' });
  });

  router.get('/admin/settings', requireAuth, (req, res) => {
    const { proxy, mode } = proxySettings.effectiveHttpProxy(scheduler.config.httpProxy, scheduler.config.httpProxyMode);
    res.render('settings', {
      appName, proxy, proxyMode: mode, proxyUrl: proxySettings.proxyUrlForDisplay(proxy),
      runner: scheduler.checker.status, error: null, success: req.query.saved === '1'
    });
  });

  router.post('/admin/settings', requireAuth, requireCsrf, (req, res) => {
    try {
      const { proxyUrl, proxyMode } = req.body;
      proxySettings.saveSettings({ proxyUrl, mode: proxyMode });
      refreshProxyConfig();
      res.redirect('/admin/settings?saved=1');
    } catch (error) {
      const { proxy, mode } = proxySettings.effectiveHttpProxy(scheduler.config.httpProxy, scheduler.config.httpProxyMode);
      res.render('settings', {
        appName, proxy, proxyMode: mode, proxyUrl: req.body.proxyUrl || '',
        runner: scheduler.checker.status, error: error.message, success: false
      });
    }
  });

  router.post('/api/settings/proxy/check', requireAuth, requireCsrf, async (req, res) => {
    const { proxy } = proxySettings.effectiveHttpProxy(scheduler.config.httpProxy, scheduler.config.httpProxyMode);
    if (!proxy) return res.status(400).json({ error: 'HTTP-прокси не настроен' });
    const target = scheduler.config.targets[0];
    const result = await requestThroughHttpProxy(target, proxy, scheduler.config.attemptTimeoutMs, new AbortController().signal, scheduler.checker.targetCa);
    res.json({ status: result.outcome === 'success' ? 'healthy' : 'proxy_error', latencyMs: result.latencyMs ?? null, httpStatus: result.httpStatus, errorCode: result.errorCode });
  });

  return router;
};
