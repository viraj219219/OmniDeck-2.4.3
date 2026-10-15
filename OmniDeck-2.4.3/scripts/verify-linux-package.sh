#!/usr/bin/env bash
# Verifies the BUILT Linux installers (not the dev tree).
#   scripts/verify-linux-package.sh <bundle-dir> [--no-install]
# <bundle-dir> = src-tauri/target/release/bundle  (contains deb/ rpm/ appimage/)
#
# deb       : bundled soffice + soffice.bin are inside the package under .../resources/libreoffice/opt/libreoffice*/program,
#             Depends is non-empty and declares the libraries the runtime links against, and the
#             runtime does NOT depend on a system LibreOffice.
#             Unless --no-install: the package is really installed (apt resolves Depends), the
#             INSTALLED soffice is located through dpkg -L, started with a minimal environment,
#             must report the pinned version and convert a real .pptx to a 3-page PDF.
# rpm       : contains soffice.bin and declares soname requirements.
# AppImage  : extracted; bundled soffice.bin present and executable.
# Exit 0 only if everything passes; every failure is listed.
set -uo pipefail
DIR="${1:-}"; MODE="${2:-}"
[ -d "$DIR" ] || { echo "usage: $0 <bundle-dir> [--no-install]" >&2; exit 1; }
# Normalize paths because AppImage inspection changes into a temporary directory.
DIR="$(cd "$DIR" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/scripts/libreoffice-version.txt")"
FIXTURE="$ROOT/src-tauri/test-fixtures/three-slides.pptx"
FAILS=()
fail() { FAILS+=("$1"); echo "FAIL: $1" >&2; }
ok()   { echo "ok:   $1"; }

one() { ls "$DIR"/$1 2>/dev/null | head -n1; }
DEB="$(one 'deb/*.deb')"; RPM="$(one 'rpm/*.rpm')"; APPIMG="$(one 'appimage/*.AppImage')"
[ -n "$DEB" ]    || fail "no .deb found under $DIR/deb"
[ -n "$RPM" ]    || fail "no .rpm found under $DIR/rpm"
[ -n "$APPIMG" ] || fail "no .AppImage found under $DIR/appimage"

if [ -n "$DEB" ]; then
  listing="$(dpkg-deb -c "$DEB")"
  if printf '%s\n' "$listing" | grep -E '/resources/libreoffice/opt/libreoffice[0-9.]*/program/soffice\.bin
  depends="$(dpkg-deb -f "$DEB" Depends 2>/dev/null || true)"
  [ -n "$depends" ] && ok "deb declares Depends ($(echo "$depends" | tr ',' '\n' | wc -l) entries)" || fail "deb has no Depends: runtime libraries are undeclared (was scripts/linux-runtime-depends.sh run before the build?)"
  echo "$depends" | grep -q 'libc6' || fail "deb Depends lacks libc6 (list looks incomplete)"
  echo "$depends" | grep -Eq 'libreoffice(-impress|-core)' && fail "deb depends on a SYSTEM LibreOffice, which defeats the bundled runtime" || ok "deb does not depend on a system LibreOffice"
fi

if [ -n "$RPM" ]; then
  if command -v rpm >/dev/null 2>&1; then
    rpm -qpl "$RPM" | grep -Eq '/resources/libreoffice/opt/libreoffice[0-9.]*/program/soffice\.bin$' && ok "rpm contains soffice.bin" || fail "rpm does not contain the bundled soffice.bin"
    req="$(rpm -qpR "$RPM")"
    echo "$req" | grep -q '\.so' && ok "rpm declares shared-library requirements" || fail "rpm declares no soname requirements"
    echo "$req" | grep -Eqi '^libreoffice' && fail "rpm requires a SYSTEM LibreOffice" || ok "rpm does not require a system LibreOffice"
  else
    fail "rpm tool not installed on this runner, so the rpm could not be inspected (apt-get install rpm)"
  fi
fi

