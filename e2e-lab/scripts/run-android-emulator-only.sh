#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARTIFACTS_DIR="${LAB_DIR}/artifacts"
EVIDENCE_FILE="${ARTIFACTS_DIR}/android-emulator-only-command.log"
mkdir -p "${ARTIFACTS_DIR}"
: >"${EVIDENCE_FILE}"

run() {
  printf '+ %q ' "$@" | tee -a "${EVIDENCE_FILE}"
  printf '\n' | tee -a "${EVIDENCE_FILE}"
  "$@" 2>&1 | tee -a "${EVIDENCE_FILE}"
}

[[ -e /dev/kvm ]] || { printf 'FAIL: /dev/kvm is unavailable.\n' | tee -a "${EVIDENCE_FILE}" >&2; exit 1; }
run "${SCRIPT_DIR}/compose.sh" up --detach android-emulator
run "${SCRIPT_DIR}/compose.sh" ps android-emulator
printf '%s\n' 'PASS: rootful Compose started android-emulator; run verify-android-emulator-only.sh for ADB readiness.' | tee -a "${EVIDENCE_FILE}"
