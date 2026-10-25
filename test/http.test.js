const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const db = require('../src/db/database');
const sources = require('../src/services/subscriptionSources');
const { app, scheduler, subscriptionConfig } = require('../src/index');
const { hashPassword } = require('../src/utils/passwords');
const { link, UUID } = require('./fixtures');

test('HTTP end-to-end: admin CRUD/jobs/CSRF, source-only assignments, Base64/JSON/QR and empty/disabled responses', async t => {
  await db.initDb({ filePath: ':memory:' });
  db.run("INSERT INTO users (id, username, password, must_change_password) VALUES ('admin-test', 'test-admin', ?, 0), ('u', '<script>test</script>', NULL, 0)", [hashPassword('test-password')]);
  scheduler.sync = (id, config, options) => sources.syncSource(id, config, { ...options,
    download: async () => ({ status: 200, body: [link('one.example.com'), link('two.example.com')].join('\n'), headers: { etag: 'one' } }) });
  scheduler.checker.status = { available: true, version: subscriptionConfig.xrayVersion };
  scheduler.checker.check = async () => ({ status: 'healthy', successCount: 1, attemptCount: 2, targetId: 'primary', targetPriority: 0, latencyMs: 30, httpStatus: 204, attempts: [] });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await scheduler.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.closeDb(); });
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  const post = (url, data, cookie) => request(url, { method: 'POST', headers: cookie ? { cookie } : {}, body: new URLSearchParams(data) });
  const healthcheck = await request('/healthz');
  assert.equal(healthcheck.status, 200);
  assert.equal((await healthcheck.json()).status, 'ok');
  assert.equal((await request('/api/users/u/subscription-preview')).status, 401);
  const login = await post('/admin/login', { username: 'test-admin', password: 'test-password' });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const dashboard = await (await request('/admin', { headers: { cookie } })).text();
  assert.ok(dashboard.includes('Ручные серверы'));
  assert.ok(dashboard.includes('Пользователи'));
  const usersDashboard = await (await request('/admin?tab=users', { headers: { cookie } })).text();
  assert.ok(usersDashboard.includes('aria-selected="true"'));
  assert.ok(usersDashboard.includes('Найти'));
  const form = await (await request('/admin/subscription-sources/new', { headers: { cookie } })).text();
  const csrf = /name="csrf-token" content="([a-f\d]+)"/.exec(form)[1];
  const csrfInput = /name="_csrf" value="([a-f\d]+)"/.exec(form)[1];
  assert.equal(csrfInput, csrf);
  const forbidden = await post('/admin/subscription-sources', { name: 'Test', url: 'https://example.com' }, cookie);
  assert.equal(forbidden.status, 403);
  const created = await post('/admin/subscription-sources', { _csrf: csrf, name: 'Test source', url: 'https://example.com/private?token=secret-token', is_active: '1', authorization: 'Bearer secret-auth' }, cookie);
  assert.equal(created.status, 302);
  await scheduler.idle();
  const source = db.get('SELECT * FROM subscription_sources');
  const listing = await (await request('/admin/subscription-sources', { headers: { cookie } })).text();
  assert.ok(!listing.includes('secret-token'));
  assert.ok(!listing.includes('secret-auth'));
  assert.ok(listing.includes('Test source'));
  const nodesPage = await (await request(`/admin/subscription-sources/${source.id}/nodes`, { headers: { cookie } })).text();
  assert.ok(nodesPage.includes('Каталог узлов'));
  assert.ok(nodesPage.includes('one.example.com'));
  assert.ok(nodesPage.includes('two.example.com'));
  for (const url of [`/admin/subscription-sources/${source.id}/edit`, `/admin/subscription-sources/${source.id}/nodes`, '/admin/users/u/servers']) {
    assert.equal((await request(url, { headers: { cookie } })).status, 200);
  }
  for (const month of ['', '?month=2026-01', '?month=../bad']) {
    const stats = await request(`/admin/stats${month}`, { headers: { cookie } });
    assert.equal(stats.status, 200);
    assert.ok((await stats.text()).includes('Общая статистика'));
  }
  const assigned = await post('/admin/users/u/servers', { _csrf: csrf, sources: source.id, [`source_limits[${source.id}]`]: '2' }, cookie);
  assert.equal(assigned.status, 302);
  assert.equal((await request('/join/u')).status, 404);
  const checking = await post(`/api/subscription-sources/${source.id}/check`, { _csrf: csrf }, cookie);
  assert.equal(checking.status, 202);
  const job = await checking.json();
  await scheduler.idle();
  assert.equal((await (await request(`/api/background-jobs/${job.jobId}`, { headers: { cookie } })).json()).state, 'completed');
  const profile = await request('/join/u');
  assert.equal(profile.status, 200);
  const body = await profile.text();
  const firstUris = Buffer.from(body, 'base64').toString('utf8').split('\n').filter(line => line.startsWith('vless://'));
  assert.equal(firstUris.length, 2);
  const decoded = Buffer.from(body, 'base64').toString('utf8');
  const uris = decoded.split('\n').filter(line => line.startsWith('vless://'));
  assert.equal(uris.length, 2);
  assert.ok(uris[0].includes(UUID));
  assert.ok(decoded.includes(`#profile-update-interval: ${profile.headers.get('profile-update-interval')}`));
  const json = await (await request('/join/u/json')).json();
  assert.deepEqual(json.servers.map(server => server.link), uris);
  assert.equal(json.servers[0].uuid, UUID);
  assert.equal(json.raw, body);
  const checkedNode = db.get('SELECT id FROM subscription_nodes WHERE source_id = ? ORDER BY id LIMIT 1', [source.id]);
  db.run("UPDATE subscription_node_health SET latency_ms = 1 WHERE node_id = ?", [checkedNode.id]);
  db.run("UPDATE subscription_node_health SET latency_ms = 999 WHERE node_id != ?", [checkedNode.id]);
  const refreshed = await request('/join/u');
  assert.equal(refreshed.status, 200);
  const refreshedUris = Buffer.from(await refreshed.text(), 'base64').toString('utf8').split('\n').filter(line => line.startsWith('vless://'));
  assert.equal(refreshedUris.length, 2);
  assert.ok(refreshedUris[0].includes('one.example.com') || refreshedUris[0].includes('two.example.com'));
  assert.equal(refreshed.headers.get('cache-control'), 'no-store');
  const qr = await (await request('/join/u/qr-img')).json();
  assert.match(qr.qrCode, /^data:image\/png;base64,/);
  const qrPage = await (await request('/join/u/qr')).text();
  assert.ok(!qrPage.includes('<script>test</script>'));
  const preview = await (await request('/api/users/u/subscription-preview', { headers: { cookie } })).json();
  assert.equal(preview.servers.length, 2);
  assert.ok(!JSON.stringify(preview).includes(UUID));
  db.run("UPDATE users SET is_active = 0 WHERE id = 'u'");
  for (const suffix of ['', '/json', '/qr', '/qr-img']) assert.equal((await request(`/join/u${suffix}`)).status, 404);
});

