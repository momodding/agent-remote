#!/usr/bin/env bash
# Bounded harness diagnosis; intentionally does not run Maestro product flows.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT="$(cd "${LAB_DIR}/.." && pwd)"
ARTIFACTS_DIR="${LAB_DIR}/artifacts/runtime-verification"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_DIR="${ARTIFACTS_DIR}/android-diagnostic-${STAMP}"
E2E_PODMAN_BIN="${E2E_PODMAN_BIN:-/home/linuxbrew/.linuxbrew/bin/podman}"
APP_ID='com.paperplain.agenticremote'
APP_ACTIVITY="${APP_ID}/.MainActivity"
mkdir -p "${EVIDENCE_DIR}"
source "${SCRIPT_DIR}/lib/android-diagnostic.sh"

log() { printf '%s\n' "$*" | tee -a "${EVIDENCE_DIR}/diagnostic.log"; }
run() { log "+ $(printf '%q ' "$@")"; "$@" 2>&1 | tee -a "${EVIDENCE_DIR}/diagnostic.log"; }
capture() { local name="$1"; shift; { printf '+ '; printf '%q ' "$@"; printf '\n'; "$@"; } >"${EVIDENCE_DIR}/${name}" 2>&1 || true; }
container_id=''
cleanup() {
  local status=$?
  if [[ -n "${container_id}" ]]; then
    capture 'android-emulator.log' "${SCRIPT_DIR}/compose.sh" logs android-emulator
  fi
  if [[ "${E2E_KEEP:-0}" != 1 && -n "${container_id}" ]]; then
    run "${SCRIPT_DIR}/compose.sh" rm --stop --force android-emulator || true
  fi
  exit "${status}"
}
trap cleanup EXIT

ADB="$(resolve_existing_android_adb)" || { log 'BLOCKED_ADB_UNAVAILABLE'; exit 1; }
run "${SCRIPT_DIR}/compose.sh" up --detach android-emulator
container_id="$("${SCRIPT_DIR}/compose.sh" ps -q android-emulator)"
[[ -n "${container_id}" ]] || { log 'FAIL: android-emulator container id was empty'; exit 1; }
container_name="$(sudo -n -- "${E2E_PODMAN_BIN}" inspect --format '{{.Name}}' "${container_id}" | sed 's#^/##')"
image_digest="$(sudo -n -- "${E2E_PODMAN_BIN}" inspect --format '{{.ImageName}}' "${container_id}")"
mapping="$(sudo -n -- "${E2E_PODMAN_BIN}" inspect --format '{{with index .NetworkSettings.Ports "5555/tcp"}}{{with index . 0}}{{.HostIP}}:{{.HostPort}}{{end}}{{end}}' "${container_id}")"
ADB_SERIAL="$(parse_podman_adb_mapping "${mapping}")" || { log "FAIL: unexpected Podman 5555/tcp mapping: ${mapping:-<empty>}"; exit 1; }
log "container_name=${container_name}"
log "container_id=${container_id}"
log "adb_serial=${ADB_SERIAL}"
log "image_digest=${image_digest}"
log "git_head=$(git -C "${ROOT}" rev-parse HEAD)"
log "adb=${ADB}"
capture 'adb-connect.txt' "${ADB}" connect "${ADB_SERIAL}"
for _ in $(seq 1 300); do
  if [[ "$("${ADB}" -s "${ADB_SERIAL}" get-state 2>/dev/null || true)" == device ]]; then
    break
  fi
  sleep 1
