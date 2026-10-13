#!/usr/bin/env bash
# Shared helpers for scripts/vendor-libreoffice-{linux,macos}.sh.
# Sourced, never executed. Written for bash 3.2 (macOS /bin/bash) and newer:
# no associative arrays, no mapfile, no ${var,,}.

vo_die() { echo "ERROR: $*" >&2; exit 1; }

# SHA-256 pins, one per "<version>:<platform>-<arch>".
# POLICY (fail-closed): every download MUST match a pin committed below. There is
# deliberately NO fallback to a checksum fetched from the same server as the
# archive: that only proves the file wasn't truncated, not that it is the file
# we trust. If a key has no pin the script refuses to build a bundle.
#
# To create a pin (once per version/platform, from a trusted network, ideally
# cross-checked against the signed release announcement / a second mirror):
#   OMNIDECK_PIN_DISCOVERY=1 scripts/vendor-libreoffice-linux.sh x86_64
# prints "Computed SHA-256" and exits 3 WITHOUT producing a bundle. Copy the
# value into the matching line below and commit. Discovery is refused on GitHub
# Actions so a release can never run it.
vo_pinned_sha256() {
  # Test-only override, honoured ONLY together with the test-only base-URL
  # override (a local fixture server) and never on GitHub Actions.
  if [ -n "${OMNIDECK_TEST_PINNED_SHA256:-}" ] && [ -n "${OMNIDECK_LO_BASE_URL:-}" ] && [ "${GITHUB_ACTIONS:-}" != "true" ]; then
    echo "$OMNIDECK_TEST_PINNED_SHA256"; return 0
  fi
  case "$1" in
    # "26.8.0:linux-x86_64")  echo "<64 hex chars>" ;;
    # "26.8.0:linux-aarch64") echo "<64 hex chars>" ;;
    # "26.8.0:macos-x86_64")  echo "<64 hex chars>" ;;
    # "26.8.0:macos-aarch64") echo "<64 hex chars>" ;;
    *) echo "" ;;
  esac
}

vo_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print tolower($1)}'
  else vo_die "neither sha256sum nor shasum is available to verify the download"; fi
}

vo_file_size() { wc -c < "$1" | tr -d '[:space:]'; }

# vo_base_url <version>: official host. OMNIDECK_LO_BASE_URL exists ONLY so the
# test-suite can point the scripts at a local fixture server; it never bypasses
# the hash policy, and it is refused on GitHub Actions so a release can't use it.
vo_base_url() {
  if [ -n "${OMNIDECK_LO_BASE_URL:-}" ]; then
    [ "${GITHUB_ACTIONS:-}" != "true" ] || vo_die "OMNIDECK_LO_BASE_URL must not be set in GitHub Actions"
    echo "$OMNIDECK_LO_BASE_URL"
  else
    echo "https://download.documentfoundation.org/libreoffice/stable"
  fi
}

# Runs a command with a wall-clock limit (macOS has no `timeout`). On expiry the
# whole process tree carrying $VO_KILL_PATTERN in its argv is killed too,
# because soffice launchers start a separate soffice.bin worker.
vo_run_timeout() {
  local secs="$1"; shift
  "$@" & local pid=$!
  ( sleep "$secs"
    if kill -0 "$pid" 2>/dev/null; then
      [ -z "${VO_KILL_PATTERN:-}" ] || pkill -9 -f "$VO_KILL_PATTERN" 2>/dev/null || true
      kill -9 "$pid" 2>/dev/null || true
    fi ) >/dev/null 2>&1 & local watcher=$!
  local rc=0
  wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return "$rc"
}

