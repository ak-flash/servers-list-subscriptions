const express = require('express');
const db = require('../db/database');
const sources = require('../services/subscriptionSources');
const health = require('../services/subscriptionHealth');
const { saveAssignments, assignSourceToAllUsers } = require('../services/subscriptionAssignments');
const { resolveUserSubscription, subscriptionPreview } = require('../services/subscriptionResolver');
const { extractHostPortFromLink } = require('../utils/linkBuilder');
const { SubscriptionError } = require('../utils/subscriptionErrors');
const { csrfToken, requireCsrf } = require('../middleware/csrf');
const view = require('../utils/subscriptionView');

module.exports = function subscriptionSourceRoutes({ config, getConfig, scheduler, requireAuth, appName }) {
  const currentConfig = () => getConfig ? getConfig() : config;
  const router = express.Router();
  const auth = [requireAuth, csrfToken, (_req, res, next) => {
    Object.assign(res.locals, { appName, ...view });
    res.set('Cache-Control', 'no-store');
    next();
  }];

  function sourceList() {
    return db.all('SELECT * FROM subscription_sources ORDER BY name, id').map(source => {
      const nodes = health.getNodes(source.id);
      return { ...sources.publicSource(source), count: nodes.filter(node => node.is_present).length,
        healthy: nodes.filter(node => health.eligibility(node, currentConfig()) === 'healthy').length,
        users: db.get('SELECT count(*) AS n FROM user_subscription_sources WHERE source_id = ?', [source.id]).n };
    });
  }

  function currentJob(req) {
    return typeof req.query.job === 'string' ? scheduler.job(req.query.job) : null;
  }

  function renderForm(req, res, source, error = null, values = {}) {
    const headers = source ? JSON.parse(source.headers_json) : {};
    res.status(error ? (error.status || 400) : 200).render('subscription-source-form', {
      source: source ? sources.publicSource(source) : null,
      values: { name: source?.name || '', url: source?.url || '', user_agent: headers['user-agent'] || '',
        sync_interval_seconds: source?.sync_interval_seconds || currentConfig().syncIntervalMs / 1000,
        is_active: source ? source.is_active : 1, ...values, ...(error ? { is_active: values.is_active || 0 } : {}) },
      linkedUsers: source ? db.get('SELECT count(*) AS n FROM user_subscription_sources WHERE source_id = ?', [source.id]).n : 0,
      saved: req.query.saved === '1',
      error: error instanceof SubscriptionError ? error.message : error ? 'Не удалось сохранить источник. Проверьте данные и повторите попытку.' : null
    });
  }

  router.get('/admin/subscription-sources', ...auth, (req, res) => {
    res.render('subscription-sources', { sources: sourceList(), metrics: scheduler.metrics(), job: currentJob(req) });
  });
  router.get('/admin/subscription-sources/new', ...auth, (req, res) => renderForm(req, res, null));
  router.post('/admin/subscription-sources', ...auth, requireCsrf, (req, res) => {
    let source;
    try { source = sources.createSource(req.body, currentConfig()); }
    catch (error) { return renderForm(req, res, null, error, req.body); }
    // Once saved, a full queue must not turn a successful create into a duplicate on form retry.
    let job;
    if (source.is_active) { try { job = scheduler.enqueueSync(source.id); } catch { /* Scheduler will pick next_sync_at=0. */ } }
    res.redirect(`/admin/subscription-sources/${source.id}/nodes${job ? `?job=${job.id}` : ''}`);
  });
  router.get('/admin/subscription-sources/:id/edit', ...auth, (req, res) => {
    const source = sources.getSource(req.params.id);
    if (!source) return res.status(404).send('Источник не найден');
    renderForm(req, res, source);
  });
  router.post('/admin/subscription-sources/:id', ...auth, requireCsrf, (req, res) => {
    const previous = sources.getSource(req.params.id);
    if (!previous) return res.status(404).send('Источник не найден');
    let source;
    try { source = sources.updateSource(previous.id, req.body, currentConfig()); }
    catch (error) { return renderForm(req, res, previous, error, req.body); }
    scheduler.invalidateSource(source.id);
    if (source.is_active) { try { scheduler.enqueueSync(source.id); } catch { /* Retried by the scheduler. */ } }
    res.redirect(`/admin/subscription-sources/${source.id}/nodes`);
  });
  router.post('/admin/subscription-sources/:id/assign-all', ...auth, requireCsrf, (req, res) => {
    const source = sources.getSource(req.params.id);
    if (!source) return res.status(404).send('Источник не найден');
    try {
      assignSourceToAllUsers(source.id, req.body.node_limit);
      res.redirect(`/admin/subscription-sources/${source.id}/edit?saved=1`);
    } catch (error) {
      renderForm(req, res, source, error, req.body);
    }
  });
  router.post('/admin/subscription-sources/:id/delete', ...auth, requireCsrf, (req, res) => {
    scheduler.invalidateSource(req.params.id);
    sources.deleteSource(req.params.id);
    res.redirect('/admin/subscription-sources');
  });
  router.get('/admin/subscription-sources/:id/nodes', ...auth, (req, res) => {
    const source = sources.getSource(req.params.id);
    if (!source) return res.status(404).send('Источник не найден');
    const all = health.getNodes(source.id).map(node => health.safeNode(node, currentConfig()));
    const filter = typeof req.query.status === 'string' ? req.query.status : '';
    const isCapabilityFilter = ['unsupported', 'invalid'].includes(filter);
     const nodes = all.filter(node => {
       const matches = !filter || (isCapabilityFilter ? node.capability_status === filter : node.effective_status === filter);
       return (node.is_present || req.query.removed === '1' || isCapabilityFilter) && matches;
     })
      .sort((a, b) => {
        const aLatency = Number.isFinite(a.latency_ms) && a.latency_ms >= 0 ? a.latency_ms : Number.POSITIVE_INFINITY;
        const bLatency = Number.isFinite(b.latency_ms) && b.latency_ms >= 0 ? b.latency_ms : Number.POSITIVE_INFINITY;
        return aLatency - bLatency || String(a.name).localeCompare(String(b.name), 'ru') || String(a.id).localeCompare(String(b.id));
      });
    const pages = Math.max(1, Math.ceil(nodes.length / 50));
    const page = Math.max(1, Math.min(pages, Number.parseInt(req.query.page, 10) || 1));
    res.render('subscription-source-nodes', {
      source: sources.publicSource(source), nodes: nodes.slice((page - 1) * 50, page * 50), total: nodes.length,
      healthy: all.filter(node => node.effective_status === 'healthy').length, page, pages, filter,
      showRemoved: req.query.removed === '1', job: currentJob(req), metrics: scheduler.metrics(),
      report: source.report_json ? JSON.parse(source.report_json) : null,
      proxyConfigured: !!currentConfig().httpProxy
    });
  });

  function action(handler) {
    return (req, res) => {
      try { handler(req, res); }
      catch (error) { res.status(error instanceof SubscriptionError ? error.status : 500).json({ error: error instanceof SubscriptionError ? error.message : 'Не удалось выполнить действие. Повторите попытку.' }); }
    };
  }
  router.post('/api/subscription-sources/:id/sync', ...auth, requireCsrf, action((req, res) => {
    const job = scheduler.enqueueSync(req.params.id);
    res.status(202).json({ jobId: job.id, job });
  }));
  router.post('/api/subscription-sources/:id/check', ...auth, requireCsrf, action((req, res) => {
    const job = scheduler.enqueueCheck({ sourceId: req.params.id });
    res.status(202).json({ jobId: job.id, job });
  }));
  router.post('/api/subscription-nodes/:id/check', ...auth, requireCsrf, async (req, res) => {
    try {
      const result = await scheduler.checkNodeNow(req.params.id);
      res.json({ result: { status: result.status, latencyMs: result.latencyMs ?? null, errorMessage: result.errorMessage ?? null } });
    } catch (error) {
      res.status(error instanceof SubscriptionError ? error.status : 500).json({ error: error instanceof SubscriptionError ? error.message : 'Не удалось выполнить проверку. Повторите попытку.' });
    }
  });
  router.post('/api/subscription-nodes/:id/settings', ...auth, requireCsrf, action((req, res) => {
    if (!['0', '1', 0, 1, true, false].includes(req.body.is_enabled)) throw new SubscriptionError('validation', 'Укажите состояние узла.');
    const node = sources.setNodeEnabled(req.params.id, ['1', 1, true].includes(req.body.is_enabled));
    res.json({ id: node.id, is_enabled: node.is_enabled });
  }));
  router.get('/api/background-jobs/:id', ...auth, (req, res) => {
    const job = scheduler.job(req.params.id);
    if (!job) return res.status(404).json({ error: 'Задача не найдена.' });
    res.json({ ...job, runner: scheduler.metrics().runner });
  });

  function renderAssignments(req, res, error = null, values = null) {
    const user = db.get('SELECT id, username, is_active FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).send('Пользователь не найден');
    const assigned = db.getUserServerAssignments(user.id);
    const selected = input => typeof input === 'string' ? [input] : Array.isArray(input) ? input : [];
    res.status(error ? 400 : 200).render('user-servers', {
      user, servers: db.all('SELECT * FROM servers WHERE is_active = 1 ORDER BY name, id').map(server => ({ ...server, ...extractHostPortFromLink(server.link) })),
      assignedIds: values ? selected(values.servers) : assigned.map(server => server.server_id),
      uuidMap: values?.uuids || Object.fromEntries(assigned.map(server => [server.server_id, server.uuid])),
      sources: sourceList(), bindings: db.all('SELECT * FROM user_subscription_sources WHERE user_id = ?', [user.id]),
      values, selectedSources: values ? selected(values.sources) : null,
      preview: subscriptionPreview(resolveUserSubscription(user.id, Date.now(), currentConfig())),
      saved: req.query.saved === '1', error: error instanceof SubscriptionError ? error.message : error ? 'Не удалось сохранить назначения. Повторите попытку.' : null
    });
  }
  router.get('/admin/users/:id/servers', ...auth, (req, res) => renderAssignments(req, res));
  router.post('/admin/users/:id/servers', ...auth, requireCsrf, (req, res) => {
    try { saveAssignments(req.params.id, req.body); }
    catch (error) { return renderAssignments(req, res, error, req.body); }
    res.redirect(`/admin/users/${encodeURIComponent(req.params.id)}/servers?saved=1`);
  });
  router.get('/api/users/:id/subscription-preview', ...auth, (req, res) => {
    const result = resolveUserSubscription(req.params.id, Date.now(), currentConfig());
    if (!result.user) return res.status(404).json({ error: 'Пользователь не найден или отключён.' });
    res.json(subscriptionPreview(result));
  });
  return router;
};
