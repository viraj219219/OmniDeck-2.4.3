#!/usr/bin/env bash
# Vendors a self-contained LibreOffice runtime for Linux into
# src-tauri/resources/libreoffice/ from the official TDF .deb tarball, unpacked
# with `dpkg-deb -x` (never `apt install`/`dpkg -i`: no root, no package DB).
#
# Usage: scripts/vendor-libreoffice-linux.sh <x86_64|aarch64> [destination]
#
# Result: <dest>/opt/libreofficeX.Y/program/soffice  (the layout
# `bundled_soffice_path()` in src-tauri/src/util.rs scans for).
#
# Fail-closed: every check below ends in a NON-ZERO exit; nothing is downgraded
# to a warning. The destination is only replaced after the staged runtime
# passed: SHA-256, ELF architecture, shared-library resolution, `--version`
# (exit code AND version string) and a real PPTX->PDF conversion.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib/vendor-common.sh
. "$HERE/lib/vendor-common.sh"

VERSION="${LIBREOFFICE_VERSION:-26.8.0}"
ARCH="${1:-}"
DEST="${2:-src-tauri/resources/libreoffice}"
FIXTURE="${OMNIDECK_SMOKE_FIXTURE:-$ROOT/src-tauri/test-fixtures/three-slides.pptx}"
SMOKE_PAGES="${OMNIDECK_SMOKE_PAGES:-3}"
MIN_BYTES="${OMNIDECK_MIN_ARCHIVE_BYTES:-100000000}"

[ -n "$ARCH" ] || { echo "usage: vendor-libreoffice-linux.sh <x86_64|aarch64> [destination]" >&2; exit 2; }
# The download directory uses x86_64, but the archive filename uses x86-64.
case "$ARCH" in
  x86_64)  FILE_ARCH="x86-64";  ELF_MACHINE="3e 00" ;;
  aarch64) FILE_ARCH="aarch64"; ELF_MACHINE="b7 00" ;;
  *) echo "Unsupported architecture: $ARCH (expected x86_64 or aarch64)" >&2; exit 2 ;;
esac

# The staged runtime must be EXECUTED to be validated, so the host must match.
case "$(uname -m)" in
  x86_64) HOST_ARCH="x86_64" ;;
  aarch64|arm64) HOST_ARCH="aarch64" ;;
  *) vo_die "unsupported host architecture $(uname -m)" ;;
esac
[ "$HOST_ARCH" = "$ARCH" ] || vo_die "target $ARCH but this host is $HOST_ARCH; vendor each architecture on a native runner (validation executes the runtime)"
command -v dpkg-deb >/dev/null 2>&1 || vo_die "dpkg-deb is required to unpack the official .deb files"
command -v curl >/dev/null 2>&1 || vo_die "curl is required"

