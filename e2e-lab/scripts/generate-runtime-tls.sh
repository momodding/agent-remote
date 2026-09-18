#!/usr/bin/env bash
set -euo pipefail

# Wrapper for e2e-lab/tls/generate-certs.ts
# Invokes TypeScript cert generator via Bun with optional output directory override

OUTDIR="${1:-e2e-lab/.runtime/tls}"

bun run "$(dirname "$0")/../tls/generate-certs.ts" "$OUTDIR"
