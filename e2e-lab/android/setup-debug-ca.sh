#!/usr/bin/env bash
set -euo pipefail

# Wrapper for e2e-lab/android/setup-debug-ca.ts
# Invokes Android debug CA setup via Bun with optional output directory override

DEBUGDIR="${1:-e2e-lab/.runtime/android}"

bun run "$(dirname "$0")/setup-debug-ca.ts" "$DEBUGDIR"
