#!/usr/bin/env sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: install.sh <release-archive> <SHA256SUMS>" >&2
  exit 1
fi

archive=$1
manifest=$2
sha256sum -c "$manifest" --ignore-missing

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
case "$archive" in
  *.tar.gz|*.tgz) tar -xzf "$archive" -C "$tmpdir" ;;
  *.zip) unzip -q "$archive" -d "$tmpdir" ;;
  *) echo "unsupported archive: $archive" >&2; exit 1 ;;
esac

install_dir=${AGENTICREMOTE_INSTALL_DIR:-/usr/local/bin}
mkdir -p "$install_dir"
bin=$(find "$tmpdir" -type f -name agenticRemote | head -n 1)
cp "$bin" "$install_dir/agenticRemote"
chmod +x "$install_dir/agenticRemote"
printf 'installed %s\n' "$install_dir/agenticRemote"
printf 'run: %s version\n' "$install_dir/agenticRemote"
