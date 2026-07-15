#!/usr/bin/env sh
set -eu
if [ "$#" -lt 1 ]; then
  echo "usage: sha256-manifest.sh <archive> [...]" >&2
  exit 1
fi
sha256sum "$@" > SHA256SUMS
cat SHA256SUMS
