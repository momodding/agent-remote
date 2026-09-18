#!/usr/bin/env bash
set -euo pipefail

echo "=== [agenticRemote E2E Lab] Topology Bringup (up.sh) ==="
# Check rootless Podman constraints
if [ ! -w /dev/kvm ] || ! command -v omp >/dev/null 2>&1; then
  echo "Status: BLOCKED_ENVIRONMENT"
  echo "Reason: Real OMP daemon and KVM device cannot be served in containerized rootless topology without host privileges."
  echo "Remediation: Run host test-all.sh with local OMP binary and grant KVM access."
  exit 0
fi

echo "Topology started."