# vo_download <url> <out-file> <min-bytes> <pinned-sha256-or-empty>
# Resumable (curl -C -), retried, size-checked, SHA-256 verified. The partial
# file survives failures so the next attempt/run continues where it stopped.
# A hash mismatch discards the partial and retries once from scratch (a resumed
# file may have been spliced from different mirrors); a second mismatch fails.
vo_download() {
  local url="$1" out="$2" min="$3" pinned="$4"
  local partial="$out.partial" attempt rc tries_fresh=0 size actual expected

  while :; do
    attempt=0
    while :; do
      attempt=$((attempt + 1))
      rc=0
      echo "Download attempt $attempt/4 (resumes from $(vo_file_size "$partial" 2>/dev/null || echo 0) bytes): $url"
      curl --fail --location --connect-timeout 30 --retry 3 --retry-delay 3 --retry-all-errors \
           -C - --output "$partial" "$url" || rc=$?
      [ "$rc" -ne 0 ] || break
      # 33 = server rejected the resume range (e.g. partial is already complete
      # or corrupt): start over rather than loop on it.
      if [ "$rc" -eq 33 ]; then rm -f "$partial"; fi
      [ "$attempt" -lt 4 ] || vo_die "download failed after $attempt attempts (curl exit $rc): $url"
      sleep $((attempt * 3))
    done

    size="$(vo_file_size "$partial")"
    if [ "$size" -lt "$min" ]; then
      rm -f "$partial"
      vo_die "download is only $size bytes (expected >= $min); refusing it"
    fi

    actual="$(vo_sha256 "$partial")"
    echo "Computed SHA-256: $actual"
    if [ -z "$pinned" ]; then
      if [ "${OMNIDECK_PIN_DISCOVERY:-0}" = "1" ] && [ "${GITHUB_ACTIONS:-}" != "true" ]; then
        echo "PIN DISCOVERY: add this to vo_pinned_sha256 in scripts/lib/vendor-common.sh:" >&2
        echo "    \"<version>:<platform>-<arch>\")  echo \"$actual\" ;;" >&2
        exit 3
      fi
      rm -f "$partial"
      vo_die "no pinned SHA-256 for this download (computed $actual). Refusing to trust an unpinned archive; see the pin policy in scripts/lib/vendor-common.sh"
    fi
    expected="$pinned"; echo "Verifying against the pinned SHA-256."
    if [ "$actual" = "$expected" ]; then
      mv -f "$partial" "$out"
      return 0
    fi
    rm -f "$partial"
    if [ "$tries_fresh" -eq 0 ]; then
      tries_fresh=1
      echo "SHA-256 mismatch (got $actual, expected $expected); discarding the partial download and retrying once from scratch." >&2
      continue
    fi
    vo_die "SHA-256 mismatch twice (got $actual, expected $expected): this is not the expected official installer"
  done
}

# vo_expect_version <soffice-launcher> <version> <timeout-secs>
# A failed launch OR a version that doesn't match the pinned major.minor is fatal.
vo_expect_version() {
  local exe="$1" version="$2" secs="${3:-120}" out rc=0 want
  want="LibreOffice ${version%.*}"
  out="$(vo_run_timeout "$secs" "$exe" --version 2>&1)" || rc=$?
  [ "$rc" -eq 0 ] || vo_die "bundled soffice --version failed (exit $rc): $out"
  case "$out" in
    "$want"*) echo "Validated runtime: $out" ;;
    *) vo_die "bundled soffice reports '$out' but LibreOffice $version was expected" ;;
  esac
}

# vo_smoke_convert <soffice-launcher> <fixture.pptx> <expected-pages>
# Real conversion with the staged runtime: proves Impress + the PDF export
# filter + every shared library actually load, not just that --version prints.
vo_smoke_convert() {
  local exe="$1" fixture="$2" want="$3" tmp out stem pdf pages rc=0
  [ -f "$fixture" ] || vo_die "smoke-test fixture missing: $fixture"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/omnideck-smoke.XXXXXX")"
  out="$tmp/out"; mkdir -p "$out"
  VO_KILL_PATTERN="$tmp/profile" vo_run_timeout 240 "$exe" --headless --norestore \
      "-env:UserInstallation=file://$tmp/profile" --convert-to pdf --outdir "$out" "$fixture" \
      >"$tmp/log" 2>&1 || rc=$?
  stem="$(basename "$fixture")"; stem="${stem%.*}"; pdf="$out/$stem.pdf"
  if [ "$rc" -ne 0 ] || [ ! -s "$pdf" ]; then
    echo "--- soffice output ---" >&2; cat "$tmp/log" >&2 || true
    rm -rf "$tmp"; vo_die "smoke conversion failed (exit $rc, pdf present: $([ -s "$pdf" ] && echo yes || echo no))"
  fi
  head -c 5 "$pdf" | grep -q '%PDF-' || { rm -rf "$tmp"; vo_die "smoke conversion produced a file that is not a PDF"; }
  pages="$(grep -a -o '/Type */Page[^s]' "$pdf" | wc -l | tr -d '[:space:]')"
  rm -rf "$tmp"
  [ "$pages" -eq "$want" ] || vo_die "smoke conversion produced $pages PDF pages, expected $want (one per slide)"
  echo "Smoke conversion OK: $(basename "$fixture") -> PDF with $pages pages (one per slide)."
}

# vo_swap <staged-dir> <dest-dir> <backup-dir> <verify-command...>
# Replaces dest only after everything validated; restores the previous bundle
# if the move or the post-move verification fails.
vo_swap() {
  local stage="$1" dest="$2" backup="$3"; shift 3
  if [ -e "$dest" ]; then mv "$dest" "$backup" || vo_die "could not move the existing bundle aside"; fi
  # Subshell: a failing verifier calls vo_die (exit) and must not skip the rollback below.
  if mv "$stage" "$dest" && ( "$@" ); then
    rm -rf "$backup"
    return 0
  fi
  echo "Installing the staged bundle failed; restoring the previous one." >&2
  rm -rf "$dest"
  if [ -e "$backup" ]; then mv "$backup" "$dest" || echo "WARNING: could not restore the previous bundle from $backup" >&2; fi
  vo_die "staged LibreOffice bundle could not be installed (previous bundle restored if there was one)"
}
