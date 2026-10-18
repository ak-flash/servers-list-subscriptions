const express = require('express');
const { requireCsrf } = require('../middleware/csrf');

module.exports = function createAdminRoutes({ requireAuth, dbGet, dbAll, dbRun, appName }) {
  const router = express.Router();
  router.post('/admin/stats/clear', requireAuth, requireCsrf, (_req, res) => {
    dbRun('DELETE FROM subscription_requests');
    dbRun('UPDATE users SET first_request_at = NULL, last_request_at = NULL');
    res.json({ success: true, message: 'Статистика успешно очищена' });
  });
  return router;
};
