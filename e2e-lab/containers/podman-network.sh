#!/usr/bin/env bash
set -euo pipefail

NETWORK_NAME="agent-remote-e2e"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/podman.sh
source "${SCRIPT_DIR}/../scripts/podman.sh"


e2e_podman --version >/dev/null

if e2e_podman network exists "${NETWORK_NAME}" 2>/dev/null; then
  echo "Podman network '${NETWORK_NAME}' already exists."
else
  echo "Creating rootless Podman network '${NETWORK_NAME}'..."
  e2e_podman network create "${NETWORK_NAME}"
  echo "Created network '${NETWORK_NAME}'."
fi
