#!/usr/bin/env bash
# Source this file for e2e_podman, or execute it as a Podman wrapper.

_e2e_podman_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_e2e_lab_dir="$(cd "${_e2e_podman_dir}/.." && pwd)"

_e2e_podman_setup() {
  if [[ -n "${_E2E_PODMAN_BIN:-}" ]]; then
    return
  fi

  _E2E_PODMAN_BIN="$(command -v podman || true)"
  if [[ -z "${_E2E_PODMAN_BIN}" ]]; then
    echo "[ERROR] Podman container runtime is required but not installed on PATH." >&2
    return 1
  fi

  # An explicit storage choice belongs to the caller; never replace it.
  if [[ -n "${CONTAINERS_STORAGE_CONF:-}" ]]; then
    return
  fi

  if [[ "$(uname -s)" != "Linux" || ! -x /usr/bin/podman ]]; then
    return
  fi

  local runtime_dir="${_e2e_lab_dir}/.runtime"
  local storage_conf="${runtime_dir}/podman-system-storage.conf"
  if [[ -f "${storage_conf}" ]]; then
    export CONTAINERS_STORAGE_CONF="${storage_conf}"
    export PATH="/usr/bin:${PATH}"
    _E2E_PODMAN_BIN=/usr/bin/podman
    return
  fi

  if "${_E2E_PODMAN_BIN}" run --rm --pull=never --entrypoint /bin/sh docker.io/oven/bun:latest \
    -c 'test -x /usr/bin/dash' >/dev/null 2>&1; then
    return
  fi

  # Cleanup verification must not recreate runtime storage it is checking.
  if [[ "${E2E_PODMAN_NO_FALLBACK_CREATE:-0}" == "1" ]]; then
    return
  fi

  mkdir -p "${runtime_dir}"
  cat >"${storage_conf}" <<EOF
[storage]
driver = "overlay"
runroot = "${runtime_dir}/podman-system-runroot"
graphroot = "${runtime_dir}/podman-system-graphroot"
rootless_storage_path = "${runtime_dir}/podman-system-graphroot"
EOF
  export CONTAINERS_STORAGE_CONF="${storage_conf}"
  export PATH="/usr/bin:${PATH}"
  _E2E_PODMAN_BIN=/usr/bin/podman
  echo "Using project-local Podman storage after the default rootfs probe failed." >&2
}

e2e_podman() {
  _e2e_podman_setup
  "${_E2E_PODMAN_BIN}" "$@"
}

e2e_podman_timeout() {
  local duration=$1
  shift
  # No --foreground: let timeout create a new process group for podman.sh so
  # its signal reaches podman's forked grandchildren too, not just the shell.
  timeout --kill-after=1s "${duration}" "${_e2e_podman_dir}/podman.sh" "$@"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  e2e_podman "$@"
fi
