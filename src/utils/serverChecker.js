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
            resolve({ host, port, status: 'error', timestamp: Date.now() });
        }
    });
}

async function checkMultipleServers(servers, timeout = 5000) {
    const checks = servers.map(server => checkServer(server.host, server.port, timeout));
    return Promise.all(checks);
}

module.exports = { checkServer, checkMultipleServers };