#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== [agenticRemote E2E Lab] Topology Bringup (up.sh) ==="

RUNTIME=""
if command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
else
  echo "[ERROR] Container runtime (podman/docker) is required but not installed." >&2
  exit 1
fi

# Ensure runtime TLS certs are generated
"${LAB_DIR}/scripts/generate-runtime-tls.sh"
TLS_DIR="${LAB_DIR}/.runtime/tls"

if [ ! -f "${TLS_DIR}/server.crt" ] || [ ! -f "${TLS_DIR}/server.key" ]; then
  echo "[ERROR] TLS certificates missing in ${TLS_DIR}" >&2
  exit 1
fi

NETWORK_NAME="agenticremote-net"
if ! ${RUNTIME} network exists "${NETWORK_NAME}" 2>/dev/null; then
  echo "Creating ${RUNTIME} network: ${NETWORK_NAME}"
  ${RUNTIME} network create "${NETWORK_NAME}"
fi

# Teardown existing containers if running
${RUNTIME} rm -f agenticremote-provider agenticremote-daemon agenticremote-client 2>/dev/null || true

echo "1. Launching deterministic upstream provider..."
${RUNTIME} run -d --name agenticremote-provider \
  --network "${NETWORK_NAME}" \
  -p 19090:19090 \
  agenticremote/provider:latest

echo "2. Launching real daemon (HTTPS / TLS 18765)..."
${RUNTIME} run -d --name agenticremote-daemon \
  --network "${NETWORK_NAME}" \
  -v "${TLS_DIR}:/etc/agenticremote/tls:ro,Z" \
  -p 18765:18765 \
  agenticremote/daemon:latest

echo "3. Launching Expo web client (port 8081)..."
${RUNTIME} run -d --name agenticremote-client \
  --network "${NETWORK_NAME}" \
  -p 8081:8081 \
  agenticremote/client:latest

echo "=== Topology successfully started ==="
echo "  Provider: http://127.0.0.1:19090"
echo "  Daemon:   https://127.0.0.1:18765 (WSS wss://127.0.0.1:18765/ws)"
echo "  Web App:  http://127.0.0.1:8081"
