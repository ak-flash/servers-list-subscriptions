const { parseVless } = require('./protocolParsers');

function extractNameFromLink(link) {
    link = link.trim();

    if (link.startsWith('vmess://')) {
        try { return JSON.parse(Buffer.from(link.slice(8).split('#')[0], 'base64').toString('utf8')).ps || ''; }
        catch { /* Keep legacy fragment names readable. */ }
    }

    if (link.startsWith('vless://') || link.startsWith('vmess://') || link.startsWith('trojan://') || link.startsWith('ss://')) {
        const hashIndex = link.indexOf('#');
        if (hashIndex !== -1 && hashIndex < link.length - 1) {
            try { return decodeURIComponent(link.slice(hashIndex + 1)); }
            catch { return ''; }
        }
    }

    return '';
}

function extractHostPortFromLink(link) {
    link = link.trim();

    try {
        if (link.startsWith('vless://') || link.startsWith('trojan://')) {
            const url = new URL(link);
            return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || null, protocol: url.protocol.slice(0, -1) };
        }
        if (link.startsWith('vmess://')) {
            const config = JSON.parse(Buffer.from(link.slice(8).split('#')[0], 'base64').toString('utf8'));
            return { host: config.add || '', port: Number(config.port) || null, protocol: 'vmess' };
        }
    } catch { return { host: '', port: null, protocol: '' }; }

    if (link.startsWith('ss://')) {
        const withoutProtocol = link.slice(5);
        const atIndex = withoutProtocol.indexOf('@');
        const afterAt = withoutProtocol.slice(atIndex + 1);
        const hostPort = afterAt.split('#')[0].split('?')[0];
        const colonIndex = hostPort.lastIndexOf(':');
        const host = hostPort.slice(0, colonIndex);
        const port = parseInt(hostPort.slice(colonIndex + 1), 10);
        return { host, port, protocol: 'ss' };
    }

    return { host: '', port: null, protocol: '' };
}

function updateLinkRemark(link, newName) {
    if (!link) return '';

    if (link.startsWith('vmess://')) {
        try {
            const config = JSON.parse(Buffer.from(link.slice(8).split('#')[0], 'base64').toString('utf8'));
            config.ps = newName;
            return 'vmess://' + Buffer.from(JSON.stringify(config)).toString('base64');
        } catch { /* Fall through for legacy URI-style manual links. */ }
    }

    const hashIndex = link.indexOf('#');
    if (hashIndex !== -1) {
        return link.slice(0, hashIndex + 1) + encodeURIComponent(newName);
    } else {
        return link + '#' + encodeURIComponent(newName);
    }
}

function parseLinkAndExtractName(link) {
    return {
        link: link.trim(),
        name: extractNameFromLink(link)
    };
}

function effectiveLink(server) {
    if (!server.link) return '';
    if (server.credential_mode === 'original') return server.link;
    let remark = server.name;
    if (server.traffic_limit > 0) {
        const usedGB = (server.total_traffic || 0) / (1024 * 1024 * 1024);
        remark = `${server.name} | ${usedGB.toFixed(1)}/${server.traffic_limit} GB`;
    }
    let link = updateLinkRemark(server.link, remark);
    const credentialMode = server.credential_mode || 'user_override';
    if (credentialMode === 'user_override' && server.user_server_uuid) link = replaceUuidInLink(link, server.user_server_uuid);
    return link;
}

function buildFullSubscription(servers, userUuid, username = 'User', options = {}) {
    const lines = [];
    lines.push(`#profile-title: Подписка ${String(username).replace(/[\r\n]/g, ' ')}`);
    lines.push(`#profile-update-interval: ${options.profileUpdateHours || 1}`);
    lines.push(`#subscription-userinfo: ${options.userinfo || 'upload=0; download=0; total=0; expire=0'}`);

    const links = servers.map(effectiveLink).filter(Boolean);

    lines.push(...links);

    return Buffer.from(lines.join('\n')).toString('base64');
}

function replaceUuidInLink(link, newUuid) {
    if (!link) return '';

    if (link.startsWith('vless://') || link.startsWith('trojan://')) {
        const protocolLen = link.startsWith('vless://') ? 8 : 9;
        const withoutProtocol = link.slice(protocolLen);
        const atIndex = withoutProtocol.indexOf('@');

        if (atIndex === -1) return link;

        const afterAt = withoutProtocol.slice(atIndex + 1);
        const hashIndex = afterAt.indexOf('#');

        let paramsAndRemark = hashIndex !== -1 ? afterAt.slice(hashIndex) : '';

        return `${link.slice(0, protocolLen)}${encodeURIComponent(newUuid)}@${afterAt.slice(0, hashIndex !== -1 ? hashIndex : afterAt.length)}${paramsAndRemark}`;
    }

    return link;
}

function publicServer(server) {
    const link = effectiveLink(server);
    const info = extractHostPortFromLink(link);
    const result = { id: server.id, name: extractNameFromLink(link) || server.name, remark: extractNameFromLink(link) || server.name, ...info, link };
    try {
        if (info.protocol === 'vless') {
            const { config } = parseVless(link);
            Object.assign(result, { uuid: config.uuid, network: config.network, tls: config.security, sni: config.sni,
                path: config.ws?.path || '', config });
        } else if (info.protocol === 'vmess') {
            const config = JSON.parse(Buffer.from(link.slice(8).split('#')[0], 'base64').toString('utf8'));
            Object.assign(result, { uuid: config.id, network: config.net, tls: config.tls, sni: config.sni, path: config.path, config });
        } else if (info.protocol === 'trojan') {
            const url = new URL(link);
            Object.assign(result, { password: decodeURIComponent(url.username), network: url.searchParams.get('type') || 'tcp',
                tls: url.searchParams.get('security') || 'tls', sni: url.searchParams.get('sni') || info.host, path: url.searchParams.get('path') || '' });
        }
    } catch { /* The original link remains authoritative for legacy manual formats. */ }
    return result;
}

module.exports = { extractNameFromLink, extractHostPortFromLink, updateLinkRemark, parseLinkAndExtractName, buildFullSubscription, replaceUuidInLink, effectiveLink, publicServer };
