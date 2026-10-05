#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/android-diagnostic.sh
source "${SCRIPT_DIR}/lib/android-diagnostic.sh"

[[ "$(parse_podman_adb_mapping '127.0.0.1:5555')" == '127.0.0.1:5555' ]]
if parse_podman_adb_mapping '0.0.0.0:5555' >/dev/null; then
  echo 'FAIL: non-loopback mapping was accepted' >&2
  exit 1
fi
if parse_podman_adb_mapping '' >/dev/null; then
  echo 'FAIL: missing mapping was accepted' >&2
  exit 1
fi
echo 'PASS: Podman Android ADB port mapping parser'
