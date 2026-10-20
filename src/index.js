require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { initDb, getDb, saveDb, closeDb, transaction, getUserTraffic, updateUserTraffic, getAllUsersTraffic, getServerByTag, updateServerTraffic, resetAllTraffic, getThreeXuiClientTraffic, getThreeXuiClientsTraffic, getThreeXuiInboundTraffic, getThreeXuiInboundClientTraffic, getThreeXuiUsersTraffic } = require('./db/database');
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

// 'auto' включает Secure-флаг только на реальном HTTPS (учитывая TRUST_PROXY),
// чтобы вход по HTTP не терял cookie сессии. SESSION_COOKIE_SECURE=1/0 форсирует режим.
const sessionCookieSecure = process.env.SESSION_COOKIE_SECURE === '1' ? true
    : process.env.SESSION_COOKIE_SECURE === '0' ? false
    : 'auto';

const WEBHOOK_LOG_FILE = path.join(__dirname, '..', 'data', 'webhook-traffic.log');
const WEBHOOK_LOG_MAX_SIZE = 50 * 1024 * 1024; // 50 MB
const WEBHOOK_ENABLED = process.env.WEBHOOK_ENABLED === '1';

function generateShortId(length = 6) {
    return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

const app = express();
const PORT = process.env.PORT || 2096;
const APP_NAME = process.env.APP_NAME || 'VPN Подписки';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET не задан');
if (process.env.NODE_ENV === 'production' && WEBHOOK_ENABLED && !WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET не задан в production');

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
function webhookAuthorized(req) {
    if (!WEBHOOK_SECRET) return process.env.NODE_ENV !== 'production';
    const token = req.params.webhookSecret;
    return typeof token === 'string' && token.length === WEBHOOK_SECRET.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(WEBHOOK_SECRET));
}
const subscriptionConfig = loadConfig();
const scheduler = new ProbeScheduler(subscriptionConfig);
const threeXuiScheduler = new ThreeXuiScheduler(process.env.THREEXUI_SYNC_ENABLED === '0' ? { disabled: true } : {});
const manualVpnChecker = scheduler.checker;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Войдите в админ-панель.' });
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

app.use(subscriptionRoutes({ config: subscriptionConfig, recordRequest: recordSubscriptionRequest }));
app.use(subscriptionSourceRoutes({ config: subscriptionConfig, scheduler, requireAuth, appName: APP_NAME }));
app.use(threeXuiRoutes({ requireAuth, appName: APP_NAME }));
app.use(adminRoutes({ requireAuth, dbGet, dbAll, dbRun, appName: APP_NAME }));
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.get('/admin/login', (req, res) => {
    res.render('login', { error: null, appName: APP_NAME });
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || username.length > 128) return res.status(400).render('login', { error: 'Неверные данные входа', appName: APP_NAME });
    const key = String(req.ip || req.socket.remoteAddress || 'unknown');
    if (!rateLimit(`login:${key}`, LOGIN_RATE_WINDOW_MS, MAX_LOGIN_ATTEMPTS)) {
        return res.status(429).render('login', { error: 'Слишком много попыток. Повторите позже.', appName: APP_NAME });
    }
    const user = dbGet('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);
    const normalizedPassword = typeof password === 'string' ? password : '';
    const verification = verifyPassword(normalizedPassword, user?.password);

    if (user && verification.valid) {
        return req.session.regenerate(error => {
            if (error) return res.status(500).render('login', { error: 'Не удалось создать сессию.', appName: APP_NAME });
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.mustChangePassword = Boolean(user.must_change_password || verification.legacy);
            if (verification.legacy) dbRun('UPDATE users SET password = ? WHERE id = ?', [hashPassword(normalizedPassword), user.id]);
            res.redirect('/admin');
        });
    }
    res.render('login', { error: 'Неверное имя пользователя или пароль', appName: APP_NAME });
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
        return res.status(400).render('password-form', { error: 'Пароли должны совпадать и содержать минимум 8 символов.', appName: APP_NAME });
    }
    dbRun('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?', [hashPassword(password), req.session.userId]);
    req.session.mustChangePassword = false;
    res.redirect('/admin');
});

// Helper function to format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

