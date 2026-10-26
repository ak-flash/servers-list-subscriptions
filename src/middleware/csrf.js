const crypto = require('crypto');

function csrfToken(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token') || req.body?._csrf;
  const expected = req.session?.csrfToken;
  if (typeof token !== 'string' || !/^[a-f\d]{64}$/.test(token) || !expected || token.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    const message = (req.t || (value => value))('Сессия формы истекла. Обновите страницу и повторите действие.');
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: message });
    return res.status(403).send(message);
  }
  next();
}

module.exports = { csrfToken, requireCsrf };
