#!/usr/bin/env bash
# Test: verify up.sh web server startup logic works
# Simulates lines 106-143 of up.sh without full compose bringup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${LAB_DIR}/.." && pwd)"
RUNTIME_DIR="${LAB_DIR}/.runtime"
LOGS_DIR="${RUNTIME_DIR}/logs"
WEB_PORT="${CLIENT_WEB_PORT:-8081}"
WEB_PID_FILE="${RUNTIME_DIR}/web-server.pid"

cleanup() {
  local pid
  if [[ -f "${WEB_PID_FILE}" ]]; then
    pid="$(<"${WEB_PID_FILE}")"
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
      sleep 1
      kill -9 "${pid}" 2>/dev/null || true
    fi
    rm -f "${WEB_PID_FILE}"
  fi
}
trap cleanup EXIT

mkdir -p "${LOGS_DIR}"
echo "Testing up.sh web startup sequence (lines 106-143)..."

# Line 106: Build web export (simulated - assume dist already exists)
if [[ ! -d "${ROOT_DIR}/client/dist" ]]; then
  echo "✗ Missing client/dist - run 'cd client && bun run build:web' first"
  exit 1
fi
echo "✓ Web export exists"

# Lines 107-108: Start web server and save PID
echo "Starting web server..."
CLIENT_WEB_PORT="${WEB_PORT}" bun "${LAB_DIR}/web/static-server.ts" >"${LOGS_DIR}/web-server.log" 2>&1 &
web_pid=$!
echo "${web_pid}" >"${WEB_PID_FILE}"

# Lines 112-124: Wait for port to become available
web_deadline=$((SECONDS + 30))
while (( SECONDS < web_deadline )); do
  if ss -ltnH "sport = :${WEB_PORT}" 2>/dev/null | grep -q LISTEN; then
    break
  fi
  if ! kill -0 "${web_pid}" 2>/dev/null; then
    printf '✗ Web server process %d exited before binding port %s\n' "${web_pid}" "${WEB_PORT}" >&2
    tail -n 20 "${LOGS_DIR}/web-server.log" >&2 || true
    exit 1
  fi
  sleep 0.1
done

# Lines 127-132: Verify port is listening
if ! ss -ltnH "sport = :${WEB_PORT}" 2>/dev/null | grep -q LISTEN; then
  printf '✗ Web server failed to bind port %s within 30s\n' "${WEB_PORT}" >&2
  tail -n 20 "${LOGS_DIR}/web-server.log" >&2 || true
  exit 1
fi
echo "✓ Port ${WEB_PORT} is listening"

# Lines 134-143: Verify HTTP works
web_deadline=$((SECONDS + 60))
until curl --fail --silent --show-error "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; do
  (( SECONDS < web_deadline )) || { 
    printf '✗ HTTP health check timed out on http://127.0.0.1:%s/\n' "${WEB_PORT}" >&2
    tail -n 20 "${LOGS_DIR}/web-server.log" >&2 || true
    exit 1
  }
  sleep 1
done
echo "✓ HTTP endpoint is responding"

echo "✓ All web startup checks passed"
