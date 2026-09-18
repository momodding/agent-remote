#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

mkdir -p "${LAB_DIR}/artifacts"
cd "${LAB_DIR}"
bun run web/web-runner.ts
