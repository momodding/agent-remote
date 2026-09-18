#!/usr/bin/env bash
set -euo pipefail

NETWORK_NAME="agent-remote-e2e"

if ! command -v podman >/dev/null 2>&1; then
  echo "[ERROR] Podman container runtime is required for rootless container network topology." >&2
  exit 1
fi

if podman network exists "${NETWORK_NAME}" 2>/dev/null; then
  echo "Podman network '${NETWORK_NAME}' already exists."
else
  echo "Creating rootless Podman network '${NETWORK_NAME}'..."
  podman network create "${NETWORK_NAME}"
  echo "Created network '${NETWORK_NAME}'."
fi
