#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

printf '%s\n' '=== [agenticRemote E2E Lab] Rootful Podman Compose Image Builder ==='
exec "${SCRIPT_DIR}/compose.sh" build provider daemon
