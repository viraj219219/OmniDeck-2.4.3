# OmniDeck release-pipeline fix: PARTIAL (not production-ready)

Done: regenerated package-lock.json (npm ci now works); rewrote the Linux, macOS and Windows
LibreOffice vendor scripts + scripts/lib/vendor-common.sh; new Windows behavioural test
and helpers in tests/.

NOT done: .github/workflows/build.yml (pdf.js vendoring, per-arch macOS jobs, runtime gates),
util.rs/main.rs runtime discovery fixes, tauri.conf.json (deb/rpm depends, macOS min version),
version alignment (2.3.2 vs 2.3.5), Linux/macOS script tests, docs.

Known issues: tests/vendor-libreoffice-linux|macos.test.mjs are stale against the rewritten
scripts and will likely fail; the PowerShell smoke-conversion helper timed out against a real
LibreOffice on Linux and is unverified; Linux/macOS/Windows vendor scripts have not been run
end to end; the full Tauri app was never compiled.