if [ -n "$APPIMG" ]; then
  tmp="$(mktemp -d)"; ( cd "$tmp" && cp "$APPIMG" app.AppImage && chmod +x app.AppImage && ./app.AppImage --appimage-extract >/dev/null 2>&1 )
  sb="$(find "$tmp/squashfs-root" -type f -name soffice.bin 2>/dev/null | head -n1)"
  if [ -n "$sb" ] && [ -x "$sb" ]; then ok "AppImage contains an executable soffice.bin"; else fail "AppImage lacks an executable bundled soffice.bin"; fi
  rm -rf "$tmp"
fi

if [ "$MODE" != "--no-install" ] && [ -n "$DEB" ]; then
  pkg="$(dpkg-deb -f "$DEB" Package)"
  if sudo apt-get install -y "$DEB" >/tmp/omnideck-apt.log 2>&1; then
    ok "deb installs on a clean runner with its declared Depends"
    inst="$(dpkg -L "$pkg" | grep -E '/program/soffice$' | head -n1)"
    if [ -z "$inst" ]; then fail "installed package has no program/soffice (dpkg -L $pkg)"; else
      echo "installed soffice: $inst"
      home="$(mktemp -d)"
      ver="$(env -i HOME="$home" PATH=/usr/bin:/bin "$inst" --headless --version 2>&1 | head -n1)"
      echo "$ver" | grep -q "$VERSION" && ok "installed runtime reports LibreOffice $VERSION" || fail "installed runtime version is '$ver', expected $VERSION"
      out="$(mktemp -d)"
      if timeout 240 env -i HOME="$home" PATH=/usr/bin:/bin "$inst" --headless --norestore "-env:UserInstallation=file://$home/profile" --convert-to pdf --outdir "$out" "$FIXTURE" >/tmp/omnideck-conv.log 2>&1; then
        pages="$(grep -a -c '/Type */Page[^s]' "$out/three-slides.pdf" 2>/dev/null || echo 0)"
        [ "$pages" -eq 3 ] && ok "INSTALLED runtime converted a real .pptx to a 3-page PDF" || fail "installed runtime produced $pages pages, expected 3"
      else fail "installed runtime failed/timed out converting the fixture (see /tmp/omnideck-conv.log)"; cat /tmp/omnideck-conv.log >&2; fi
    fi
  else fail "deb did not install cleanly: $(tail -n5 /tmp/omnideck-apt.log | tr '\n' ' ')"; fi
elif [ "$MODE" = "--no-install" ]; then echo "note: install/convert test skipped (--no-install); only static package checks ran"; fi

if [ "${#FAILS[@]}" -gt 0 ]; then echo "LINUX PACKAGE VERIFICATION FAILED (${#FAILS[@]})" >&2; exit 1; fi
echo "Linux package verification passed."
 >/dev/null; then
    ok "deb contains soffice.bin"
  else
    fail "deb does not contain the bundled soffice.bin"
    printf '%s\n' "$listing" | grep -E 'soffice(\.bin)?$|libreoffice' | head -n 80 >&2 || true
  fi
  if printf '%s\n' "$listing" | grep -E '/resources/libreoffice/opt/libreoffice[0-9.]*/program/soffice
  depends="$(dpkg-deb -f "$DEB" Depends 2>/dev/null || true)"
  [ -n "$depends" ] && ok "deb declares Depends ($(echo "$depends" | tr ',' '\n' | wc -l) entries)" || fail "deb has no Depends: runtime libraries are undeclared (was scripts/linux-runtime-depends.sh run before the build?)"
  echo "$depends" | grep -q 'libc6' || fail "deb Depends lacks libc6 (list looks incomplete)"
  echo "$depends" | grep -Eq 'libreoffice(-impress|-core)' && fail "deb depends on a SYSTEM LibreOffice, which defeats the bundled runtime" || ok "deb does not depend on a system LibreOffice"
fi

