#!/usr/bin/env bash
# Bundle the official LibreOffice macOS app into OmniDeck resources.
# Usage: scripts/vendor-libreoffice-macos.sh [x86_64|aarch64] [destination]
#
# ONE architecture per run, on a NATIVE runner (validation executes the app):
#   Apple Silicon runner -> aarch64     Intel runner -> x86_64
# The matching OmniDeck build must then use the same Rust target, so the app and
# its LibreOffice runtime are always the same CPU architecture (no universal
# build can carry a single-architecture LibreOffice).
#
# Fail-closed: SHA-256, vendor signature + notarization (spctl), Mach-O
# architecture, `--version` (exit code AND version string) and a real
# PPTX->PDF conversion must all pass before the destination is replaced.
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

case "$(uname -m)" in
  arm64|aarch64) HOST_ARCH="aarch64" ;;
  x86_64) HOST_ARCH="x86_64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 2 ;;
esac
[ -n "$ARCH" ] || ARCH="$HOST_ARCH"
case "$ARCH" in
  aarch64) FILE_ARCH="aarch64"; MACHO_ARCH="arm64" ;;
  x86_64)  FILE_ARCH="x86-64";  MACHO_ARCH="x86_64" ;;
  *) echo "Architecture must be x86_64 or aarch64 (got: $ARCH)" >&2; exit 2 ;;
esac
[ "$HOST_ARCH" = "$ARCH" ] || vo_die "target $ARCH but this Mac is $HOST_ARCH; vendor each architecture on its native runner (validation executes the app)"
for tool in hdiutil codesign spctl lipo ditto curl; do
  command -v "$tool" >/dev/null 2>&1 || vo_die "$tool is required (this script only runs on macOS)"
done

case "$DEST" in /*) DEST_ABS="$DEST" ;; *) DEST_ABS="$(pwd)/$DEST" ;; esac
PARENT="$(dirname "$DEST_ABS")"
mkdir -p "$PARENT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/omnideck-lo.XXXXXX")"
MOUNT="$WORK/mount"
STAGE="$PARENT/libreoffice-staging-$$"
BACKUP="$PARENT/libreoffice-backup-$$"
CACHE="${OMNIDECK_VENDOR_CACHE:-${TMPDIR:-/tmp}/omnideck-lo-cache}"
mkdir -p "$MOUNT" "$CACHE"
ATTACHED=0
cleanup() {
  if [ "$ATTACHED" -eq 1 ]; then hdiutil detach "$MOUNT" -quiet -force >/dev/null 2>&1 || true; fi
  rm -rf "$WORK" "$STAGE"
}
trap cleanup EXIT
rm -rf "$PARENT"/libreoffice-staging-* "$PARENT"/libreoffice-backup-*

DMG="LibreOffice_${VERSION}_MacOS_${FILE_ARCH}.dmg"
URL="$(vo_base_url)/${VERSION}/mac/${ARCH}/${DMG}"
echo "Vendoring official LibreOffice $VERSION for macOS $ARCH"
vo_download "$URL" "$CACHE/$DMG" "$MIN_BYTES" "$(vo_pinned_sha256 "$VERSION:macos-$ARCH")"
DMG_SHA="$(vo_sha256 "$CACHE/$DMG")"

hdiutil attach "$CACHE/$DMG" -readonly -nobrowse -mountpoint "$MOUNT" >/dev/null || vo_die "could not mount $DMG"
ATTACHED=1

APP="$(find "$MOUNT" -maxdepth 3 -type d -name 'LibreOffice.app' -print -quit)"
[ -n "$APP" ] && [ -x "$APP/Contents/MacOS/soffice" ] || vo_die "the DMG does not contain LibreOffice.app/Contents/MacOS/soffice"

# Vendor signature (valid, sealed, strict) AND Gatekeeper/notarization acceptance.
codesign --verify --deep --strict --verbose=2 "$APP" || vo_die "LibreOffice.app signature verification failed"
SPCTL_OUT="$(spctl --assess --type execute --verbose=2 "$APP" 2>&1)" || vo_die "Gatekeeper rejected LibreOffice.app: $SPCTL_OUT"
echo "Gatekeeper: $SPCTL_OUT"
TEAM_ID="$(codesign -dv --verbose=2 "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -n1)"
case "$TEAM_ID" in ""|"not set") vo_die "LibreOffice.app has no Developer ID TeamIdentifier" ;; esac

mkdir -p "$STAGE"
ditto "$APP" "$STAGE/LibreOffice.app"
hdiutil detach "$MOUNT" -quiet || vo_die "could not unmount the DMG"
ATTACHED=0
rm -f "$CACHE/$DMG"   # verified + copied; don't leave ~350 MB behind

STAGED="$STAGE/LibreOffice.app/Contents/MacOS/soffice"
[ -x "$STAGED" ] || vo_die "staged LibreOffice.app is missing its executable"
# Copy must still be validly signed, by the same team, and the right architecture.
codesign --verify --deep --strict "$STAGE/LibreOffice.app" || vo_die "staged copy no longer verifies (copy damaged the signature)"
STAGED_TEAM="$(codesign -dv --verbose=2 "$STAGE/LibreOffice.app" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -n1)"
[ "$STAGED_TEAM" = "$TEAM_ID" ] || vo_die "staged copy TeamIdentifier '$STAGED_TEAM' differs from the DMG's '$TEAM_ID'"
ARCHS="$(lipo -archs "$STAGED" 2>&1)" || vo_die "lipo could not read $STAGED: $ARCHS"
case " $ARCHS " in *" $MACHO_ARCH "*) ;; *) vo_die "soffice architectures are '$ARCHS', expected '$MACHO_ARCH'" ;; esac

# Keep the signed staged app pristine: smoke-test a disposable copy so first-launch
# caches cannot alter the signed bundle that will be installed.
SMOKE_APP="$WORK/LibreOffice-smoke.app"
ditto "$STAGE/LibreOffice.app" "$SMOKE_APP"
SMOKE_SOFFICE="$SMOKE_APP/Contents/MacOS/soffice"
vo_expect_version "$SMOKE_SOFFICE" "$VERSION" 180
vo_smoke_convert "$SMOKE_SOFFICE" "$FIXTURE" "$SMOKE_PAGES"
codesign --verify --deep --strict "$STAGE/LibreOffice.app" || vo_die "staged signed app changed during smoke validation"

{
  echo "libreoffice_version=$VERSION"
  echo "platform=macos-$ARCH"
  echo "source_url=$URL"
  echo "archive_sha256=$DMG_SHA"
  echo "team_identifier=$TEAM_ID"
  echo "launcher=LibreOffice.app/Contents/MacOS/soffice"
} > "$STAGE/OMNIDECK-LIBREOFFICE.txt"

verify_final() {
  [ -x "$DEST_ABS/LibreOffice.app/Contents/MacOS/soffice" ] || return 1
  codesign --verify --deep --strict "$DEST_ABS/LibreOffice.app" || return 1
  vo_expect_version "$DEST_ABS/LibreOffice.app/Contents/MacOS/soffice" "$VERSION" 180
}
vo_swap "$STAGE" "$DEST_ABS" "$BACKUP" verify_final

echo "LibreOffice $VERSION ($ARCH, team $TEAM_ID) vendored at $DEST_ABS"
