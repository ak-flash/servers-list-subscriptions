# VPN Subscription Service

[Russian](README.md) | **English**

A VPN subscription service with an admin panel: manual server assignments and automatic selection of working VLESS nodes from external sources.

Xray runs as a temporary client to test external VPN nodes. User traffic goes directly to the assigned nodes; this application does not host a VPN server for users.

## Screenshots

| Manual Servers | Users |
|:---:|:---:|
| [<img src="screenshots/dashboard-servers.png" alt="Manual servers" width="360">](screenshots/dashboard-servers.png) | [<img src="screenshots/dashboard-users.png" alt="Users" width="360">](screenshots/dashboard-users.png) |
| **Settings** | **Statistics** |
| [<img src="screenshots/settings.png" alt="Settings" width="360">](screenshots/settings.png) | [<img src="screenshots/stats.png" alt="Statistics" width="360">](screenshots/stats.png) |
| **Subscription Sources** | |
| [<img src="screenshots/subscription-sources.png" alt="Subscription sources" width="360">](screenshots/subscription-sources.png) | |

## Features

- **Admin panel** for managing servers and users
- **Supported protocols**: VLESS, VMess, Trojan, Shadowsocks
- **Server import** from links (vless://, vmess://, trojan://, ss://)
- **Base64 subscriptions** compatible with 3X-UI, Happ, and other clients
- **Caddy routing** with forwarding for `/join/*`
- **External sources**: HTTP(S), plain/Base64/Base64URL VLESS, periodic updates, and a persistent catalog
- **Real VPN probes**: VLESS TCP/WS/XHTTP/gRPC with or without TLS, TCP/XHTTP/gRPC Reality (including Vision), HTTPS 204 checks, latency, and failure reasons
- **Automatic node assignment**: per-source node limits, latency thresholds, priorities, deduplication, and freshness checks
- **Background jobs**: a bounded queue, progress in the admin panel, and schedule recovery

Configuration, compatibility matrix, and operations: [external subscriptions and Xray](docs/EXTERNAL_SUBSCRIPTIONS.md) (in Russian).

Restart the application after updating protocol support. Stored links will be parsed again automatically, and previously unsupported Reality/`security=none` nodes will be queued for VPN probes. Source assignments and node exclusion settings are preserved.

## Requirements

- Node.js 22+
- npm
- For VPN probes: Xray-core **26.10.21**. Linux and local testing on Windows are supported.

## Installation

```bash
npm ci
npm run build:css
```

Interface CSS is built locally from `src/styles.css` into `public/app.css`; no external Tailwind CDN is used.

**Important:** The `data/subscription.db` database is created automatically on first startup.

## Configuration

Copy `.env.example` to `.env` and configure the settings:

```bash
cp .env.example .env
```

Settings in `.env`:

| Setting | Description | Default |
|---------|-------------|---------|
| `PORT` | Server port | `4000` in `.env.example`, `2096` if unset |
| `APP_NAME` | Application name displayed in the interface | `VPN Подписки` (VPN Subscriptions) |
| `SESSION_SECRET` | Session secret | Set in `.env` |
| `PUBLIC_DOMAIN` | Public domain for QR codes | `your-domain.com` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Temporary credentials for the first administrator; a new password is set after the first login | Set only for initial setup |
| `XRAY_PATH` | Absolute path to the Xray binary | Linux: `/usr/local/bin/xray`; Windows: `tools/xray/xray.exe` in the project |
| `XRAY_VERSION` | Expected Xray version | `26.10.21` |
| `PROBE_CONCURRENCY` | Concurrent VPN probes | `4` |
| `PROBE_HTTP_PROXY` | HTTP(S) proxy for additional node probes: Xray connects to the node through this proxy, with latency measured separately (Proxy badge) | Empty: probe without a proxy |
| `PROBE_HTTP_PROXY_MODE` | `extra`: regular probe plus an additional proxy probe; `only`: all probes use the proxy | `extra` |
| `PROFILE_UPDATE_INTERVAL_HOURS` | Client profile update interval | `1` |

Set `SESSION_SECRET` and a temporary `ADMIN_PASSWORD` before the first startup. The application requires a new password on first login. After creating the administrator, you can remove `ADMIN_PASSWORD` from `.env`. 3x-ui statistics are collected through its API after adding a panel in the admin interface. The complete set of settings and limits is listed in `.env.example` and the [documentation](docs/EXTERNAL_SUBSCRIPTIONS.md) (in Russian).

### Installing Xray on Linux

```bash
sudo bash scripts/install-xray.sh
```

The script verifies the official archive's SHA-256 checksum and installs only the binary. Copy the printed `XRAY_VERSION` into `.env`. The application starts and stops Xray for each probe; no separate, continuously running Xray service is required.

### Installing Xray and Testing on Windows

Run in PowerShell from the project directory:

```powershell
.\scripts\install-xray.ps1
```

The installer downloads Xray 26.10.21, verifies SHA-256, and places `xray.exe` in `tools/xray`. Installing into the project directory does not require administrator privileges. Copy the printed `XRAY_PATH` and `XRAY_VERSION` into `.env`. For local QR codes, set `PUBLIC_DOMAIN=`.

```powershell
npm run test:vpn
npm start
```

The test automatically reads the Xray path from `.env`; if `XRAY_PATH` is empty on Windows, it uses `tools/xray/xray.exe`. The panel is available at `http://localhost:4000/admin` when `PORT=4000`. The application starts Xray for probes automatically. Stop the application with `Ctrl+C`.

Details: [Windows and PowerShell](docs/EXTERNAL_SUBSCRIPTIONS.md#windows-и-powershell) (in Russian).

## Running

```bash
npm start
```

### Docker

```bash
docker build -t vpn-subscription-service .
docker run --name vpn-subscription-service --env-file .env -p 2096:2096 -v vpn-subscription-data:/app/data vpn-subscription-service
```

For production, set `PORT` to match the published port and configure `SESSION_SECRET`, `PUBLIC_DOMAIN`, and `ADMIN_PASSWORD` in `.env` before the first login.

Rebuild local styles before startup or after changing templates:

```bash
npm run build:css
```

For development with automatic restarts on changes:

```bash
npm start watch
```

You can also use `npm run dev`. On Windows and macOS, files in `src/` (including EJS templates), `public/`, and `.env` are watched. On Linux, Node.js's built-in watch mode tracks loaded JS modules. Database and log changes do not trigger restarts. Refresh the browser to see page changes.

## Admin Panel

- URL: http://localhost:port/admin
- Username: the `ADMIN_USERNAME` value (`admin` by default)
- Temporary password: the `ADMIN_PASSWORD` value

On first login, the application opens a mandatory password change form. The new password must contain at least 8 characters. After changing it successfully, you can remove `ADMIN_PASSWORD` from `.env`; the new password is stored as a hash in the database.

## Project Structure

```text
├── src/
│   ├── index.js          # Application entry point
│   ├── db/
│   │   └── database.js    # SQLite schema and connection
│   ├── utils/
│   │   └── linkBuilder.js # Subscription link generation
│   └── views/             # EJS templates
│       ├── login.ejs
│       ├── dashboard.ejs
│       ├── server-form.ejs
│       ├── user-form.ejs
│       └── user-servers.ejs
├── data/                  # SQLite database (created automatically)
├── package.json
└── README.md
```

## Subscription Link Format

After creating a user and assigning servers, the subscription link is available at:

```text
http://your-domain.com/join/{user_id}
```

The same URL provides the Base64 format for 3X-UI / Happ:

```text
http://your-domain.com/join/{user_id}
```

The application automatically returns a Base64-encoded server list.

## Caddy Integration

Add the following to your `Caddyfile` (replace ${PORT} with your PORT from `.env`):

```caddy
# Subscriptions
@sub path /join*
handle @sub {
    reverse_proxy http://[::]:${PORT} {
        header_up Host localhost:${PORT}
        header_up X-Real-IP {remote_host}
    }
}
```

## Running as a Persistent Service

### Option 1: systemd on Linux

A ready-to-use unit is provided: [`deploy/vpn-subscriptions.service`](deploy/vpn-subscriptions.service). Instructions for creating a system user, configuring permissions, and starting the service are in the [documentation](docs/EXTERNAL_SUBSCRIPTIONS.md#linux-и-systemd) (in Russian).

### Option 2: Supervisor 3.1

Supervisor runs the application as the `ubuntu` user and restarts it automatically after a failure. Use an absolute path to Node.js and run `src/index.js` directly: Supervisor often has a different `PATH`, so `command=npm start` may fail with `spawn error`. Find your Node.js path with `command -v node`.

If Supervisor is installed as an aaPanel plugin, the system `supervisorctl` command may not be available. In that case, use the path from the aaPanel environment:

```bash
sudo /www/server/panel/pyenv/bin/supervisorctl status
sudo /www/server/panel/pyenv/bin/supervisorctl reread
sudo /www/server/panel/pyenv/bin/supervisorctl update
sudo /www/server/panel/pyenv/bin/supervisorctl restart subcsriptions:subcsriptions_00
```

Use `status` to find the process name; it is composed of the `[program:...]` section name and `process_name`.

To automatically update the project, install dependencies, build CSS, and restart the application, use the general-purpose [`deploy/deploy.sh`](deploy/deploy.sh) script. Settings are stored in `.deploy.env` in the project root, which is not tracked by Git:

```bash
cd /home/ubuntu/servers-list-subscriptions
cp .deploy.env.example .deploy.env
chmod +x deploy/deploy.sh
nano .deploy.env
./deploy/deploy.sh
```

Example settings for aaPanel Supervisor:

```env
PROJECT_DIR=/home/ubuntu/servers-list-subscriptions
DEPLOY_BRANCH=main
INSTALL_COMMAND="npm ci"
BUILD_COMMAND="npm run build:css"
RESTART_COMMAND="sudo /www/server/panel/pyenv/bin/supervisorctl restart subcsriptions:subcsriptions_00"
```

For systemd, replace `RESTART_COMMAND`:

```env
RESTART_COMMAND="sudo systemctl restart vpn-subscriptions.service"
```

For Docker Compose:

```env
RESTART_COMMAND="docker compose up -d --build"
```

The script uses `git pull --ff-only`, stops at the first error, and does not restart the application if `RESTART_COMMAND` is empty.

Create a configuration file, such as `/etc/supervisor/conf.d/subcsriptions.conf`:

```ini
[program:subcsriptions]
command=/usr/bin/node /home/ubuntu/servers-list-subscriptions/src/index.js
directory=/home/ubuntu/servers-list-subscriptions/
autorestart=true
startsecs=3
startretries=3
stdout_logfile=/www/server/panel/plugin/supervisor/log/subcsriptions.out.log
stderr_logfile=/www/server/panel/plugin/supervisor/log/subcsriptions.err.log
stdout_logfile_maxbytes=2MB
stderr_logfile_maxbytes=2MB
user=ubuntu
priority=999
numprocs=1
stopsignal=SIGTERM
stopasgroup=true
killasgroup=true
stopwaitsecs=10
process_name=%(program_name)s_%(process_num)02d
```

Before startup, make sure the project directory is owned by `ubuntu`, `.env` is configured, dependencies are installed, and CSS is built. If you use aaPanel Node.js, replace `/usr/bin/node` in `command` with the result of `command -v node` run as the user running Supervisor:

```bash
cd /home/ubuntu/servers-list-subscriptions
npm ci
npm run build:css
```

Supervisor commands:

```bash
sudo /www/server/panel/pyenv/bin/supervisorctl reread
sudo /www/server/panel/pyenv/bin/supervisorctl update
sudo /www/server/panel/pyenv/bin/supervisorctl status subcsriptions:subcsriptions_00
sudo /www/server/panel/pyenv/bin/supervisorctl start subcsriptions:subcsriptions_00
sudo /www/server/panel/pyenv/bin/supervisorctl stop subcsriptions:subcsriptions_00
sudo /www/server/panel/pyenv/bin/supervisorctl restart subcsriptions:subcsriptions_00
```

If `status` shows `ERROR (spawn error)`, run these commands on the server:

```bash
command -v node
ls -ld /home/ubuntu/servers-list-subscriptions
sudo -u ubuntu /usr/bin/node --version
sudo -u ubuntu /usr/bin/node /home/ubuntu/servers-list-subscriptions/src/index.js
```

The last command should either start the application or print the exact Node.js error. For aaPanel, use the actual Node.js path instead of `/usr/bin/node`.

After changing `.env`, code, or templates, rebuild CSS as needed and run:

```bash
cd /home/ubuntu/servers-list-subscriptions
npm run build:css
sudo /www/server/panel/pyenv/bin/supervisorctl restart subcsriptions:subcsriptions_00
```

View logs:

```bash
tail -f /www/server/panel/plugin/supervisor/log/subcsriptions.out.log
tail -f /www/server/panel/plugin/supervisor/log/subcsriptions.err.log
```

If `supervisorctl` cannot find the process, check the section name and process list:

```bash
sudo /www/server/panel/pyenv/bin/supervisorctl status
sudo /www/server/panel/pyenv/bin/supervisorctl reread
sudo /www/server/panel/pyenv/bin/supervisorctl update
```

Run only one application instance. `sql.js` keeps the database in memory; multi-instance cluster mode is not supported. A second instance stops when it detects the database lock.

### Option 3: PM2

PM2 is a Node.js process manager that automatically restarts the application after failures and server reboots.

Run only one application instance. `sql.js` keeps the database in memory; multi-instance cluster mode is not supported. A second instance stops when it detects the database lock.

```bash
# Install PM2 globally
npm install -g pm2

# Start the application
pm2 start src/index.js --name vpn-subscriptions

# Save the process list for automatic startup after reboot
pm2 save

# Configure startup at system boot
pm2 startup
```

**Useful PM2 commands:**

```bash
pm2 status                    # View status
pm2 logs vpn-subscriptions     # View logs
pm2 restart vpn-subscriptions  # Restart
pm2 stop vpn-subscriptions     # Stop
```

## 3x-ui Statistics via API

The webhook is disabled by default. To collect user traffic and inbound connection statistics:

1. In 3x-ui, open **Settings > Security > API Token** and create a token.
2. In this application, open **Admin > 3x-ui > Add Panel**.
3. Enter the panel URL, including the secret base path if configured, such as `https://panel.example.com/secret-path`.
4. Paste the API token and save the panel.

The application automatically polls the 3x-ui `/panel/api/inbounds/list` endpoint, stores statistics locally, and displays them under **Admin > Statistics**. The synchronization interval is configured per panel.

The token is stored in the application's local database. Do not publish it or add it to `.env`, shell history, or third-party logs.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Public health check for the service and scheduler |
| GET | `/admin` | Admin panel (authentication required) |
| GET | `/admin/login` | Login page |
| POST | `/admin/login` | Log in |
| GET | `/admin/logout` | Log out |
| GET | `/join/:id` | Get subscription (Base64) |
| GET | `/join/:id/json` | Get subscription (JSON) |
| GET | `/join/:id/qr`, `/join/:id/qr-img` | Subscription link QR code, including for users assigned only external sources |
| GET | `/admin/subscription-sources` | Sources, catalog, and saved VPN probe results |
| POST | `/api/subscription-sources/:id/sync` | Background fetch, `202 + jobId` |
| POST | `/api/subscription-sources/:id/check` | Background VPN probe, `202 + jobId` |
| GET | `/admin/threexui` | Configure 3x-ui panels and start synchronization |
| POST | `/api/threexui/sync` | Force synchronization of all active 3x-ui panels |
| POST | `/api/threexui/:id/sync` | Force synchronization of one 3x-ui panel |
| GET | `/api/background-jobs/:id` | Job progress (authentication required) |
| GET | `/api/users/:id/subscription-preview` | Saved subscription composition and reasons for node shortfalls (authentication required) |

## Tests

```bash
npm test
# Local VPN test setup; Xray is read from .env or the OS default path
npm run test:vpn
```

`npm test` uses temporary databases, local HTTP, and test implementations of network tasks. The VPN integration test runs real Xray with a local test server and an HTTPS target; it does not require external subscriptions or Google.

## License

MIT
