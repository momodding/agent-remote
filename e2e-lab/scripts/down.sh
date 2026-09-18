#!/usr/bin/env bash
set -euo pipefail

echo "=== [agenticRemote E2E Lab] Topology Teardown (down.sh) ==="

# Check for container runtime
CONTAINER_RUNTIME=""
if command -v podman >/dev/null 2>&1; then
  CONTAINER_RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  CONTAINER_RUNTIME="docker"
else
  echo "Status: NO_RUNTIME"
  echo "Reason: Container runtime not found. Nothing to tear down."
  exit 0
fi

# Stop and remove containers
echo "Stopping containers..."
$CONTAINER_RUNTIME stop agenticremote-provider 2>/dev/null || true
$CONTAINER_RUNTIME stop agenticremote-daemon 2>/dev/null || true
$CONTAINER_RUNTIME stop agenticremote-client 2>/dev/null || true

echo "Removing containers..."
$CONTAINER_RUNTIME rm agenticremote-provider 2>/dev/null || true
$CONTAINER_RUNTIME rm agenticremote-daemon 2>/dev/null || true
$CONTAINER_RUNTIME rm agenticremote-client 2>/dev/null || true

# Clean up network if using podman
if [ "$CONTAINER_RUNTIME" = "podman" ]; then
  echo "Cleaning up network..."
  $CONTAINER_RUNTIME network rm agenticremote-net 2>/dev/null || true
fi

echo "Status: Teardown complete. All temporary lab resources released."
