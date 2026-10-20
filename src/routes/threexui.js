const express = require('express');
const db = require('../db/database');
const service = require('../services/threeXui');
const { SubscriptionError } = require('../utils/subscriptionErrors');
const { csrfToken, requireCsrf } = require('../middleware/csrf');

function renderError(error) {
  if (error instanceof SubscriptionError) return error.message;
  return 'Не удалось сохранить панель 3x-ui. Проверьте данные и повторите попытку.';
}

module.exports = function createThreeXuiRoutes({ requireAuth, appName }) {
  const router = express.Router();
  const auth = [requireAuth, csrfToken, (_req, res, next) => {
    res.locals.appName = appName;
    res.set('Cache-Control', 'no-store');
    next();
  }];

  router.get('/admin/threexui', ...auth, (req, res) => {
    const panels = service.listPanels().map(service.publicPanel);
    res.render('threexui-panels', { panels, saved: req.query.saved === '1' });
  });

  router.get('/admin/threexui/new', ...auth, (req, res) => {
    res.render('threexui-form', { panel: null, values: { is_active: 1, sync_interval_seconds: 300 }, error: null });
  });

  router.post('/admin/threexui', ...auth, requireCsrf, (req, res) => {
    try {
      service.createPanel(req.body);
      res.redirect('/admin/threexui?saved=1');
    } catch (error) {
      res.status(error.status || 400).render('threexui-form', { panel: null, values: req.body, error: renderError(error) });
    }
  });

  router.get('/admin/threexui/:id/edit', ...auth, (req, res) => {
    const panel = service.getPanel(req.params.id);
    if (!panel) return res.status(404).send('Панель не найдена');
    res.render('threexui-form', { panel: service.publicPanel(panel), values: { ...panel, token: panel.token }, error: null });
  });

  router.post('/admin/threexui/:id', ...auth, requireCsrf, (req, res) => {
    try {
      service.updatePanel(req.params.id, req.body);
      res.redirect('/admin/threexui?saved=1');
    } catch (error) {
      const panel = service.getPanel(req.params.id);
      if (!panel) return res.status(404).send('Панель не найдена');
      res.status(error.status || 400).render('threexui-form', { panel: service.publicPanel(panel), values: req.body, error: renderError(error) });
    }
  });

  router.post('/admin/threexui/:id/delete', ...auth, requireCsrf, (req, res) => {
    service.deletePanel(req.params.id);
    res.redirect('/admin/threexui?saved=1');
  });

  router.post('/api/threexui/sync', ...auth, requireCsrf, async (req, res) => {
    const results = await service.syncAll({ force: true, includeInactive: false });
    const failed = results.filter(result => result.status === 'error');
    res.status(failed.length ? 207 : 200).json({ success: !failed.length, results });
  });

  router.post('/api/threexui/:id/sync', ...auth, requireCsrf, async (req, res) => {
    try {
      const result = await service.syncPanel(req.params.id, { force: true });
      res.json({ success: true, result });
    } catch (error) {
      res.status(error.status || 500).json({ success: false, error: renderError(error) });
    }
  });

  return router;
};