app.get('/admin', requireAuth, (req, res) => {
    const servers = dbAll('SELECT * FROM servers ORDER BY created_at DESC');
    const serversWithInfo = servers.map(server => {
        const info = extractHostPortFromLink(server.link);
        return { ...server, ...info };
    });
    const users = dbAll('SELECT * FROM users ORDER BY created_at DESC');

    const subscriptionSources = dbAll('SELECT * FROM subscription_sources ORDER BY name, id');
    let healthyNodes = 0;
    subscriptionSources.forEach(source => {
        health.getNodes(source.id).forEach(node => {
            if (node.is_present && health.eligibility(node, subscriptionConfig) === 'healthy') healthyNodes += 1;
        });
    });

    // Add traffic data to users
    const usersWithTraffic = users.map(user => {
        const localTraffic = getUserTraffic(user.id);
        const panelTraffic = getThreeXuiClientTraffic(user.username);
        const traffic = {
            total_upload: Math.max(localTraffic.total_upload || 0, panelTraffic.total_upload || 0),
            total_download: Math.max(localTraffic.total_download || 0, panelTraffic.total_download || 0),
            total_traffic: Math.max(localTraffic.total_traffic || 0, panelTraffic.total_traffic || 0)
        };
        return {
            ...user,
            total_upload: traffic.total_upload,
            total_download: traffic.total_download,
            total_traffic: traffic.total_traffic,
            monthly_traffic: localTraffic.total_traffic || 0,
            formatted_upload: formatBytes(traffic.total_upload),
            formatted_download: formatBytes(traffic.total_download),
            formatted_total: formatBytes(traffic.total_traffic),
            formatted_monthly: formatBytes(localTraffic.total_traffic || 0)
        };
    });

    res.render('dashboard', { servers: serversWithInfo, users: usersWithTraffic, username: req.session.username, appName: APP_NAME, stats: { totalSources: subscriptionSources.length, healthyNodes } });
});

app.get('/admin/servers/new', requireAuth, (req, res) => {
    res.render('server-form', { server: null, error: null, appName: APP_NAME });
});

app.post('/admin/servers', requireAuth, requireCsrf, (req, res) => {
    const { link, name } = req.body;

    if (!link || !link.trim()) {
        res.render('server-form', { server: req.body, error: 'Вставьте ссылку на сервер', appName: APP_NAME });
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
        res.render('server-form', { server: req.body, error: 'Ошибка: ' + err.message, appName: APP_NAME });
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
        res.render('server-form', { server: serverWithInfo, error: 'Ошибка: ' + err.message, appName: APP_NAME });
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
        res.render('user-form', { user: req.body, error: 'Ошибка при создании пользователя: ' + err.message, appName: APP_NAME });
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
        res.render('user-form', { user: req.body, error: 'Ошибка при обновлении пользователя: ' + err.message, appName: APP_NAME });
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
            return { id: server.id, name: server.name, status: parsed.capability, errorCode: 'unsupported', errorMessage: parsed.error || 'Конфигурация не поддерживается' };
        }
        const result = await manualVpnChecker.check({ normalized_config_json: JSON.stringify(parsed.config) });
        return { id: server.id, name: server.name, status: result.status, latency_ms: result.latencyMs ?? null, target_id: result.targetId ?? null,
            errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null };
    } catch (error) {
        return { id: server.id, name: server.name, status: 'runner_error', latency_ms: null, errorCode: 'runner_error', errorMessage: 'Не удалось выполнить VPN-проверку.' };
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
    if (!server) return res.status(404).json({ error: 'Сервер не найден' });
    res.json(await checkManualServer(server));
});

