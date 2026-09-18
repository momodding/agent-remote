#!/usr/bin/env bash
set -euo pipefail

NET_NAME="agentic-e2e-net"

case "${1:-status}" in
  up|create)
    if ! podman network exists "$NET_NAME" 2>/dev/null; then
      echo "[Podman] Creating isolated network: $NET_NAME"
      podman network create "$NET_NAME" --subnet 10.89.0.0/24
    else
      echo "[Podman] Network $NET_NAME already exists."
    fi
    ;;
  down|remove)
    if podman network exists "$NET_NAME" 2>/dev/null; then
      echo "[Podman] Removing isolated network: $NET_NAME"
      podman network rm "$NET_NAME"
    fi
    ;;
  status)
    if podman network exists "$NET_NAME" 2>/dev/null; then
      echo "[Podman] Network $NET_NAME is ACTIVE"
      podman network inspect "$NET_NAME"
    else
      echo "[Podman] Network $NET_NAME is NOT CREATED"
    fi
    ;;
  *)
    echo "Usage: $0 {up|down|status}" >&2
    exit 1
    ;;
esac
