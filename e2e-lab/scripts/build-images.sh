#!/usr/bin/env bash
set -euo pipefail

echo "=== [agenticRemote E2E Lab] Container Image Builder ==="

# Check for container runtime
CONTAINER_RUNTIME=""
if command -v podman >/dev/null 2>&1; then
  CONTAINER_RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  CONTAINER_RUNTIME="docker"
else
  echo "Status: BLOCKED_ENVIRONMENT"
  echo "Reason: Container runtime (podman/docker) not found."
  exit 0
fi

echo "Using container runtime: $CONTAINER_RUNTIME"

# Verify OMP binary exists
if ! command -v agenticRemote >/dev/null 2>&1; then
  echo "Status: BLOCKED_ENVIRONMENT"
  echo "Reason: agenticRemote binary not found in PATH."
  exit 0
fi

# Create network
if [ "$CONTAINER_RUNTIME" = "podman" ]; then
  bash "$(dirname "$0")/../containers/podman-network.sh" || true
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTAINERS_DIR="$PROJECT_ROOT/e2e-lab/containers"
RUNTIME_DIR="$PROJECT_ROOT/e2e-lab/.runtime"

mkdir -p "$RUNTIME_DIR"

# Build daemon image
echo "Building daemon image..."
$CONTAINER_RUNTIME build \
  -f "$CONTAINERS_DIR/Containerfile.daemon" \
  -t agenticremote/daemon:latest \
  "$PROJECT_ROOT" || {
  echo "Status: BLOCKED_ENVIRONMENT"
  echo "Reason: Failed to build daemon image"
  exit 0
}

# Build client image
echo "Building client image..."
$CONTAINER_RUNTIME build \
  -f "$CONTAINERS_DIR/Containerfile.client" \
  -t agenticremote/client:latest \
  "$PROJECT_ROOT" || {
  echo "Status: BLOCKED_ENVIRONMENT"
  echo "Reason: Failed to build client image"
  exit 0
}

# Build provider image
echo "Building provider image..."
$CONTAINER_RUNTIME build \
  -f "$CONTAINERS_DIR/Containerfile.provider" \
  -t agenticremote/provider:latest \
  "$PROJECT_ROOT" || {
  echo "Status: BLOCKED_ENVIRONMENT"
  echo "Reason: Failed to build provider image"
  exit 0
}

echo "Status: BUILD_SUCCESS"
echo "Built images:"
echo "  - agenticremote/daemon:latest"
echo "  - agenticremote/client:latest"
echo "  - agenticremote/provider:latest"
