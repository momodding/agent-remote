#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${LAB_DIR}/.." && pwd)"

echo "=== [agenticRemote E2E Lab] Container Image Builder ==="

RUNTIME=""
if command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
else
  echo "[ERROR] Container runtime (podman/docker) not found in PATH." >&2
  exit 1
fi

echo "Using container runtime: ${RUNTIME}"

# Source pinned versions
if [ -f "${LAB_DIR}/env/versions.env" ]; then
  # shellcheck source=/dev/null
  source "${LAB_DIR}/env/versions.env"
fi

echo "1. Building deterministic upstream provider image..."
${RUNTIME} build -t agenticremote/provider:latest -f "${LAB_DIR}/containers/Containerfile.provider" "${LAB_DIR}/containers/provider"

echo "2. Building daemon image (Go ${GO_VERSION:-1.26.4}, OMP ${OMP_VERSION:-18.1.22}, tmux)..."
${RUNTIME} build -t agenticremote/daemon:latest -f "${LAB_DIR}/containers/Containerfile.daemon" "${ROOT_DIR}"

echo "3. Building web client image..."
${RUNTIME} build -t agenticremote/client:latest -f "${LAB_DIR}/containers/Containerfile.client" "${ROOT_DIR}"

echo "=== All Container Images Built Successfully ==="
