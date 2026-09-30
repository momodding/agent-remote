#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly PROJECT_NAME="agenticremote-e2e"

blocked() {
  printf 'BLOCKED_EXTERNAL: %s\n' "$*" >&2
  exit 69
}

readonly E2E_PODMAN_BIN="${E2E_PODMAN_BIN:-/home/linuxbrew/.linuxbrew/bin/podman}"
[[ -x "${E2E_PODMAN_BIN}" ]] || blocked "Podman is unavailable or not executable: ${E2E_PODMAN_BIN}"

sudo -n -- "${E2E_PODMAN_BIN}" --version >/dev/null 2>&1 || blocked "noninteractive sudo is required for ${E2E_PODMAN_BIN}."
sudo -n -- "${E2E_PODMAN_BIN}" compose version >/dev/null 2>&1 || blocked "rootful Podman Compose is unavailable through ${E2E_PODMAN_BIN}."

exec sudo -n -- "${E2E_PODMAN_BIN}" compose \
  --file "${LAB_DIR}/compose.yaml" \
  --project-directory "${LAB_DIR}" \
  --project-name "${PROJECT_NAME}" \
  "$@"
