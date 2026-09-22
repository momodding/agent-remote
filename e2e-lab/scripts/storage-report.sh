#!/usr/bin/env bash
set -euo pipefail

mode="${1:-baseline}"
case "${mode}" in baseline|after) ;; *) echo "Usage: $0 [baseline|after]" >&2; exit 2 ;; esac

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "${LAB_DIR}/.." && pwd)"
out="${LAB_DIR}/artifacts/storage-${mode}.txt"
mkdir -p "${LAB_DIR}/artifacts"

{
  printf 'E2E storage %s — %s\n' "${mode}" "$(date -u +%FT%TZ)"
  for path in "${ROOT_DIR}/client/node_modules" "${ROOT_DIR}/client/dist" "${LAB_DIR}/node_modules" "${LAB_DIR}/.runtime" "${LAB_DIR}/artifacts"; do
    if [[ -e "${path}" ]]; then
      du -sk "${path}"
    else
      printf '0\t%s (absent)\n' "${path}"
    fi
  done

  versions_file="${LAB_DIR}/env/versions.env"
  if [[ -r "${versions_file}" ]]; then
    source "${versions_file}"
    if [[ ${ANDROID_IMAGE_REPO:-} =~ ^[a-z0-9][a-z0-9._/-]*$ && ${ANDROID_IMAGE_DIGEST:-} =~ ^sha256:[a-f0-9]{64}$ ]] && command -v podman >/dev/null 2>&1; then
      printf 'pinned-android-image\t'
      podman image inspect --format '{{.Size}}' "${ANDROID_IMAGE_REPO}@${ANDROID_IMAGE_DIGEST}" 2>/dev/null || printf 'absent\n'
    fi
  fi
} | tee "${out}"
