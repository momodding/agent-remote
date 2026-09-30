#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# EXIT trap: collect Compose logs and teardown if E2E_KEEP!=1
cleanup_e2e() {
  local exit_code=$?
  if [[ "${E2E_KEEP:-0}" != "1" ]]; then
    echo "\n=== [EXIT trap: Collect Compose logs] ==="
    "${SCRIPT_DIR}/compose.sh" logs provider || true
    "${SCRIPT_DIR}/compose.sh" logs daemon || true
    "${SCRIPT_DIR}/compose.sh" logs android-emulator || true
    echo "\n=== [EXIT trap: Teardown] ==="
    "${SCRIPT_DIR}/down.sh" || true
  fi
  exit $exit_code
}
trap cleanup_e2e EXIT INT TERM

export PATH="${HOME}/.bun/bin:${HOME}/go/bin:${HOME}/.local/bin:${PATH}"

PHASES=(doctor up backend web android security)

phase_cmd() {
  case "$1" in
    doctor)   "${SCRIPT_DIR}/doctor.sh" ;;
    up)       "${SCRIPT_DIR}/up.sh"     ;;
    backend)  "${SCRIPT_DIR}/test-backend.sh" ;;
    web)      "${SCRIPT_DIR}/test-web.sh"     ;;
    android)  "${SCRIPT_DIR}/test-android.sh" ;;
    security) "${SCRIPT_DIR}/test-security.sh" ;;
    *) echo "Unknown phase $1" >&2; exit 101;;
  esac
}

mkdir -p "${LAB_DIR}/artifacts"
cd "${LAB_DIR}"

for phase in "${PHASES[@]}"; do
  echo "\n=== [RUNNING: $phase] ==="
  if ! phase_cmd "$phase"; then
    echo "\n===[FAIL:$phase]===" >&2
    exit 200
  fi
done

timeout 600 bun run test-all.ts
