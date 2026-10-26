require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const { initDb, getDb, saveDb, closeDb, transaction, getPaginatedServers, getPaginatedUsers, getAllUsersTraffic, resetAllTraffic, getThreeXuiClientsTraffic, getThreeXuiInboundTraffic, getThreeXuiInboundTrafficTotals, getThreeXuiInboundMonthlyTraffic, getThreeXuiInboundClientTraffic, getThreeXuiUsersTraffic, getThreeXuiClientMonthlyTraffic } = require('./db/database');
const { extractHostPortFromLink, parseLinkAndExtractName } = require('./utils/linkBuilder');
const { parseVless } = require('./utils/protocolParsers');
const { loadConfig } = require('./config/subscriptions');
const { ProbeScheduler } = require('./services/probeScheduler');
const { ThreeXuiScheduler } = require('./services/threeXuiScheduler');
const { deleteUser, deleteServer } = require('./services/subscriptionAssignments');
const subscriptionRoutes = require('./routes/subscriptions');
const subscriptionSourceRoutes = require('./routes/subscriptionSources');
const threeXuiRoutes = require('./routes/threexui');
const adminRoutes = require('./routes/admin');
const subscriptionView = require('./utils/subscriptionView');
const health = require('./services/subscriptionHealth');
const { hashPassword, verifyPassword } = require('./utils/passwords');
const { csrfToken, requireCsrf } = require('./middleware/csrf');
const logger = require('./utils/logger');
const { i18n } = require('./i18n');

// 'auto' включает Secure-флаг только на реальном HTTPS (учитывая TRUST_PROXY),
// чтобы вход по HTTP не терял cookie сессии. SESSION_COOKIE_SECURE=1/0 форсирует режим.
const sessionCookieSecure = process.env.SESSION_COOKIE_SECURE === '1' ? true
    : process.env.SESSION_COOKIE_SECURE === '0' ? false
    : 'auto';

function generateShortId(length = 6) {
    return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

const app = express();
const PORT = process.env.PORT || 2096;
const APP_NAME = process.env.APP_NAME || 'VPN Подписки';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET не задан');

const loginAttempts = new Map();
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
function rateLimit(key, windowMs, max) {
    const now = Date.now();
    const entry = loginAttempts.get(key);
    if (!entry || entry.resetAt <= now) {
        loginAttempts.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
}
const { effectiveHttpProxy, applySettingsToConfig, applyProxyToConfig } = require('./services/proxySettings');
let subscriptionConfig = loadConfig();
const scheduler = new ProbeScheduler(subscriptionConfig);
function refreshProxyConfig() {
  const envConfig = loadConfig();
  const settingsConfig = applySettingsToConfig(envConfig);
  const effective = effectiveHttpProxy(settingsConfig.httpProxy, settingsConfig.httpProxyMode, settingsConfig);
  subscriptionConfig = applyProxyToConfig(settingsConfig, effective);
  scheduler.config = subscriptionConfig;
  scheduler.checker.config = subscriptionConfig;
}
const threeXuiScheduler = new ThreeXuiScheduler(process.env.THREEXUI_SYNC_ENABLED === '0' ? { disabled: true } : {});
const manualVpnChecker = scheduler.checker;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(i18n);
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    });
    next();
});
app.locals = { ...app.locals, ...subscriptionView };
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.use(session({
     secret: SESSION_SECRET,
     resave: false,
     saveUninitialized: false,
     cookie: {
         maxAge: 24 * 60 * 60 * 1000,
         httpOnly: true,
         sameSite: 'lax',
         secure: sessionCookieSecure
     }
}));
app.use(csrfToken);

function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        if (req.session.mustChangePassword && req.path !== '/admin/password' && !req.path.startsWith('/api/')) return res.redirect('/admin/password');
        return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: req.t ? req.t('Войдите в админ-панель.') : 'Войдите в админ-панель.' });
    res.redirect('/admin/login');
}

function db() {
    return getDb();
}

function dbGet(sql, params = []) {
    const stmt = db().prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}

function dbAll(sql, params = []) {
    const stmt = db().prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}

function dbRun(sql, params = []) {
    db().run(sql, params);
    saveDb();
}

