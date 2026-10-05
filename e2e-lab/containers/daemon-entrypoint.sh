#!/usr/bin/env sh
set -eu

Xvfb :99 -screen 0 800x600x24 -nolisten tcp &
xvfb_pid=$!
DISPLAY=:99 x11vnc -display :99 -nopw -localhost -rfbport 5900 -forever -shared >/dev/null 2>&1 &
vnc_pid=$!

cleanup() {
  kill "$vnc_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

agenticRemote serve --config /app/.agenticremote/config.json &
daemon_pid=$!
wait "$daemon_pid"
