const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'index.js');
const watch = process.argv.slice(2).some(arg => arg === 'watch' || arg === '--watch');

if (!watch) {
    require(entry);
} else {
    const args = ['--watch', '--watch-preserve-output'];

    // Explicit watch paths are supported by Node.js only on Windows and macOS.
    if (process.platform === 'win32' || process.platform === 'darwin') {
        for (const directory of ['src', 'public', '.env']) {
            args.push(`--watch-path=${path.join(root, directory)}`);
        }
    }

    const child = spawn(process.execPath, [...args, entry], {
        cwd: root,
        stdio: 'inherit'
    });

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            if (!child.killed) child.kill(signal);
        });
    }

    child.on('error', error => {
        console.error(error.message);
        process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
        process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal ? 1 : 0);
    });
}
