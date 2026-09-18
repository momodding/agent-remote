#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${LAB_DIR}/.." && pwd)"

echo "=== [agenticRemote E2E Lab] Rootless Podman Image Builder ==="

if ! command -v podman >/dev/null 2>&1; then
  echo "[ERROR] Podman container runtime is required but not installed on PATH." >&2
  exit 1
fi

# Source pinned versions
if [ -f "${LAB_DIR}/env/versions.env" ]; then
  # shellcheck source=/dev/null
  source "${LAB_DIR}/env/versions.env"
fi

echo "1. Building deterministic upstream provider image with Podman..."
podman build -t agenticremote/provider:latest -f "${LAB_DIR}/containers/Containerfile.provider" "${ROOT_DIR}"

echo "2. Building real daemon image (Go ${GO_VERSION:-1.26.4}, @oh-my-pi/pi-coding-agent@${OMP_VERSION:-18.1.22}, tmux)..."
podman build -t agenticremote/daemon:latest -f "${LAB_DIR}/containers/Containerfile.daemon" "${ROOT_DIR}"

echo "3. Building Expo web client image with Podman..."
podman build -t agenticremote/client:latest -f "${LAB_DIR}/containers/Containerfile.client" "${ROOT_DIR}"

echo "=== All Podman Container Images Built Successfully ==="
