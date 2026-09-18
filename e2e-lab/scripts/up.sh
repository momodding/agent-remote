#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== [agenticRemote E2E Lab] Rootless Podman Topology Bringup ==="

if ! command -v podman >/dev/null 2>&1; then
  echo "[ERROR] Podman container runtime is required for rootless container topology." >&2
  exit 1
fi

# Ensure runtime TLS certs are generated
"${LAB_DIR}/scripts/generate-runtime-tls.sh"
TLS_DIR="${LAB_DIR}/.runtime/tls"

if [ ! -f "${TLS_DIR}/server.crt" ] || [ ! -f "${TLS_DIR}/server.key" ]; then
  echo "[ERROR] TLS certificates missing in ${TLS_DIR}" >&2
  exit 1
fi

NETWORK_NAME="agent-remote-e2e"
if ! podman network exists "${NETWORK_NAME}" 2>/dev/null; then
  echo "Creating Podman network: ${NETWORK_NAME}"
  podman network create "${NETWORK_NAME}"
fi

# Teardown any existing containers
podman rm -f agenticremote-provider agenticremote-daemon agenticremote-client 2>/dev/null || true

echo "1. Launching deterministic upstream provider..."
podman run -d --name agenticremote-provider \
  --network "${NETWORK_NAME}" \
  -p 19090:19090 \
  agenticremote/provider:latest

echo "2. Launching real daemon with TLS cert mounts (HTTPS 18765)..."
podman run -d --name agenticremote-daemon \
  --network "${NETWORK_NAME}" \
  -v "${TLS_DIR}/server.crt:/app/.agenticremote/state/tls/cert.pem:ro,Z" \
  -v "${TLS_DIR}/server.key:/app/.agenticremote/state/tls/key.pem:ro,Z" \
  -p 18765:18765 \
  agenticremote/daemon:latest

echo "3. Launching Expo web client (port 8081)..."
podman run -d --name agenticremote-client \
  --network "${NETWORK_NAME}" \
  -p 8081:8081 \
  agenticremote/client:latest

echo "=== Podman Topology Started Successfully ==="
echo "  Provider: http://127.0.0.1:19090"
echo "  Daemon:   https://127.0.0.1:18765 (WSS wss://127.0.0.1:18765/ws)"
echo "  Web App:  http://127.0.0.1:8081"
