#!/usr/bin/env bash
set -euo pipefail

echo "=== [agenticRemote E2E Lab] Topology Teardown (down.sh) ==="

RUNTIME=""
if command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
fi

if [ -n "${RUNTIME}" ]; then
  echo "Stopping and removing containers..."
  ${RUNTIME} rm -f agenticremote-provider agenticremote-daemon agenticremote-client 2>/dev/null || true

  NETWORK_NAME="agenticremote-net"
  if ${RUNTIME} network exists "${NETWORK_NAME}" 2>/dev/null; then
    echo "Cleaning up network: ${NETWORK_NAME}"
    ${RUNTIME} network rm "${NETWORK_NAME}" 2>/dev/null || true
  fi
fi

echo "Status: Teardown complete. All lab containers and networks released."