// Traffic reporting API endpoints
if (WEBHOOK_ENABLED) app.post('/api/traffic/report/:webhookSecret', (req, res) => {
    if (!webhookAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { user_id, server_id, upload_bytes, download_bytes } = req.body;

    if (!user_id || !server_id || upload_bytes === undefined || download_bytes === undefined) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    try {
        updateUserTraffic(user_id, server_id, upload_bytes, download_bytes);
        res.json({ success: true, message: 'Traffic data updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update traffic data' });
    }
});

app.get('/api/traffic/user/:userId', requireAuth, (req, res) => {
    const userId = req.params.userId;
    const traffic = getUserTraffic(userId);

    res.json({
        user_id: userId,
        upload_bytes: traffic.total_upload || 0,
        download_bytes: traffic.total_download || 0,
        total_bytes: traffic.total_traffic || 0
    });
});

app.get('/api/traffic/all', requireAuth, (req, res) => {
    const allTraffic = getAllUsersTraffic();
    res.json({ users: allTraffic });
});

function logWebhook(type, data, ip) {
    const now = new Date();
    const offset = 3 * 60;
    const localTime = new Date(now.getTime() + (now.getTimezoneOffset() + offset) * 60000);
    const timestamp = localTime.toISOString().replace('T', ' ').slice(0, 19);
    const logEntry = `[${timestamp}] [${type}] [IP: ${ip}]\n${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
    try {
        const dir = path.dirname(WEBHOOK_LOG_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (fs.existsSync(WEBHOOK_LOG_FILE)) {
            const stat = fs.statSync(WEBHOOK_LOG_FILE);
            if (stat.size >= WEBHOOK_LOG_MAX_SIZE) {
                const backup = WEBHOOK_LOG_FILE + '.old';
                fs.renameSync(WEBHOOK_LOG_FILE, backup);
            }
        }
        fs.appendFileSync(WEBHOOK_LOG_FILE, logEntry);
    } catch (err) {
        logger.error('webhook_logging_failed', { error: err.message });
    }
}

if (WEBHOOK_ENABLED) app.post('/api/webhook/traffic/:webhookSecret', (req, res) => {
    if (!webhookAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    logWebhook('INCOMING', req.body, ip);

    if (req.body.inboundTraffics && Array.isArray(req.body.inboundTraffics)) {
        const results = [];

        for (const inbound of req.body.inboundTraffics) {
            const { Tag, Up = 0, Down = 0 } = inbound;

            if (!Tag) {
                continue;
            }

            const server = getServerByTag(Tag);

            if (!server) {
                logWebhook('SERVER_NOT_FOUND', { tag: Tag, up: Up, down: Down }, ip);
                results.push({ tag: Tag, status: 'server_not_found' });
                continue;
            }

            try {
                updateServerTraffic(server.id, Up, Down);
                logWebhook('SUCCESS', { tag: Tag, server_id: server.id, server_name: server.name, upload_bytes: Up, download_bytes: Down }, ip);
                results.push({ tag: Tag, server_id: server.id, server_name: server.name, status: 'success' });
            } catch (error) {
                logWebhook('ERROR', { tag: Tag, message: error.message }, ip);
                results.push({ tag: Tag, status: 'error', message: error.message });
            }
        }

        return res.json({
            success: true,
            message: 'Server traffic updated',
            processed: results.length,
            results
        });
    }

    const {
        user_id,
        server_id,
        upload_bytes = 0,
        download_bytes = 0
    } = req.body;

    if (!user_id || !server_id) {
        logWebhook('ERROR', { message: 'Missing user_id or server_id', received: req.body }, ip);
        return res.status(400).json({ error: 'Missing user_id or server_id' });
    }

    try {
        updateUserTraffic(user_id, server_id, upload_bytes, download_bytes);

        logWebhook('SUCCESS', {
            user_id,
            server_id,
            upload_bytes,
            download_bytes,
            total: upload_bytes + download_bytes
        }, ip);

        res.json({
            success: true,
            message: 'Traffic data updated',
            received: {
                user_id,
                server_id,
                upload_bytes,
                download_bytes
            }
        });
    } catch (error) {
        logWebhook('ERROR', { message: error.message, stack: error.stack }, ip);
        res.status(500).json({ error: 'Failed to update traffic data' });
    }
});

app.get('/api/webhook/logs', requireAuth, (req, res) => {
    try {
        if (fs.existsSync(WEBHOOK_LOG_FILE)) {
            const content = fs.readFileSync(WEBHOOK_LOG_FILE, 'utf-8');
            res.type('text/plain').send(content);
        } else {
            res.type('text/plain').send('No webhook logs yet.');
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to read logs: ' + err.message });
    }
});

app.delete('/api/webhook/logs', requireAuth, (req, res) => {
    try {
        if (fs.existsSync(WEBHOOK_LOG_FILE)) {
            fs.unlinkSync(WEBHOOK_LOG_FILE);
            res.json({ success: true, message: 'Logs cleared' });
        } else {
            res.json({ success: true, message: 'No logs to clear' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear logs: ' + err.message });
    }
});

async function startServer() {
    await initDb();

    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD;
    const defaultAdmin = dbGet('SELECT * FROM users WHERE username = ?', [adminUsername]);
    if (!defaultAdmin && !adminPassword) throw new Error('ADMIN_PASSWORD не задан для создания администратора');
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
    const selectedMonth = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;

    const totalUsers = dbGet('SELECT COUNT(*) as count FROM users')?.count || 0;
    const activeUsers = dbGet('SELECT COUNT(*) as count FROM users WHERE is_active = 1')?.count || 0;

    const requestMonthFilter = selectedMonth ? " WHERE strftime('%Y-%m', requested_at) = ?" : '';
    const requestMonthParams = selectedMonth ? [selectedMonth] : [];
    const totalRequests = dbGet(`SELECT COUNT(*) as count FROM subscription_requests${requestMonthFilter}`, requestMonthParams)?.count || 0;
    const todayRequests = selectedMonth ? 0 : dbGet(`SELECT COUNT(*) as count FROM subscription_requests WHERE date(requested_at) = date('now')`)?.count || 0;
    const weekRequests = selectedMonth ? 0 : dbGet(`SELECT COUNT(*) as count FROM subscription_requests WHERE requested_at >= datetime('now', '-7 days')`)?.count || 0;
    const monthRequests = selectedMonth ? 0 : dbGet(`SELECT COUNT(*) as count FROM subscription_requests WHERE requested_at >= datetime('now', '-30 days')`)?.count || 0;

    const dateFilter = selectedMonth ? `AND strftime('%Y-%m', st.recorded_at) = ?` : '';
    const trafficParams = selectedMonth ? [selectedMonth] : [];

    const allServersTraffic = dbAll(`
        SELECT
            s.id,
            s.name,
            s.tag,
            COALESCE(SUM(st.upload_bytes), 0) as total_upload,
            COALESCE(SUM(st.download_bytes), 0) as total_download,
            COALESCE(SUM(st.total_bytes), 0) as total_traffic
        FROM servers s
        LEFT JOIN server_traffic st ON s.id = st.server_id ${dateFilter}
        WHERE s.is_active = 1
        GROUP BY s.id, s.name, s.tag
        ORDER BY total_traffic DESC
    `, trafficParams);

    const totalTraffic = allServersTraffic.reduce((sum, server) => sum + (server.total_traffic || 0), 0);
    const activeTrafficUsers = allServersTraffic.filter(server => server.total_traffic > 0).length;
    const formattedTotalTraffic = formatBytes(totalTraffic);

    const threeXuiInbounds = getThreeXuiInboundTraffic();
    const threeXuiMonthFilter = selectedMonth ? ' AND strftime(\'%Y-%m\', updated_at) = ?' : '';
    const threeXuiMonthParams = selectedMonth ? [selectedMonth] : [];
    const threeXuiTotals = threeXuiInbounds.reduce((totals, inbound) => ({
        up: totals.up + (inbound.up_bytes || 0),
        down: totals.down + (inbound.down_bytes || 0),
        total: totals.total + (inbound.total_bytes || 0)
    }), { up: 0, down: 0, total: 0 });
    const formattedThreeXuiTotalTraffic = formatBytes(threeXuiTotals.total);

    const topServersTraffic = allServersTraffic.slice(0, 10).map(server => ({
        ...server,
        formatted_upload: formatBytes(server.total_upload || 0),
        formatted_download: formatBytes(server.total_download || 0),
        formatted_total: formatBytes(server.total_traffic || 0)
    }));

    const topThreeXuiInbounds = threeXuiInbounds.slice(0, 10).map(inbound => ({
        ...inbound,
        formatted_upload: formatBytes(inbound.up_bytes || 0),
        formatted_download: formatBytes(inbound.down_bytes || 0),
        formatted_total: formatBytes(inbound.total_bytes || 0)
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

    const lastRequests = dbAll(`
        SELECT sr.*, u.username
        FROM subscription_requests sr
        LEFT JOIN users u ON sr.user_id = u.id
        ORDER BY sr.requested_at DESC
        LIMIT 50
    `);

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

    const availableMonths = dbAll(`
        SELECT DISTINCT strftime('%Y-%m', recorded_at) as month
        FROM server_traffic
        WHERE recorded_at IS NOT NULL
        ORDER BY month DESC
        LIMIT 12
    `).map(row => row.month);

    const trafficByUsername = new Map();
    for (const client of threeXuiUsersTraffic) {
        const current = trafficByUsername.get(client.username) || { total_upload: 0, total_download: 0, total_traffic: 0 };
        current.total_upload += client.up_bytes || 0;
        current.total_download += client.down_bytes || 0;
        current.total_traffic += client.total_bytes || 0;
        trafficByUsername.set(client.username, current);
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
        threeXuiTotals,
        formattedThreeXuiTotalTraffic,
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
        process.exitCode = 1;
    });
}

module.exports = { app, startServer, scheduler, threeXuiScheduler, subscriptionConfig };