function recordSubscriptionRequest(userId, req) {
    const ipAddress = req.ip || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    transaction(() => {
        dbRun(`INSERT INTO subscription_requests (user_id, requested_at, ip_address, user_agent)
            VALUES (?, datetime('now'), ?, ?)`, [userId, ipAddress, userAgent]);
        dbRun(`UPDATE users SET first_request_at = COALESCE(first_request_at, datetime('now')),
            last_request_at = datetime('now') WHERE id = ?`, [userId]);
    });
}

app.use(subscriptionRoutes({ getConfig: () => subscriptionConfig, recordRequest: recordSubscriptionRequest }));
app.use(subscriptionSourceRoutes({ getConfig: () => subscriptionConfig, scheduler, requireAuth, appName: APP_NAME }));
app.use(threeXuiRoutes({ requireAuth, appName: APP_NAME }));
app.use(adminRoutes({ requireAuth, dbGet, dbAll, dbRun, appName: APP_NAME, scheduler, refreshProxyConfig }));
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.get('/admin/login', (req, res) => {
    res.render('login', { error: null, appName: APP_NAME });
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || username.length > 128) return res.status(400).render('login', { error: req.t('Неверные данные входа'), appName: APP_NAME });
    const key = String(req.ip || req.socket.remoteAddress || 'unknown');
    if (!rateLimit(`login:${key}`, LOGIN_RATE_WINDOW_MS, MAX_LOGIN_ATTEMPTS)) {
        return res.status(429).render('login', { error: req.t('Слишком много попыток. Повторите позже.'), appName: APP_NAME });
    }
    const user = dbGet('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);
    const normalizedPassword = typeof password === 'string' ? password : '';
    const verification = verifyPassword(normalizedPassword, user?.password);

    if (user && verification.valid) {
        return req.session.regenerate(error => {
            if (error) return res.status(500).render('login', { error: req.t('Не удалось создать сессию.'), appName: APP_NAME });
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.mustChangePassword = Boolean(user.must_change_password || verification.legacy);
            if (verification.legacy) dbRun('UPDATE users SET password = ? WHERE id = ?', [hashPassword(normalizedPassword), user.id]);
            res.redirect('/admin');
        });
    }
    res.render('login', { error: req.t('Неверное имя пользователя или пароль'), appName: APP_NAME });
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
});

app.get('/admin/password', requireAuth, (req, res) => {
    res.render('password-form', { error: null, appName: APP_NAME });
});

app.post('/admin/password', requireAuth, requireCsrf, (req, res) => {
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirmation = typeof req.body.password_confirmation === 'string' ? req.body.password_confirmation : '';
    if (password.length < 8 || password !== confirmation) {
        return res.status(400).render('password-form', { error: req.t('Пароли должны совпадать и содержать минимум 8 символов.'), appName: APP_NAME });
    }
    dbRun('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?', [hashPassword(password), req.session.userId]);
    req.session.mustChangePassword = false;
    res.redirect('/admin');
});

