#!/usr/bin/env bash
# Verify the built Linux installers, not the development tree.
# Usage: verify-linux-package.sh <bundle-dir> [--no-install]
set -uo pipefail
DIR="${1:-}"
MODE="${2:-}"
[ -d "$DIR" ] || { echo "usage: $0 <bundle-dir> [--no-install]" >&2; exit 1; }
DIR="$(cd "$DIR" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/scripts/libreoffice-version.txt")"
FIXTURE="$ROOT/src-tauri/test-fixtures/three-slides.pptx"
FAILS=()
fail() { FAILS+=("$1"); echo "FAIL: $1" >&2; }
ok() { echo "ok: $1"; }
one() { local subdir="${1%%/*}"; local pattern="${1#*/}"; find "$DIR/$subdir" -maxdepth 1 -type f -name "$pattern" 2>/dev/null | head -n 1; }

DEB="$(one deb/*.deb)"
RPM="$(one rpm/*.rpm)"
APPIMG="$(one appimage/*.AppImage)"
[ -n "$DEB" ] || fail "no .deb found under $DIR/deb"
[ -n "$RPM" ] || fail "no .rpm found under $DIR/rpm"
[ -n "$APPIMG" ] || fail "no .AppImage found under $DIR/appimage"

if [ -n "$DEB" ]; then
  listing="$(dpkg-deb -c "$DEB" 2>/dev/null || true)"
  if printf '%s\n' "$listing" | grep -Eq '/resources/libreoffice/opt/libreoffice[0-9.]*/program/soffice\.bin$'; then
    ok "deb contains soffice.bin"
  else
    fail "deb does not contain the bundled soffice.bin"
    printf '%s\n' "$listing" | grep -E 'soffice(\.bin)?$|libreoffice' | head -n 80 >&2 || true
  fi
  if printf '%s\n' "$listing" | grep -Eq '/resources/libreoffice/opt/libreoffice[0-9.]*/program/soffice$'; then
    ok "deb contains the soffice launcher"
  else
    fail "deb does not contain the bundled soffice launcher"
  fi
  if printf '%s\n' "$listing" | grep -E '/resources/libreoffice/opt/libreoffice[0-9.]*/program/soffice\.bin$' | grep -Eq '^-rwx'; then
    ok "soffice.bin keeps its executable bit in the deb"
  else
    fail "soffice.bin lost its executable bit in the deb"
  fi
  depends="$(dpkg-deb -f "$DEB" Depends 2>/dev/null || true)"
  [ -n "$depends" ] && ok "deb declares Depends ($(printf '%s' "$depends" | tr ',' '\n' | wc -l) entries)" || fail "deb has no Depends: runtime libraries are undeclared (was scripts/linux-runtime-depends.sh run before the build?)"
  printf '%s' "$depends" | grep -q 'libc6' || fail "deb Depends lacks libc6 (list looks incomplete)"
  if printf '%s' "$depends" | grep -Eq 'libreoffice(-impress|-core)'; then
    fail "deb depends on a SYSTEM LibreOffice, which defeats the bundled runtime"
  else
    ok "deb does not depend on a system LibreOffice"
  fi
fi

if [ -n "$RPM" ]; then
  if command -v rpm >/dev/null 2>&1; then
    if rpm -qpl "$RPM" | grep -Eq '/resources/libreoffice/opt/libreoffice[0-9.]*/program/soffice\.bin$'; then ok "rpm contains soffice.bin"; else fail "rpm does not contain the bundled soffice.bin"; fi
    req="$(rpm -qpR "$RPM" 2>/dev/null || true)"
    printf '%s\n' "$req" | grep -q '\.so' && ok "rpm declares shared-library requirements" || fail "rpm declares no soname requirements"
    if printf '%s\n' "$req" | grep -Eqi '^libreoffice'; then fail "rpm requires a SYSTEM LibreOffice"; else ok "rpm does not require a system LibreOffice"; fi
  else
    fail "rpm tool not installed on this runner, so the rpm could not be inspected (apt-get install rpm)"
  fi
fi

if [ -n "$APPIMG" ]; then
  tmp="$(mktemp -d)"
  if ( cd "$tmp" && cp "$APPIMG" app.AppImage && chmod +x app.AppImage && ./app.AppImage --appimage-extract >/dev/null 2>&1 ); then
    sb="$(find "$tmp/squashfs-root" -type f -name soffice.bin 2>/dev/null | head -n 1)"
    if [ -n "$sb" ] && [ -x "$sb" ]; then ok "AppImage contains an executable soffice.bin"; else fail "AppImage lacks an executable bundled soffice.bin"; fi
  else
    fail "AppImage extraction failed"
  fi
  rm -rf "$tmp"
fi

if [ "$MODE" != "--no-install" ] && [ -n "$DEB" ]; then
  pkg="$(dpkg-deb -f "$DEB" Package)"
  if sudo apt-get install -y "$DEB" >/tmp/omnideck-apt.log 2>&1; then
    ok "deb installs on a clean runner with its declared Depends"
    inst="$(dpkg -L "$pkg" | grep -E '/program/soffice$' | head -n 1)"
    if [ -z "$inst" ]; then
      fail "installed package has no program/soffice (dpkg -L $pkg)"
    else
      echo "installed soffice: $inst"
      home="$(mktemp -d)"
      ver="$(env -i HOME="$home" PATH=/usr/bin:/bin "$inst" --headless --version 2>&1 | head -n 1)"
      if printf '%s' "$ver" | grep -q "$VERSION"; then ok "installed runtime reports LibreOffice $VERSION"; else fail "installed runtime version is '$ver', expected $VERSION"; fi
      out="$(mktemp -d)"
      if timeout 240 env -i HOME="$home" PATH=/usr/bin:/bin "$inst" --headless --norestore "-env:UserInstallation=file://$home/profile" --convert-to pdf --outdir "$out" "$FIXTURE" >/tmp/omnideck-conv.log 2>&1; then
        pages="$(grep -a -c '/Type */Page[^s]' "$out/three-slides.pdf" 2>/dev/null || true)"
        [ "${pages:-0}" -eq 3 ] && ok "INSTALLED runtime converted a real .pptx to a 3-page PDF" || fail "installed runtime produced ${pages:-0} pages, expected 3"
      else
        fail "installed runtime failed/timed out converting the fixture (see /tmp/omnideck-conv.log)"
        cat /tmp/omnideck-conv.log >&2
      fi
      rm -rf "$home" "$out"
    fi
  else
    fail "deb did not install cleanly: $(tail -n 5 /tmp/omnideck-apt.log | tr '\n' ' ')"
  fi
elif [ "$MODE" = "--no-install" ]; then
  echo "note: install/convert test skipped (--no-install); only static package checks ran"
fi

if [ "${#FAILS[@]}" -gt 0 ]; then echo "LINUX PACKAGE VERIFICATION FAILED (${#FAILS[@]})" >&2; exit 1; fi
echo "Linux package verification passed."
