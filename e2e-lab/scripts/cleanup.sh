#!/usr/bin/env bash
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "${LAB_DIR}/.." && pwd)"
# shellcheck source=podman.sh
source "${LAB_DIR}/scripts/podman.sh"
DEEP=0
DEPENDENCIES=0

for arg in "$@"; do
  case "${arg}" in
    --deep) DEEP=1 ;;
    --dependencies) DEPENDENCIES=1 ;;
    *) echo "Usage: $0 [--deep] [--dependencies]" >&2; exit 2 ;;
  esac
done

if [[ ${DEPENDENCIES} -eq 1 ]]; then
  cat <<EOF
Dependency cleanup preview only; nothing is deleted.
Known E2E dependency paths:
  ${LAB_DIR}/node_modules
  ${LAB_DIR}/.runtime/browser
  ${LAB_DIR}/.runtime/bunx
  ${LAB_DIR}/.runtime/gradle-cache
  ${LAB_DIR}/.runtime/helper-cache
The first path is legacy. The remaining paths are E2E-owned only when created by this lab.
EOF
  exit 0
fi

"${LAB_DIR}/scripts/down.sh"

if e2e_podman_timeout 3s --version >/dev/null 2>&1; then
  for label in agenticremote.e2e=true io.agent-remote.e2e=true; do
    mapfile -t labelled < <(e2e_podman_timeout 3s ps -aq --filter "label=${label}" 2>/dev/null || true)
    if ((${#labelled[@]})); then
      e2e_podman_timeout 3s rm -f "${labelled[@]}" || true
    fi
  done

  # This is the lab's sole topology network; never prune networks globally.
  e2e_podman_timeout 3s network rm agent-remote-e2e 2>/dev/null || true
fi

# These are exact, lab-generated runtime paths; do not broaden this list.
rm -rf "${LAB_DIR}/.runtime/tls" \
  "${LAB_DIR}/.runtime/logs" \
  "${LAB_DIR}/.runtime/daemon-state" \
  "${LAB_DIR}/.runtime/workspace" \
  "${LAB_DIR}/.runtime/android" \
  "${LAB_DIR}/.runtime/app-debug.apk" \
  "${LAB_DIR}/.runtime/pairing.json" \
  "${LAB_DIR}/.runtime/web-server.pid" \
  "${LAB_DIR}/artifacts/security.log" \
  "${LAB_DIR}/artifacts/backend.log" \
  "${LAB_DIR}/artifacts/backend-results.json" \
  "${LAB_DIR}/artifacts/security-results.json" \
  "${LAB_DIR}/artifacts/playwright" \
  "${LAB_DIR}/artifacts/playwright-report" \
  "${LAB_DIR}/artifacts/playwright-results.json"

# Rootless overlay layers can be owned by a mapped container UID. Use Podman's
# user namespace for these exact project-local paths before considering sudo.
podman_storage=(
  "${LAB_DIR}/.runtime/podman-system-runroot"
  "${LAB_DIR}/.runtime/podman-system-graphroot"
  "${LAB_DIR}/.runtime/podman-system-storage.conf"
)
if ! rm -rf "${podman_storage[@]}" 2>/dev/null; then
  if e2e_podman_timeout 3s unshare rm -rf -- "${podman_storage[@]}"; then
    :
  elif sudo -n true 2>/dev/null; then
    sudo rm -rf -- "${podman_storage[@]}"
  else
    echo "[ERROR] Could not remove project-local Podman storage; Podman user-namespace cleanup and noninteractive sudo both failed." >&2
    exit 1
  fi
fi

if [[ ${DEEP} -eq 1 ]]; then
  rm -rf "${LAB_DIR}/.runtime/browser" \
    "${LAB_DIR}/.runtime/bunx" \
    "${LAB_DIR}/.runtime/gradle-cache" \
    "${LAB_DIR}/.runtime/helper-cache" \
    "${LAB_DIR}/android/.gradle"
  versions_file="${LAB_DIR}/env/versions.env"
  if [[ -r "${versions_file}" ]]; then
    # This trusted lab file is the single source of the Android image pin.
    source "${versions_file}"
    if [[ ! ${ANDROID_IMAGE_REPO:-} =~ ^[a-z0-9][a-z0-9._/-]*$ || ! ${ANDROID_IMAGE_DIGEST:-} =~ ^sha256:[a-f0-9]{64}$ ]]; then
      echo "Skipping pinned Android image cleanup: no valid image pin in ${versions_file}." >&2
    elif command -v podman >/dev/null 2>&1; then
      # Bare podman (default store), matching the command -v check above; the pinned
      # Android image lives in the default store, not the bounded e2e-lab store.
      timeout --kill-after=1s 3s podman image rm -f "${ANDROID_IMAGE_REPO}@${ANDROID_IMAGE_DIGEST}" 2>/dev/null || true
    fi
  else
    echo "Skipping pinned Android image cleanup: ${versions_file} is unavailable." >&2
  fi
fi
if [[ ${DEEP} -eq 1 ]]; then
  echo "E2E cleanup complete (deep)."
else
  echo "E2E cleanup complete."
fi
