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
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"
HEALTHCHECK_TIMEOUT="${HEALTHCHECK_TIMEOUT:-60}"
GENERATED_FILES="${GENERATED_FILES:-public/app.css}"
ALLOW_NO_RESTART="${ALLOW_NO_RESTART:-0}"

cd "$PROJECT_DIR"
PREVIOUS_COMMIT="$(git rev-parse HEAD)"

rollback() {
  printf '==> rollback to %s\n' "$PREVIOUS_COMMIT" >&2
  git reset --hard "$PREVIOUS_COMMIT" >/dev/null 2>&1 || true
  timeout 300 bash -lc "$INSTALL_COMMAND" || true
  timeout 300 bash -lc "$BUILD_COMMAND" || true
  if [[ -n "$RESTART_COMMAND" ]]; then bash -lc "$RESTART_COMMAND" || true; fi
}

wait_for_health() {
  local deadline=$((SECONDS + HEALTHCHECK_TIMEOUT))
  while (( SECONDS < deadline )); do
    if curl -fsS -o /dev/null --max-time 5 "$HEALTHCHECK_URL"; then
      printf '==> health check passed: %s\n' "$HEALTHCHECK_URL"
      return 0
    fi
    sleep 2
  done
  return 1
}

if [[ -z "$RESTART_COMMAND" && "$ALLOW_NO_RESTART" != "1" ]]; then
  printf 'RESTART_COMMAND is not configured. Set it in %s or pass ALLOW_NO_RESTART=1 for a non-production deploy.\n' "$CONFIG_FILE" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no -- $GENERATED_FILES)" ]]; then
  printf '==> discard generated local files: %s\n' "$GENERATED_FILES"
  git restore --worktree -- $GENERATED_FILES
fi
printf '==> git pull (%s) from %s\n' "$DEPLOY_BRANCH" "$PREVIOUS_COMMIT"
git pull --ff-only origin "$DEPLOY_BRANCH"
printf '==> deploy commit: %s\n' "$(git rev-parse --short HEAD)"
printf '==> install: %s\n' "$INSTALL_COMMAND"
timeout 300 bash -lc "$INSTALL_COMMAND"
printf '==> build: %s\n' "$BUILD_COMMAND"
timeout 300 bash -lc "$BUILD_COMMAND"

if [[ -n "$RESTART_COMMAND" ]]; then
  bash -lc "$RESTART_COMMAND"
else
  printf '==> restart skipped (ALLOW_NO_RESTART=1)\n'
fi

if [[ -n "$HEALTHCHECK_URL" ]]; then
  if ! wait_for_health; then
    printf '==> health check failed: %s\n' "$HEALTHCHECK_URL" >&2
    rollback
    exit 1
  fi
else
  printf '==> HEALTHCHECK_URL is not configured; skipping post-deploy health check\n'
fi