app.get('/admin', requireAuth, (req, res) => {
    const pageSize = 10;
    const activeTab = req.query.tab === 'users' ? 'users' : 'servers';
    const pageNumber = value => /^\d+$/.test(String(value || '')) ? Number(value) : 1;
    const collection = {
        servers: {
            search: typeof req.query.serverSearch === 'string' ? req.query.serverSearch.trim() : '',
            status: ['active', 'inactive'].includes(req.query.serverStatus) ? req.query.serverStatus : 'all',
            page: pageNumber(req.query.serverPage)
        },
        users: {
            search: typeof req.query.userSearch === 'string' ? req.query.userSearch.trim() : '',
            status: ['active', 'inactive'].includes(req.query.userStatus) ? req.query.userStatus : 'all',
            page: pageNumber(req.query.userPage)
        }
    };
    const currentMonth = new Date().toISOString().slice(0, 7);
    const serverPage = getPaginatedServers({ search: collection.servers.search, status: collection.servers.status, page: collection.servers.page, perPage: pageSize });
    const userPage = getPaginatedUsers({ search: collection.users.search, status: collection.users.status, page: collection.users.page, perPage: pageSize, month: currentMonth });
    const serverTotals = dbGet(`SELECT COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active FROM servers`) || { total: 0, active: 0 };
    const userTotals = dbGet(`SELECT COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active FROM users`) || { total: 0, active: 0 };

    const subscriptionSources = dbAll('SELECT * FROM subscription_sources ORDER BY name, id');
    let healthyNodes = 0;
    subscriptionSources.forEach(source => {
        health.getNodes(source.id).forEach(node => {
            if (node.is_present && health.eligibility(node, subscriptionConfig) === 'healthy') healthyNodes += 1;
        });
    });

    const visibleUserIds = userPage.rows.map(user => user.id);
    const userPlaceholders = visibleUserIds.map(() => '?').join(', ');
    const manualServersByUser = new Map();
    if (visibleUserIds.length) {
        dbAll(`
            SELECT us.user_id, s.name
            FROM user_servers us
            JOIN servers s ON s.id = us.server_id
            WHERE us.user_id IN (${userPlaceholders})
            ORDER BY s.name, us.server_id
        `, visibleUserIds).forEach(row => {
            if (!manualServersByUser.has(row.user_id)) manualServersByUser.set(row.user_id, []);
            manualServersByUser.get(row.user_id).push(row.name);
        });
    }
    const subscriptionSourcesByUser = new Map();
    if (visibleUserIds.length) {
        dbAll(`
            SELECT us.user_id, s.name
            FROM user_subscription_sources us
            JOIN subscription_sources s ON s.id = us.source_id
            WHERE us.user_id IN (${userPlaceholders})
            ORDER BY s.name, us.source_id
        `, visibleUserIds).forEach(row => {
            if (!subscriptionSourcesByUser.has(row.user_id)) subscriptionSourcesByUser.set(row.user_id, []);
            subscriptionSourcesByUser.get(row.user_id).push(row.name);
        });
    }

    const serversWithInfo = serverPage.rows.map(server => {
        const info = extractHostPortFromLink(server.link);
        return { ...server, ...info };
    });
    const usersWithTraffic = userPage.rows.map(user => ({
        ...user,
        formatted_upload: formatBytes(user.total_upload),
        formatted_download: formatBytes(user.total_download),
        formatted_total: formatBytes(user.total_traffic),
        formatted_monthly: formatBytes(user.monthly_traffic),
        manual_servers: manualServersByUser.get(user.id) || [],
        subscription_sources: subscriptionSourcesByUser.get(user.id) || []
    }));
    const dashboardCollections = {
        servers: { ...collection.servers, page: serverPage.page, total: serverPage.total, totalPages: serverPage.totalPages, perPage: serverPage.perPage },
        users: { ...collection.users, page: userPage.page, total: userPage.total, totalPages: userPage.totalPages, perPage: userPage.perPage }
    };
    const collectionUrl = (targetTab, overrides = {}) => {
        const values = {
            tab: targetTab,
            serverSearch: dashboardCollections.servers.search,
            serverStatus: dashboardCollections.servers.status,
            serverPage: dashboardCollections.servers.page,
            userSearch: dashboardCollections.users.search,
            userStatus: dashboardCollections.users.status,
            userPage: dashboardCollections.users.page,
            ...overrides
        };
        const params = new URLSearchParams();
        if (values.serverSearch) params.set('serverSearch', values.serverSearch);
        if (values.serverStatus && values.serverStatus !== 'all') params.set('serverStatus', values.serverStatus);
        if (Number(values.serverPage) > 1) params.set('serverPage', values.serverPage);
        if (values.userSearch) params.set('userSearch', values.userSearch);
        if (values.userStatus && values.userStatus !== 'all') params.set('userStatus', values.userStatus);
        if (Number(values.userPage) > 1) params.set('userPage', values.userPage);
        params.set('tab', values.tab);
        return `/admin?${params.toString()}`;
    };
    const paginationPages = (page, pageCount) => {
        if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
        if (page <= 4) return [1, 2, 3, 4, 5, 'ellipsis-end', pageCount];
        if (page >= pageCount - 3) return [1, 'ellipsis-start', pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
        return [1, 'ellipsis-start', page - 1, page, page + 1, 'ellipsis-end', pageCount];
    };

    res.render('dashboard', {
        servers: serversWithInfo,
        users: usersWithTraffic,
        username: req.session.username,
        appName: APP_NAME,
        activeTab,
        collections: dashboardCollections,
        collectionUrl,
        paginationPages,
        totals: { servers: serverTotals, users: userTotals },
        stats: { totalSources: subscriptionSources.length, healthyNodes }
    });
});

app.get('/admin/servers/new', requireAuth, (req, res) => {
    res.render('server-form', { server: null, error: null, appName: APP_NAME });
});

app.post('/admin/servers', requireAuth, requireCsrf, (req, res) => {
    const { link, name } = req.body;

    if (!link || !link.trim()) {
        res.render('server-form', { server: req.body, error: req.t('Вставьте ссылку на сервер'), appName: APP_NAME });
        return;
    }

    try {
        const serverData = parseLinkAndExtractName(link.trim());
        const serverName = name && name.trim() ? name.trim() : serverData.name;
        const id = generateShortId();

        dbRun(`
            INSERT INTO servers (id, name, link, remark, is_active, created_at)
            VALUES (?, ?, ?, ?, 1, datetime('now'))
        `, [id, serverName, serverData.link, serverName]);

        res.redirect('/admin');
    } catch (err) {
        res.render('server-form', { server: req.body, error: req.t('Ошибка: ') + err.message, appName: APP_NAME });
    }
});

app.get('/admin/servers/:id/edit', requireAuth, (req, res) => {
    const server = dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
    if (!server) return res.redirect('/admin');
    const info = extractHostPortFromLink(server.link);
    const serverWithInfo = { ...server, ...info };
    res.render('server-form', { server: serverWithInfo, error: null, appName: APP_NAME });
});

app.post('/admin/servers/:id', requireAuth, requireCsrf, (req, res) => {
    const { name, link, tag, traffic_limit, is_active } = req.body;

    try {
        const server = dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
        if (!server) return res.redirect('/admin');

        const newName = name && name.trim() ? name.trim() : server.name;
        const updatedLink = (link && link.trim()) ? link.trim() : server.link;
        const newTag = tag && tag.trim() ? tag.trim() : null;
        const newTrafficLimit = parseInt(traffic_limit) || 0;

        dbRun(`UPDATE servers SET name = ?, link = ?, tag = ?, traffic_limit = ?, is_active = ? WHERE id = ?`,
            [newName, updatedLink, newTag, newTrafficLimit, is_active ? 1 : 0, req.params.id]);

        res.redirect('/admin');
    } catch (err) {
        const server = dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
        if (!server) return res.redirect('/admin');
        const info = extractHostPortFromLink(server.link);
        const serverWithInfo = { ...server, ...info, name: name || server.name, link: link || server.link, tag: tag, traffic_limit: traffic_limit, is_active: is_active ? 1 : 0 };
        res.render('server-form', { server: serverWithInfo, error: req.t('Ошибка: ') + err.message, appName: APP_NAME });
    }
});

app.post('/admin/servers/:id/delete', requireAuth, requireCsrf, (req, res) => {
    deleteServer(req.params.id);
    res.redirect('/admin');
});

app.get('/admin/users/new', requireAuth, (req, res) => {
    res.render('user-form', { user: null, error: null, appName: APP_NAME });
});

app.post('/admin/users', requireAuth, requireCsrf, (req, res) => {
    const { username, is_active } = req.body;
    const id = generateShortId();

    try {
        dbRun(`
            INSERT INTO users(id, username, is_active, created_at) VALUES(?, ?, ?, datetime('now'))
        `, [id, username, is_active ? 1 : 0]);

        res.redirect('/admin');
    } catch (err) {
        res.render('user-form', { user: req.body, error: req.t('Ошибка при создании пользователя: ') + err.message, appName: APP_NAME });
    }
});

app.get('/admin/users/:id/edit', requireAuth, (req, res) => {
    const user = dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.redirect('/admin');
    res.render('user-form', { user, error: null, appName: APP_NAME });
});

app.post('/admin/users/:id', requireAuth, requireCsrf, (req, res) => {
    const { username, password, is_active } = req.body;

    try {
        if (password) {
            dbRun(`UPDATE users SET username = ?, password = ?, is_active = ? WHERE id = ? `,
                [username, hashPassword(password), is_active ? 1 : 0, req.params.id]);
        } else {
            dbRun(`UPDATE users SET username = ?, is_active = ? WHERE id = ? `,
                [username, is_active ? 1 : 0, req.params.id]);
        }
        if (req.session.userId === req.params.id) {
            req.session.username = username;
        }
        res.redirect('/admin');
    } catch (err) {
        res.render('user-form', { user: req.body, error: req.t('Ошибка при обновлении пользователя: ') + err.message, appName: APP_NAME });
    }
});

app.post('/admin/users/:id/delete', requireAuth, requireCsrf, (req, res) => {
    deleteUser(req.params.id);
    res.redirect('/admin');
});

async function checkManualServer(server) {
    try {
        const parsed = parseVless(server.link);
        if (parsed.capability !== 'supported') {
            return { id: server.id, name: server.name, status: parsed.capability, errorCode: 'unsupported', errorMessage: parsed.error || req.t('Конфигурация не поддерживается') };
        }
        const result = await manualVpnChecker.check({ normalized_config_json: JSON.stringify(parsed.config) });
        return { id: server.id, name: server.name, status: result.status, latency_ms: result.latencyMs ?? null, target_id: result.targetId ?? null,
            errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null, errorDetail: result.errorDetail ?? null };
    } catch (error) {
        return { id: server.id, name: server.name, status: 'runner_error', latency_ms: null, errorCode: 'runner_error', errorMessage: error.message || req.t('Не удалось выполнить VPN-проверку.') };
    }
}

app.post('/api/servers/check', requireAuth, requireCsrf, async (req, res) => {
    const servers = dbAll('SELECT * FROM servers WHERE is_active = 1');
    const results = [];
    for (const server of servers) results.push(await checkManualServer(server));
    res.json({ results });
});

app.post('/api/servers/:id/check', requireAuth, requireCsrf, async (req, res) => {
    const server = dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
    if (!server) return res.status(404).json({ error: req.t('Сервер не найден') });
    res.json(await checkManualServer(server));
});

async function startServer() {
    await initDb();
    refreshProxyConfig();

    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
    const defaultAdmin = dbGet('SELECT * FROM users WHERE username = ?', [adminUsername]);
    if (!defaultAdmin) {
        dbRun('INSERT INTO users (id, username, password, is_active, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))',
            [generateShortId(12), adminUsername, hashPassword(adminPassword), 1, 1]);
        logger.info('admin_created', { username: adminUsername });
    }

    await scheduler.start();
    await threeXuiScheduler.start();
    const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
        logger.info('server_started', { port: PORT, host: process.env.HOST || '0.0.0.0' });
    });

    let stopping = false;
    let monthlyReset;
    const shutdown = async (exitCode = 0) => {
        if (stopping) return;
        stopping = true;
        logger.info('shutdown_started');
        clearInterval(monthlyReset);
        const deadline = setTimeout(() => process.exit(1), 10000);
        const closed = new Promise(resolve => server.close(resolve));
        server.closeIdleConnections();
        try {
            threeXuiScheduler.stop();
            await scheduler.stop();
            await closed;
            saveDb();
            closeDb();
            clearTimeout(deadline);
            process.exit(exitCode);
        } catch (error) {
            logger.error('shutdown_failed', { error: error.message });
            process.exit(1);
        }
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('uncaughtException', error => {
        logger.error('uncaught_exception', { error: error?.message, stack: error?.stack });
        shutdown(1);
    });
    process.on('unhandledRejection', error => {
        logger.error('unhandled_rejection', { error: error?.message, stack: error?.stack });
        shutdown(1);
    });

    // Ежемесячный сброс трафика (1-го числа)
    monthlyReset = setInterval(checkMonthlyReset, 60 * 60 * 1000);
    checkMonthlyReset();
    return server;
}