if [ -n "$RPM" ]; then
  if command -v rpm >/dev/null 2>&1; then
    rpm -qpl "$RPM" | grep -Eq '/resources/libreoffice/opt/libreoffice[0-9.]*/program/soffice\.bin$' && ok "rpm contains soffice.bin" || fail "rpm does not contain the bundled soffice.bin"
    req="$(rpm -qpR "$RPM")"
    echo "$req" | grep -q '\.so' && ok "rpm declares shared-library requirements" || fail "rpm declares no soname requirements"
    echo "$req" | grep -Eqi '^libreoffice' && fail "rpm requires a SYSTEM LibreOffice" || ok "rpm does not require a system LibreOffice"
  else
    fail "rpm tool not installed on this runner, so the rpm could not be inspected (apt-get install rpm)"
  fi
fi

if [ -n "$APPIMG" ]; then
  tmp="$(mktemp -d)"; ( cd "$tmp" && cp "$APPIMG" app.AppImage && chmod +x app.AppImage && ./app.AppImage --appimage-extract >/dev/null 2>&1 )
  sb="$(find "$tmp/squashfs-root" -type f -name soffice.bin 2>/dev/null | head -n1)"
  if [ -n "$sb" ] && [ -x "$sb" ]; then ok "AppImage contains an executable soffice.bin"; else fail "AppImage lacks an executable bundled soffice.bin"; fi
  rm -rf "$tmp"
fi

if [ "$MODE" != "--no-install" ] && [ -n "$DEB" ]; then
  pkg="$(dpkg-deb -f "$DEB" Package)"
  if sudo apt-get install -y "$DEB" >/tmp/omnideck-apt.log 2>&1; then
    ok "deb installs on a clean runner with its declared Depends"
    inst="$(dpkg -L "$pkg" | grep -E '/program/soffice$' | head -n1)"
    if [ -z "$inst" ]; then fail "installed package has no program/soffice (dpkg -L $pkg)"; else
      echo "installed soffice: $inst"
      home="$(mktemp -d)"
      ver="$(env -i HOME="$home" PATH=/usr/bin:/bin "$inst" --headless --version 2>&1 | head -n1)"
      echo "$ver" | grep -q "$VERSION" && ok "installed runtime reports LibreOffice $VERSION" || fail "installed runtime version is '$ver', expected $VERSION"
      out="$(mktemp -d)"
      if timeout 240 env -i HOME="$home" PATH=/usr/bin:/bin "$inst" --headless --norestore "-env:UserInstallation=file://$home/profile" --convert-to pdf --outdir "$out" "$FIXTURE" >/tmp/omnideck-conv.log 2>&1; then
        pages="$(grep -a -c '/Type */Page[^s]' "$out/three-slides.pdf" 2>/dev/null || echo 0)"
        [ "$pages" -eq 3 ] && ok "INSTALLED runtime converted a real .pptx to a 3-page PDF" || fail "installed runtime produced $pages pages, expected 3"
      else fail "installed runtime failed/timed out converting the fixture (see /tmp/omnideck-conv.log)"; cat /tmp/omnideck-conv.log >&2; fi
    fi
  else fail "deb did not install cleanly: $(tail -n5 /tmp/omnideck-apt.log | tr '\n' ' ')"; fi
elif [ "$MODE" = "--no-install" ]; then echo "note: install/convert test skipped (--no-install); only static package checks ran"; fi

if [ "${#FAILS[@]}" -gt 0 ]; then echo "LINUX PACKAGE VERIFICATION FAILED (${#FAILS[@]})" >&2; exit 1; fi
echo "Linux package verification passed."
 >/dev/null; then
    ok "deb contains the soffice launcher"
  else
    fail "deb does not contain the bundled soffice launcher"
  fi
  if printf '%s\n' "$listing" | grep -E -- '-rwx.*/program/soffice\.bin
  depends="$(dpkg-deb -f "$DEB" Depends 2>/dev/null || true)"
  [ -n "$depends" ] && ok "deb declares Depends ($(echo "$depends" | tr ',' '\n' | wc -l) entries)" || fail "deb has no Depends: runtime libraries are undeclared (was scripts/linux-runtime-depends.sh run before the build?)"
  echo "$depends" | grep -q 'libc6' || fail "deb Depends lacks libc6 (list looks incomplete)"
  echo "$depends" | grep -Eq 'libreoffice(-impress|-core)' && fail "deb depends on a SYSTEM LibreOffice, which defeats the bundled runtime" || ok "deb does not depend on a system LibreOffice"
