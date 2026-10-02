#!/usr/bin/env bash
# Resolves the group gid that owns a KVM device node, for Compose's
# group_add interpolation (see compose.sh). Extracted into its own file so it
# can be unit-tested (kvm-gid.test.sh) without invoking sudo/podman.
#
# Usage: resolve_kvm_gid [device_path]  (defaults to /dev/kvm)
# On success: prints the numeric gid to stdout, returns 0.
# On failure: prints a BLOCKED_EXTERNAL message to stderr, returns 69.
resolve_kvm_gid() {
  local device="${1:-/dev/kvm}"
  if [[ ! -e "${device}" ]]; then
    printf 'BLOCKED_EXTERNAL: %s does not exist; cannot resolve its group gid for android-emulator'"'"'s group_add.\n' "${device}" >&2
    return 69
  fi
  local gid
  gid="$(stat -c %g "${device}")"
  if [[ ! "${gid}" =~ ^[0-9]+$ ]]; then
    printf "BLOCKED_EXTERNAL: Could not resolve a numeric group gid for %s (got: '%s').\n" "${device}" "${gid}" >&2
    return 69
  fi
  printf '%s\n' "${gid}"
}
