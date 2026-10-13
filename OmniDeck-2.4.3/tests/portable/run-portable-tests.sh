#!/usr/bin/env bash
# Runs the app's platform logic (src-tauri/src/util.rs — no Tauri) on targets
# the full app can't be built/run for on a Linux box:
#   * Windows (x86_64-pc-windows-gnu) — EXECUTED under Wine
#   * macOS (aarch64/x86_64-apple-darwin) — type-checked only (no Apple SDK/OS here)
#
# Needs: rustc/cargo >= 1.91, gcc-mingw-w64-x86-64-posix, wine64 (+ a display,
# e.g. Xvfb), and the UPSTREAM Rust std sources (build-std): Debian/Ubuntu's
# `rust-src` package has the Windows bindings stripped out, so check out
# rust-lang/rust @ <your rustc version> (with submodules library/backtrace and
# library/stdarch) and point <sysroot>/lib/rustlib/src/rust at it. The mingw
# start-up objects also have to be built once:
#   rustc --target x86_64-pc-windows-gnu --emit=obj --crate-type rlib -C panic=abort \
#         library/rtstartup/rsbegin.rs   (and rsend.rs)  -> <sysroot>/lib/rustlib/x86_64-pc-windows-gnu/lib/
# In CI none of this is needed: `cargo test` on the windows-latest / macos-latest
# jobs runs these same tests natively.
set -euo pipefail
cd "$(dirname "$0")/../../src-tauri/portable-tests"
export RUSTC_BOOTSTRAP=1 CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/portable-target}"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
export WINEPREFIX="${WINEPREFIX:-/tmp/wineprefix}" WINEDEBUG=-all WINEARCH=win64

echo "== macOS (type-check)"
for t in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo check --tests --target "$t" -Zbuild-std=std,panic_abort
done

echo "== Windows (run under Wine)"
cargo test --target x86_64-pc-windows-gnu -Zbuild-std=std,panic_abort --no-run
wine64 wineboot -u >/dev/null 2>&1 || true
EXE=$(ls -t "$CARGO_TARGET_DIR"/x86_64-pc-windows-gnu/debug/deps/*.exe | head -1)
wine64 "$EXE" --test-threads=1
