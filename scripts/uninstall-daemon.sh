#!/usr/bin/env sh
set -eu

# Removes the daemon binary and config/state directory installed by
# scripts/install-daemon.sh. Source-checkout counterpart to
# scripts/uninstall.sh, which only removes the binary (the archive installer
# never creates config).
#
# Env overrides:
#   AGENTICREMOTE_INSTALL_DIR   binary install dir (default /usr/local/bin)
#   AGENTICREMOTE_CONFIG_DIR    managed config dir (default /etc/agenticremote)
#
# Run with sudo when using the system-wide defaults above.

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
  echo "refusing to remove: $config_dir exists and is not managed by install-daemon.sh (missing $marker)" >&2
  exit 1
fi

rm -f "$install_dir/agenticRemote"
rm -rf "$config_dir"

echo "removed: $install_dir/agenticRemote"
echo "removed: $config_dir"
