# Releasing OmniDeck

Version **2.4.3** (OmniDeck 2.4.3). Everything below is driven by `.github/workflows/build.yml`.
What is *verified in CI* and what is *only verifiable by a human on real machines* is spelled out at the end.

## 1. One-time setup

### 1a. Pin the LibreOffice checksums (REQUIRED before any Linux or macOS build)
The vendoring scripts are **fail-closed**: an archive without a committed SHA-256 pin is refused
(`scripts/lib/vendor-common.sh`, `vo_pinned_sha256`). There is deliberately no fallback to a checksum
downloaded from the same server.

1. GitHub → Actions → **Pin LibreOffice checksums (manual)** → Run workflow.
2. Each job (Linux x86_64/arm64, macOS Intel/Apple Silicon) prints the line to paste into
   `vo_pinned_sha256`. The Windows job re-derives the pin already in
   `scripts/vendor-libreoffice-windows.ps1` and fails if it no longer matches.
3. **Confirm before committing**: run the workflow twice and compare, and compare with the checksum on
   The Document Foundation's release page for that exact file. A hash you copied from the same
   download proves nothing about authenticity.
4. Uncomment/add the lines in `vo_pinned_sha256`, commit, push.

> The Windows pin (`4AA6C6E1…DB95` for 26.8.0) was inherited from the previous session and its
> provenance could not be verified when this was written. The workflow's Windows job exists to check it.

### 1b. Updater signing keys
```bash
npx tauri signer generate -w ~/.tauri/omnideck.key     # choose a password
```
* **Private key** (`~/.tauri/omnideck.key`) → GitHub secret `TAURI_SIGNING_PRIVATE_KEY`
  (the file's contents); password → secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  Never commit it. Back it up offline: if it is lost, installed copies can never be updated again
  and users must reinstall manually.
* **Public key** (`~/.tauri/omnideck.key.pub`) → GitHub **repository variable** `TAURI_UPDATER_PUBKEY`
  (contents of the `.pub` file; it is public by design and is compiled into the app).
* The endpoint is derived automatically from `${{ github.repository }}`:
  `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.
  Changing the repository name/owner later breaks the endpoint baked into already-installed apps.

### 1c. macOS signing + notarization (recommended; optional for CI to pass)
Secrets: `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`. When `APPLE_CERTIFICATE` is set, the macOS
verifier additionally requires Gatekeeper acceptance and a stapled notarization ticket.
Windows installers are not code-signed by this workflow (SmartScreen will warn).

## 2. Cutting a release
1. Bump the version in **all** of: `package.json`, `package-lock.json` (2 places), `src-tauri/Cargo.toml`,
   `src-tauri/Cargo.lock` (`omnideck` entry), `src-tauri/tauri.conf.json`, and `PACKAGE_APP_VERSION` in
   `src/js/services/LessonPackageService.js`. `tests/release-config.test.mjs` fails if they disagree.
2. `git tag v2.4.3 && git push origin v2.4.3`.
3. The tag run: builds 5 native targets, **requires** the signing inputs, attaches signed installers and
   `latest.json` to a **draft** release, then `release-integrity` checks that `latest.json` covers all five
   platforms, every entry is signed, every URL points at an attached asset, and the version matches; it also
   uploads `SHA256SUMS`.
4. Open the draft, run the manual acceptance list (§5), then **Publish**. The updater serves only *published*
   releases (`/releases/latest/`), so nothing reaches users until you publish.

## 3. Building locally
Requires Node 20+, Rust stable, and the platform's Tauri prerequisites.

| Target | Where to build | Command |
|---|---|---|
| Windows x64 | Windows | `npm ci && npm run build` |
| macOS Intel | an **Intel** Mac (or `macos-15-intel`) | `npm ci && npm run build -- --target x86_64-apple-darwin` |
| macOS Apple Silicon | an **Apple Silicon** Mac | `npm ci && npm run build -- --target aarch64-apple-darwin` |
| Linux x86_64 / arm64 | Ubuntu 22.04 on that architecture | `npm ci && npm run build` then `bash scripts/linux-runtime-depends.sh src-tauri/resources/libreoffice src-tauri/tauri.linux.conf.json` **before** `tauri build` |

`npm run build` = strict pdf.js vendoring → LibreOffice vendoring → `verify-release-inputs` → `tauri build`.
It fails if pdf.js or LibreOffice is missing or inconsistent. macOS is **not** a universal build: the bundled
LibreOffice is single-architecture, so each arch gets its own runtime and is validated by executing it natively.
Local unsigned builds have no updater (it is registered only when a public key is configured).

## 4. Platform notes (verified requirements)
* macOS minimum **11.0** — LibreOffice 26.x dropped 10.15. Apple Silicon requires 11 anyway.
* Windows 10+ (LibreOffice 26.x; WebView2 bootstrapper is embedded).
* Linux: build on Ubuntu 22.04 (glibc 2.35 ≥ LibreOffice's 2.27 floor). `.deb`/`.rpm` dependency lists are
  *generated from the bundled binaries* (`scripts/linux-runtime-depends.sh`), not guessed.
* In-app updates: Windows (NSIS/MSI), macOS, Linux **AppImage** only. `.deb`/`.rpm` installs are told a new
  version exists and to download it (the OS package manager owns those files).

## 5. What CI proves vs. what only a person can
| Check | Status |
|---|---|
| JS/script/Rust-source unit tests, vendor-script behaviour, release gates | Run in CI on every push |
| Bundled LibreOffice present, right version/arch, converts a real .pptx — **inside the built installer** (deb installed with `apt`; MSI unpacked; DMG mounted) | Run in CI on native runners |
| `cargo check` / `cargo test` | Run in CI |
| Updater manifest completeness + signatures present | Run on tag builds |
| **Signed update actually installs N → N+1** | **Manual** (needs two published signed releases) |
| Windows 10 specifically, Fedora/Debian/Mint, macOS 11–13 | **Manual** |
| Notarized app launches under Gatekeeper on a clean Mac | **Manual** (CI runs `spctl`/`stapler`) |
| Real projector / second display behaviour | **Manual** (see `docs/PRESENTER_VIEW.md`) |
