#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARTIFACTS_DIR="${LAB_DIR}/artifacts"
EVIDENCE_FILE="${ARTIFACTS_DIR}/android-emulator-only-command.log"
readonly ADB_SERIAL="127.0.0.1:5555"
readonly TIMEOUT=300
mkdir -p "${ARTIFACTS_DIR}"
: >>"${EVIDENCE_FILE}"

log() { printf '%s\n' "$*" | tee -a "${EVIDENCE_FILE}"; }
run() { log "+ $*"; "$@" 2>&1 | tee -a "${EVIDENCE_FILE}"; return "${PIPESTATUS[0]}"; }
preserve_logs() { "${SCRIPT_DIR}/compose.sh" logs android-emulator >>"${EVIDENCE_FILE}" 2>&1 || true; }
trap 'status=$?; (( status )) && preserve_logs; exit "${status}"' EXIT

source "${SCRIPT_DIR}/lib/android-diagnostic.sh"
ADB="$(resolve_existing_android_adb)" || { log "FAIL: existing Android SDK adb was not found."; exit 1; }
log "Using existing Android SDK adb: ${ADB}"
run "${SCRIPT_DIR}/compose.sh" ps android-emulator
"${SCRIPT_DIR}/compose.sh" ps --status running --services | grep -Fxq android-emulator || { log 'FAIL: android-emulator is not running.'; exit 1; }

"${ADB}" disconnect "${ADB_SERIAL}" >>"${EVIDENCE_FILE}" 2>&1 || true
run "${ADB}" connect "${ADB_SERIAL}"
deadline=$((SECONDS + TIMEOUT))
while :; do
  state="$("${ADB}" -s "${ADB_SERIAL}" get-state 2>&1 || true)"
  log "+ ${ADB} -s ${ADB_SERIAL} get-state: ${state}"
  [[ "${state}" == device ]] && break
  (( SECONDS < deadline )) || { log "FAIL: adb never reached device state within ${TIMEOUT}s."; exit 1; }
  sleep 1
done
while :; do
  boot_completed="$("${ADB}" -s "${ADB_SERIAL}" shell getprop sys.boot_completed 2>&1 || true)"
  log "+ ${ADB} -s ${ADB_SERIAL} shell getprop sys.boot_completed: ${boot_completed}"
  [[ "${boot_completed}" == 1 ]] && break
  (( SECONDS < deadline )) || { log "FAIL: Android never booted within ${TIMEOUT}s."; exit 1; }
  sleep 1
done
run "${ADB}" -s "${ADB_SERIAL}" shell pm list packages
log "PASS: android-emulator booted and ADB package listing succeeded on ${ADB_SERIAL}."
