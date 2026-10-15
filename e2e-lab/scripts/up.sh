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
DAEMON_FORWARD_PORT="${E2E_DAEMON_FORWARD_PORT:-18766}"
DAEMON_FORWARD_PID_FILE="${RUNTIME_DIR}/daemon-forwarder.pid"
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
  [[ -f "${WEB_PID_FILE}" ]] || return 0

  local web_pid
  web_pid="$(<"${WEB_PID_FILE}")"
  if kill -0 "${web_pid}" 2>/dev/null && is_lab_web_server "${web_pid}"; then
    kill -TERM "${web_pid}" 2>/dev/null || true
  fi
  rm -f "${WEB_PID_FILE}"
}

is_lab_daemon_forwarder() {
  local pid="$1" cmdline
  [[ "${pid}" =~ ^[0-9]+$ && -r "/proc/${pid}/cmdline" ]] || return 1
  cmdline="$(tr '\0' ' ' <"/proc/${pid}/cmdline")"
  [[ "${cmdline}" == *"${LAB_DIR}/web/tcp-forwarder.ts"* ]]
}

daemon_forwarder_listener_details() {
  ss -ltnp "sport = :${DAEMON_FORWARD_PORT}" 2>&1 || ss -ltn "sport = :${DAEMON_FORWARD_PORT}" 2>&1
}

stop_daemon_forwarder() {
  [[ -f "${DAEMON_FORWARD_PID_FILE}" ]] || return 0

  local forwarder_pid
  forwarder_pid="$(<"${DAEMON_FORWARD_PID_FILE}")"
  if kill -0 "${forwarder_pid}" 2>/dev/null && is_lab_daemon_forwarder "${forwarder_pid}"; then
    kill -TERM "${forwarder_pid}" 2>/dev/null || true
  fi
  rm -f "${DAEMON_FORWARD_PID_FILE}"
}

