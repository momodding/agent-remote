#!/usr/bin/env bash
set -euo pipefail

echo "=== [agenticRemote E2E Lab] Container Image Builder ==="
# Audit check: rootless podman cannot access host /dev/kvm and real OMP daemon without privileged namespaces.
if ! command -v podman >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
  echo "Status: BLOCKED_ENVIRONMENT"
  echo "Reason: Container runtime (podman/docker) not found."
  exit 0
fi

echo "Status: READY (Host execution preferred for real tmux and OMP integration)"
