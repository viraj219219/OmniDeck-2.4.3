# PowerPoint (.pptx) / PDF / Word — external tool dependencies and setup

## What this covers

Four features share the SAME two external tools (nothing new to install
for one if the others already work):

1. **PowerPoint import** (`convert_pptx_to_slides`) — .pptx/.ppt → real
   slide PNGs, one per slide, each becoming its own editable lesson page.
2. **PDF import** (`convert_pdf_to_slides`) — a PDF handout → real
   per-page PNGs, one per page, each becoming its own editable lesson
   page — the same treatment as PowerPoint import, added so a PDF isn't
   only ever embedded whole via the webview's own PDF viewer. That
   embedded-viewer path (see mediaRenderer.js) is kept as the fallback
   for whenever this conversion isn't possible (poppler missing, or the
   browser dev-preview), so PDF import never silently fails outright.
3. **PDF text extraction** (`extract_pdf_text`, used by "Generate Quiz →
   From PDF") — real text pulled from a PDF for quiz generation.
4. **Word document text extraction** (`extract_docx_text`, used by
   "Generate Quiz → From Word Document") — .docx/.doc → real text.

## What actually does the work

There is no bundled PowerPoint/PDF/Word parser (there isn't a small,
embeddable, license-clean one for all four). All four features use two
separately-installed system tools, orchestrated by Tauri commands in
`src-tauri/src/main.rs`:

1. **LibreOffice** (`soffice --headless --convert-to pdf` for PowerPoint,
   `soffice --headless --convert-to txt:Text` for Word) — does the real
   conversion/rendering work for PowerPoint and Word. Not used for PDF
   import — a PDF is already a PDF, so PDF import skips straight to step 2.
2. **poppler-utils** (`pdftoppm -png` to rasterize PDF pages — both a
   PowerPoint-derived PDF and a teacher's own PDF handout go through the
   exact same `render_pdf_to_pngs` function in Rust, so they're rendered
   identically; `pdftotext -layout` to extract PDF text) — renders page
   images and extracts real PDF text.

Only these two exact binaries, with a fixed argument list, are ever
invoked from Rust (via `std::process::Command`, not the frontend-facing
shell plugin) — never an arbitrary command built from user input, and the
caller-supplied file path is always passed as a single argument, never
interpolated into a shell string.

## Install commands

**Ubuntu/Debian/Linux Mint:**
```
sudo apt-get install libreoffice poppler-utils
```

**Windows 10/11:** install LibreOffice from
https://www.libreoffice.org/download/ (the installer adds `soffice.exe`
to Program Files; it needs to be on `PATH` for `Command::new("soffice")`
to find it — Rust's `Command::new` resolves the binary via the OS `PATH`
on every platform, so no platform-specific path is hardcoded here, but
the LibreOffice Windows installer does not always add itself to `PATH`
automatically). As of this pass, the app no longer strictly requires
`soffice` to already be on `PATH`: if the plain `soffice` command isn't
found, it automatically falls back to checking the default install
locations (`C:\Program Files\LibreOffice\program\soffice.exe` and the
`(x86)` equivalent on Windows; `/usr/bin/soffice`,
`/usr/lib/libreoffice/program/soffice`, `/opt/libreoffice/program/soffice`,
and `/snap/bin/libreoffice.soffice` on Linux; the LibreOffice.app bundle
path on macOS — see `soffice_candidates()`/`run_soffice_with_fallback()`
in `src-tauri/src/main.rs`). A teacher only needs to add LibreOffice to
`PATH` by hand if it was installed somewhere outside all of these
defaults (e.g. a custom install directory). Poppler for Windows:
https://github.com/oschwartz10612/poppler-windows (extract and add its
`bin/` folder to `PATH` for `pdftoppm.exe`/`pdftotext.exe` — poppler has
no equivalent fallback-path search yet, since its own Windows build has
no single conventional install location the way LibreOffice does).

**macOS:** the build script vendors the official LibreOffice.app bundle for
the build machine's architecture (Intel or Apple Silicon). Poppler is still
needed for PDF page rasterization and PDF text extraction unless a separate
bundled Poppler runtime is added. For local development, `brew install poppler`
provides `pdftoppm` and `pdftotext`; PowerPoint conversion uses the bundled
LibreOffice runtime.

