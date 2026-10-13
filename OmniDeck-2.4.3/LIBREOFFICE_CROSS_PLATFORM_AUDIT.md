# OmniDeck v2.4.0 — LibreOffice cross-platform audit

## Fixes applied in this audit

- **Windows:** explicitly load `System.Net.Http` before resolving `HttpClient` / `HttpClientHandler`. This addresses the reported type-resolution failure seen with Windows PowerShell environments that do not auto-load the assembly.
- **Linux:** correct the official x86_64 archive filename mapping. The download directory is `deb/x86_64`, but the x64 archive filename uses `Linux_x86-64`, not `Linux_x86_64`. Added a static regression test for both x86_64 and aarch64 naming.
- Added a Windows regression assertion for explicit assembly loading and a Linux vendoring regression test.

## Validation performed here

- `node tests/run-all.mjs`: **21/21 test files passed**.
- `node tests/syntax-check.mjs`: **45/45 files passed**.
- Windows, Linux, and macOS vendoring static tests passed.
- `bash -n` passed for both Linux and macOS vendoring scripts.

## Important macOS packaging issue found — not yet fixed

The GitHub Actions workflow currently builds a **universal macOS app** but has no macOS LibreOffice vendoring step. Separately, the vendoring wrapper selects one LibreOffice architecture based on the runner's `process.arch`. Simply adding the current script to the universal job would bundle only one architecture's LibreOffice runtime, so the other slice could not reliably render presentations on the other CPU architecture.

Before calling macOS packaging production-ready, change the workflow to build architecture-specific macOS installers (Intel and Apple Silicon, each with its matching LibreOffice runtime), or implement and test a dual-runtime bundle with runtime architecture selection. This was intentionally not papered over with a misleading one-line workflow change.

## Other caveats

- This environment cannot execute Windows PowerShell/MSI extraction or macOS `hdiutil`/`codesign`, so those platform-native operations still need CI or machine validation.
- The Linux download/extraction and real `soffice --version` path must be exercised on Linux CI; shell syntax and static checks alone do not prove the official remote asset is reachable.
- The workflow currently pins Linux LibreOffice to 24.8.4 while Windows pins 26.8.0 and the macOS script defaults to 26.8.0. Align versions deliberately if cross-platform rendering parity is required.
