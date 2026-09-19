#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="${HOME}/.bun/bin:${HOME}/go/bin:${HOME}/.local/bin:${PATH}"

# Ensure clean hermetic Podman container topology is running
"${SCRIPT_DIR}/up.sh"

mkdir -p "${LAB_DIR}/artifacts"
cd "${LAB_DIR}"
bun run test-all.ts
