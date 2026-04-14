require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { initDb, getDb, saveDb } = require('./db/database');
const { extractHostPortFromLink, parseLinkAndExtractName, updateLinkRemark, buildFullSubscription } = require('./utils/linkBuilder');

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

app.get('/admin', requireAuth, (req, res) => {
    const servers = dbAll('SELECT * FROM servers ORDER BY created_at DESC');
    const serversWithInfo = servers.map(server => {
        const info = extractHostPortFromLink(server.link);
        return { ...server, ...info };
    });
    const users = dbAll('SELECT * FROM users ORDER BY created_at DESC');
    res.render('dashboard', { servers: serversWithInfo, users, username: req.session.username, appName: APP_NAME });
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

    const subscription = buildFullSubscription(servers, user.id, user.username);

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('profile-title', `base64:${Buffer.from('Подписка ' + user.username).toString('base64')}`);
    res.set('profile-update-interval', '24');
    res.set('subscription-userinfo', `upload=0; download=0; total=0; expire=0`);
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

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
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

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
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

startServer();
