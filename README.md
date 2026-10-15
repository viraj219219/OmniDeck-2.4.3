# OmniDeck — Sunday School Lesson Builder & Presenter

> **Version 2.4.3** — current application source lives in `OmniDeck-2.4.3/`. The repository includes native GitHub Actions workflows for testing and building Windows, macOS, and Linux packages. See the [release guide](OmniDeck-2.4.3/docs/RELEASING.md) for required signing inputs and manual acceptance checks.

A desktop application for Sunday School teachers to build lessons and
present them in class: `OPEN OMNIDECK → CREATE/OPEN LESSON → TEACH`.

After cloning this repository, run all npm and Rust commands from `OmniDeck-2.4.3/` (the folder containing `package.json`), not from the repository root.

This is a **production-track build**, not a mock-data prototype. Every
service listed below is backed by a real, storage/API-driven
implementation; `Mock*` classes still exist in a few service files but are
kept **only** as unit-test doubles — they are never imported by any view
or by the runtime singleton, and each file says so explicitly in a comment
next to the class.

---

## 1. Technology choice

**Tauri v2 (Rust shell) + a hand-written vanilla HTML/CSS/JS frontend.**
No React/Vue, no bundler, no build step for the UI itself.

- **Performance & stability** — ships as a small native binary around the
  OS's own webview (WebView2 on Windows, WebKitGTK on Linux), not a
  bundled Chromium.
- **Windows, macOS, and Linux** — native builds are produced from one codebase: NSIS `.exe` on Windows, `.dmg` on macOS, and `.deb`/`.rpm`/`.AppImage` on Linux.
- **Fullscreen presentation support** — native OS fullscreen via
  `set_presentation_fullscreen` in `src-tauri/src/main.rs`.
- **Reliable file handling** — the `dialog` and `fs` plugins give a native
  file picker and local file I/O; least-privilege permissions are scoped
  in `src-tauri/capabilities/default.json` to `$APPLOCALDATA/**` only.
- **No framework for the UI** — views are plain functions rendering into a
  container (`src/js/views/*.js`); no build step, no framework upgrade
  treadmill.

---

## 2. Repository and application structure

```text
OmniDeck-Presentation/
├── README.md
├── .github/
│   └── workflows/                 # CI, native builds, release validation
└── OmniDeck-2.4.3/                 # actual app root: run npm/Rust commands here
    ├── package.json / package-lock.json
    ├── src/                        # vanilla HTML/CSS/JavaScript frontend
    ├── src-tauri/                  # Rust shell, Tauri config and capabilities
    ├── scripts/                    # vendoring, build and installer verification
    ├── tests/                      # frontend, script and release-gate tests
    └── docs/RELEASING.md            # release setup and manual acceptance
```

---

## 3. Running it

