#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=podman.sh
source "${SCRIPT_DIR}/podman.sh"

echo "=== [agenticRemote E2E Lab] Rootless Podman Topology Teardown ==="

if e2e_podman_timeout 3s --version >/dev/null 2>&1; then
  echo "Stopping and removing containers..."
  e2e_podman_timeout 3s rm -f agenticremote-provider agenticremote-daemon 2>/dev/null || true

  NETWORK_NAME="agent-remote-e2e"
  if e2e_podman_timeout 3s network exists "${NETWORK_NAME}" 2>/dev/null; then
    echo "Cleaning up Podman network: ${NETWORK_NAME}"
    e2e_podman_timeout 3s network rm "${NETWORK_NAME}" 2>/dev/null || true
  fi
fi


rm -f "${LAB_DIR}/.runtime/pairing.json"
WEB_PID_FILE="${LAB_DIR}/.runtime/web-server.pid"
if [[ -f "${WEB_PID_FILE}" ]]; then
  web_pid=$(cat "${WEB_PID_FILE}")
  if kill -0 "${web_pid}" 2>/dev/null; then
    kill "${web_pid}" 2>/dev/null || true
  fi
  rm -f "${WEB_PID_FILE}"
fi

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
