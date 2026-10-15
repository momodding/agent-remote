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
# The Brew CLI's local mode reads a different Netavark configuration from the
# system rootful API service. Compose is served by that rootful API, so force
# every wrapper invocation through its socket to keep network state coherent.
readonly E2E_PODMAN_SOCKET="${E2E_PODMAN_SOCKET:-unix:///run/podman/podman.sock}"
[[ -x "${E2E_PODMAN_BIN}" ]] || blocked "Podman is unavailable or not executable: ${E2E_PODMAN_BIN}"

sudo -n -- "${E2E_PODMAN_BIN}" --remote --url "${E2E_PODMAN_SOCKET}" --version >/dev/null 2>&1 || blocked "the rootful Podman API socket is unavailable: ${E2E_PODMAN_SOCKET}."
sudo -n -- "${E2E_PODMAN_BIN}" --remote --url "${E2E_PODMAN_SOCKET}" compose version >/dev/null 2>&1 || blocked "rootful Podman Compose is unavailable through ${E2E_PODMAN_BIN}."

# android-emulator's group_add needs the host's /dev/kvm group gid, which
# varies per host/CI; resolve it here rather than hard-coding it in
# compose.yaml. sudo -n strips arbitrary environment variables (only root may
# set them per sudoers), so pass it through a generated --env-file instead.
readonly KVM_GID="$(resolve_kvm_gid)" || exit $?
readonly KVM_GID_ENV_FILE="${LAB_DIR}/.runtime/kvm-gid.env"
mkdir -p "${LAB_DIR}/.runtime"
printf 'KVM_GID=%s\n' "${KVM_GID}" >"${KVM_GID_ENV_FILE}"
if [[ -n "${E2E_PROVIDER_IPV4:-}" ]]; then
  printf 'E2E_PROVIDER_IPV4=%s\n' "${E2E_PROVIDER_IPV4}" >>"${KVM_GID_ENV_FILE}"
fi

exec sudo -n -- "${E2E_PODMAN_BIN}" --remote --url "${E2E_PODMAN_SOCKET}" compose \
  --file "${LAB_DIR}/compose.yaml" \
  --project-directory "${LAB_DIR}" \
  --project-name "${PROJECT_NAME}" \
  --env-file "${KVM_GID_ENV_FILE}" \
  "$@"