## What happens if one/both are missing

Every one of the three Tauri commands returns a specific error string
identifying exactly which tool is missing and points back to this file —
the frontend shows that message to the teacher rather than a generic
failure, a blank result, or a fake conversion. Nothing pretends a file was
converted/read when it wasn't.

## Known visual-fidelity limits (not bugs in this app's code)

Because rendering is fully delegated to LibreOffice + poppler rather than
a bundled PowerPoint-compatible renderer, a converted slide is only ever
as faithful as LibreOffice Impress's own PPTX import. Three real, inherent
gaps a teacher may notice next to opening the same file in actual
PowerPoint:

- **Fonts** — if a font used in the .pptx isn't installed on the machine
  running the conversion, LibreOffice substitutes a fallback font, which
  can reflow text, change line breaks, or shift text off a background
  graphic. Installing the same fonts the deck was authored with (or using
  only system fonts) avoids this.
- **Backgrounds/fills** — LibreOffice's PPTX import has known gaps around
  slide backgrounds set via "Format Background" → picture/texture fill,
  especially when set at the slide-master/layout level rather than per
  slide; these can render blank in some LibreOffice versions. Keeping
  LibreOffice updated to a recent release measurably reduces this.
- **PowerPoint-only effects** — SmartArt, morph transitions, 3D effects,
  and some shadow/gradient combinations are PowerPoint-specific and
  Impress approximates or drops them; there is no workaround short of
  flattening those elements to images before import.

`convert_pptx_to_slides` now runs `soffice` against a fresh, isolated
`-env:UserInstallation` profile per conversion (with `--norestore`)
instead of the machine's shared LibreOffice profile — this was previously
a real reliability gap: a locked/half-initialized shared profile (e.g. a
leftover LibreOffice Quickstarter process, or a conversion that didn't
fully exit) could make a conversion hang until timeout or silently reuse
a broken profile. It's still delegated rendering, so the fidelity gaps
above remain, but this removes one concrete cause of a conversion coming
out incomplete or a slide image failing to appear at all.



**PDF/Word text extraction — verified with real files.** This sandbox
happens to have LibreOffice + poppler-utils already installed, so
`extract_pdf_text`/`extract_docx_text`'s exact function bodies were
compiled standalone with plain `rustc` (the full Tauri app could not be
compiled here — see below) and run against a real generated .docx and the
PDF exported from it. Both extracted the correct text; the
missing-source-file error path was exercised too.

**PowerPoint conversion — logic unchanged from the prior pass, still
BLOCKED for end-to-end verification** (needs the actual Tauri desktop
app + a real multi-slide .pptx; this sandbox has no Tauri GUI runtime).

**Full Tauri application build — NOT VERIFIED, real toolchain limitation.**
This sandbox's Rust toolchain (via apt, including backports) tops out at
rustc/cargo 1.75.0; Tauri v2's dependency tree (e.g. `dlopen2_derive`,
transitively required by the Linux window-manager integration) requires
the `edition2024` Cargo feature, which needs a materially newer Rust.
There is no `rust-toolchain` file pinning an older version in this
project, no newer compiler already present in the environment, and no
network access to `rustup` to fetch one (only crates.io/npm/apt mirrors
are reachable). Downgrading the offending transitive dependency
(`cargo update -p dlopen2_derive --precise <older>`) was attempted and
only shifted the same `edition2024` requirement to a different transitive
crate, so this is a genuine environment limitation, not a one-line fix —
`cargo check`/`cargo build` need to be run in an environment with a
current Rust toolchain (e.g. via `rustup`) to verify the full binary
compiles.


## Checking that everything is installed

Open **Settings → Import Tools**. It shows, for PowerPoint import, PDF page
import, and quiz-from-document import, either `✓ Ready` or what is missing
(for example `⚠ LibreOffice not installed`). The check only looks for the
programs (on PATH, plus LibreOffice's usual install folders) — it never
launches them. After installing a tool, press **Re-check**; if OmniDeck was
already open when you installed it, restart OmniDeck so it picks up the new
PATH (this matters most on Windows).

A PowerPoint import that can't run is refused up front with a message naming
the missing tool, and nothing is added to your lesson. A PDF without Poppler
is still added — as one embedded page rather than page-by-page slides.
