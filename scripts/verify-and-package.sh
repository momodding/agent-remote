#!/usr/bin/env sh
set -u

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

utc_timestamp=$(date -u +%Y%m%dT%H%M%SZ)
head_sha=$(git rev-parse HEAD)
short_sha=$(git rev-parse --short HEAD)
branch=$(git branch --show-current)
describe=$(git describe --tags --always --dirty)
git_status_tmp=$(mktemp "${TMPDIR:-/tmp}/agenticremote-git-status.XXXXXX")
trap 'test -z "${git_status_tmp:-}" || rm -f "$git_status_tmp"' EXIT
git status --porcelain >"$git_status_tmp"
if [ -s "$git_status_tmp" ]; then
  source_dirty=true
  bundle_name="${utc_timestamp}-${short_sha}-dirty"
else
  source_dirty=false
  bundle_name="${utc_timestamp}-${short_sha}"
fi

manual_root="$repo_root/builds/manual"
bundle="$manual_root/$bundle_name"
index=2
while [ -e "$bundle" ]; do
  bundle="$manual_root/${bundle_name}-${index}"
  index=$((index + 1))
done
mkdir -p "$bundle"
mv "$git_status_tmp" "$bundle/git-status.txt"
git_status_tmp=

android_apk="android/agenticRemote-android-${short_sha}.apk"
verify_log="$bundle/verification.log"
verify_started_at_utc=$(date -u +%Y%m%dT%H%M%SZ)
verify_rc=0
timeout --signal=TERM 12m ./e2e-lab/scripts/test-backend.sh >"$verify_log" 2>&1 || verify_rc=$?
verify_finished_at_utc=$(date -u +%Y%m%dT%H%M%SZ)

daemon_log="$bundle/daemon-release.log"
daemon_rc=0
make daemon-release \
  DAEMON_BUILD_DIR="$bundle/daemon" \
  DAEMON_RELEASE_DIR="$bundle/archives" >"$daemon_log" 2>&1 || daemon_rc=$?

android_log="$bundle/android-build.log"
android_rc=0
make client-build-android \
  CLIENT_ANDROID_OUTPUT="$bundle/$android_apk" >"$android_log" 2>&1 || android_rc=$?

if [ "$daemon_rc" -ne 0 ]; then
  package_rc=$daemon_rc
else
  package_rc=$android_rc
fi

status_label() {
  if [ "$1" -eq 0 ]; then
    printf 'passed'
  else
    printf 'failed'
  fi
}
cat >"$bundle/verify-status.txt" <<EOF
command=timeout --signal=TERM 12m ./e2e-lab/scripts/test-backend.sh
started_at_utc=$verify_started_at_utc
finished_at_utc=$verify_finished_at_utc
exit_code=$verify_rc
status=$(status_label "$verify_rc")
EOF

cat >"$bundle/README.txt" <<EOF
agenticRemote manual build bundle

NON-RELEASE: this is an unsigned, local/manual build. Do not publish it as an
official release or treat it as a substitute for a signed release.

Source
- UTC timestamp: $utc_timestamp
- commit: $head_sha
- branch: $branch
- describe: $describe
- source dirty at start: $source_dirty