stop_daemon_forwarder_port_listener() {
  local listener pids pid attempt
  listener="$(ss -ltnH "sport = :${DAEMON_FORWARD_PORT}")"
  [[ -z "${listener}" ]] && return

  pids="$(fuser -n tcp "${DAEMON_FORWARD_PORT}" 2>/dev/null || true)"
  for pid in ${pids}; do
    if ! is_lab_daemon_forwarder "${pid}"; then
      printf 'Refusing to terminate non-lab listener on TCP port %s:\n%s\n' "${DAEMON_FORWARD_PORT}" "$(daemon_forwarder_listener_details)" >&2
      return 1
    fi
  done
  if [[ -z "${pids}" ]]; then
    for attempt in {1..5}; do
      sleep 1
      listener="$(ss -ltnH "sport = :${DAEMON_FORWARD_PORT}")"
      [[ -z "${listener}" ]] && return
    done
    printf 'Unable to identify daemon forwarder on TCP port %s:\n%s\n' "${DAEMON_FORWARD_PORT}" "$(daemon_forwarder_listener_details)" >&2
    return 1
  fi
  for pid in ${pids}; do kill -TERM "${pid}"; done
  for attempt in {1..5}; do
    sleep 1
    listener="$(ss -ltnH "sport = :${DAEMON_FORWARD_PORT}")"
    [[ -z "${listener}" ]] && return
  done
  for pid in ${pids}; do kill -KILL "${pid}" 2>/dev/null || true; done
  sleep 1
  listener="$(ss -ltnH "sport = :${DAEMON_FORWARD_PORT}")"
  [[ -z "${listener}" ]] || {
    printf 'Unable to clear TCP port %s before starting daemon forwarder:\n%s\n' "${DAEMON_FORWARD_PORT}" "$(daemon_forwarder_listener_details)" >&2
    return 1
  }
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

bridge_ipv4() {
  local service="$1" addresses ip octet
  addresses="$("${COMPOSE[@]}" exec -T "${service}" sh -c 'hostname -i')"
  for ip in ${addresses}; do
    [[ "${ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || continue
    for octet in ${ip//./ }; do
      (( 10#${octet} <= 255 )) || continue 2
    done
    printf '%s\n' "${ip}"
    return 0
  done
  printf 'Unable to determine %s bridge IPv4 address: %s\n' "${service}" "${addresses}" >&2
  return 1
}

daemon_bridge_ipv4() {
  bridge_ipv4 daemon
}

provider_bridge_ipv4() {
  bridge_ipv4 provider
}

redact_failed_stack_logs() {
  sed -E \
    -e 's/([Aa]uthorization[[:space:]]*:[[:space:]]*)[^[:space:],}]+([[:space:]]+[^[:space:],}]+)?/\1[REDACTED]/g' \
    -e 's/([Bb]earer[[:space:]]+)[^[:space:],}]+/\1[REDACTED]/g' \
    -e 's/(([[:alnum:]_-]*(token|secret|password|api[-_]?key)[[:alnum:]_-]*)[[:space:]]*[=:][[:space:]]*)[^[:space:],}]+/\1[REDACTED]/Ig'
}

retain_failed_stack() {
  local exit_code=$? diagnostic_path
  if (( exit_code != 0 )) && [[ "${E2E_KEEP_FAILED_STACK:-0}" == "1" ]]; then
    mkdir -p "${LOGS_DIR}"
    diagnostic_path="${LOGS_DIR}/failed-up-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
    {
      printf 'E2E failed up stack status\n'
      printf 'DAEMON_URL=%s\n' "${DAEMON_URL:-unresolved}"
      printf '\n=== compose ps --all ===\n'
      "${COMPOSE[@]}" ps --all || true
      printf '\n=== provider and daemon logs (last 200 lines, redacted) ===\n'
      ("${COMPOSE[@]}" logs --tail 200 provider daemon 2>&1 || true) | redact_failed_stack_logs
    } >"${diagnostic_path}"
    printf 'E2E stack retained after failed up.sh; diagnostics: %s\n' "${diagnostic_path}" >&2
  fi
  exit "${exit_code}"
}
trap retain_failed_stack EXIT

printf '%s\n' '=== [agenticRemote E2E Lab] Rootful Podman Compose Bringup ==='
mkdir -p "${TLS_DIR}" "${LOGS_DIR}"
if [[ ! -f "${TLS_DIR}/cert.pem" || ! -f "${TLS_DIR}/key.pem" ]]; then
  "${SCRIPT_DIR}/generate-runtime-tls.sh" "${TLS_DIR}"
fi

stop_web_server
stop_web_port_listener
stop_daemon_forwarder
stop_daemon_forwarder_port_listener
# Aardvark DNS can be unavailable even when Podman advertises service aliases.
# Start provider first, derive its current private bridge address, then inject
# that address only into daemon's internal provider URL. This keeps provider
# un-published and avoids stale addresses across network recreation.
# Timeout compose up to prevent indefinite hangs on slow builds.
COMPOSE_TIMEOUT="${E2E_COMPOSE_TIMEOUT:-900}"
timeout "${COMPOSE_TIMEOUT}" "${COMPOSE[@]}" up --detach --build --remove-orphans provider || {
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 124 ]; then
    printf 'ERROR: provider startup timed out after %s seconds. Increase E2E_COMPOSE_TIMEOUT or check build performance.\n' "${COMPOSE_TIMEOUT}" >&2
  fi
  exit $EXIT_CODE
}
provider_ip="$(provider_bridge_ipv4)"
E2E_PROVIDER_IPV4="${provider_ip}" timeout "${COMPOSE_TIMEOUT}" "${COMPOSE[@]}" up --detach --build --remove-orphans --no-deps daemon || {
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 124 ]; then
    printf 'ERROR: daemon startup timed out after %s seconds. Increase E2E_COMPOSE_TIMEOUT or check build performance.\n' "${COMPOSE_TIMEOUT}" >&2
  fi
  exit $EXIT_CODE
}

daemon_ip="$(daemon_bridge_ipv4)"
DAEMON_URL="https://${daemon_ip}:18765"
wait_for_http daemon "${DAEMON_URL}/healthz"

# Host Chromium cannot route to Podman's private bridge. Forward its loopback
# traffic to the dynamically discovered daemon address without terminating TLS.
DAEMON_FORWARD_URL="https://127.0.0.1:${DAEMON_FORWARD_PORT}"
DAEMON_FORWARD_HOST="${daemon_ip}" DAEMON_FORWARD_PORT="${DAEMON_FORWARD_PORT}" bun "${LAB_DIR}/web/tcp-forwarder.ts" >"${LOGS_DIR}/daemon-forwarder.log" 2>&1 &
daemon_forwarder_pid=$!
echo "${daemon_forwarder_pid}" >"${DAEMON_FORWARD_PID_FILE}"
wait_for_http daemon "${DAEMON_FORWARD_URL}/healthz"
CLIENT_DAEMON_URL="${DAEMON_FORWARD_URL}"
(cd "${ROOT_DIR}/client" && EXPO_PUBLIC_API_URL="${CLIENT_DAEMON_URL}" bun run build:web)
# Start web server and wait for listening port
CLIENT_WEB_PORT="${WEB_PORT}" bun "${LAB_DIR}/web/static-server.ts" >"${LOGS_DIR}/web-server.log" 2>&1 &
web_pid=$!
echo "${web_pid}" >"${WEB_PID_FILE}"

# Wait for port to become available (server must bind before returning)
web_deadline=$((SECONDS + 30))
while (( SECONDS < web_deadline )); do
  if ss -ltnH "sport = :${WEB_PORT}" 2>/dev/null | grep -q LISTEN; then
    break
  fi
  if ! kill -0 "${web_pid}" 2>/dev/null; then
    printf 'Web server process %d exited before binding port %s\n' "${web_pid}" "${WEB_PORT}" >&2
    tail -n 20 "${LOGS_DIR}/web-server.log" >&2 || true
    exit 1
  fi
  sleep 0.1
done

# Verify port is listening
if ! ss -ltnH "sport = :${WEB_PORT}" 2>/dev/null | grep -q LISTEN; then
  printf 'Web server failed to bind port %s within 30s\n' "${WEB_PORT}" >&2
  tail -n 20 "${LOGS_DIR}/web-server.log" >&2 || true
  exit 1
fi
# Bun's launcher can fork before the server binds. Record the listener owner so
# subsequent health checks verify the process that serves the browser.
web_pids="$(fuser -n tcp "${WEB_PORT}" 2>/dev/null || true)"
[[ -n "${web_pids}" ]] || {
  printf 'Unable to identify web server process on TCP port %s\n' "${WEB_PORT}" >&2
  exit 1
}
for listener_pid in ${web_pids}; do
  if ! is_lab_web_server "${listener_pid}"; then
    printf 'Web port %s is owned by a non-lab process:\n%s\n' "${WEB_PORT}" "$(listener_details)" >&2
    exit 1
  fi
  web_pid="${listener_pid}"
done
printf '%s\n' "${web_pid}" >"${WEB_PID_FILE}"

# Verify the complete consumer path rather than merely a bound socket or HTTP
# status. This includes process liveness, HTML and bundle delivery, plus a real
# Chromium page.goto with rendered application content.
web_deadline=$((SECONDS + 60))
until WEB_PID="${web_pid}" CLIENT_WEB_PORT="${WEB_PORT}" "${SCRIPT_DIR}/web-health-probe.sh"; do
  (( SECONDS < web_deadline )) || {
    printf 'Web consumer-path health check timed out on http://127.0.0.1:%s/\n' "${WEB_PORT}" >&2
    tail -n 20 "${LOGS_DIR}/web-server.log" >&2 || true
    exit 1
  }
  sleep 1
done

printf '%s\n' 'Provider and daemon are healthy. Android will be brought up by android-runner.'
"${COMPOSE[@]}" exec --no-TTY daemon bash -c "echo 'Hello from sample.txt in project1' > /app/workspace/sample.txt && mkdir -p /app/workspace/project1 && echo 'Hello from sample.txt in project1' > /app/workspace/project1/sample.txt"
printf '%s\n' 'Provider, daemon, and web client are healthy. Android is not ready until verify-android-emulator-only.sh passes its ADB boot gate.'
