#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${LAB_DIR}/.." && pwd)"
RUNTIME_DIR="${LAB_DIR}/.runtime"
TLS_DIR="${RUNTIME_DIR}/tls"
LOGS_DIR="${RUNTIME_DIR}/logs"
WEB_PORT="${CLIENT_WEB_PORT:-8081}"
WEB_PID_FILE="${RUNTIME_DIR}/web-server.pid"
COMPOSE=("${SCRIPT_DIR}/compose.sh")

is_lab_web_server() {
  local pid="$1" cmdline
  [[ "${pid}" =~ ^[0-9]+$ && -r "/proc/${pid}/cmdline" ]] || return 1
  cmdline="$(tr '\0' ' ' <"/proc/${pid}/cmdline")"
  [[ "${cmdline}" == *"${LAB_DIR}/web/static-server.ts"* ]]
}

listener_details() {
  ss -ltnp "sport = :${WEB_PORT}" 2>&1 || ss -ltn "sport = :${WEB_PORT}" 2>&1
}

stop_web_server() {
  [[ -f "${WEB_PID_FILE}" ]] || return

  local web_pid
  web_pid="$(<"${WEB_PID_FILE}")"
  if kill -0 "${web_pid}" 2>/dev/null && is_lab_web_server "${web_pid}"; then
    kill -TERM "${web_pid}" 2>/dev/null || true
  fi
  rm -f "${WEB_PID_FILE}"
}

stop_web_port_listener() {
  local listener pids pid attempt
  listener="$(ss -ltnH "sport = :${WEB_PORT}")"
  [[ -z "${listener}" ]] && return

  pids="$(fuser -n tcp "${WEB_PORT}" 2>/dev/null || true)"
  for pid in ${pids}; do
    if ! is_lab_web_server "${pid}"; then
      printf 'Refusing to terminate non-lab listener on TCP port %s:\n%s\n' "${WEB_PORT}" "$(listener_details)" >&2
      return 1
    fi
  done
  [[ -n "${pids}" ]] || {
    printf 'Unable to identify listener on TCP port %s:\n%s\n' "${WEB_PORT}" "$(listener_details)" >&2
    return 1
  }

  printf 'Stopping stale lab web server on TCP port %s.\n' "${WEB_PORT}" >&2
  for pid in ${pids}; do kill -TERM "${pid}"; done
  for attempt in {1..5}; do
    sleep 1
    listener="$(ss -ltnH "sport = :${WEB_PORT}")"
    [[ -z "${listener}" ]] && return
  done

  pids="$(fuser -n tcp "${WEB_PORT}" 2>/dev/null || true)"
  for pid in ${pids}; do
    if ! is_lab_web_server "${pid}"; then
      printf 'Refusing to kill non-lab listener on TCP port %s:\n%s\n' "${WEB_PORT}" "$(listener_details)" >&2
      return 1
    fi
  done
  [[ -n "${pids}" ]] || {
    printf 'Unable to identify listener on TCP port %s:\n%s\n' "${WEB_PORT}" "$(listener_details)" >&2
    return 1
  }
  for pid in ${pids}; do kill -KILL "${pid}"; done
  sleep 1
  listener="$(ss -ltnH "sport = :${WEB_PORT}")"
  [[ -z "${listener}" ]] || {
    printf 'Unable to clear TCP port %s before starting the web server:\n%s\n' "${WEB_PORT}" "$(listener_details)" >&2
    return 1
  }
}

wait_for_http() {
  local name="$1" url="$2" deadline=$((SECONDS + 180))
  until curl --fail --silent --show-error --insecure "${url}" >/dev/null; do
    (( SECONDS < deadline )) || {
      "${COMPOSE[@]}" logs "${name}" || true
      printf '%s health check timed out: %s\n' "${name}" "${url}" >&2
      exit 1
    }
    sleep 1
  done
}

printf '%s\n' '=== [agenticRemote E2E Lab] Rootful Podman Compose Bringup ==='
mkdir -p "${TLS_DIR}" "${LOGS_DIR}"
if [[ ! -f "${TLS_DIR}/cert.pem" || ! -f "${TLS_DIR}/key.pem" ]]; then
  "${SCRIPT_DIR}/generate-runtime-tls.sh" "${TLS_DIR}"
fi

stop_web_server
stop_web_port_listener
"${COMPOSE[@]}" up --detach --build --remove-orphans provider daemon

wait_for_http provider http://127.0.0.1:19090/health
wait_for_http daemon https://127.0.0.1:18765/healthz

(cd "${ROOT_DIR}/client" && EXPO_PUBLIC_API_URL="https://127.0.0.1:18765" bun run build:web)
CLIENT_WEB_PORT="${WEB_PORT}" bun "${LAB_DIR}/web/static-server.ts" >"${LOGS_DIR}/web-server.log" 2>&1 &
echo "$!" >"${WEB_PID_FILE}"
web_deadline=$((SECONDS + 180))
until curl --fail --silent --show-error "http://127.0.0.1:${WEB_PORT}/" >/dev/null; do
  (( SECONDS < web_deadline )) || { tail -n 20 "${LOGS_DIR}/web-server.log" >&2 || true; exit 1; }
  sleep 1
done

printf '%s\n' 'Provider and daemon are healthy. Android will be brought up by android-runner.'
"${COMPOSE[@]}" exec --no-TTY daemon bash -c "echo 'Hello from sample.txt in project1' > /app/workspace/sample.txt && mkdir -p /app/workspace/project1 && echo 'Hello from sample.txt in project1' > /app/workspace/project1/sample.txt"
printf '%s\n' 'Provider, daemon, and web client are healthy. Android is not ready until verify-android-emulator-only.sh passes its ADB boot gate.'