case "$DEST" in /*) DEST_ABS="$DEST" ;; *) DEST_ABS="$(pwd)/$DEST" ;; esac
PARENT="$(dirname "$DEST_ABS")"
mkdir -p "$PARENT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/omnideck-lo.XXXXXX")"
STAGE="$PARENT/libreoffice-staging-$$"
BACKUP="$PARENT/libreoffice-backup-$$"
CACHE="${OMNIDECK_VENDOR_CACHE:-${TMPDIR:-/tmp}/omnideck-lo-cache}"
mkdir -p "$CACHE"
cleanup() { rm -rf "$WORK" "$STAGE"; }
trap cleanup EXIT
# Leftovers of a killed earlier run (never the live bundle).
rm -rf "$PARENT"/libreoffice-staging-* "$PARENT"/libreoffice-backup-*

ARCHIVE="LibreOffice_${VERSION}_Linux_${FILE_ARCH}_deb.tar.gz"
URL="$(vo_base_url)/${VERSION}/deb/${ARCH}/${ARCHIVE}"
echo "Vendoring official LibreOffice $VERSION for Linux $ARCH"
vo_download "$URL" "$CACHE/$ARCHIVE" "$MIN_BYTES" "$(vo_pinned_sha256 "$VERSION:linux-$ARCH")"
ARCHIVE_SHA="$(vo_sha256 "$CACHE/$ARCHIVE")"

mkdir -p "$WORK/tar"
tar -xzf "$CACHE/$ARCHIVE" -C "$WORK/tar"
rm -f "$CACHE/$ARCHIVE"   # verified + unpacked; don't leave ~200 MB behind

DEB_DIR="$(find "$WORK/tar" -maxdepth 2 -type d -name DEBS | head -n1)"
[ -n "$DEB_DIR" ] || vo_die "no DEBS directory in the archive - the TDF tarball layout changed"

# Core suite + Impress/Writer filters only: skip language packs, help and the
# desktop-integration packages, which mean nothing for a bundled, never-installed copy.
mkdir -p "$STAGE"
extracted=0
for deb in "$DEB_DIR"/*.deb; do
  [ -e "$deb" ] || continue
  case "$(basename "$deb")" in
    *-gnome-integration*|*-kde-integration*|*-l10n-*|*-help-*|*-debian-menus*) continue ;;
  esac
  dpkg-deb -x "$deb" "$STAGE"
  extracted=$((extracted + 1))
done
[ "$extracted" -gt 0 ] || vo_die "no .deb files were extracted"

# OmniDeck uses headless Impress/PDF export. These optional Java/GTK4/Qt6 media
# plugins are not used by that path and pull in libraries absent on supported
# Linux baselines. Remove them instead of requiring unrelated desktop/media stacks.
find "$STAGE/opt" \( -name 'libofficebean.so*' -o -name 'libavmediagtk.so*' -o -name 'libavmediaqt6.so*' \) -print -delete

# The version-numbered path can't be hardcoded; whole tree stays together so the
# relative symlinks dpkg-deb preserves keep working (never flatten program/).
SOFFICE_BIN="$(find "$STAGE/opt" -type f -name soffice.bin 2>/dev/null | head -n1)"
[ -n "$SOFFICE_BIN" ] || vo_die "no soffice.bin under $STAGE/opt - the bundle is unusable"
SOFFICE_DIR="$(dirname "$SOFFICE_BIN")"
SOFFICE="$SOFFICE_DIR/soffice"
[ -f "$SOFFICE" ] || vo_die "soffice.bin has no soffice launcher next to it in $SOFFICE_DIR"
chmod +x "$SOFFICE" "$SOFFICE_BIN"
[ -x "$SOFFICE" ] || vo_die "soffice launcher is not executable"

# Must be an ELF file (magic 7f 45 4c 46) whose e_machine (bytes 18-19) matches
# the requested architecture. Checked without letting a short/non-ELF file abort
# the script with an unrelated tool error.
MAGIC="$(od -An -tx1 -N4 "$SOFFICE_BIN" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//' || true)"
[ "$MAGIC" = "7f 45 4c 46" ] || vo_die "soffice.bin is not an ELF binary (magic bytes: '$MAGIC'); the bundle is unusable"
MACHINE="$(od -An -tx1 -j18 -N2 "$SOFFICE_BIN" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//' || true)"
[ "$MACHINE" = "$ELF_MACHINE" ] || vo_die "soffice.bin is not a $ARCH ELF binary (e_machine bytes: '$MACHINE')"

# Runtime dependencies that are NOT in the bundle must exist on the machine.
# (LibreOffice's own libraries resolve via its program directory.)
if command -v ldd >/dev/null 2>&1; then
  MISSING="$(LD_LIBRARY_PATH="$SOFFICE_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ldd "$SOFFICE_BIN" 2>&1 | grep -i 'not found' || true)"
  if [ -n "$MISSING" ]; then
    echo "$MISSING" >&2
    vo_die "soffice.bin needs system libraries that are not installed on this machine (listed above)"
  fi
else
  vo_die "ldd is required to verify runtime library dependencies"
fi

vo_expect_version "$SOFFICE" "$VERSION" 120
vo_smoke_convert "$SOFFICE" "$FIXTURE" "$SMOKE_PAGES"

{
  echo "libreoffice_version=$VERSION"
  echo "platform=linux-$ARCH"
  echo "source_url=$URL"
  echo "archive_sha256=$ARCHIVE_SHA"
  echo "launcher=${SOFFICE#"$STAGE"/}"
} > "$STAGE/OMNIDECK-LIBREOFFICE.txt"

REL_SOFFICE="${SOFFICE#"$STAGE"/}"
verify_final() {
  [ -x "$DEST_ABS/$REL_SOFFICE" ] || return 1
  vo_expect_version "$DEST_ABS/$REL_SOFFICE" "$VERSION" 120
}
vo_swap "$STAGE" "$DEST_ABS" "$BACKUP" verify_final

echo "LibreOffice $VERSION vendored at $DEST_ABS (launcher: $REL_SOFFICE)"
echo "Runtime is self-contained except for the system libraries ldd just verified (see README 'Linux runtime libraries')."
