#!/usr/bin/env bash
set -euo pipefail

# Install only the client binary. No VPN service, TUN device or public inbound is created.
version='26.3.27'
case "$(uname -m)" in
  x86_64|amd64)
    asset='Xray-linux-64.zip'
    checksum='23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae'
    ;;
  aarch64|arm64)
    asset='Xray-linux-arm64-v8a.zip'
    checksum='4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c'
    ;;
  *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
for tool in curl unzip sha256sum install; do
  command -v "$tool" >/dev/null || { printf 'Required command: %s\n' "$tool" >&2; exit 1; }
done
if [ "$(id -u)" -ne 0 ]; then
  printf 'Run: sudo bash scripts/install-xray.sh\n' >&2
  exit 1
fi
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 --max-time 120 --retry 2 \
  "https://github.com/XTLS/Xray-core/releases/download/v${version}/${asset}" --output "$temporary/$asset"
printf '%s  %s\n' "$checksum" "$temporary/$asset" | sha256sum --check --status
unzip -q "$temporary/$asset" xray -d "$temporary"
install -o root -g root -m 0755 "$temporary/xray" /usr/local/bin/xray
/usr/local/bin/xray version
printf '\nAdd these settings to .env:\nXRAY_PATH=/usr/local/bin/xray\nXRAY_VERSION=%s\nXRAY_SHA256=%s\n' \
  "$version" "$(sha256sum /usr/local/bin/xray | cut -d ' ' -f 1)"
