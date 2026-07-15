#!/usr/bin/env sh
set -eu
install_dir=${AGENTICREMOTE_INSTALL_DIR:-/usr/local/bin}
rm -f "$install_dir/agenticRemote"
printf 'removed %s\n' "$install_dir/agenticRemote"
