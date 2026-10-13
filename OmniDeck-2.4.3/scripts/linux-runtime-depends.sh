#!/usr/bin/env bash
# Computes the REAL external runtime dependencies of the bundled LibreOffice
# (Linux) and writes them as a Tauri platform config override:
#
#   scripts/linux-runtime-depends.sh <bundle-dir> [out.json]
#   -> src-tauri/tauri.linux.conf.json   (merged automatically by `tauri build` on Linux)
#
# Why: the bundled runtime is NOT fully self-contained — LibreOffice links against
# system libraries (X11, fontconfig, cups, ...). A .deb/.rpm that does not declare
# them installs "successfully" and then fails to convert on a clean machine. We
# derive the list from the binaries themselves instead of guessing:
#   * ldd every ELF in the bundle (bundle dirs on LD_LIBRARY_PATH)
#   * every library resolved OUTSIDE the bundle must belong to a Debian package
#     (dpkg -S) -> bundle.linux.deb.depends
#   * the same sonames become RPM capabilities "<soname>()(64bit)" -> bundle.linux.rpm.depends
#   * any "not found" library, or a library no package owns, is a hard failure.
#
# Exit codes: 0 ok, 1 usage/environment, 2 unresolved/unowned library.
set -euo pipefail

BUNDLE_IN="${1:-}"; OUT="${2:-src-tauri/tauri.linux.conf.json}"
[ -n "$BUNDLE_IN" ] && [ -d "$BUNDLE_IN" ] || { echo "usage: $0 <bundle-dir> [out.json]" >&2; exit 1; }
for t in ldd file dpkg python3; do command -v "$t" >/dev/null 2>&1 || { echo "ERROR: '$t' is required" >&2; exit 1; }; done
BUNDLE="$(cd "$BUNDLE_IN" && pwd)"

LIBPATH="$(find "$BUNDLE" -type f -name '*.so*' -printf '%h\n' | sort -u | paste -sd: -)"
declare -A SONAME_PATH=()
UNRESOLVED=""
count=0
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q '^ELF' || continue
  count=$((count+1))
  out="$(LD_LIBRARY_PATH="$LIBPATH" ldd "$f" 2>/dev/null || true)"
  while IFS= read -r line; do
    case "$line" in
      *"not found"*) UNRESOLVED="$UNRESOLVED
$(basename "$f"): ${line#"${line%%[![:space:]]*}"}" ;;
      *"=> /"*)
        so="${line%%=>*}"; so="${so//[[:space:]]/}"
        p="${line#*=> }"; p="${p%% (*}"
        case "$p" in "$BUNDLE"/*) continue ;; esac
        SONAME_PATH["$so"]="$p" ;;
    esac
  done <<< "$out"
done < <(find "$BUNDLE" -type f \( -name '*.so*' -o -perm -u+x \) -print0)
[ "$count" -gt 0 ] || { echo "ERROR: no ELF files found under $BUNDLE" >&2; exit 1; }

if [ -n "$UNRESOLVED" ]; then
  echo "ERROR: libraries needed by the bundle are not available on this machine:$UNRESOLVED" >&2
  exit 2
fi

declare -A DEBPKG=()
unowned=""
for so in "${!SONAME_PATH[@]}"; do
  p="${SONAME_PATH[$so]}"; real="$(readlink -f "$p")"
  pkg=""
  for cand in "$p" "$real"; do
    pkg="$(dpkg -S "$cand" 2>/dev/null | head -n1 | cut -d: -f1 || true)"; [ -n "$pkg" ] && break
  done
  if [ -z "$pkg" ]; then unowned="$unowned
  $so -> $p"; else DEBPKG["$pkg"]=1; fi
done
if [ -n "$unowned" ]; then
  echo "ERROR: these libraries are not owned by any Debian package, so a .deb dependency cannot be declared:$unowned" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUT")"
DEBS="$(printf '%s\n' "${!DEBPKG[@]}" | sort | paste -sd, -)" SONAMES="$(printf '%s\n' "${!SONAME_PATH[@]}" | sort | paste -sd, -)" OUT="$OUT" python3 - <<'PY'
import json, os
debs = [d for d in os.environ["DEBS"].split(",") if d]
rpms = [s + "()(64bit)" for s in os.environ["SONAMES"].split(",") if s]
cfg = {"bundle": {"linux": {"deb": {"depends": debs}, "rpm": {"depends": rpms}}}}
open(os.environ["OUT"], "w").write(json.dumps(cfg, indent=2) + "\n")
print(f"{len(debs)} deb packages, {len(rpms)} rpm sonames")
PY
echo "Scanned $count ELF files under $BUNDLE; wrote $OUT"
