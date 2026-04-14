require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { initDb, getDb, saveDb, getUserTraffic, updateUserTraffic, getAllUsersTraffic } = require('./db/database');
const { extractHostPortFromLink, parseLinkAndExtractName, updateLinkRemark, buildFullSubscription } = require('./utils/linkBuilder');
const { checkServer, checkMultipleServers } = require('./utils/serverChecker');

function generateShortId(length = 6) {
    return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

const app = express();
const PORT = process.env.PORT || 2096;
const APP_NAME = process.env.APP_NAME || 'VPN Подписки';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'vpn-subscription-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
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
    const ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    dbRun(`
        INSERT INTO subscription_requests (user_id, requested_at, ip_address, user_agent)
        VALUES (?, datetime('now'), ?, ?)
    `, [userId, ipAddress, userAgent]);

    const user = dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (user) {
        const firstRequestAt = user.first_request_at;
        if (!firstRequestAt) {
            dbRun(`UPDATE users SET first_request_at = datetime('now'), last_request_at = datetime('now') WHERE id = ?`, [userId]);
        } else {
            dbRun(`UPDATE users SET last_request_at = datetime('now') WHERE id = ?`, [userId]);
        }
    }
}

app.get('/admin/login', (req, res) => {
    res.render('login', { error: null, appName: APP_NAME });
});

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    const user = dbGet('SELECT * FROM users WHERE username = ? AND password = ? AND is_active = 1', [username, password]);

    if (user) {
        req.session.userId = user.id;
        req.session.username = user.username;
        res.redirect('/admin');
    } else {
        res.render('login', { error: 'Неверное имя пользователя или пароль', appName: APP_NAME });
    }
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
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

    // Add traffic data to users
    const usersWithTraffic = users.map(user => {
        const traffic = getUserTraffic(user.id);
        return {
            ...user,
            total_upload: traffic.total_upload || 0,
            total_download: traffic.total_download || 0,
            total_traffic: traffic.total_traffic || 0,
            formatted_upload: formatBytes(traffic.total_upload || 0),
            formatted_download: formatBytes(traffic.total_download || 0),
            formatted_total: formatBytes(traffic.total_traffic || 0)
        };
    });

    res.render('dashboard', { servers: serversWithInfo, users: usersWithTraffic, username: req.session.username, appName: APP_NAME });
});

app.get('/admin/servers/new', requireAuth, (req, res) => {
    res.render('server-form', { server: null, error: null, appName: APP_NAME });
});

