#!/usr/bin/env bash
# Minimal test: verify web server starts and responds on configured port
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

echo "Starting web server on port ${WEB_PORT}..."
mkdir -p "${LOGS_DIR}"

# Start server
CLIENT_WEB_PORT="${WEB_PORT}" bun "${LAB_DIR}/web/static-server.ts" >"${LOGS_DIR}/web-server.log" 2>&1 &
web_pid=$!
echo "${web_pid}" >"${WEB_PID_FILE}"
echo "Web server PID: ${web_pid}"

# Wait for port binding (30s timeout)
echo "Waiting for port ${WEB_PORT} to be listening..."
start=$SECONDS
while (( SECONDS - start < 30 )); do
  if ss -ltnH "sport = :${WEB_PORT}" 2>/dev/null | grep -q LISTEN; then
    echo "✓ Port ${WEB_PORT} is listening"
    break
  fi
  if ! kill -0 "${web_pid}" 2>/dev/null; then
    echo "✗ Web server process died before binding port"
    tail -n 20 "${LOGS_DIR}/web-server.log"
    exit 1
  fi
  sleep 0.1
done

if ! ss -ltnH "sport = :${WEB_PORT}" 2>/dev/null | grep -q LISTEN; then
  echo "✗ Port ${WEB_PORT} never became available"
  tail -n 20 "${LOGS_DIR}/web-server.log"
  exit 1
fi

# HTTP health check (60s timeout)
echo "Checking HTTP health on http://127.0.0.1:${WEB_PORT}/..."
start=$SECONDS
while (( SECONDS - start < 60 )); do
  if curl --fail --silent --show-error "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1; then
    echo "✓ HTTP endpoint responded successfully"
    exit 0
  fi
  sleep 1
done

echo "✗ HTTP health check timed out"
tail -n 20 "${LOGS_DIR}/web-server.log"
exit 1