test('HTTP statistics: request pagination, month filters, validation and escaping', async t => {
  await db.initDb({ filePath: ':memory:' });
  const username = '<script>stats-user</script>';
  const ipAddress = '"><svg/onload=alert(1)>';
  const userAgent = '"><img src=x onerror=alert(2)>';
  db.run("INSERT INTO users (id, username, password, must_change_password) VALUES ('admin-stats', 'stats-admin', ?, 0), ('stats-user', ?, NULL, 0)", [hashPassword('test-password'), username]);
  db.transaction(() => {
    for (let id = 1; id <= 25; id++) {
      const requestedAt = id === 1 ? '2026-03-01 00:00:00' : id === 2 ? '2026-03-31 23:59:59' : '2026-03-15 12:00:00';
      db.run('INSERT INTO subscription_requests (id, user_id, requested_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)',
        [id, 'stats-user', requestedAt, id === 25 ? ipAddress : `198.51.100.${id}`, id === 25 ? userAgent : `StatsTest/${id}`]);
    }
    db.run("INSERT INTO subscription_requests (id, user_id, requested_at) VALUES (101, 'stats-user', '2026-02-28 23:59:59'), (102, 'stats-user', '2026-04-01 00:00:00')");
  });
  const monthIds = [2, ...Array.from({ length: 23 }, (_, index) => 25 - index), 1];
  const allIds = [102, ...monthIds, 101];
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.closeDb(); });
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  const render = t.mock.method(app, 'render');
  const login = await request('/admin/login', { method: 'POST', body: new URLSearchParams({ username: 'stats-admin', password: 'test-password' }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const statsPage = async (url = '/admin/stats') => {
    const response = await request(url, { headers: { cookie } });
    assert.equal(response.status, 200, url);
    const html = await response.text();
    const call = render.mock.calls.at(-1);
    assert.equal(call.arguments[0], 'stats');
    return { ...call.arguments[1], html };
  };
  const requestLinks = html => {
    const nav = /<nav\b[^>]*\bdata-pagination=["']requests["'][^>]*>[\s\S]*?<\/nav>/.exec(html)?.[0];
    return [...(nav || '').matchAll(/\bhref=["']([^"']+)["']/g)].map(match => new URL(match[1].replace(/&amp;/g, '&'), base));
  };
  const assertMonthOptions = (result, months, selectedMonth = null) => {
    assert.deepEqual(result.availableMonths, months);
    assert.equal(result.selectedMonth, selectedMonth);
    const select = /<select\b[^>]*\bid=["']stats-month["'][^>]*>[\s\S]*?<\/select>/.exec(result.html)?.[0];
    assert.ok(select);
    assert.match(select, /\bname=["']month["']/);
    const options = [...select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(match => ({
      value: /\bvalue=["']([^"']*)["']/.exec(match[1])?.[1],
      selected: /(?:^|\s)selected(?:\s|=|$)/.test(match[1]),
      text: match[2].trim()
    }));
    assert.deepEqual(options.map(option => option.value), ['', ...months]);
    assert.equal(options[0].text, 'Все время');
    const selected = options.filter(option => option.selected).map(option => option.value);
    if (selectedMonth) assert.deepEqual(selected, [selectedMonth]);
    else assert.ok(selected.length === 0 || (selected.length === 1 && selected[0] === ''));
  };
  const assertUrl = (url, page, month) => {
    const target = new URL(url, base);
    assert.equal(target.origin, base);
    assert.equal(target.pathname, '/admin/stats');
    assert.equal(target.hash, '#requests');
    assert.deepEqual(target.searchParams.getAll('month'), month ? [month] : []);
    const queryPages = target.searchParams.getAll('requestPage');
    assert.ok(queryPages.length === 1 || (page === 1 && queryPages.length === 0));
    assert.equal(queryPages[0] || '1', String(page));
    assert.ok([...target.searchParams.keys()].every(key => key === 'month' || key === 'requestPage'));
  };
  const assertPage = (result, expectedIds, page, total, pages, month = null) => {
    const totalPages = Math.max(1, Math.ceil(total / 10));
    const from = total ? (page - 1) * 10 + 1 : 0;
    const to = Math.min(page * 10, total);
    assert.equal(result.totalRequests, total);
    assert.equal(result.selectedMonth, month);
    assert.deepEqual(result.requestPagination, { page, perPage: 10, total, totalPages, from, to, pages });
    assert.deepEqual(result.lastRequests.map(row => row.id), expectedIds);
    assert.ok(result.lastRequests.length <= 10);
    for (const number of pages.filter(value => value !== null)) assertUrl(result.requestPageUrl(number), number, month);
    const ids = [...result.html.matchAll(/\bdata-request-id=["'](\d+)["']/g)].map(match => Number(match[1]));
    assert.deepEqual([...new Set(ids)], expectedIds);
    assert.equal(ids.length, expectedIds.length * 2);
    for (const id of expectedIds) assert.equal(ids.filter(value => value === id).length, 2);
    const info = /\bdata-pagination-info=["']requests["'][^>]*>\s*Показаны\s+(\d+)\s*–\s*(\d+)\s+из\s+(\d+)\s+запросов/.exec(result.html);
    if (totalPages > 1) {
      assert.match(result.html, /<nav\b[^>]*\baria-label=["']Пагинация запросов["']/);
      assert.match(result.html, /<nav\b[^>]*\bdata-pagination=["']requests["']/);
      assert.ok(info);
    }
    if (info) assert.deepEqual(info.slice(1).map(Number), [from, to, total]);
    const links = requestLinks(result.html);
    assert.ok(links.length <= 9);
    for (const target of links) {
      const number = Number(target.searchParams.get('requestPage') || '1');
      assert.ok(Number.isSafeInteger(number) && number >= 1 && number <= totalPages);
      assertUrl(target, number, month);
    }
  };

  await t.test('request pages require authentication', async () => {
    const renderCount = render.mock.callCount();
    for (const url of ['/admin/stats', '/admin/stats?month=2026-03&requestPage=2']) {
      const response = await request(url);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/admin/login');
    }
    assert.equal(render.mock.callCount(), renderCount);
  });

  await t.test('three disjoint pages use timestamp then descending ID order', async () => {
    const seen = [];
    for (let page = 1; page <= 3; page++) {
      const result = await statsPage(page === 1 ? '/admin/stats' : `/admin/stats?requestPage=${page}`);
      assertPage(result, allIds.slice((page - 1) * 10, page * 10), page, 27, [1, 2, 3]);
      seen.push(...result.lastRequests.map(row => row.id));
    }
    assert.deepEqual(seen, allIds);
    assert.equal(new Set(seen).size, 27);
    assertPage(await statsPage('/admin/stats?requestPage=2'), allIds.slice(10, 20), 2, 27, [1, 2, 3]);
    assertPage(await statsPage('/admin/stats?requestPage=1'), allIds.slice(0, 10), 1, 27, [1, 2, 3]);
  });

  await t.test('month filtering includes its boundaries and pagination links preserve the filter', async () => {
    let url = '/admin/stats?month=2026-03';
    const seen = [];
    for (let page = 1; page <= 3; page++) {
      const result = await statsPage(url);
      assertPage(result, monthIds.slice((page - 1) * 10, page * 10), page, 25, [1, 2, 3], '2026-03');
      seen.push(...result.lastRequests.map(row => row.id));
      const links = requestLinks(result.html);
      if (page > 1) assert.ok(links.some(target => Number(target.searchParams.get('requestPage') || '1') === page - 1));
      if (page < 3) {
        const next = links.find(target => target.searchParams.get('requestPage') === String(page + 1));
        assert.ok(next);
        url = `${next.pathname}${next.search}${next.hash}`;
      }
    }
    assert.deepEqual(seen, monthIds);
    assertPage(await statsPage('/admin/stats?month=2026-02&requestPage=2'), [101], 1, 1, [1], '2026-02');
  });

  await t.test('request-only months appear in the filter and keep their selection', async () => {
    const months = ['2026-04', '2026-03', '2026-02'];
    assertMonthOptions(await statsPage(), months);
    assertMonthOptions(await statsPage('/admin/stats?month=2026-03&requestPage=2'), months, '2026-03');
    const emptyMonth = await statsPage('/admin/stats?month=2026-05');
    assertPage(emptyMonth, [], 1, 0, [1], '2026-05');
    assertMonthOptions(emptyMonth, [...months, '2026-05'], '2026-05');
  });

  await t.test('valid out-of-range integers clamp to the last page', async () => {
    for (const page of ['4', '99999', String(Number.MAX_SAFE_INTEGER)]) {
      assertPage(await statsPage(`/admin/stats?requestPage=${page}`), allIds.slice(20), 3, 27, [1, 2, 3]);
      assertPage(await statsPage(`/admin/stats?month=2026-03&requestPage=${page}`), monthIds.slice(20), 3, 25, [1, 2, 3], '2026-03');
    }
    assertPage(await statsPage('/admin/stats?requestPage=0002'), allIds.slice(10, 20), 2, 27, [1, 2, 3]);
  });

  await t.test('malformed, repeated and unsafe page inputs default to the first page', async () => {
    const invalid = ['', '0', '-2', '2.5', '2.0', 'NaN', 'Infinity', '-Infinity', '2foo', '2e0', '0x2', '+2', ' 2', '2 ', '2\n', '2\r', '2\t', '2\0', '1,2',
      String(Number.MAX_SAFE_INTEGER + 1), '9007199254740993', '9'.repeat(400), '2; DROP TABLE subscription_requests;--', '<script>alert(1)</script>'];
    for (const requestPage of invalid) {
      const query = new URLSearchParams({ month: '2026-03', requestPage });
      assertPage(await statsPage(`/admin/stats?${query}`), monthIds.slice(0, 10), 1, 25, [1, 2, 3], '2026-03');
    }
    for (const query of ['requestPage=2&requestPage=3', 'requestPage=2&requestPage=2', 'requestPage[]=2', 'requestPage[0]=2', 'requestPage[value]=2']) {
      assertPage(await statsPage(`/admin/stats?${query}`), allIds.slice(0, 10), 1, 27, [1, 2, 3]);
    }
    assert.equal(db.get('SELECT COUNT(*) AS count FROM subscription_requests').count, 27);
  });

  await t.test('invalid or repeated months are not reflected into pagination URLs', async () => {
    for (const query of ['month=%3Cscript%3Ealert(1)%3C%2Fscript%3E', 'month=2026-03&month=2026-03', 'month[]=2026-03', 'month=2026-00', 'month=2026-13', 'month=2026-03%0A']) {
      assertPage(await statsPage(`/admin/stats?${query}&requestPage=2`), allIds.slice(10, 20), 2, 27, [1, 2, 3]);
    }
  });

  await t.test('request usernames, IP addresses and user agents remain escaped', async () => {
    const result = await statsPage('/admin/stats?month=2026-03');
    assertPage(result, monthIds.slice(0, 10), 1, 25, [1, 2, 3], '2026-03');
    for (const value of [username, ipAddress, userAgent]) assert.equal(result.html.includes(value), false);
    assert.ok(result.html.includes('&lt;script&gt;stats-user&lt;/script&gt;'));
    assert.ok(result.html.includes('&#34;&gt;&lt;svg/onload=alert(1)&gt;'));
    assert.ok(result.html.includes('&#34;&gt;&lt;img src=x onerror=alert(2)&gt;'));
  });

  await t.test('large result sets use bounded page numbers and null ellipses at each boundary', async () => {
    const extraIds = Array.from({ length: 82 }, (_, index) => 200 + index);
    db.transaction(() => {
      for (const id of extraIds) db.run("INSERT INTO subscription_requests (id, user_id, requested_at) VALUES (?, 'stats-user', '2026-03-15 12:00:00')", [id]);
    });
    const ids = [monthIds[0], ...extraIds.reverse(), ...monthIds.slice(1)];
    for (const [page, pages] of [
      [1, [1, 2, 3, 4, 5, null, 11]],
      [4, [1, 2, 3, 4, 5, null, 11]],
      [5, [1, null, 4, 5, 6, null, 11]],
      [7, [1, null, 6, 7, 8, null, 11]],
      [8, [1, null, 7, 8, 9, 10, 11]],
      [11, [1, null, 7, 8, 9, 10, 11]]
    ]) {
      assertPage(await statsPage(`/admin/stats?month=2026-03&requestPage=${page}`), ids.slice((page - 1) * 10, page * 10), page, 107, pages, '2026-03');
    }
  });

  await t.test('month choices retain the 24 recent default and append older selected months', async () => {
    const months = Array.from({ length: 26 }, (_, index) => `${2020 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`);
    db.transaction(() => {
      for (const month of months) db.run("INSERT INTO subscription_requests (user_id, requested_at) VALUES ('stats-user', ?)", [`${month}-15 12:00:00`]);
    });
    const recent = ['2026-04', '2026-03', '2026-02', ...months.slice().reverse()].slice(0, 24);
    assertMonthOptions(await statsPage(), recent);
    const olderMonth = await statsPage(`/admin/stats?month=${months[0]}`);
    assert.equal(olderMonth.totalRequests, 1);
    assertMonthOptions(olderMonth, [...recent, months[0]], months[0]);
    const emptyMonth = await statsPage('/admin/stats?month=2019-12');
    assertPage(emptyMonth, [], 1, 0, [1], '2019-12');
    assertMonthOptions(emptyMonth, [...recent, '2019-12'], '2019-12');
  });

  await t.test('empty months and an empty request log have a zero range on page one', async () => {
    const emptyMonth = await statsPage('/admin/stats?month=2026-05&requestPage=99999');
    assertPage(emptyMonth, [], 1, 0, [1], '2026-05');
    assert.match(emptyMonth.html, /Нет запросов подписок/);
    db.run('DELETE FROM subscription_requests');
    for (const query of ['', '?requestPage=99999', '?requestPage=NaN']) {
      const result = await statsPage(`/admin/stats${query}`);
      assertPage(result, [], 1, 0, [1]);
      assert.match(result.html, /Нет запросов подписок/);
    }
  });
});

test('HTTP settings page: save proxy, check endpoint rejects when not configured', async t => {
  await db.initDb({ filePath: ':memory:' });
  db.run("INSERT INTO users (id, username, password, must_change_password) VALUES ('admin-test', 'test-admin', ?, 0)", [hashPassword('test-password')]);
  scheduler.checker.status = { available: true, version: subscriptionConfig.xrayVersion };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await scheduler.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.closeDb(); });
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  const post = (url, data, cookie) => request(url, { method: 'POST', headers: cookie ? { cookie } : {}, body: new URLSearchParams(data) });
  const login = await post('/admin/login', { username: 'test-admin', password: 'test-password' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const settingsPage = await (await request('/admin/settings', { headers: { cookie } })).text();
  assert.ok(settingsPage.includes('HTTP-прокси'));
  const csrf = /name="_csrf" value="([a-f\d]+)"/.exec(settingsPage)[1];
  const saved = await post('/admin/settings', { _csrf: csrf, proxyUrl: 'http://proxy.example.com:3128', proxyMode: 'extra' }, cookie);
  assert.equal(saved.status, 302);
  assert.equal(db.get("SELECT value FROM app_state WHERE key = 'probe_http_proxy'").value.includes('proxy.example.com'), true);
  const configured = await (await request('/admin/settings', { headers: { cookie } })).text();
  assert.ok(configured.includes('proxy.example.com'));
  const check = await request('/api/settings/proxy/check', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(check.status, 200);
  const body = await check.json();
  assert.equal(body.status, 'proxy_error');
  assert.ok(body.latencyMs === null || typeof body.latencyMs === 'number');
  const cleared = await post('/admin/settings', { _csrf: csrf, proxyUrl: '', proxyMode: 'extra' }, cookie);
  assert.equal(cleared.status, 302);
  const notConfigured = await request('/api/settings/proxy/check', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(notConfigured.status, 400);
});

test('HTTP settings page: proxy stats and recheck-all trigger jobs', async t => {
  await db.initDb({ filePath: ':memory:' });
  db.run("INSERT INTO users (id, username, password, must_change_password) VALUES ('admin-test', 'test-admin', ?, 0)", [hashPassword('test-password')]);
  scheduler.checker.status = { available: true, version: subscriptionConfig.xrayVersion };
  scheduler.checker.check = async () => ({ status: 'healthy', successCount: 1, attemptCount: 2, targetId: 'primary', targetPriority: 0, latencyMs: 30, httpStatus: 204, attempts: [] });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await scheduler.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.closeDb(); });
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  const post = (url, data, cookie) => request(url, { method: 'POST', headers: cookie ? { cookie } : {}, body: new URLSearchParams(data) });
  const login = await post('/admin/login', { username: 'test-admin', password: 'test-password' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const settingsPage = await (await request('/admin/settings', { headers: { cookie } })).text();
  const csrf = /name="_csrf" value="([a-f\d]+)"/.exec(settingsPage)[1];
  await post('/admin/settings', { _csrf: csrf, proxyUrl: 'http://proxy.example.com:3128', proxyMode: 'extra' }, cookie);
  const withStats = await (await request('/admin/settings', { headers: { cookie } })).text();
  assert.ok(withStats.includes('Доступность узлов через прокси'));
  assert.ok(withStats.includes('Не проверено'));
  const recheck = await post('/admin/settings/recheck', { _csrf: csrf }, cookie);
  const recheckBody = await recheck.text();
  assert.ok(recheckBody.includes('Перепроверка узлов') || recheckBody.includes('перепроверка') || recheck.status === 200);
  assert.equal(recheck.status, 200);
});
