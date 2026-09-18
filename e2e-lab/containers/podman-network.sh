#!/usr/bin/env bash
set -euo pipefail

NETWORK_NAME="agent-remote-e2e"

if ! command -v podman >/dev/null 2>&1; then
  echo "[ERROR] Rootless Podman is required for container network topology." >&2
  exit 1
fi

if ! podman network exists "${NETWORK_NAME}" 2>/dev/null; then
  echo "Creating Podman network: ${NETWORK_NAME}"
  podman network create "${NETWORK_NAME}"
else
  echo "Podman network '${NETWORK_NAME}' already exists."
fi