done
[[ "$("${ADB}" -s "${ADB_SERIAL}" get-state 2>/dev/null || true)" == device ]] || { log 'FAIL: adb state never reached device'; exit 1; }
for _ in $(seq 1 300); do
  if [[ "$("${ADB}" -s "${ADB_SERIAL}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then
    break
  fi
  sleep 1
done
[[ "$("${ADB}" -s "${ADB_SERIAL}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]] || { log 'FAIL: Android never booted'; exit 1; }

capture 'system-server.txt' "${ADB}" -s "${ADB_SERIAL}" shell dumpsys activity service system_server
capture 'services.txt' "${ADB}" -s "${ADB_SERIAL}" shell service list
capture 'activity.txt' "${ADB}" -s "${ADB_SERIAL}" shell dumpsys activity activities
capture 'window.txt' "${ADB}" -s "${ADB_SERIAL}" shell dumpsys window
capture 'input.txt' "${ADB}" -s "${ADB_SERIAL}" shell dumpsys input
capture 'launcher.txt' "${ADB}" -s "${ADB_SERIAL}" shell dumpsys package com.google.android.apps.nexuslauncher
capture 'pre-install-screenshot.png' "${ADB}" -s "${ADB_SERIAL}" exec-out screencap -p

stage_dir="${LAB_DIR}/.runtime/android/source"
temp_dir="$(mktemp -d)"
cp -a "${ROOT}/client/." "${temp_dir}/"
rm -rf "${temp_dir}/node_modules"
ln -s "${ROOT}/client/node_modules" "${temp_dir}/node_modules"
( cd "${temp_dir}" && "${ROOT}/client/node_modules/.bin/expo" prebuild --platform android --clean --no-install ) >"${EVIDENCE_DIR}/expo-prebuild.log" 2>&1
rm "${temp_dir}/node_modules"
rm -rf "${stage_dir}"
mkdir -p "${stage_dir}"
cp -a "${temp_dir}/." "${stage_dir}/"
rm -rf "${temp_dir}"
run "${SCRIPT_DIR}/compose.sh" exec -T android-emulator bash -c 'find /workspace/build -mindepth 1 -maxdepth 1 -exec rm -rf {} + && find /workspace/source -mindepth 1 -maxdepth 1 ! -name node_modules -exec cp -a {} /workspace/build/ \; && ln -s /workspace/source/node_modules /workspace/build/node_modules && cd /workspace/build/android && GRADLE_USER_HOME=/tmp/gradle-e2e ./gradlew -x testDebug assembleDebug'
apk="${EVIDENCE_DIR}/agent-remote-current.apk"
run "${SCRIPT_DIR}/compose.sh" cp 'android-emulator:/workspace/build/android/app/build/outputs/apk/debug/app-debug.apk' "${apk}"
apk_sha="$(sha256sum "${apk}" | awk '{print $1}')"
log "apk_sha256=${apk_sha}"
run "${ADB}" -s "${ADB_SERIAL}" install -r "${apk}"
capture 'am-start.txt' "${ADB}" -s "${ADB_SERIAL}" shell am start -n "${APP_ACTIVITY}"
sleep 5
capture 'resumed-activity.txt' "${ADB}" -s "${ADB_SERIAL}" shell dumpsys activity activities
if grep -Fq "${APP_ID}/.MainActivity" "${EVIDENCE_DIR}/resumed-activity.txt"; then log 'am_launch_resumed_activity=PASS'; else log 'am_launch_resumed_activity=FAIL'; fi
capture 'post-launch-screenshot.png' "${ADB}" -s "${ADB_SERIAL}" exec-out screencap -p
capture 'logcat.txt' "${ADB}" -s "${ADB_SERIAL}" logcat -d -v threadtime
MAESTRO_BIN="${MAESTRO_BIN:-${HOME}/.maestro/bin/maestro}"
if [[ -x "${MAESTRO_BIN}" ]]; then
  capture 'maestro-hierarchy.txt' env "PATH=$(dirname "${ADB}"):$(dirname "${MAESTRO_BIN}"):${PATH}" "${MAESTRO_BIN}" --verbose --platform android --device "${ADB_SERIAL}" hierarchy
  log "maestro_hierarchy=$(grep -q 'No running devices found\|is not connected' "${EVIDENCE_DIR}/maestro-hierarchy.txt" && echo FAIL || echo COMPLETE)"
else
  log "maestro_hierarchy=UNAVAILABLE (${MAESTRO_BIN})"
fi
log "PASS: bounded Android diagnostic completed; evidence=${EVIDENCE_DIR}"
