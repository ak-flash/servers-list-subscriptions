#!/usr/bin/env bash
set -euo pipefail

# Install only the client binary. No VPN service, TUN device or public inbound is created.
log() { printf '[xray] %s\n' "$*"; }
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$project_root/.env"
log "Project directory: $project_root"
log "Reading configuration: $env_file"
if [ ! -f "$env_file" ]; then
  printf '[xray] .env not found: %s\n' "$env_file" >&2
  exit 1
fi
version="$(awk -F= '$1 == "XRAY_VERSION" { print $2; exit }' "$env_file")"
checksum="$(awk -F= '$1 == "XRAY_SHA256" { print $2; exit }' "$env_file")"
if [ -z "$version" ]; then
  printf '[xray] XRAY_VERSION is missing in %s\n' "$env_file" >&2
  exit 1
fi
log "Requested version: $version"
case "$(uname -m)" in
  x86_64|amd64)
    asset='Xray-linux-64.zip'
    ;;
  aarch64|arm64)
    asset='Xray-linux-arm64-v8a.zip'
    ;;
  *) printf '[xray] Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
log "Architecture: $(uname -m), archive: $asset"
for tool in curl unzip sha256sum install; do
  command -v "$tool" >/dev/null || { printf '[xray] Required command: %s\n' "$tool" >&2; exit 1; }
done
log "Required commands are available"
if [ "$(id -u)" -ne 0 ]; then
  printf '[xray] Run: sudo bash scripts/install-xray.sh\n' >&2
  exit 1
fi
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
url="https://github.com/XTLS/Xray-core/releases/download/v${version}/${asset}"
log "Downloading: $url"
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 --max-time 120 --retry 2 \
  "$url" --output "$temporary/$asset"
log "Download complete: $(du -h "$temporary/$asset" | awk '{print $1}')"
if [ -n "$checksum" ]; then
  printf '%s  %s\n' "$checksum" "$temporary/$asset" | sha256sum --check --status
  log "SHA-256 checksum verified"
else
  log "XRAY_SHA256 is not set; checksum verification skipped"
fi
unzip -q "$temporary/$asset" xray -d "$temporary"
log "Archive extracted"
install -o root -g root -m 0755 "$temporary/xray" /usr/local/bin/xray
log "Installed to /usr/local/bin/xray"
/usr/local/bin/xray version
log "Update completed"
printf '\nAdd these settings to .env:\nXRAY_PATH=/usr/local/bin/xray\nXRAY_VERSION=%s\n' \
  "$version"
