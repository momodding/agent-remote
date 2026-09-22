#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${LAB_DIR}/.." && pwd)"
# shellcheck source=podman.sh
source "${SCRIPT_DIR}/podman.sh"

echo "=== [agenticRemote E2E Lab] Rootless Podman Image Builder ==="

e2e_podman --version >/dev/null

# Source pinned versions
if [ -f "${LAB_DIR}/env/versions.env" ]; then
  # shellcheck source=/dev/null
  source "${LAB_DIR}/env/versions.env"
fi

echo "1. Building deterministic upstream provider image with Podman..."
e2e_podman build -t agenticremote/provider:latest -f "${LAB_DIR}/containers/Containerfile.provider" "${ROOT_DIR}"

echo "2. Building real daemon image (Go ${GO_VERSION:-1.26.4}, @oh-my-pi/pi-coding-agent@${OMP_VERSION:-18.1.22}, tmux)..."
e2e_podman build -t agenticremote/daemon:latest -f "${LAB_DIR}/containers/Containerfile.daemon" "${ROOT_DIR}"


echo "=== All Podman Container Images Built Successfully ==="