function checkMonthlyReset() {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${now.getMonth() + 1}`;
    const state = dbGet('SELECT value FROM app_state WHERE key = ?', ['traffic_reset_month']);
    if (state?.value === monthKey || now.getDate() !== 1) return;
    logger.info('monthly_traffic_reset_started', { month: monthKey });
    transaction(() => {
        dbRun('DELETE FROM user_traffic');
        dbRun('DELETE FROM server_traffic');
        dbRun('DELETE FROM traffic_snapshots');
        dbRun('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', ['traffic_reset_month', monthKey]);
    });
    logger.info('monthly_traffic_reset_completed', { month: monthKey });
}

// Helper function to format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

app.get('/admin/stats', requireAuth, (req, res) => {
    const selectedMonth = typeof req.query.month === 'string' && req.query.month.length === 7 && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : null;

    const totalUsers = dbGet('SELECT COUNT(*) as count FROM users')?.count || 0;
    const activeUsers = dbGet('SELECT COUNT(*) as count FROM users WHERE is_active = 1')?.count || 0;

    const requestMonthFilter = selectedMonth ? " WHERE strftime('%Y-%m', sr.requested_at) = ?" : '';
    const requestMonthParams = selectedMonth ? [selectedMonth] : [];
    const totalRequests = dbGet(`SELECT COUNT(*) as count FROM subscription_requests sr${requestMonthFilter}`, requestMonthParams)?.count || 0;
    const todayRequests = selectedMonth ? 0 : dbGet(`SELECT COUNT(*) as count FROM subscription_requests WHERE date(requested_at) = date('now')`)?.count || 0;
    const weekRequests = selectedMonth ? 0 : dbGet(`SELECT COUNT(*) as count FROM subscription_requests WHERE requested_at >= datetime('now', '-7 days')`)?.count || 0;
    const monthRequests = selectedMonth ? 0 : dbGet(`SELECT COUNT(*) as count FROM subscription_requests WHERE requested_at >= datetime('now', '-30 days')`)?.count || 0;

    const threeXuiInbounds = selectedMonth ? getThreeXuiInboundMonthlyTraffic(selectedMonth) : getThreeXuiInboundTraffic();
    const threeXuiTotals = selectedMonth ? getThreeXuiInboundTrafficTotals(selectedMonth) : threeXuiInbounds.reduce((totals, inbound) => ({
        total_upload: totals.total_upload + (inbound.up_bytes || 0),
        total_download: totals.total_download + (inbound.down_bytes || 0),
        total_traffic: totals.total_traffic + (inbound.total_bytes || 0)
    }), { total_upload: 0, total_download: 0, total_traffic: 0 });
    const totalTraffic = threeXuiTotals.total_traffic || 0;
    const totalDownload = threeXuiTotals.total_download || 0;
    const totalUpload = threeXuiTotals.total_upload || 0;
    const activeTrafficUsers = 0;
    const formattedTotalTraffic = formatBytes(totalTraffic);
    const formattedTotalDownload = formatBytes(totalDownload);
    const formattedTotalUpload = formatBytes(totalUpload);
    const threeXuiTotalsView = {
        up: threeXuiTotals.total_upload || 0,
        down: threeXuiTotals.total_download || 0,
        total: threeXuiTotals.total_traffic || 0
    };
    const formattedThreeXuiTotalTraffic = formatBytes(threeXuiTotalsView.total);

    const topServersTraffic = threeXuiInbounds.slice(0, 10).map(inbound => ({
        id: `${inbound.panel_id}:${inbound.inbound_id}`,
        name: inbound.remark || inbound.tag || `Inbound ${inbound.inbound_id}`,
        tag: inbound.tag,
        panel_name: inbound.panel_name,
        total_upload: inbound.up_bytes || 0,
        total_download: inbound.down_bytes || 0,
        total_traffic: inbound.total_bytes || 0,
        formatted_upload: formatBytes(inbound.up_bytes || 0),
        formatted_download: formatBytes(inbound.down_bytes || 0),
         formatted_total: formatBytes((inbound.up_bytes || 0) + (inbound.down_bytes || 0))
     }));

     const topThreeXuiInbounds = threeXuiInbounds.slice(0, 10).map(inbound => ({
         ...inbound,
         formatted_upload: formatBytes(inbound.up_bytes || 0),
         formatted_download: formatBytes(inbound.down_bytes || 0),
         formatted_total: formatBytes((inbound.up_bytes || 0) + (inbound.down_bytes || 0))
     }));

    const topThreeXuiClients = getThreeXuiClientsTraffic().slice(0, 10).map(client => ({
        ...client,
        formatted_upload: formatBytes(client.total_upload || 0),
        formatted_download: formatBytes(client.total_download || 0),
        formatted_total: formatBytes(client.total_traffic || 0)
    }));

    const threeXuiUsersTraffic = getThreeXuiUsersTraffic().slice(0, 10).map(client => ({
        ...client,
        formatted_upload: formatBytes(client.up_bytes || 0),
        formatted_download: formatBytes(client.down_bytes || 0),
        formatted_total: formatBytes(client.total_bytes || 0)
    }));

    const threeXuiConnectionsTraffic = getThreeXuiInboundClientTraffic().slice(0, 10).map(client => ({
        ...client,
        formatted_upload: formatBytes(client.up_bytes || 0),
        formatted_download: formatBytes(client.down_bytes || 0),
        formatted_total: formatBytes(client.total_bytes || 0)
    }));

    const requestPerPage = 10;
    const requestedPage = typeof req.query.requestPage === 'string' && !/\D/.test(req.query.requestPage) ? Number(req.query.requestPage) : 1;
    const totalRequestPages = Math.max(1, Math.ceil(totalRequests / requestPerPage));
    const requestPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, totalRequestPages) : 1;
    const requestOffset = (requestPage - 1) * requestPerPage;
    let requestPages;
    if (totalRequestPages <= 7) requestPages = Array.from({ length: totalRequestPages }, (_, index) => index + 1);
    else if (requestPage <= 4) requestPages = [1, 2, 3, 4, 5, null, totalRequestPages];
    else if (requestPage >= totalRequestPages - 3) requestPages = [1, null, totalRequestPages - 4, totalRequestPages - 3, totalRequestPages - 2, totalRequestPages - 1, totalRequestPages];
    else requestPages = [1, null, requestPage - 1, requestPage, requestPage + 1, null, totalRequestPages];
    const requestPagination = {
        page: requestPage,
        perPage: requestPerPage,
        total: totalRequests,
        totalPages: totalRequestPages,
        from: totalRequests ? requestOffset + 1 : 0,
        to: Math.min(requestOffset + requestPerPage, totalRequests),
        pages: requestPages
    };
    const requestPageUrl = page => {
        const params = new URLSearchParams();
        if (selectedMonth) params.set('month', selectedMonth);
        params.set('requestPage', page);
        return `/admin/stats?${params.toString()}#requests`;
    };
    const lastRequests = dbAll(`
        SELECT sr.*, u.username
        FROM subscription_requests sr
        LEFT JOIN users u ON sr.user_id = u.id
        ${requestMonthFilter}
        ORDER BY sr.requested_at DESC, sr.id DESC
        LIMIT ? OFFSET ?
    `, [...requestMonthParams, requestPerPage, requestOffset]);

    const topUsers = dbAll(`
        SELECT u.username, u.id, COUNT(*) as request_count, MAX(sr.requested_at) as last_request
        FROM subscription_requests sr
        LEFT JOIN users u ON sr.user_id = u.id
        GROUP BY sr.user_id
        ORDER BY request_count DESC
        LIMIT 10
    `);

    const requestsByDay = dbAll(`
        SELECT date(requested_at) as day, COUNT(*) as count
        FROM subscription_requests
        WHERE requested_at >= datetime('now', '-30 days')
        GROUP BY date(requested_at)
        ORDER BY day DESC
    `);

    const availableMonths = [...new Set([
        ...dbAll(`SELECT DISTINCT strftime('%Y-%m', recorded_at) as month FROM server_traffic WHERE recorded_at IS NOT NULL`).map(row => row.month),
        ...dbAll('SELECT DISTINCT month FROM threexui_inbound_monthly_traffic').map(row => row.month),
        ...dbAll(`SELECT DISTINCT strftime('%Y-%m', requested_at) as month FROM subscription_requests WHERE requested_at IS NOT NULL`).map(row => row.month)
    ])].filter(Boolean).sort().reverse().slice(0, 24);
    if (selectedMonth && !availableMonths.includes(selectedMonth)) availableMonths.push(selectedMonth);

    const trafficByUsername = new Map();
    const threeXuiUsersForTraffic = selectedMonth ? getThreeXuiClientMonthlyTraffic(selectedMonth) : threeXuiUsersTraffic;
    for (const client of threeXuiUsersForTraffic) {
        const username = selectedMonth ? client.email : client.username;
        const current = trafficByUsername.get(username) || { total_upload: 0, total_download: 0, total_traffic: 0 };
        current.total_upload += client.up_bytes || 0;
        current.total_download += client.down_bytes || 0;
        current.total_traffic += client.total_bytes || 0;
        trafficByUsername.set(username, current);
    }
    const topTrafficUsers = getAllUsersTraffic(selectedMonth).map(user => {
        const xuiTraffic = trafficByUsername.get(user.username) || {};
        user.total_upload = Math.max(user.total_upload || 0, xuiTraffic.total_upload || 0);
        user.total_download = Math.max(user.total_download || 0, xuiTraffic.total_download || 0);
        user.total_traffic = Math.max(user.total_traffic || 0, xuiTraffic.total_traffic || 0);
        const details = dbGet(`
            SELECT
                COUNT(DISTINCT us.server_id) as connection_count,
                COUNT(DISTINCT sr.id) as request_count,
                MAX(sr.requested_at) as last_request
            FROM users u
            LEFT JOIN user_servers us ON us.user_id = u.id
            LEFT JOIN subscription_requests sr ON sr.user_id = u.id
            WHERE u.id = ?
            GROUP BY u.id
        `, [user.id]) || {};
        return {
            ...user,
            ...details,
            formatted_upload: formatBytes(user.total_upload || 0),
            formatted_download: formatBytes(user.total_download || 0),
            formatted_total: formatBytes(user.total_traffic || 0)
        };
    });
    const userTrafficTotal = topTrafficUsers.reduce((sum, user) => sum + (user.total_traffic || 0), 0);
    const userDownloadTotal = topTrafficUsers.reduce((sum, user) => sum + (user.total_download || 0), 0);
    const userUploadTotal = topTrafficUsers.reduce((sum, user) => sum + (user.total_upload || 0), 0);
    const userConnectionTotal = topTrafficUsers.reduce((sum, user) => sum + (user.connection_count || 0), 0);

    res.render('stats', {
        threeXuiInbounds: topThreeXuiInbounds,
        threeXuiClients: topThreeXuiClients,
        threeXuiUsers: threeXuiUsersTraffic,
        threeXuiConnections: threeXuiConnectionsTraffic,
        threeXuiTotals: threeXuiTotalsView,
        formattedThreeXuiTotalTraffic,
        formattedThreeXuiDownload: formatBytes(threeXuiTotalsView.down),
        formattedThreeXuiUpload: formatBytes(threeXuiTotalsView.up),
        formattedTotalDownload,
        formattedTotalUpload,
        totalUsers,
        activeUsers,
        totalRequests,
        todayRequests,
        weekRequests,
        monthRequests,
        totalTraffic,
        formattedTotalTraffic,
        activeTrafficUsers,
        lastRequests,
        requestPagination,
        requestPageUrl,
        topUsers,
        topTrafficUsers,
        userTrafficTotal,
        userConnectionTotal,
        formattedUserTrafficTotal: formatBytes(userTrafficTotal),
        formattedUserDownloadTotal: formatBytes(userDownloadTotal),
        formattedUserUploadTotal: formatBytes(userUploadTotal),
        topServersTraffic,
        requestsByDay,
        availableMonths,
        selectedMonth,
        username: req.session.username,
        appName: APP_NAME
    });
});

if (require.main === module) {
    startServer().catch(error => {
        logger.error('server_start_failed', { error: error.message });
        try { closeDb(); } catch {}
        process.exitCode = 1;
    });
}

module.exports = { app, startServer, scheduler, threeXuiScheduler, subscriptionConfig };
