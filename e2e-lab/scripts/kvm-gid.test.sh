#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/kvm-gid.sh"

assert_equals() {
  [[ "$1" == "$2" ]] || { printf 'FAIL: expected %q, got %q\n' "$2" "$1" >&2; exit 1; }
}

fixture="$(mktemp)"
trap 'rm -f "${fixture}"' EXIT

expected_gid="$(stat -c %g "${fixture}")"
assert_equals "$(resolve_kvm_gid "${fixture}")" "${expected_gid}"

missing="${fixture}.missing"
set +e
missing_output="$(resolve_kvm_gid "${missing}" 2>&1)"
missing_status=$?
set -e
assert_equals "${missing_status}" "69"
[[ "${missing_output}" == "BLOCKED_EXTERNAL: ${missing} does not exist; cannot resolve its group gid for android-emulator's group_add." ]] || {
  printf 'FAIL: missing-device error was not actionable: %s\n' "${missing_output}" >&2
  exit 1
}

printf 'PASS: KVM gid resolution handles portable gid values and missing devices.\n'
