#!/usr/bin/env bash

resolve_existing_android_adb() {
  local candidate
  local -a candidates=()
  [[ -n "${ANDROID_HOME:-}" ]] && candidates+=("${ANDROID_HOME}/platform-tools/adb")
  [[ -n "${ANDROID_SDK_ROOT:-}" ]] && candidates+=("${ANDROID_SDK_ROOT}/platform-tools/adb")
  candidates+=("${HOME:-/root}/android-sdk/platform-tools/adb" "${LAB_DIR}/.runtime/platform-tools/adb")
  for candidate in "${candidates[@]}"; do
    [[ -x "${candidate}" ]] && { printf '%s\n' "${candidate}"; return 0; }
  done
  printf 'Existing Android SDK adb was not found. Searched: %s\n' "${candidates[*]}" >&2
  return 1
}

parse_podman_adb_mapping() {
  local mapping="$1"
  [[ "${mapping}" =~ ^127\.0\.0\.1:([1-9][0-9]*)$ ]] || return 1
  printf '127.0.0.1:%s\n' "${BASH_REMATCH[1]}"
}
