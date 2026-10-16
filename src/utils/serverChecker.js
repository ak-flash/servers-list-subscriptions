const net = require('net');

function checkServer(host, port, timeout = 5000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let status = 'offline';

        socket.setTimeout(timeout);

        socket.on('connect', () => {
            status = 'online';
            socket.destroy();
        });

        socket.on('timeout', () => {
            status = 'timeout';
            socket.destroy();
        });

        socket.on('error', (err) => {
            status = 'error';
            socket.destroy();
        });

        socket.on('close', () => {
            resolve({ host, port, status, timestamp: Date.now() });
        });

        try {
            socket.connect(port, host);
        } catch (err) {
            socket.destroy();
            resolve({ host, port, status: 'error', timestamp: Date.now() });
        }
    });
}

async function checkMultipleServers(servers, timeout = 5000, concurrency = 8) {
    const results = new Array(servers.length);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, servers.length) }, async () => {
        while (index < servers.length) {
            const current = index++;
            results[current] = await checkServer(servers[current].host, servers[current].port, timeout);
        }
    }));
    return results;
}

module.exports = { checkServer, checkMultipleServers };
