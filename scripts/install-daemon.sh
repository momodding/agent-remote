#!/usr/bin/env sh
set -eu

# Builds agenticRemote from this checkout, installs it, and initializes its
# config directory. Source-checkout counterpart to scripts/install.sh, which
# installs a pre-built release archive instead of compiling.
#
# Env overrides:
#   AGENTICREMOTE_INSTALL_DIR   binary install dir (default /usr/local/bin)
#   AGENTICREMOTE_CONFIG_DIR    managed config dir (default /etc/agenticremote)
#
# Run with sudo when using the system-wide defaults above.

# ponytail: resolves the script's own directory; does not follow symlinks to
# the script file itself. Invoke via a real path (not a symlinked one) if that
# ever matters.
repo_root=$(cd "$(dirname "$0")/.." && pwd)
install_dir=${AGENTICREMOTE_INSTALL_DIR:-/usr/local/bin}
config_dir=${AGENTICREMOTE_CONFIG_DIR:-/etc/agenticremote}
marker="$config_dir/.agenticremote-managed-by-install-daemon-sh"

check_path() {
  p=$1; label=$2; min=$3
  case "$p" in
    /*) : ;;
    *) echo "$label must be an absolute path: $p" >&2; exit 1 ;;
  esac
  case "$p" in
    /) echo "$label must not be /: $p" >&2; exit 1 ;;
    */) echo "$label must not end in /: $p" >&2; exit 1 ;;
    *//*) echo "$label must not contain //: $p" >&2; exit 1 ;;
  esac
  n=0
  IFS=/
  for seg in $p; do
    case "$seg" in
      "") ;;
      .|..) echo "$label must not contain a . or .. path segment: $p" >&2; exit 1 ;;
      *) n=$((n + 1)) ;;
    esac
  done
  unset IFS
  if [ "$n" -lt "$min" ]; then
    echo "$label must have at least $min path segment(s) below root: $p" >&2
    exit 1
  fi
}

check_path "$install_dir" "AGENTICREMOTE_INSTALL_DIR" 1
check_path "$config_dir" "AGENTICREMOTE_CONFIG_DIR" 2

if [ -e "$config_dir" ] && [ ! -f "$marker" ]; then
  echo "refusing to install: $config_dir exists and is not managed by install-daemon.sh (missing $marker)" >&2
  exit 1
fi

tmpbin=$(mktemp)
trap 'rm -f "$tmpbin"' EXIT
(cd "$repo_root/backend" && CGO_ENABLED=0 go build -o "$tmpbin" ./cmd/agenticRemote)

install -d -m 0755 "$install_dir" "$config_dir"
install -m 0755 "$tmpbin" "$install_dir/agenticRemote"
[ -f "$marker" ] || install -m 0644 /dev/null "$marker"

bin="$install_dir/agenticRemote"
config_file="$config_dir/config.json"
if [ -f "$config_file" ]; then
  echo "existing config found at $config_file; left untouched"
else
  "$bin" config init --path "$config_dir"
  echo "initialized config: $config_file"
fi

echo "installed daemon binary: $bin"
echo "managed config directory: $config_dir"
echo
echo "next step:"
printf "  sudo '%s' serve --config '%s'\n" "$bin" "$config_file"
