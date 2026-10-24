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
GENERATED_FILES="${GENERATED_FILES:-public/app.css}"

cd "$PROJECT_DIR"
if [[ -n "$(git status --porcelain --untracked-files=no -- $GENERATED_FILES)" ]]; then
  printf '==> discard generated local files: %s\n' "$GENERATED_FILES"
  git restore --worktree -- $GENERATED_FILES
fi
printf '==> git pull (%s)\n' "$DEPLOY_BRANCH"
git pull --ff-only origin "$DEPLOY_BRANCH"
printf '==> install: %s\n' "$INSTALL_COMMAND"
timeout 300 bash -lc "$INSTALL_COMMAND"
printf '==> build: %s\n' "$BUILD_COMMAND"
timeout 300 bash -lc "$BUILD_COMMAND"

if [[ -n "$RESTART_COMMAND" ]]; then
  bash -lc "$RESTART_COMMAND"
else
  printf 'RESTART_COMMAND is not configured; deployment completed without restarting the application.\n'
fi