Independent status
- Verification: $(status_label "$verify_rc") (exit $verify_rc). This records only the prescribed backend verification command.
- Packaging: $(status_label "$package_rc") (exit $package_rc). This records only required artifact stages and ran even if verification failed.
- Daemon release stage: $(status_label "$daemon_rc") (exit $daemon_rc; log: daemon-release.log).
- Android APK stage: $(status_label "$android_rc") (exit $android_rc; log: android-build.log).
- Verification started UTC: $verify_started_at_utc
- Verification finished UTC: $verify_finished_at_utc
- Metadata: git-status.txt is the exact \`git status --porcelain\` captured at start; verify-status.txt records the verification command, timestamps, exit code, and status; verification.log, daemon-release.log, and android-build.log are combined command output.

Verify the available build artifact hashes
  sha256sum -c SHA256SUMS
EOF

manual_ready=true
write_daemon_install() {
  install_name=$1
  platform=$2
  arch=$3
  run_command=$4
  archive_found=false
  for archive in "$bundle"/archives/agenticRemote_*_"$platform"_"$arch".tar.gz; do
    if [ -f "$archive" ]; then
      relative_archive=${archive#"$bundle"/}
      cat >>"$bundle/README.txt" <<EOF

Install $install_name
  tar -xzf $relative_archive
  sudo install -m 0755 agenticRemote /usr/local/bin/agenticRemote
  $run_command
EOF
      archive_found=true
      break
    fi
  done
  if [ "$archive_found" = false ]; then
    cat >>"$bundle/README.txt" <<EOF

Unavailable required artifact: $install_name release archive.
EOF
    manual_ready=false
  fi
}

write_daemon_install "Linux daemon (AMD64)" linux amd64 "agenticRemote version"
write_daemon_install "Linux daemon (ARM64)" linux arm64 "agenticRemote version"
write_daemon_install "macOS daemon (Intel)" darwin amd64 "agenticRemote version"
write_daemon_install "macOS daemon (Apple Silicon)" darwin arm64 "agenticRemote version"
write_daemon_install "Windows daemon (AMD64, PowerShell)" windows amd64 '.\agenticRemote.exe version'

if [ -f "$bundle/$android_apk" ]; then
  cat >>"$bundle/README.txt" <<EOF

Install Android APK
  adb install -r $android_apk
EOF
else
  cat >>"$bundle/README.txt" <<EOF

Unavailable required artifact: Android APK.
EOF
  manual_ready=false
fi

if [ "$package_rc" -ne 0 ]; then
  manual_ready=false
fi
if [ "$manual_ready" = true ]; then
  package_readiness="PACKAGE PASS / manual-ready"
else
  package_readiness="PACKAGE FAIL / not manual-ready"
fi
cat >>"$bundle/README.txt" <<EOF

$package_readiness

manifest.json is authoritative for exact typed build artifacts, hashes, and independent command statuses.
EOF

set --
for target in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64; do
  binary="daemon/$target/agenticRemote"
  if [ "$target" = windows-amd64 ]; then
    binary="${binary}.exe"
  fi
  if [ -f "$bundle/$binary" ]; then
    set -- "$@" "$binary"
  fi
  platform=${target%%-*}
  arch=${target#*-}
  for archive in "$bundle"/archives/agenticRemote_*_"$platform"_"$arch".tar.gz; do
    if [ -f "$archive" ]; then
      set -- "$@" "archives/$(basename "$archive")"
    fi
  done
done
if [ -f "$bundle/$android_apk" ]; then
  set -- "$@" "$android_apk"
fi

if [ "$#" -gt 0 ]; then
  (
    cd "$bundle"
    "$repo_root/scripts/sha256-manifest.sh" "$@" >/dev/null
  )
else
  : >"$bundle/SHA256SUMS"
fi

json_escape() {
  printf '%s' "$1" | sed 's/[\\"]/\\&/g'
}

sha256_for() {
  (cd "$bundle" && sha256sum "$1" | cut -d ' ' -f 1)
}

manifest="$bundle/manifest.json"
{
  printf '{\n'
  printf '  "created_at_utc": "%s",\n' "$(json_escape "$utc_timestamp")"
  printf '  "bundle": "%s",\n' "$(json_escape "$(basename "$bundle")")"
  printf '  "git": {"commit": "%s", "short_sha": "%s", "branch": "%s", "describe": "%s", "dirty_at_start": %s},\n' \
    "$(json_escape "$head_sha")" "$(json_escape "$short_sha")" "$(json_escape "$branch")" "$(json_escape "$describe")" "$source_dirty"
  printf '  "metadata": {"git_status": "git-status.txt", "verify_status": "verify-status.txt", "verification_log": "verification.log", "daemon_release_log": "daemon-release.log", "android_build_log": "android-build.log"},\n'
  printf '  "verification": {"status": "%s", "exit_code": %s, "command": "timeout --signal=TERM 12m ./e2e-lab/scripts/test-backend.sh", "started_at_utc": "%s", "finished_at_utc": "%s", "log": "verification.log", "status_file": "verify-status.txt"},\n' \
    "$(status_label "$verify_rc")" "$verify_rc" "$(json_escape "$verify_started_at_utc")" "$(json_escape "$verify_finished_at_utc")"
  printf '  "packaging": {"status": "%s", "exit_code": %s, "daemon_release": {"status": "%s", "exit_code": %s, "log": "daemon-release.log"}, "android_apk": {"status": "%s", "exit_code": %s, "log": "android-build.log"}},\n' \
    "$(status_label "$package_rc")" "$package_rc" "$(status_label "$daemon_rc")" "$daemon_rc" "$(status_label "$android_rc")" "$android_rc"
  printf '  "artifacts": ['
  first=true
  emit_artifact() {
    if [ "$first" = true ]; then
      first=false
    else
      printf ','
    fi
    printf '\n    {"type": "%s", "format": "%s", "platform": "%s", "arch": "%s", "path": "%s", "sha256": "%s"}' \
      "$1" "$2" "$3" "$4" "$(json_escape "$5")" "$(sha256_for "$5")"
  }
  for target in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64; do
    platform=${target%%-*}
    arch=${target#*-}
    binary="daemon/$target/agenticRemote"
    if [ "$target" = windows-amd64 ]; then
      binary="${binary}.exe"
    fi
    if [ -f "$bundle/$binary" ]; then
      emit_artifact daemon raw-binary "$platform" "$arch" "$binary"
    fi
    for archive in "$bundle"/archives/agenticRemote_*_"$platform"_"$arch".tar.gz; do
      if [ -f "$archive" ]; then
        archive="archives/$(basename "$archive")"
        emit_artifact daemon release-archive "$platform" "$arch" "$archive"
      fi
    done
  done
  if [ -f "$bundle/$android_apk" ]; then
    emit_artifact android-apk apk android universal "$android_apk"
  fi
  if [ "$first" = false ]; then
    printf '\n  '
  fi
  printf ']\n}\n'
} >"$manifest"

latest_tmp="$manual_root/.latest.$$"
ln -s "$(basename "$bundle")" "$latest_tmp"
mv -f "$latest_tmp" "$manual_root/latest"

if [ "$verify_rc" -ne 0 ]; then
  exit "$verify_rc"
fi
exit "$package_rc"