app.post('/admin/servers', requireAuth, (req, res) => {
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

app.post('/admin/servers/:id', requireAuth, (req, res) => {
    const { name, is_active } = req.body;

    try {
        const server = dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
        if (!server) return res.redirect('/admin');

        const newName = name && name.trim() ? name.trim() : server.name;
        const updatedLink = updateLinkRemark(server.link, newName);

        dbRun(`UPDATE servers SET name = ?, link = ?, is_active = ? WHERE id = ?`,
            [newName, updatedLink, is_active ? 1 : 0, req.params.id]);

        res.redirect('/admin');
    } catch (err) {
        const server = dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
        if (!server) return res.redirect('/admin');
        const info = extractHostPortFromLink(server.link);
        const serverWithInfo = { ...server, ...info, name: name || server.name, is_active: is_active ? 1 : 0 };
        res.render('server-form', { server: serverWithInfo, error: 'Ошибка: ' + err.message, appName: APP_NAME });
    }
});

app.post('/admin/servers/:id/delete', requireAuth, (req, res) => {
    dbRun('DELETE FROM user_servers WHERE server_id = ?', [req.params.id]);
    dbRun('DELETE FROM servers WHERE id = ?', [req.params.id]);
    res.redirect('/admin');
});

app.get('/admin/users/new', requireAuth, (req, res) => {
    res.render('user-form', { user: null, error: null, appName: APP_NAME });
});

app.post('/admin/users', requireAuth, (req, res) => {
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

app.post('/admin/users/:id', requireAuth, (req, res) => {
    const { username, password, is_active } = req.body;

    try {
        if (password) {
            dbRun(`UPDATE users SET username = ?, password = ?, is_active = ? WHERE id = ? `,
                [username, password, is_active ? 1 : 0, req.params.id]);
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

app.post('/admin/users/:id/delete', requireAuth, (req, res) => {
    dbRun('DELETE FROM user_servers WHERE user_id = ?', [req.params.id]);
    dbRun('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.redirect('/admin');
});

app.get('/admin/users/:id/servers', requireAuth, (req, res) => {
    const user = dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.redirect('/admin');

    const allServers = dbAll('SELECT * FROM servers WHERE is_active = 1');
    const serversWithInfo = allServers.map(server => {
        const info = extractHostPortFromLink(server.link);
        return { ...server, ...info };
    });
    const assignedServers = dbAll('SELECT server_id FROM user_servers WHERE user_id = ?', [req.params.id]);
    const assignedIds = assignedServers.map(s => String(s.server_id));

    res.render('user-servers', { user, servers: serversWithInfo, assignedIds, appName: APP_NAME });
});

app.post('/admin/users/:id/servers', requireAuth, (req, res) => {
    let { servers } = req.body;

    if (typeof servers === 'string') {
        servers = servers ? [servers] : [];
    } else if (!Array.isArray(servers)) {
        servers = [];
    }

    dbRun('DELETE FROM user_servers WHERE user_id = ?', [req.params.id]);

    for (const serverId of servers) {
        dbRun('INSERT INTO user_servers (user_id, server_id) VALUES (?, ?)', [req.params.id, serverId]);
    }

    res.redirect('/admin');
});

app.get('/join/:id', (req, res) => {
    const user = dbGet('SELECT * FROM users WHERE id = ? AND is_active = 1', [req.params.id]);

    if (!user) {
        return res.status(404).send('Пользователь не найден или отключен');
    }

    const servers = dbAll(`
        SELECT s.* FROM servers s
        INNER JOIN user_servers us ON s.id = us.server_id
        WHERE us.user_id = ? AND s.is_active = 1
    `, [user.id]);

    if (servers.length === 0) {
        return res.status(404).send('Нет доступных серверов для этого пользователя');
    }

    recordSubscriptionRequest(user.id, req);

    const subscription = buildFullSubscription(servers, user.id, user.username);

    // Get user traffic data
    const traffic = getUserTraffic(user.id);
    const uploadBytes = traffic.total_upload || 0;
    const downloadBytes = traffic.total_download || 0;
    const totalBytes = traffic.total_traffic || 0;

    // Set default expiration (30 days from now) if not set
    const expireTimestamp = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('profile-title', `base64:${Buffer.from('Подписка ' + user.username).toString('base64')}`);
    res.set('profile-update-interval', '24');
    res.set('subscription-userinfo', `upload=${uploadBytes}; download=${downloadBytes}; total=${totalBytes}; expire=${expireTimestamp}`);
    res.send(subscription);
});

app.get('/join/:id/qr', async (req, res) => {
    const user = dbGet('SELECT * FROM users WHERE id = ? AND is_active = 1', [req.params.id]);

    if (!user) {
        return res.status(404).send('Пользователь не найден или отключен');
    }

    const servers = dbAll(`
        SELECT s.* FROM servers s
        INNER JOIN user_servers us ON s.id = us.server_id
        WHERE us.user_id = ? AND s.is_active = 1
    `, [user.id]);

    if (servers.length === 0) {
        return res.status(404).send('Нет доступных серверов для этого пользователя');
    }

    recordSubscriptionRequest(user.id, req);

    let protocol = req.headers['x-forwarded-proto'] || req.protocol;
    let host = req.headers['x-forwarded-host'] || req.get('host');

    // Use configured domain if available
    if (process.env.PUBLIC_DOMAIN) {
        host = process.env.PUBLIC_DOMAIN;
        protocol = 'https'; // Assume HTTPS for custom domains
    }

    const subscriptionUrl = `${protocol}://${host}/join/${user.id}#Подписка_${user.username}`;

    try {
        const qrCode = await QRCode.toDataURL(subscriptionUrl, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
        });
        res.send(`<html><head><meta charset="UTF-8"><title>QR Код - ${user.username}</title><style>body{display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5;font-family:system-ui,sans-serif}.container{text-align:center;background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}.username{font-size:1.5rem;font-weight:600;margin-bottom:1rem;color:#1f2937}</style></head><body><div class="container"><div class="username">${user.username}</div><img src="${qrCode}" /></div></body></html>`);
    } catch (err) {
        res.status(500).send('Ошибка генерации QR кода');
    }
});

app.get('/join/:id/qr-img', async (req, res) => {
    const user = dbGet('SELECT * FROM users WHERE id = ? AND is_active = 1', [req.params.id]);

    if (!user) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const servers = dbAll(`
        SELECT s.* FROM servers s
        INNER JOIN user_servers us ON s.id = us.server_id
        WHERE us.user_id = ? AND s.is_active = 1
    `, [user.id]);

    if (servers.length === 0) {
        return res.status(404).json({ error: 'Нет серверов' });
    }

    recordSubscriptionRequest(user.id, req);

    let protocol = req.headers['x-forwarded-proto'] || req.protocol;
    let host = req.headers['x-forwarded-host'] || req.get('host');

    // Use configured domain if available
    if (process.env.PUBLIC_DOMAIN) {
        host = process.env.PUBLIC_DOMAIN;
        protocol = 'https'; // Assume HTTPS for custom domains
    }

    const subscriptionUrl = `${protocol}://${host}/join/${user.id}#Подписка_${user.username}`;

    try {
        const qrCode = await QRCode.toDataURL(subscriptionUrl, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
        });
        res.json({ qrCode, username: user.username, subscriptionUrl });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка генерации QR кода' });
    }
});

app.get('/join/:id/json', (req, res) => {
    const user = dbGet('SELECT * FROM users WHERE id = ? AND is_active = 1', [req.params.id]);

    if (!user) {
        return res.status(404).json({ error: 'Пользователь не найден или отключен' });
    }

    const servers = dbAll(`
        SELECT s.* FROM servers s
        INNER JOIN user_servers us ON s.id = us.server_id
        WHERE us.user_id = ? AND s.is_active = 1
    `, [user.id]);

    if (servers.length === 0) {
        return res.status(404).json({ error: 'Нет доступных серверов' });
    }

    recordSubscriptionRequest(user.id, req);

    const subscription = buildFullSubscription(servers, user.id, user.username);

    res.json({
        version: 2,
        servers: servers.map(s => ({
            id: s.id,
            name: s.name,
            remark: s.remark,
            host: s.host,
            port: s.port,
            protocol: s.protocol,
            uuid: s.uuid,
            network: s.network,
            tls: s.tls,
            sni: s.sni,
            path: s.path
        })),
        raw: subscription
    });
});

app.post('/api/servers/check', requireAuth, async (req, res) => {
    const servers = dbAll('SELECT * FROM servers');

    if (servers.length === 0) {
        return res.json({ results: [] });
    }

    const serversToCheck = servers.map(server => {
        const info = extractHostPortFromLink(server.link);
        return { id: server.id, name: server.name, host: info.host, port: info.port };
    });

    const results = await checkMultipleServers(serversToCheck);

    const resultsWithId = results.map((result, index) => ({
        ...result,
        id: serversToCheck[index].id,
        name: serversToCheck[index].name
    }));

    res.json({ results: resultsWithId });
});

app.post('/api/servers/:id/check', requireAuth, async (req, res) => {
    const server = dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);

    if (!server) {
        return res.status(404).json({ error: 'Сервер не найден' });
    }

    const info = extractHostPortFromLink(server.link);
    const result = await checkServer(info.host, info.port);

    res.json({
        id: server.id,
        name: server.name,
        ...result
    });
});

// Traffic reporting API endpoints
app.post('/api/traffic/report', (req, res) => {
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

async function startServer() {
    await initDb();

    const dataDir = path.join(__dirname, '..', '..', 'data');
    const fs = require('fs');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const defaultAdmin = dbGet('SELECT * FROM users WHERE username = ?', ['admin']);
    if (!defaultAdmin) {
        dbRun('INSERT INTO users (id, username, password, is_active, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))',
            [generateShortId(), 'admin', 'admin123', 1]);
        console.log('Создан администратор по умолчанию: admin / admin123');
    }

    app.listen(PORT, () => {
        console.log(`Сервер подписок запущен на порту ${PORT} `);
        console.log(`Админ - панель: http://localhost:${PORT}/admin`);
        console.log(`Подписка: http://localhost:${PORT}/join/{user_id}`);
    });
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
    const totalUsers = dbGet('SELECT COUNT(*) as count FROM users')?.count || 0;
    const activeUsers = dbGet('SELECT COUNT(*) as count FROM users WHERE is_active = 1')?.count || 0;

    const totalRequests = dbGet('SELECT COUNT(*) as count FROM subscription_requests')?.count || 0;
    const todayRequests = dbGet(`SELECT COUNT(*) as count FROM subscription_requests WHERE date(requested_at) = date('now')`)?.count || 0;
    const weekRequests = dbGet(`SELECT COUNT(*) as count FROM subscription_requests WHERE requested_at >= datetime('now', '-7 days')`)?.count || 0;
    const monthRequests = dbGet(`SELECT COUNT(*) as count FROM subscription_requests WHERE requested_at >= datetime('now', '-30 days')`)?.count || 0;

    // Get traffic statistics
    const allTraffic = getAllUsersTraffic();
    const totalTraffic = allTraffic.reduce((sum, user) => sum + (user.total_traffic || 0), 0);
    const activeTrafficUsers = allTraffic.filter(user => user.total_traffic > 0).length;
    const formattedTotalTraffic = formatBytes(totalTraffic);

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

    // Format traffic data for top users
    const topTrafficUsers = allTraffic.slice(0, 10).map(user => ({
        ...user,
        formatted_upload: formatBytes(user.total_upload || 0),
        formatted_download: formatBytes(user.total_download || 0),
        formatted_total: formatBytes(user.total_traffic || 0)
    }));

    const requestsByDay = dbAll(`
        SELECT date(requested_at) as day, COUNT(*) as count
        FROM subscription_requests
        WHERE requested_at >= datetime('now', '-30 days')
        GROUP BY date(requested_at)
        ORDER BY day DESC
    `);

    res.render('stats', {
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
        requestsByDay,
        username: req.session.username,
        appName: APP_NAME
    });
});

app.post('/admin/stats/clear', requireAuth, (req, res) => {
    try {
        // Clear all subscription requests
        dbRun('DELETE FROM subscription_requests');

        // Reset user request tracking
        dbRun('UPDATE users SET first_request_at = NULL, last_request_at = NULL');

        res.json({ success: true, message: 'Статистика успешно очищена' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Ошибка при очистке статистики: ' + error.message });
    }
});

startServer();