### Prerequisites (all platforms)
- Node.js 18+ and npm
- Rust via [rustup](https://rustup.rs) — see "Rust toolchain" note below
- Network access for the first run only (`npm ci`, then the one-time LibreOffice download)
- **No separate LibreOffice or Poppler install is needed.** `npm run dev` downloads
  a checksum-verified LibreOffice into `src-tauri/resources/libreoffice/` and the app
  uses that bundled copy; PDF/PowerPoint import uses the bundled pdf.js.

### Every OS: first-time setup and daily commands
Run from the project folder (the one containing `package.json`):
```
cd OmniDeck-2.4.3
npm ci            # REQUIRED once, and again after dependencies change.
npm run dev       # preflight -> pdf.js -> LibreOffice -> local Tauri CLI (dev mode)
npm run build     # strict release build: fails if pdf.js/LibreOffice are missing
```
`'tauri' is not recognized` / `tauri: command not found` / `node_modules/pdfjs-dist
not found` all mean `npm ci` has not been run in this folder (or failed). The scripts
now stop with that instruction. A global Tauri CLI is not needed; `npm run tauri -- <args>`
runs the locally installed one. To run dev without pdf.js on purpose, set
`OMNIDECK_ALLOW_NO_PDFJS=1` (ignored by `npm run build`).

### Ubuntu / Linux Mint
```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  build-essential curl wget file libssl-dev libayatana-appindicator3-dev
cd OmniDeck-2.4.3 && npm ci && npm run dev
```
Linux Mint is Ubuntu-LTS-based; if a given Mint release's `.deb`
dependency names differ from the Ubuntu LTS base you built on, install the
equivalent WebKitGTK/GTK packages for that Mint release specifically —
don't assume the `.deb` installs cleanly unverified.

### macOS (Intel and Apple Silicon)
```bash
xcode-select --install     # Command Line Tools, once
cd OmniDeck-2.4.3 && npm ci && npm run dev
```

### Windows 10 / 11 (PowerShell or CMD)
```powershell
# Requires "Desktop development with C++" (Visual Studio Build Tools)
# and the WebView2 Runtime (preinstalled on Windows 11 and most
# up-to-date Windows 10 machines).
cd OmniDeck-2.4.3
npm ci
npm run dev
```

### Browser dev-preview (no native shell)
Opening `src/index.html` directly also works — every service falls back
to a browser-safe implementation (file `<input>` instead of the native
dialog, `localStorage` instead of the Tauri filesystem,
`document.requestFullscreen` for Present Mode).

---

## 4. Installers for every platform

`bundle.targets` is `"all"`, so `npm run build` produces every installer
format the machine it runs on can make. Installers can only be produced on
their own OS, so the release path is the GitHub Actions workflow
(`.github/workflows/build.yml`): push a tag such as `v1.0.0` and it builds
all of the following and attaches them, with a `SHA256SUMS` file, to a
**draft** GitHub Release.

| Platform | Installer(s) | Notes |
|---|---|---|
| **Windows 11 / Windows 10** (x64, 1809+) | `OmniDeck_*_x64-setup.exe` (NSIS, per-user or all-users) and `OmniDeck_*_x64_en-US.msi` | Same installer for 10 and 11. Installs the WebView2 runtime if the machine lacks it (needs internet only in that case; Windows 11 and updated Windows 10 already have it). |
| **macOS 10.15+** (Intel + Apple Silicon) | `OmniDeck_*_universal.dmg` | One universal build. |
| **Linux x86_64 / arm64 — Debian, Ubuntu, Linux Mint, Pop!_OS, …** | `.deb` | Recommends LibreOffice Impress + Poppler for import. |
| **Linux — Fedora, RHEL/Rocky/Alma, openSUSE, …** | `.rpm` | Same recommendations. |
| **Linux — any other distro (Arch, Manjaro, …)** | `.AppImage` | `chmod +x` and run; needs WebKitGTK 4.1 + GTK 3 on the system. |

Linux builds are made on Ubuntu 22.04 so they run on 22.04 and newer
(glibc 2.35+). An installer built on a newer distro would not run on older
ones — build releases through the workflow, not on a developer laptop.

**First-launch warnings (installers are unsigned unless you add signing
secrets):**
- *Windows SmartScreen*: "Windows protected your PC" → **More info → Run
  anyway**.
- *macOS Gatekeeper*: drag OmniDeck to Applications, then **right-click →
  Open** (once). If macOS says the app is damaged, run
  `xattr -dr com.apple.quarantine /Applications/OmniDeck.app`. To ship a
  signed + notarized `.dmg`, add the `APPLE_*` secrets listed at the top of
  the workflow.
- *Linux AppImage*: `chmod +x OmniDeck_*.AppImage`.

**Optional tools for PowerPoint/PDF import** (everything else works
without them; Settings → Import Tools shows what's missing):
- Windows: LibreOffice (`winget install TheDocumentFoundation.LibreOffice`)
  and Poppler (`scoop install poppler` or `choco install poppler`, or the
  zip from the poppler-windows project with its `Library\bin` on PATH).
  Restart OmniDeck after installing so it sees the new PATH.
- macOS: `brew install --cask libreoffice` and `brew install poppler`
  (OmniDeck also looks in `/opt/homebrew/bin` and `/usr/local/bin`, which a
  Dock-launched app does not have on its PATH).
- Linux: `sudo apt install libreoffice-impress poppler-utils` (or the
  `dnf`/`pacman` equivalents). The `.deb`/`.rpm` recommend these
  automatically.

Building locally instead: `npm run build` on the target OS (Windows needs the
"Desktop development with C++" build tools; macOS needs Xcode command-line
tools; for the universal macOS build run
`rustup target add aarch64-apple-darwin x86_64-apple-darwin` then
`npx tauri build --target universal-apple-darwin`).

**Rust toolchain**: this project's dependency graph (Tauri 2.11.x, resolved
in the committed `Cargo.lock`) needs a current stable Rust toolchain —
distro-packaged Rust on some LTS bases (e.g. `apt install cargo` giving
rustc 1.75) is too old for some transitive dependencies. Install/update via
[rustup](https://rustup.rs) and run `rustc --version` / `cargo --version`
before building; if `cargo check` fails citing an edition/feature it
doesn't recognize, `rustup update` first.

---

## 5. Where each service is implemented

Every feature is written against an **interface** with exactly one real,
concrete implementation instantiated at runtime. `Mock*` classes (where
present) are unit-test doubles only — never imported by a view.

| Service | File | Runtime implementation |
|---|---|---|
| `LessonService` | `LessonService.js` | `StorageLessonService` — real JSON persistence via `storageAdapter` (Tauri fs / localStorage dev-preview fallback): crash-safe atomic writes with `.bak` recovery, ONE serialized save queue for autosave/manual/import saves, seeded example lessons with real Scripture |
| `BibleService` | `BibleService.js` | `RealBibleService` — real WEB (World English Bible, public domain) text for English; Telugu shows an honest "coming soon" empty state rather than fake data — see `LICENSE-BIBLE.md` |
| `MediaService` | `MediaService.js` | `TauriMediaService` — native file picker, copies real bytes into `$APPLOCALDATA/media/**`, real thumbnails, duplicate detection, real PPTX→PDF→PNG conversion (bundled/installed LibreOffice for the OOXML→PDF step, pdf.js for PDF page rasterization — see PdfJsService.js); physical deletion is reference-safe (refuses while any lesson still uses the file) |
| `DocumentImportService` | `DocumentImportService.js` | Real PDF text extraction via pdf.js (in-app, no external tool) and DOCX text extraction via a pure-Rust zip/XML reader (`docx_reader.rs`, no external tool); legacy `.doc` still falls back to `soffice` |
| `QuizService` | `QuizService.js` | `StorageQuizService` — real validation + grading for MC/T-F/fill-blank/short-answer |
| `QuizGenerationService` | `QuizGenerationService.js` | `RealQuizGenerationService` — real HTTP call to a configured LLM API; throws a clear error until a key is set in Settings, never fabricates questions |
| `PresentationService` | `PresentationService.js` | `TauriPresentationService` — real OS fullscreen, real monitor enumeration, real second-display "audience window" for 2+ monitor setups (see `main.rs`) |

Settings → AI Quiz Generation is where an API key is entered; it's stored
locally (not hard-coded, not committed) and is never required for the
app's core lesson/Scripture/media/quiz/Present Mode workflow to work.
OmniDeck has no AI or image-generation feature — a scripture page's image
is chosen manually from the media library, the same as a page background.

---

## 6. Multi-display Present Mode

- **One display** (the common case): Present Mode fullscreens the main
  window in place. No configuration required.
- **Two or more displays**: the teacher can pick which monitor is the
  audience display; the backend (`open_audience_window` in `main.rs`)
  refuses to ever place the audience window on the presenter's own
  monitor, even if the frontend's chosen index is stale.
- Display disconnect/reconnect and invalid/out-of-range saved monitor
  indices fall back to a safe default rather than crashing — see
  `presentation-service.test.mjs`.

---

## 6b. Data safety (crash / power-loss / failed-import hardening)

OmniDeck is meant to survive a crash, power cut, rapid editing, or a failed
import without corrupting or silently destroying lesson data.

- **Atomic saves** (`utils/atomicFile.js`, used by `storageAdapter.js`): a
  data file `X.json` is never overwritten in place. The new version is
  written to `X.json.tmp`, read back and verified, the current good file is
  copied to `X.json.bak`, and only then is `X.json.tmp` renamed over
  `X.json`. A crash at any point leaves the old or the new version intact.
- **Recovery on start-up**: a corrupted or missing `X.json` is restored from
  `X.json.bak` (the corrupt file is kept as `X.json.corrupt-<time>`, and a
  notice is shown). If nothing valid can be recovered the app reports the
  problem and does **not** treat the library as empty or overwrite it.
- **One save pipeline** (`utils/SaveQueue.js`): autosave, manual save, page
  operations and imports all persist through a single per-file queue — at
  most one write is active, edits made during a write coalesce into one
  follow-up write, and the last write always carries the latest state.
- **Reference-safe media deletion**: `MediaService.removeMedia` refuses to
  delete a file that any lesson (page, scripture-page image, text/image box, page
  background — in memory *or* in the last saved version) still references,
  and refuses when that can't be verified. There is no "remove anyway".
  Scripture-page image accept/replace (`services/MediaLifecycle.js`) saves the lesson
  first and only then deletes the old image, and only if unused.
- **Transactional imports** (`services/ImportService.js`): PPTX/PDF/backup
  imports prepare everything first, save the lesson in one step, and on any
  failure remove exactly the media that import created — never pre-existing
  media, and never leave a half-built lesson.
- **Closing the app**: the native close request is intercepted in `main.rs`
  (`CloseGate`); the frontend flushes every pending save, then confirms the
  close. If the save fails the teacher chooses *Close without saving* or
  *Keep editing*; a Rust watchdog guarantees the window can never become
  un-closable. Entering Present Mode flushes first and refuses to present
  unsaved edits unless the teacher explicitly chooses to.
- **Import tools status**: Settings → *Import Tools* shows whether LibreOffice
  and Poppler are installed (`check_import_dependencies`, detection only —
  nothing is launched). Missing tools produce a clear message, never a crash
  or fake slides.

---

## 7. Testing performed in this environment

Last verified in an Ubuntu 24.04 container (Rust 1.91, Node 20+, Tauri 2.x,
WebKitGTK, LibreOffice 24.2.7, Poppler, a virtual two-monitor X display and
the Openbox window manager). Only what was actually run is claimed:

- [x] `npm install`, `npm run check` — every frontend file parses.
- [x] `npm test` — 16/16 test files pass (fault-injecting fake filesystem):
      `atomic-storage`, `save-queue`, `media-safety`, `import-transaction`,
      `shutdown`, `dependency-service`, `tauri-static-audit`, and
      `regressions-v2-2` (audit fixes below), plus the original suites.
- [x] `cargo check --tests` / `cargo test` — 17 Rust tests, including the
      REAL `soffice` + `pdftoppm` converting a real PPTX and PDF (work folder
      containing a space), stale-page clearing, LibreOffice-profile cleanup,
      and rejection of a corrupt `.pptx` (a real bug this found: LibreOffice
      turns garbage into "slides"). Tests skip themselves if the tools are
      absent.
- [x] `npm run e2e:linux` — 34 checks against the **release binary in a real
      WebKitGTK webview** (tauri-driver + WebKitWebDriver): real Tauri fs /
      dialog / event plugins and the real permission scope (out-of-scope
      writes are denied); atomic save + `.bak` recovery + quarantine on the
      real filesystem; 40 rapid saves; real LibreOffice/Poppler PPTX and PDF
      import, corrupt-file rollback with no orphans; reference-safe media
      deletion; **two real monitors** (audience opens on the second, refused
      on the presenter's monitor); the **native close handshake** via the
      window manager (a 6.5 s pending save outlives the 5 s watchdog and is
      written before exit; with no webview the watchdog closes the app); the
      native "Unsaved changes" dialog with both *Keep editing* and *Close
      without saving*. The only stub is the GTK file picker, which can't be
      automated (it returns a prepared path). See `tests/e2e/`.
- [x] **Windows platform logic executed under Wine** — 28/28 tests
      (`tests/portable/run-portable-tests.sh`): real PATHEXT lookup, `\\?\`
      paths -> LibreOffice URLs, no-console-window process launch, timeout
      kill of a hung tool, audience-placement rules. Plus
      `cargo check --tests --target x86_64-pc-windows-gnu` of the WHOLE app.
      The macOS logic (Homebrew lookup for Dock-launched apps) is
      type-checked for both Apple targets and simulated on other hosts.
- [x] `npm run e2e:linux` plus `E2E_SCRIPT=tests/e2e/hardware-e2e.mjs
      bash tests/e2e/run-linux-e2e.sh` — **native GTK open/save dialogs**
      (typed path, Escape-cancel, PPTX via the real dialog, save + write
      outside app data) and **display hot-plug during Present Mode** (real
      RandR monitor unplug/replug: audience window closed at once, restored on
      replug, renamed display, presenter never moves).
- [x] `npx tauri build` on Linux — `.deb`, `.rpm` and `.AppImage` built; the `.deb` was installed and launched, the `.AppImage` was launched, the `.rpm` metadata was inspected (not installed: no RPM-based OS here).

**Not performed here:**
- Windows 10/11 and macOS: the Windows `.msi` / NSIS `.exe` and the macOS
  `.dmg` cannot be built on Linux, so they were **not built or run here**.
  The `cfg(windows)` / macOS code paths (console-window suppression, PATH
  handling, Homebrew lookup) are compiled and tested only by the CI matrix
  in `.github/workflows/build.yml` — push a `v*` tag to produce them.
- Linux distros other than Ubuntu 24.04 (the local build); the CI Linux
  build uses Ubuntu 22.04 for wider compatibility.
- Physical displays: hot-plug was tested with real RandR monitor add/remove
  events on a virtual X display (what a driver raises on unplug), not with a
  physical cable, GPU or projector.
- The Windows (WebView2) and macOS (WKWebView) native file-picker dialogs;
  only the Linux GTK dialogs were driven.

Before shipping, run the full matrix in section 8 on real machines or CI.

---

## 7b. Post-release audit fixes (code review of v2.2)

Fixed after a read-through of the v2.2 source. JS fixes are covered by
`tests/regressions-v2-2.test.mjs` / `quiz-generation.test.mjs` and were also
exercised in a jsdom scratch harness (not part of the repo). The Rust change
below was compiled and tested: `cargo test --locked` on Rust 1.89 → 31/31 pass,
and the resulting Linux release binary was launched under a virtual display
(Xvfb) and ran 25 s without crashing. **Not** re-run after the fixes:
`npm run e2e:linux` (needs a real desktop + tauri-driver) and anything on
Windows/macOS — build those with the GitHub Actions workflow (section 4) and
smoke-test them (open a lesson, Present Mode, second display) before shipping.

- Boxes added on top of non-freeform slides now render in Present Mode, the
  audience window and thumbnails (previously editor-only).
- Audience window always receives the *current* slide after a hot-plug/late
  projector (previously nothing, or a stale slide).
- Arrow/Home/End keys no longer change slides while typing a quiz answer.
- Present Mode setup failures (monitor list, fullscreen) no longer strand the
  app on a blank overlay; `exit()` is idempotent.
- `open_audience_window` and the PPTX/PDF/DOCX commands use
  `#[tauri::command(async)]` (sync commands run on the main thread: UI freeze
  during import; documented window-creation deadlock on Windows). Compiled +
  tested on Linux; the Windows deadlock fix itself is unverified on Windows.
- An emptied lesson library is no longer re-seeded on the next launch.
- Home / Settings / any view show an error instead of a blank screen when the
  lesson library can't be read; failed lesson deletion reports the error.
- Bible view keeps search focus and scroll position; scripture picker keeps
  verse scroll.
- Media Library "Remove" now asks for confirmation before deleting a file from
  disk; Present Mode's quiz text input is explicitly kept editable (WebKit
  `user-select: none` quirk).
- Esc on an empty inline text field no longer saves the placeholder text;
  quiz generation no longer shifts the answer key past a blank option;
  Settings shows the real app version.

---

## 8. Recommended release matrix

| Platform | Build | Install | Launch | Storage | Media | Present | Display |
|---|---|---|---|---|---|---|---|
| Windows 10 | — | — | — | — | — | — | — |
| Windows 11 | — | — | — | — | — | — | — |
| Ubuntu LTS | — | — | — | — | — | — | — |
| Linux Mint | — | — | — | — | — | — | — |

(`—` = not yet executed against real hardware/VMs; fill in pass/fail as
each is actually run. Do not mark a cell done from static review alone.)


---

## Linux installers in this package (`installers-linux/`)

Built from THIS (fixed) source with `npm run build` on Ubuntu 24.04, Rust 1.89:
`OmniDeck_2.2.0_amd64.deb`, `OmniDeck-2.2.0-1.x86_64.rpm`,
`OmniDeck_2.2.0_amd64.AppImage`, plus `SHA256SUMS`
(`sha256sum -c SHA256SUMS` inside that folder). Windows (.msi/.exe) and macOS
(.dmg) installers are NOT included: they can only be built on those operating
systems — push this source to GitHub and run the `build` workflow. The
`verification-screenshots/` are from the original v2.2 verification run
(before the audit fixes) and are kept for reference.