fi

if [ -n "$RPM" ]; then
  if command -v rpm >/dev/null 2>&1; then
    rpm -qpl "$RPM" | grep -Eq '/resources/libreoffice/opt/libreoffice[0-9.]*/program/soffice\.bin$' && ok "rpm contains soffice.bin" || fail "rpm does not contain the bundled soffice.bin"
    req="$(rpm -qpR "$RPM")"
    echo "$req" | grep -q '\.so' && ok "rpm declares shared-library requirements" || fail "rpm declares no soname requirements"
    echo "$req" | grep -Eqi '^libreoffice' && fail "rpm requires a SYSTEM LibreOffice" || ok "rpm does not require a system LibreOffice"
  else
    fail "rpm tool not installed on this runner, so the rpm could not be inspected (apt-get install rpm)"
  fi
fi

if [ -n "$APPIMG" ]; then
  tmp="$(mktemp -d)"; ( cd "$tmp" && cp "$APPIMG" app.AppImage && chmod +x app.AppImage && ./app.AppImage --appimage-extract >/dev/null 2>&1 )
  sb="$(find "$tmp/squashfs-root" -type f -name soffice.bin 2>/dev/null | head -n1)"
  if [ -n "$sb" ] && [ -x "$sb" ]; then ok "AppImage contains an executable soffice.bin"; else fail "AppImage lacks an executable bundled soffice.bin"; fi
  rm -rf "$tmp"
fi

if [ "$MODE" != "--no-install" ] && [ -n "$DEB" ]; then
  pkg="$(dpkg-deb -f "$DEB" Package)"
  if sudo apt-get install -y "$DEB" >/tmp/omnideck-apt.log 2>&1; then
    ok "deb installs on a clean runner with its declared Depends"
    inst="$(dpkg -L "$pkg" | grep -E '/program/soffice$' | head -n1)"
    if [ -z "$inst" ]; then fail "installed package has no program/soffice (dpkg -L $pkg)"; else
      echo "installed soffice: $inst"
      home="$(mktemp -d)"
      ver="$(env -i HOME="$home" PATH=/usr/bin:/bin "$inst" --headless --version 2>&1 | head -n1)"
      echo "$ver" | grep -q "$VERSION" && ok "installed runtime reports LibreOffice $VERSION" || fail "installed runtime version is '$ver', expected $VERSION"
      out="$(mktemp -d)"
      if timeout 240 env -i HOME="$home" PATH=/usr/bin:/bin "$inst" --headless --norestore "-env:UserInstallation=file://$home/profile" --convert-to pdf --outdir "$out" "$FIXTURE" >/tmp/omnideck-conv.log 2>&1; then
        pages="$(grep -a -c '/Type */Page[^s]' "$out/three-slides.pdf" 2>/dev/null || echo 0)"
        [ "$pages" -eq 3 ] && ok "INSTALLED runtime converted a real .pptx to a 3-page PDF" || fail "installed runtime produced $pages pages, expected 3"
      else fail "installed runtime failed/timed out converting the fixture (see /tmp/omnideck-conv.log)"; cat /tmp/omnideck-conv.log >&2; fi
    fi
  else fail "deb did not install cleanly: $(tail -n5 /tmp/omnideck-apt.log | tr '\n' ' ')"; fi
elif [ "$MODE" = "--no-install" ]; then echo "note: install/convert test skipped (--no-install); only static package checks ran"; fi

if [ "${#FAILS[@]}" -gt 0 ]; then echo "LINUX PACKAGE VERIFICATION FAILED (${#FAILS[@]})" >&2; exit 1; fi
echo "Linux package verification passed."
 >/dev/null; then
    ok "soffice.bin keeps its executable bit in the deb"
  else
    fail "soffice.bin lost its executable bit in the deb"
  fi
  depends="$(dpkg-deb -f "$DEB" Depends 2>/dev/null || true)"
  [ -n "$depends" ] && ok "deb declares Depends ($(echo "$depends" | tr ',' '\n' | wc -l) entries)" || fail "deb has no Depends: runtime libraries are undeclared (was scripts/linux-runtime-depends.sh run before the build?)"
  echo "$depends" | grep -q 'libc6' || fail "deb Depends lacks libc6 (list looks incomplete)"
  echo "$depends" | grep -Eq 'libreoffice(-impress|-core)' && fail "deb depends on a SYSTEM LibreOffice, which defeats the bundled runtime" || ok "deb does not depend on a system LibreOffice"
