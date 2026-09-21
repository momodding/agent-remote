#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${LAB_DIR}/.." && pwd)"

echo "=== [agenticRemote E2E Lab] Rootless Podman Topology Bringup ==="

# 1. Ensure Podman binary is present
if ! command -v podman >/dev/null 2>&1; then
  echo "[ERROR] Podman container runtime is required for rootless container topology." >&2
  exit 1
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

# 5. Clean up old containers if running
echo "Cleaning up prior containers..."
podman rm -f agenticremote-provider agenticremote-daemon agenticremote-client 2>/dev/null || true

# 6. Start deterministic upstream provider
echo "Starting upstream mock LLM provider container (port 19090)..."
podman run -d \
  --name agenticremote-provider \
  --network agent-remote-e2e \
  -p 19090:19090 \
  localhost/agenticremote/provider:latest

# 7. Start real Go daemon with OMP toolchain
echo "Starting daemon container (HTTPS port 18765, Go 1.26.4, OMP 18.1.22, tmux)..."
podman run -d \
  --name agenticremote-daemon \
  --network agent-remote-e2e \
  -p 18765:18765 \
  -v "${TLS_DIR}:/app/.agenticremote/state/tls:Z" \
  localhost/agenticremote/daemon:latest

# 8. Start Expo web client container
echo "Starting web client container (port 8081)..."
podman run -d \
  --name agenticremote-client \
  --network agent-remote-e2e \
  -p 8081:8081 \
  localhost/agenticremote/client:latest

# 9. Health checks
echo "Waiting for services to become healthy (up to 180s)..."
PROVIDER_HEALTHY=0
DAEMON_HEALTHY=0
CLIENT_HEALTHY=0

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

  # Check Client
  if [[ ${CLIENT_HEALTHY} -eq 0 ]]; then
    CLIENT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8081/" 2>/dev/null || echo "000")
    if [[ "${CLIENT_CODE}" == "200" ]]; then
      echo "  [HEALTHY] Web client on http://127.0.0.1:8081"
      CLIENT_HEALTHY=1
    fi
  fi

  if [[ ${PROVIDER_HEALTHY} -eq 1 && ${DAEMON_HEALTHY} -eq 1 && ${CLIENT_HEALTHY} -eq 1 ]]; then
    break
  fi

  sleep 1
done

if [[ ${PROVIDER_HEALTHY} -eq 0 || ${DAEMON_HEALTHY} -eq 0 || ${CLIENT_HEALTHY} -eq 0 ]]; then
  echo "[ERROR] Service health checks timed out:" >&2
  echo "  Provider: ${PROVIDER_HEALTHY}" >&2
  echo "  Daemon:   ${DAEMON_HEALTHY}" >&2
  echo "  Client:   ${CLIENT_HEALTHY}" >&2
  echo "--- Provider Logs ---" >&2
  podman logs agenticremote-provider 2>&1 | tail -n 20 >&2 || true
  echo "--- Daemon Logs ---" >&2
  podman logs agenticremote-daemon 2>&1 | tail -n 20 >&2 || true
  echo "--- Client Logs ---" >&2
  podman logs agenticremote-client 2>&1 | tail -n 20 >&2 || true
  exit 1
fi

# 10. Extract real temporary pairing payload from daemon logs
PAIRING_JSON=$(podman logs agenticremote-daemon 2>&1 | grep -E '^{"v":2,' | tail -n 1 || true)
if [[ -n "${PAIRING_JSON}" ]]; then
  mkdir -p "${RUNTIME_DIR}"
  echo "${PAIRING_JSON}" > "${RUNTIME_DIR}/pairing.json"
  chmod 0600 "${RUNTIME_DIR}/pairing.json"
  echo "Real daemon pairing payload saved to ${RUNTIME_DIR}/pairing.json (mode 0600)"
else
  echo "Warning: Could not extract pairing payload from daemon logs." >&2
fi

# 11. Ensure test files exist in daemon workspace
podman exec agenticremote-daemon bash -c "echo 'Hello from sample.txt in project1' > /app/workspace/sample.txt && mkdir -p /app/workspace/project1 && echo 'Hello from sample.txt in project1' > /app/workspace/project1/sample.txt" || true

echo "=== Podman Topology Started Successfully ==="
