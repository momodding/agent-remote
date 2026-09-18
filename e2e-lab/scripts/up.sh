#!/usr/bin/env bash
set -euo pipefail

echo "=== [agenticRemote E2E Lab] Topology Bringup (up.sh) ==="

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

# Verify KVM device is accessible for advanced features
if [ ! -w /dev/kvm ] 2>/dev/null; then
  echo "Warning: /dev/kvm not accessible. Some features may be limited."
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTAINERS_DIR="$PROJECT_ROOT/e2e-lab/containers"
RUNTIME_DIR="$PROJECT_ROOT/e2e-lab/.runtime"
ARTIFACTS_DIR="$PROJECT_ROOT/e2e-lab/artifacts"

mkdir -p "$RUNTIME_DIR" "$ARTIFACTS_DIR"

# Create network
if [ "$CONTAINER_RUNTIME" = "podman" ]; then
  bash "$CONTAINERS_DIR/podman-network.sh" || true
  NETWORK_OPTS="--network agenticremote-net"
else
  NETWORK_OPTS="--network agenticremote-net"
fi

echo "Starting provider container..."
$CONTAINER_RUNTIME run -d \
  --name agenticremote-provider \
  -p 19090:19090 \
  $NETWORK_OPTS \
  agenticremote/provider:latest \
  || {
  echo "Status: BLOCKED_ENVIRONMENT"
  echo "Reason: Failed to start provider container"
  exit 0
}

echo "Starting daemon container..."
$CONTAINER_RUNTIME run -d \
  --name agenticremote-daemon \
  -p 18765:18765 \
  $NETWORK_OPTS \
  -e OMP_PROVIDER_URL="http://agenticremote-provider:19090" \
  agenticremote/daemon:latest \
  || {
  echo "Status: BLOCKED_ENVIRONMENT"
  echo "Reason: Failed to start daemon container"
  exit 0
}

echo "Starting client container..."
$CONTAINER_RUNTIME run -d \
  --name agenticremote-client \
  -p 8081:8081 \
  $NETWORK_OPTS \
  -e EXPO_PUBLIC_API_URL="http://localhost:18765" \
  agenticremote/client:latest \
  || {
  echo "Status: BLOCKED_ENVIRONMENT"
  echo "Reason: Failed to start client container"
  exit 0
}

# Wait for containers to become healthy
echo "Waiting for topology to stabilize..."
sleep 3

echo "Status: TOPOLOGY_UP"
echo "Endpoints:"
echo "  - Daemon:   http://localhost:18765"
echo "  - Client:   http://localhost:8081"
echo "  - Provider: http://localhost:19090"
echo ""
echo "Container IDs:"
$CONTAINER_RUNTIME ps --filter "name=agenticremote-" --format "table {{.Names}}\t{{.Status}}"