fi

if [ -n "$RPM" ]; then
  if command -v rpm >/dev/null 2>&1; then
    rpm -qpl "$RPM" | grep -Eq '/resources/libreoffice/opt/libreoffice[0-9.]*/program/soffice\.bin$' && ok "rpm contains soffice.bin" || fail "rpm does not contain the bundled soffice.bin"
    req="$(rpm -qpR "$RPM")"
    echo "$req" | grep -q '\.so' && ok "rpm declares shared-library requirements" || fail "rpm declares no soname requirements"
    echo "$req" | grep -Eqi '^libreoffice' && fail "rpm requires a SYSTEM LibreOffice" || ok "rpm does not require a system LibreOffice"
  else
    fail "rpm tool not installed on this runner, so the rpm could not be inspected (apt-get install rpm)"
  fi
fi

if [ -n "$APPIMG" ]; then
  tmp="$(mktemp -d)"; ( cd "$tmp" && cp "$APPIMG" app.AppImage && chmod +x app.AppImage && ./app.AppImage --appimage-extract >/dev/null 2>&1 )
  sb="$(find "$tmp/squashfs-root" -type f -name soffice.bin 2>/dev/null | head -n1)"
  if [ -n "$sb" ] && [ -x "$sb" ]; then ok "AppImage contains an executable soffice.bin"; else fail "AppImage lacks an executable bundled soffice.bin"; fi
  rm -rf "$tmp"
fi

if [ "$MODE" != "--no-install" ] && [ -n "$DEB" ]; then
  pkg="$(dpkg-deb -f "$DEB" Package)"
  if sudo apt-get install -y "$DEB" >/tmp/omnideck-apt.log 2>&1; then
    ok "deb installs on a clean runner with its declared Depends"
    inst="$(dpkg -L "$pkg" | grep -E '/program/soffice$' | head -n1)"
    if [ -z "$inst" ]; then fail "installed package has no program/soffice (dpkg -L $pkg)"; else
      echo "installed soffice: $inst"
      home="$(mktemp -d)"
      ver="$(env -i HOME="$home" PATH=/usr/bin:/bin "$inst" --headless --version 2>&1 | head -n1)"
      echo "$ver" | grep -q "$VERSION" && ok "installed runtime reports LibreOffice $VERSION" || fail "installed runtime version is '$ver', expected $VERSION"
      out="$(mktemp -d)"
      if timeout 240 env -i HOME="$home" PATH=/usr/bin:/bin "$inst" --headless --norestore "-env:UserInstallation=file://$home/profile" --convert-to pdf --outdir "$out" "$FIXTURE" >/tmp/omnideck-conv.log 2>&1; then
        pages="$(grep -a -c '/Type */Page[^s]' "$out/three-slides.pdf" 2>/dev/null || echo 0)"
        [ "$pages" -eq 3 ] && ok "INSTALLED runtime converted a real .pptx to a 3-page PDF" || fail "installed runtime produced $pages pages, expected 3"
      else fail "installed runtime failed/timed out converting the fixture (see /tmp/omnideck-conv.log)"; cat /tmp/omnideck-conv.log >&2; fi
    fi
  else fail "deb did not install cleanly: $(tail -n5 /tmp/omnideck-apt.log | tr '\n' ' ')"; fi
elif [ "$MODE" = "--no-install" ]; then echo "note: install/convert test skipped (--no-install); only static package checks ran"; fi

if [ "${#FAILS[@]}" -gt 0 ]; then echo "LINUX PACKAGE VERIFICATION FAILED (${#FAILS[@]})" >&2; exit 1; fi
echo "Linux package verification passed."
