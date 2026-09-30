#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEEP=0
DEPENDENCIES=0

for arg in "$@"; do
  case "${arg}" in
    --deep) DEEP=1 ;;
    --dependencies) DEPENDENCIES=1 ;;
    *) echo "Usage: $0 [--deep] [--dependencies]" >&2; exit 2 ;;
  esac
done

if (( DEPENDENCIES )); then
  printf '%s\n' 'Dependency cleanup preview only; nothing is deleted.' "  ${LAB_DIR}/node_modules" "  ${LAB_DIR}/.runtime/browser" "  ${LAB_DIR}/.runtime/bunx" "  ${LAB_DIR}/.runtime/gradle-cache" "  ${LAB_DIR}/.runtime/helper-cache"
  exit 0
fi

"${SCRIPT_DIR}/down.sh"
"${SCRIPT_DIR}/compose.sh" down --remove-orphans --volumes
rm -rf "${LAB_DIR}/.runtime/tls" \
  "${LAB_DIR}/.runtime/logs" \
  "${LAB_DIR}/.runtime/daemon-state" \
  "${LAB_DIR}/.runtime/workspace" \
  "${LAB_DIR}/.runtime/android" \
  "${LAB_DIR}/.runtime/app-debug.apk" \
  "${LAB_DIR}/artifacts/security.log" \
  "${LAB_DIR}/artifacts/backend.log" \
  "${LAB_DIR}/artifacts/backend-results.json" \
  "${LAB_DIR}/artifacts/security-results.json" \
  "${LAB_DIR}/artifacts/playwright" \
  "${LAB_DIR}/artifacts/playwright-report" \
  "${LAB_DIR}/artifacts/playwright-results.json"
if (( DEEP )); then
  rm -rf "${LAB_DIR}/.runtime/browser" "${LAB_DIR}/.runtime/bunx" "${LAB_DIR}/.runtime/gradle-cache" "${LAB_DIR}/.runtime/helper-cache" "${LAB_DIR}/android/.gradle"
fi
printf 'E2E cleanup complete%s.\n' "$([[ ${DEEP} -eq 1 ]] && printf ' (deep)' || true)"
