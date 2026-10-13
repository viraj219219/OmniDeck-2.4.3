#!/usr/bin/env bash
# Verifies the BUILT macOS .dmg (run on a macOS runner).
#   scripts/verify-macos-package.sh <bundle-dir> <x86_64|aarch64> [--require-signed]
# Checks: dmg mounts; OmniDeck.app contains the nested LibreOffice.app; every Mach-O in the
# bundled soffice is the right architecture (lipo); the nested app is validly signed; the
# bundled soffice reports the pinned version and converts a real .pptx to 3 pages; and with
# --require-signed the outer app passes Gatekeeper (spctl) and carries a stapled notarization ticket.
set -uo pipefail
DIR="${1:-}"; ARCH="${2:-}"; REQ="${3:-}"
[ -d "$DIR" ] && [ -n "$ARCH" ] || { echo "usage: $0 <bundle-dir> <x86_64|aarch64> [--require-signed]" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/scripts/libreoffice-version.txt")"
FIXTURE="$ROOT/src-tauri/test-fixtures/three-slides.pptx"
want="$ARCH"; [ "$ARCH" = "aarch64" ] && want="arm64"
FAILS=(); fail(){ FAILS+=("$1"); echo "FAIL: $1" >&2; }; ok(){ echo "ok:   $1"; }

DMG="$(ls "$DIR"/dmg/*.dmg 2>/dev/null | head -n1)"; [ -n "$DMG" ] || { echo "FAIL: no .dmg under $DIR/dmg" >&2; exit 1; }
MNT="$(mktemp -d)"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null || { echo "FAIL: dmg did not mount" >&2; exit 1; }
trap 'hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true' EXIT
APP="$(ls -d "$MNT"/*.app | head -n1)"; [ -n "$APP" ] && ok "dmg mounts and contains $(basename "$APP")" || { fail "no .app in dmg"; exit 1; }
LO="$APP/Contents/Resources/resources/libreoffice/LibreOffice.app"
SOFFICE="$LO/Contents/MacOS/soffice"
[ -x "$SOFFICE" ] && ok "nested LibreOffice.app is present at the path util.rs searches" || { fail "bundled LibreOffice.app missing at $LO"; }

if [ -x "$SOFFICE" ]; then
  archs="$(lipo -archs "$SOFFICE" 2>/dev/null)"
  echo "$archs" | grep -qw "$want" && ok "bundled soffice contains $want ($archs)" || fail "bundled soffice architectures '$archs' do not include $want"
  [ "$ARCH" = "x86_64" ] && { echo "$archs" | grep -qw arm64 && echo "note: soffice is a fat binary" || true; }
  codesign --verify --deep --strict "$LO" >/dev/null 2>&1 && ok "nested LibreOffice.app signature is valid" || fail "nested LibreOffice.app signature is INVALID"
  home="$(mktemp -d)"; ver="$("$SOFFICE" --headless --version 2>&1 | head -n1)"
  echo "$ver" | grep -q "$VERSION" && ok "bundled soffice reports $VERSION" || fail "bundled soffice version '$ver' != $VERSION"
  out="$(mktemp -d)"
  if timeout 300 "$SOFFICE" --headless --norestore "-env:UserInstallation=file://$home/profile" --convert-to pdf --outdir "$out" "$FIXTURE" >/tmp/omnideck-conv.log 2>&1; then
    pages="$(grep -a -c '/Type */Page[^s]' "$out/three-slides.pdf" 2>/dev/null || echo 0)"
    [ "$pages" -eq 3 ] && ok "mounted package converted a real .pptx to 3 pages" || fail "produced $pages pages, expected 3"
  else fail "conversion failed or timed out inside the mounted package"; cat /tmp/omnideck-conv.log >&2; fi
fi
main_arch="$(lipo -archs "$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info" CFBundleExecutable)" 2>/dev/null)"
echo "$main_arch" | grep -qw "$want" && ok "OmniDeck executable is $main_arch" || fail "OmniDeck executable architectures '$main_arch' do not include $want"
minos="$(defaults read "$APP/Contents/Info" LSMinimumSystemVersion 2>/dev/null)"; echo "LSMinimumSystemVersion=$minos"
[ "$minos" = "11.0" ] || fail "LSMinimumSystemVersion is '$minos', expected 11.0 (LibreOffice 26.x requires macOS 11)"

if [ "$REQ" = "--require-signed" ]; then
  codesign --verify --deep --strict "$APP" >/dev/null 2>&1 && ok "OmniDeck.app signature valid" || fail "OmniDeck.app signature invalid"
  spctl --assess --type execute -vv "$APP" >/dev/null 2>&1 && ok "Gatekeeper accepts OmniDeck.app (signed + notarized)" || fail "Gatekeeper REJECTS OmniDeck.app"
  xcrun stapler validate "$APP" >/dev/null 2>&1 && ok "notarization ticket is stapled" || fail "no stapled notarization ticket"
else echo "note: signing/notarization NOT checked (no --require-signed)"; fi

[ "${#FAILS[@]}" -eq 0 ] || { echo "MACOS PACKAGE VERIFICATION FAILED (${#FAILS[@]})" >&2; exit 1; }
echo "macOS package verification passed ($ARCH)."
