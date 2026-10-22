#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${DEPLOY_CONFIG_FILE:-${SCRIPT_DIR}/../.deploy.env}"

if [[ -f "$CONFIG_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
fi

PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
INSTALL_COMMAND="${INSTALL_COMMAND:-npm ci --no-audit --no-fund --loglevel=error}"
BUILD_COMMAND="${BUILD_COMMAND:-npm run build:css}"
RESTART_COMMAND="${RESTART_COMMAND:-}"

cd "$PROJECT_DIR"
git pull --ff-only origin "$DEPLOY_BRANCH"
bash -lc "$INSTALL_COMMAND"
bash -lc "$BUILD_COMMAND"

if [[ -n "$RESTART_COMMAND" ]]; then
  bash -lc "$RESTART_COMMAND"
else
  printf 'RESTART_COMMAND is not configured; deployment completed without restarting the application.\n'
fi
