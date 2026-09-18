#!/usr/bin/env bash
set -euo pipefail

echo "=== [agenticRemote E2E Lab] Rootless Podman Topology Teardown ==="

if ! command -v podman >/dev/null 2>&1; then
  echo "Podman not found; skipping container teardown."
  exit 0
fi

echo "Stopping and removing containers..."
podman rm -f agenticremote-provider agenticremote-daemon agenticremote-client 2>/dev/null || true

NETWORK_NAME="agent-remote-e2e"
if podman network exists "${NETWORK_NAME}" 2>/dev/null; then
  echo "Cleaning up Podman network: ${NETWORK_NAME}"
  podman network rm "${NETWORK_NAME}" 2>/dev/null || true
fi

echo "Status: Teardown complete. All lab containers and networks released."
