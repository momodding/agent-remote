#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Cleanup trap: call down.sh on exit unless E2E_KEEP=1
cleanup_e2e() {
  local exit_code=$?
  if [[ "${E2E_KEEP:-0}" != "1" ]]; then
    echo ""
    echo "=== E2E Cleanup (EXIT trap) ==="
    "${SCRIPT_DIR}/down.sh" || true
  fi
  exit $exit_code
}
trap cleanup_e2e EXIT INT TERM

export PATH="${HOME}/.bun/bin:${HOME}/go/bin:${HOME}/.local/bin:${PATH}"

# Ensure clean hermetic Podman container topology is running
"${SCRIPT_DIR}/up.sh"

mkdir -p "${LAB_DIR}/artifacts"
cd "${LAB_DIR}"
timeout 600 bun run test-all.ts
