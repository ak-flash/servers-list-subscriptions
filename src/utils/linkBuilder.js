function extractNameFromLink(link) {
    link = link.trim();

    if (link.startsWith('vless://') || link.startsWith('vmess://') || link.startsWith('trojan://') || link.startsWith('ss://')) {
        const hashIndex = link.indexOf('#');
        if (hashIndex !== -1 && hashIndex < link.length - 1) {
            return decodeURIComponent(link.slice(hashIndex + 1));
        }
    }

    return '';
}

function extractHostPortFromLink(link) {
    link = link.trim();

    if (link.startsWith('vless://') || link.startsWith('trojan://')) {
        const protocolLen = link.startsWith('vless://') ? 8 : 9;
        const withoutProtocol = link.slice(protocolLen);
        const atIndex = withoutProtocol.indexOf('@');
        const afterAt = withoutProtocol.slice(atIndex + 1);

        const questionIndex = afterAt.indexOf('?');
        const hostPort = questionIndex !== -1 ? afterAt.slice(0, questionIndex) : afterAt;
        const colonIndex = hostPort.lastIndexOf(':');
        const host = hostPort.slice(0, colonIndex);
        const port = parseInt(hostPort.slice(colonIndex + 1), 10);
        const protocol = link.startsWith('vless://') ? 'vless' : 'trojan';
        return { host, port, protocol };
    } else if (link.startsWith('vmess://')) {
        const withoutProtocol = link.slice(8);
        const atIndex = withoutProtocol.indexOf('@');
        const afterAt = withoutProtocol.slice(atIndex + 1);
        const hashIndex = afterAt.indexOf('#');
        const hostPort = hashIndex !== -1 ? afterAt.slice(0, hashIndex) : afterAt;
        const colonIndex = hostPort.lastIndexOf(':');
        const host = hostPort.slice(0, colonIndex);
        const port = parseInt(hostPort.slice(colonIndex + 1).split('?')[0], 10);
        return { host, port, protocol: 'vmess' };
    } else if (link.startsWith('ss://')) {
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

function buildFullSubscription(servers, userUuid, username = 'User') {
    const lines = [];
    lines.push(`#profile-title: Подписка ${username}`);
    lines.push(`#profile-update-interval: 24`);
    lines.push(`#subscription-userinfo: upload=0; download=0; total=0; expire=0`);

    const links = servers.map(server => {
        if (!server.link) return '';
        let remark = server.name;
        if (server.traffic_limit > 0) {
            const usedGB = (server.total_traffic || 0) / (1024 * 1024 * 1024);
            const limitGB = server.traffic_limit;
            const remainingGB = Math.max(0, limitGB - usedGB);
            remark = `${server.name} | ${remainingGB.toFixed(1)}/${limitGB} GB`;
        }
        let link = updateLinkRemark(server.link, remark);
        if (server.user_server_uuid) {
            link = replaceUuidInLink(link, server.user_server_uuid);
        }
        return link;
    }).filter(Boolean);

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

        return `${link.slice(0, protocolLen)}${newUuid}@${afterAt.slice(0, hashIndex !== -1 ? hashIndex : afterAt.length)}${paramsAndRemark}`;
    }

    return link;
}

module.exports = { extractNameFromLink, extractHostPortFromLink, updateLinkRemark, parseLinkAndExtractName, buildFullSubscription, replaceUuidInLink };
