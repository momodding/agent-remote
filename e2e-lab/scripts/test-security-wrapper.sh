#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARTIFACTS_DIR="${LAB_DIR}/artifacts/runtime-verification"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
PREFIX="${ARTIFACTS_DIR}/security-acceptance-${TIMESTAMP}"

mkdir -p "${ARTIFACTS_DIR}"
printf 'timestamp=%s\ncommand=bun run security/leak-scanner.ts\n' "${TIMESTAMP}" > "${PREFIX}.started"
sync "${PREFIX}.started"

cd "${LAB_DIR}"

# Track if we've written markers to avoid duplicates
MARKERS_WRITTEN=0
CHILD_PID=""

# Signal trap handler: kill child process group, write markers
cleanup() {
  local signal="$1"
  local exit_code
  
  # Kill child process group (not wrapper) if it exists
  if [ -n "${CHILD_PID}" ]; then
    kill -TERM "-${CHILD_PID}" 2>/dev/null || true
    wait "${CHILD_PID}" 2>/dev/null || true
  fi
  
  # Write markers if not already written
  if [ "${MARKERS_WRITTEN}" -eq 0 ]; then
    case "${signal}" in
      TERM)  exit_code=143 ;;  # 128 + 15
      INT)   exit_code=130 ;;  # 128 + 2
      HUP)   exit_code=129 ;;  # 128 + 1
      *)     exit_code=1 ;;
    esac
    printf 'exit_code=%s\ntimestamp=%s\ncommand=bun run security/leak-scanner.ts\nsignal=%s\n' "${exit_code}" "${TIMESTAMP}" "${signal}" > "${PREFIX}.exit"
    sync "${PREFIX}.exit"
    printf 'timestamp=%s\nexit_code=%s\nsignal=%s\n' "${TIMESTAMP}" "${exit_code}" "${signal}" > "${PREFIX}.completed"
    sync "${PREFIX}.completed"
    MARKERS_WRITTEN=1
  fi
  exit "${exit_code:-1}"
}

trap 'cleanup TERM' TERM
trap 'cleanup INT' INT
trap 'cleanup HUP' HUP

# Run scanner pipeline in its own process group/session; SIGTERM interrupts wait below
setsid bash -o pipefail -c 'bun run security/leak-scanner.ts 2>&1 | sed -E \
  -e '\''s/((authorization|token|secret|password|api[_-]?key)[[:space:]]*[:=][[:space:]]*)[^[:space:],}]+/\1[REDACTED]/Ig'\'' \
  -e '\''s/(Bearer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/Ig'\'' | tee '"${PREFIX}"'.log' &
CHILD_PID=$!

set +e
wait "${CHILD_PID}"
EXIT_CODE=$?
set -e

# Normal completion: write markers if not already written by trap
if [ "${MARKERS_WRITTEN}" -eq 0 ]; then
  printf 'exit_code=%s\ntimestamp=%s\ncommand=bun run security/leak-scanner.ts\n' "${EXIT_CODE}" "${TIMESTAMP}" > "${PREFIX}.exit"
  sync "${PREFIX}.exit"
  printf 'timestamp=%s\nexit_code=%s\n' "${TIMESTAMP}" "${EXIT_CODE}" > "${PREFIX}.completed"
  sync "${PREFIX}.completed"
  MARKERS_WRITTEN=1
fi
exit "${EXIT_CODE}"
