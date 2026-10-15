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

# Browser clients connect from the host's network namespace, which in this
# rootful-Podman setup cannot route the loopback-published container port
# back into the container (route_localnet NAT hairpin limitation). The
# container's own bridge-network IP IS reachable from the host, so rewrite
# the image's baked "localhost" publicEndpoint to that address before the
# daemon starts. This only ever matches the literal placeholder baked into
# Containerfile.daemon's config.json, so it is a no-op for any real
# deployment config that already names a concrete reachable host.
container_ip="$(hostname -i 2>/dev/null | awk '{print $1}')"
if [ -n "$container_ip" ]; then
  sed -i "s#https://localhost:18765#https://${container_ip}:18765#" /app/.agenticremote/config.json
fi

# Rootful Podman can advertise DNS while its Aardvark resolver cannot answer
# service aliases. up.sh obtains this address from the internal provider
# container on every start; never expose the provider beyond this bridge.
if [ -n "${E2E_PROVIDER_IPV4:-}" ]; then
  if ! printf '%s\n' "${E2E_PROVIDER_IPV4}" | awk -F. 'NF == 4 { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]{1,3}$/ || $i + 0 > 255) exit 1; exit 0 } { exit 1 }'; then
    printf '%s\n' "Invalid E2E_PROVIDER_IPV4: ${E2E_PROVIDER_IPV4}" >&2
    exit 1
  fi
  sed -i "s#http://provider:19090/v1#http://${E2E_PROVIDER_IPV4}:19090/v1#" /root/.omp/agent/models.yml
fi

agenticRemote serve --config /app/.agenticremote/config.json &
daemon_pid=$!
wait "$daemon_pid"
