#!/usr/bin/env bash
set -euo pipefail

mode="${1:-baseline}"
case "${mode}" in baseline|after) ;; *) echo "Usage: $0 [baseline|after]" >&2; exit 2 ;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
out="${LAB_DIR}/artifacts/storage-${mode}.txt"
mkdir -p "${LAB_DIR}/artifacts"

{
  printf 'E2E rootful Compose storage %s — %s\n' "${mode}" "$(date -u +%FT%TZ)"
  for path in "${LAB_DIR}/.runtime" "${LAB_DIR}/artifacts"; do
    [[ -e "${path}" ]] && du -sk "${path}" || printf '0\t%s (absent)\n' "${path}"
  done
  printf '\nCompose images:\n'
  "${SCRIPT_DIR}/compose.sh" images
  printf '\nCompose volumes:\n'
  "${SCRIPT_DIR}/compose.sh" config --volumes
} | tee "${out}"
