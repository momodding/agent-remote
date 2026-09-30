#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WEB_PID_FILE="${LAB_DIR}/.runtime/web-server.pid"

"${SCRIPT_DIR}/compose.sh" down --remove-orphans
if [[ -f "${WEB_PID_FILE}" ]]; then
  web_pid="$(<"${WEB_PID_FILE}")"
  if kill -0 "${web_pid}" 2>/dev/null; then
    kill "${web_pid}" 2>/dev/null || true
  fi
  rm -f "${WEB_PID_FILE}"
fi
printf '%s\n' 'Status: rootful Compose project stopped; disposable volumes retained.'
