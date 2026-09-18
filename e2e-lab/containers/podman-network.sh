#!/usr/bin/env bash
set -euo pipefail

# Helper script to create or verify the podman network for e2e-lab containers

NETWORK_NAME="agenticremote-net"

# Check if podman is available
if ! command -v podman >/dev/null 2>&1; then
  echo "Status: podman not found"
  exit 0
fi

# Create network if it doesn't exist
if podman network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "Network '$NETWORK_NAME' already exists"
else
  echo "Creating podman network: $NETWORK_NAME"
  podman network create "$NETWORK_NAME" || {
    if podman network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
      echo "Network '$NETWORK_NAME' exists (possibly created by another process)"
    else
      echo "Failed to create network '$NETWORK_NAME'"
      exit 1
    fi
  }
fi

echo "Status: Network '$NETWORK_NAME' ready"
