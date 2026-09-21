#!/usr/bin/env bash
set -euo pipefail

echo "=== [agenticRemote E2E Lab] Rootless Podman Topology Teardown ==="

if ! command -v podman >/dev/null 2>&1; then
  echo "Podman not found; skipping container teardown."
  exit 0
fi

echo "Stopping and removing containers..."
podman rm -f agenticremote-provider agenticremote-daemon agenticremote-client 2>/dev/null || true

NETWORK_NAME="agent-remote-e2e"
if podman network exists "${NETWORK_NAME}" 2>/dev/null; then
  echo "Cleaning up Podman network: ${NETWORK_NAME}"
  podman network rm "${NETWORK_NAME}" 2>/dev/null || true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
rm -f "${LAB_DIR}/.runtime/pairing.json"

# Clean up test-spawned OMP, daemon, bridge, and test tmux processes
test_pids=$(ps -eo pid,args | grep -E '(/tmp/Test|\.agenticremote|e2e-lab|\.runtime)' | grep -E 'omp|agenticRemote|tmux|agenticremote|bridge' | grep -v grep | awk '{print $1}' || true)
if [[ -n "${test_pids}" ]]; then
  echo "Cleaning up lingering test PIDs: ${test_pids}"
  kill -9 ${test_pids} 2>/dev/null || true
fi
# Clean up test-created tmux sessions
if command -v tmux >/dev/null 2>&1; then
  tmux_sessions=$(tmux list-sessions -F "#{session_name}" 2>/dev/null | grep -E '^agent_|^TestOMP_|^TestGoldenFlow_' || true)
  if [[ -n "${tmux_sessions}" ]]; then
    for s in ${tmux_sessions}; do
      tmux kill-session -t "$s" 2>/dev/null || true
    done
  fi
fi

echo "Status: Teardown complete. All lab containers, networks, and test processes released."
