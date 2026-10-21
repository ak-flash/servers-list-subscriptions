const express = require('express');
const QRCode = require('qrcode');
const { resolveUserSubscription } = require('../services/subscriptionResolver');
const { buildFullSubscription, publicServer } = require('../utils/linkBuilder');
const { getUserTraffic } = require('../db/database');

module.exports = function subscriptionRoutes({ config, getConfig, recordRequest }) {
  const router = express.Router();
  const currentConfig = () => getConfig ? getConfig() : config;
  router.rateLimits = new Map();
  router.use('/join/:id', (req, res, next) => {
    const key = `join:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const entry = router.rateLimits.get(key);
    if (!entry || entry.resetAt <= now) router.rateLimits.set(key, { count: 1, resetAt: now + 60 * 1000 });
    else if (entry.count >= 120) return res.status(429).send('Слишком много запросов. Повторите позже.');
    else entry.count++;
    res.set('Cache-Control', 'no-store');
    const result = resolveUserSubscription(req.params.id, Date.now(), currentConfig());
    if (!result.user) return res.status(404).send('Пользователь не найден или отключён');
    if (!result.servers.length) return res.status(404).send('Нет доступных серверов для этого пользователя');
    res.locals.subscription = result;
    next();
  });

  function profile(result) {
    const traffic = getUserTraffic(result.user.id);
    // This service does not know a personal upstream quota or expiry for shared external credentials.
    const userinfo = `upload=${traffic.total_upload || 0}; download=${traffic.total_download || 0}; total=0; expire=0`;
    return { userinfo, raw: buildFullSubscription(result.servers, result.user.id, result.user.username, { profileUpdateHours: currentConfig().profileUpdateHours, userinfo }) };
  }

  function subscriptionUrl(req, user) {
    const protocol = currentConfig().publicDomain ? 'https' : req.protocol;
    const host = currentConfig().publicDomain || req.get('host');
    return `${protocol}://${host}/join/${encodeURIComponent(user.id)}#${encodeURIComponent(`Подписка_${user.username}`)}`;
  }

  router.get('/join/:id', (req, res) => {
    const result = res.locals.subscription;
    const content = profile(result);
    recordRequest(result.user.id, req);
    res.type('text/plain');
    res.set('profile-title', `base64:${Buffer.from('Подписка ' + result.user.username).toString('base64')}`);
    res.set('profile-update-interval', String(currentConfig().profileUpdateHours));
    res.set('subscription-userinfo', content.userinfo);
    res.send(content.raw);
  });

  router.get('/join/:id/json', (req, res) => {
    const result = res.locals.subscription;
    recordRequest(result.user.id, req);
    res.json({ version: 2, servers: result.servers.map(publicServer), raw: profile(result).raw });
  });

  for (const suffix of ['qr', 'qr-img']) {
    router.get(`/join/:id/${suffix}`, async (req, res) => {
      const { user } = res.locals.subscription;
      try {
        const url = subscriptionUrl(req, user);
        const qrCode = await QRCode.toDataURL(url, { width: 300, margin: 2 });
        recordRequest(user.id, req);
        if (suffix === 'qr-img') return res.json({ qrCode, username: user.username, subscriptionUrl: url });
        res.render('subscription-qr', { user, qrCode, subscriptionUrl: url });
      } catch {
        res.status(500).send('Не удалось создать QR-код. Повторите попытку.');
      }
    });
  }
  return router;
};
