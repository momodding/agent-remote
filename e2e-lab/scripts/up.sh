#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${LAB_DIR}/.." && pwd)"
# shellcheck source=podman.sh
source "${SCRIPT_DIR}/podman.sh"

echo "=== [agenticRemote E2E Lab] Rootless Podman Topology Bringup ==="

e2e_podman --version >/dev/null

# The web topology owns these two local images. Build them only when absent;
# this avoids a registry pull and leaves already-built images untouched.
if ! e2e_podman image exists localhost/agenticremote/provider:latest || ! e2e_podman image exists localhost/agenticremote/daemon:latest; then
  echo "Building missing local E2E provider/daemon images..."
  "${SCRIPT_DIR}/build-images.sh"
fi

# 2. Setup runtime directories
RUNTIME_DIR="${LAB_DIR}/.runtime"
TLS_DIR="${RUNTIME_DIR}/tls"
LOGS_DIR="${RUNTIME_DIR}/logs"
mkdir -p "${TLS_DIR}" "${LOGS_DIR}" "${RUNTIME_DIR}/daemon-state" "${RUNTIME_DIR}/workspace"

# 3. Generate TLS certificates if missing
if [[ ! -f "${TLS_DIR}/cert.pem" || ! -f "${TLS_DIR}/key.pem" ]]; then
  echo "Generating runtime TLS certificates..."
  "${SCRIPT_DIR}/generate-runtime-tls.sh" "${TLS_DIR}"
fi

# 4. Ensure network exists
"${LAB_DIR}/containers/podman-network.sh"

echo "Cleaning up prior containers and exported web server..."
e2e_podman rm -f agenticremote-provider agenticremote-daemon 2>/dev/null || true
WEB_PID_FILE="${RUNTIME_DIR}/web-server.pid"
if [[ -f "${WEB_PID_FILE}" ]]; then
  web_pid=$(cat "${WEB_PID_FILE}")
  if kill -0 "${web_pid}" 2>/dev/null; then
    kill "${web_pid}" 2>/dev/null || true
  fi
  rm -f "${WEB_PID_FILE}"
fi

# 6. Start deterministic upstream provider
echo "Starting upstream mock LLM provider container (port 19090)..."
e2e_podman run -d \
  --name agenticremote-provider \
  --label agenticremote.e2e=true \
  --network agent-remote-e2e \
  --network-alias agenticremote-provider \
  -p 19090:19090 \
  localhost/agenticremote/provider:latest
provider_ip="$(e2e_podman inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' agenticremote-provider)"
if [[ -z "${provider_ip}" ]]; then
  echo "Provider container has no E2E network address." >&2
  exit 1
fi

# 7. Start real Go daemon with OMP toolchain
echo "Starting daemon container (HTTPS port 18765, Go 1.26.4, OMP 18.1.22, tmux)..."
  # Fresh E2E state has no interactive OMP setup; skip it so the real bridge can reach session_start.
e2e_podman run -d \
  --name agenticremote-daemon \
  --label agenticremote.e2e=true \
  --network agent-remote-e2e \
  --add-host "agenticremote-provider:${provider_ip}" \
  -p 18765:18765 \
  -e OMP_SKIP_SETUP=1 \
  -v "${TLS_DIR}:/app/.agenticremote/state/tls:Z" \
  localhost/agenticremote/daemon:latest

# 8. Export and serve the canonical client web build
echo "Exporting canonical Expo web client to client/dist (port 8081)..."
(cd "${ROOT_DIR}/client" && EXPO_PUBLIC_API_URL="https://127.0.0.1:18765" bun run build:web)
CLIENT_WEB_PORT=8081 bun "${LAB_DIR}/web/static-server.ts" >"${LOGS_DIR}/web-server.log" 2>&1 &
echo $! > "${WEB_PID_FILE}"

# 9. Health checks
echo "Waiting for services to become healthy (up to 180s)..."
PROVIDER_HEALTHY=0
DAEMON_HEALTHY=0
WEB_HEALTHY=0

for i in $(seq 1 180); do
  # Check Provider
  if [[ ${PROVIDER_HEALTHY} -eq 0 ]]; then
    if curl -s -f "http://127.0.0.1:19090/health" >/dev/null 2>&1 || curl -s "http://127.0.0.1:19090/v1/models" | grep -q "model" 2>/dev/null; then
      echo "  [HEALTHY] Provider server on http://127.0.0.1:19090"
      PROVIDER_HEALTHY=1
    fi
  fi

  # Check Daemon HTTPS
  if [[ ${DAEMON_HEALTHY} -eq 0 ]]; then
    DAEMON_CODE=$(curl -k -s -o /dev/null -w "%{http_code}" "https://127.0.0.1:18765/" 2>/dev/null || echo "000")
    if [[ "${DAEMON_CODE}" != "000" && "${DAEMON_CODE}" != "" ]]; then
      echo "  [HEALTHY] Daemon server (HTTPS ${DAEMON_CODE}) on https://127.0.0.1:18765"
      DAEMON_HEALTHY=1
    fi
  fi

  # Check exported web client
  if [[ ${WEB_HEALTHY} -eq 0 ]]; then
    WEB_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8081/" 2>/dev/null || echo "000")
    if [[ "${WEB_CODE}" == "200" ]]; then
      echo "  [HEALTHY] Exported web client on http://127.0.0.1:8081"
      WEB_HEALTHY=1
    fi
  fi

  if [[ ${PROVIDER_HEALTHY} -eq 1 && ${DAEMON_HEALTHY} -eq 1 && ${WEB_HEALTHY} -eq 1 ]]; then
    break
  fi

  sleep 1
done

if [[ ${PROVIDER_HEALTHY} -eq 0 || ${DAEMON_HEALTHY} -eq 0 || ${WEB_HEALTHY} -eq 0 ]]; then
  echo "[ERROR] Service health checks timed out:" >&2
  echo "  Provider: ${PROVIDER_HEALTHY}" >&2
  echo "  Daemon:   ${DAEMON_HEALTHY}" >&2
  echo "  Web:      ${WEB_HEALTHY}" >&2
  echo "--- Provider Logs ---" >&2
  e2e_podman logs agenticremote-provider 2>&1 | tail -n 20 >&2 || true
  echo "--- Daemon Logs ---" >&2
  e2e_podman logs agenticremote-daemon 2>&1 | tail -n 20 >&2 || true
  echo "--- Web Logs ---" >&2
  tail -n 20 "${LOGS_DIR}/web-server.log" >&2 || true
  exit 1
fi

# 10. Extract real temporary pairing payload from daemon logs
PAIRING_JSON=$(e2e_podman logs agenticremote-daemon 2>&1 | grep -E '^{"v":2,' | tail -n 1 || true)
if [[ -n "${PAIRING_JSON}" ]]; then
  mkdir -p "${RUNTIME_DIR}"
  echo "${PAIRING_JSON}" > "${RUNTIME_DIR}/pairing.json"
  chmod 0600 "${RUNTIME_DIR}/pairing.json"
  echo "Real daemon pairing payload saved to ${RUNTIME_DIR}/pairing.json (mode 0600)"
else
  echo "Warning: Could not extract pairing payload from daemon logs." >&2
fi

# 11. Ensure test files exist in daemon workspace
e2e_podman exec agenticremote-daemon bash -c "echo 'Hello from sample.txt in project1' > /app/workspace/sample.txt && mkdir -p /app/workspace/project1 && echo 'Hello from sample.txt in project1' > /app/workspace/project1/sample.txt" || true

echo "=== Podman Topology Started Successfully ==="
