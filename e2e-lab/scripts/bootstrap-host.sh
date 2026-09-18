#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== [agenticRemote E2E Lab] Bootstrapping Host ==="
mkdir -p "${LAB_DIR}/artifacts"
touch "${LAB_DIR}/artifacts/.gitkeep"

cd "${LAB_DIR}"
bun run bootstrap/bootstrap.ts
echo "=== Host Bootstrap Completed ==="
