#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly PROJECT_NAME="agenticremote-e2e"
source "${SCRIPT_DIR}/lib/kvm-gid.sh"


blocked() {
  printf 'BLOCKED_EXTERNAL: %s\n' "$*" >&2
  exit 69
}

readonly E2E_PODMAN_BIN="${E2E_PODMAN_BIN:-/home/linuxbrew/.linuxbrew/bin/podman}"
[[ -x "${E2E_PODMAN_BIN}" ]] || blocked "Podman is unavailable or not executable: ${E2E_PODMAN_BIN}"

sudo -n -- "${E2E_PODMAN_BIN}" --version >/dev/null 2>&1 || blocked "noninteractive sudo is required for ${E2E_PODMAN_BIN}."
sudo -n -- "${E2E_PODMAN_BIN}" compose version >/dev/null 2>&1 || blocked "rootful Podman Compose is unavailable through ${E2E_PODMAN_BIN}."

# android-emulator's group_add needs the host's /dev/kvm group gid, which
# varies per host/CI; resolve it here rather than hard-coding it in
# compose.yaml. sudo -n strips arbitrary environment variables (only root may
# set them per sudoers), so pass it through a generated --env-file instead.
readonly KVM_GID="$(resolve_kvm_gid)" || exit $?
readonly KVM_GID_ENV_FILE="${LAB_DIR}/.runtime/kvm-gid.env"
mkdir -p "${LAB_DIR}/.runtime"
printf 'KVM_GID=%s\n' "${KVM_GID}" >"${KVM_GID_ENV_FILE}"

exec sudo -n -- "${E2E_PODMAN_BIN}" compose \
  --file "${LAB_DIR}/compose.yaml" \
  --project-directory "${LAB_DIR}" \
  --project-name "${PROJECT_NAME}" \
  --env-file "${KVM_GID_ENV_FILE}" \
  "$@"

