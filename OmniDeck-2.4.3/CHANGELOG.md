# Changelog

## 2.4.3 (OmniDeck 2.4.3)

- Fixed remaining Preview/Presentation typography drift by carrying the preview's measured auto-fit scale into single-screen and audience/projector presentation surfaces.
- Presentation no longer recomputes the auto-fit scale when the editor has supplied its scale; this preserves the preview's text sizing, line wrapping, and layout when the whole slide is scaled up.
- Added parity regression checks for the preview scale handoff and for both presentation render paths.
- Version metadata advanced to 2.4.3 because the prior 2.4.2 package did not fix this reported mismatch.

## 2.4.2 (OmniDeck 2.4.2)

### Preview / presentation WYSIWYG scaling
- Present Mode now renders every slide inside the measured editor preview canvas, then scales that complete canvas uniformly to the available output area. Text wrapping, font clamps, internal spacing, padding, freeform box positions, and image placement are therefore calculated at preview size instead of being reflowed at the projector width.
- The measured design dimensions are passed to the audience window as part of the current slide state, so single-display and two-display output follow the same sizing rule.
- Kept the editor preview layout unchanged; presentation scales the preview geometry rather than changing preview text size.
- Matched freeform text-box inset padding between editor and output.

### Release
- Updated app/package metadata to 2.4.2 (npm, Tauri/Cargo, and lesson-package exports).


## 2.4.1 (OmniDeck 2.4.1)

### Scripture preview / presentation parity
- Editor preview now uses the same Scripture-stage renderer as Present Mode, including the shared inner-stage layout and auto-fit measurements.
- Added saved left/center/right Scripture alignment and Scripture text styling controls (including larger/smaller text) in the editor properties panel.
- Preview canvas clips overflowing content like the actual presentation surface instead of showing an inner scrollbar.

### Release
- Updated app/package metadata to 2.4.1 (npm, Tauri/Cargo, and lesson-package exports).


## 2.4.0 (OmniDeck 2.4)

### Import
- Every PowerPoint slide / PDF page now becomes a real OmniDeck canvas slide ("Slide 1", "Slide 2", ...) whose
  background is the rendered picture. The old "Image" title + caption bar around imported slides is gone.
  Imported slides keep every OmniDeck feature: add text/image boxes, replace the background, reorder, duplicate,
  delete, present. Wide and 4:3 sources are letterboxed (`background.fit = "contain"`), never cropped.
- The editor's slide list now shows thumbnails for pages with a background picture.

### Present Mode / preview
- Fixed the scripture "glitch": long passages were painted at full size for a frame or two before the auto-fit
  shrank them. The fit now runs before the first paint, and re-runs on resize/fullscreen.
- Scripture verse block is centred in the slide (it hugged the left edge).
- Presenter and audience windows keep the previous slide on screen until the next slide's background picture is
  decoded, so imported slides don't flash black on the projector. Resolved background URLs are cached.

### Release
- Versions aligned to 2.4.0 (package.json, lockfile, Cargo, tauri.conf.json, lesson-package metadata).

## 2.3.6
- Fixed Windows LibreOffice process exit-code validation and reuse of the bundled console launcher.
- Synchronized application version metadata.


## 2.3.5

### Packaging / release
- LibreOffice vendoring is **fail-closed**: every archive must match a committed SHA-256 pin; the old fallback to a
  checksum fetched from the same server is gone. `OMNIDECK_PIN_DISCOVERY=1` and the new *Pin LibreOffice checksums*
  workflow produce pins without ever producing a bundle.
- LibreOffice version has one source of truth (`scripts/libreoffice-version.txt`, 26.8.0); the workflow's stale
  24.8.4 is removed.
- macOS is now **per-architecture** (`macos-15-intel`, `macos-15`) instead of universal; minimum macOS raised to 11.0
  (LibreOffice 26.x requirement).
- New release gates: `verify-release-inputs` (pdf.js + LibreOffice present, matching version/arch/provenance,
  versions agree, tag matches), strict pdf.js vendoring, and built-package verification for deb/rpm/AppImage (deb is
  really installed and converts a .pptx), MSI, and DMG.
- `.deb`/`.rpm` dependencies are generated from the bundled binaries (`linux-runtime-depends.sh`); the old
  `recommends: libreoffice-impress, poppler-utils` is removed (Poppler is not needed when pdf.js is vendored).
- Bundled LibreOffice discovery uses Tauri's `resource_dir` (fixes installed `.deb`/`.rpm`), and the dependency
  check now reports the bundled runtime first.
- Windows smoke conversion: output captured via files with bounded waits and tree/profile kill (fixes the
  inherited-pipe hang). *Unverified on Windows from the authoring environment.*
- Versions aligned to 2.3.5 (were 2.3.2).

### Features
- **Portable lesson packages** (`.omnilesson`): Export Lesson / Import Lesson, hardened ZIP, versioned manifest,
  per-asset SHA-256, rollback on failure, unique names. See `docs/PORTABLE_LESSONS.md`.
- **Secure auto-updates** from GitHub Releases (Tauri updater, signature verified). See `docs/UPDATER.md`.
- **Presenter View** for two-display presentations: next-slide preview, slide list, direct selection, status,
  display chooser, video follow with audience-only sound. See `docs/PRESENTER_VIEW.md`.


## 2.3.2
Integration audit pass — no functional changes to shipped behavior.

Two external components were evaluated for integration into this release:
an `@omnideck/import-runtime` Node/TypeScript package (LibreOffice +
Poppler orchestration) and an `@omnideck/universal-bible-converter`
Bible JSON/XML normalizer.

Neither was integrated, because OmniDeck already contains its own
equivalent, tested implementation of both:

- PPT/PPTX/DOC/DOCX/PDF conversion is already implemented natively in
  `src-tauri/src/main.rs`/`util.rs`, calling the same two binaries
  (`soffice`, `pdftoppm`/`pdftotext`) directly from Rust, with bundled-resource
  resolution, PATH fallback, and Windows/macOS well-known-path fallback
  already in place. Bringing in the Node-based runtime would have added
  a Node.js production dependency for functionality that already works
  without one — the exact problem the runtime itself would need solving.
- Bible JSON/XML import (multiple schema shapes, Unicode/script-based
  language detection, atomic replace-on-import) is already implemented
  and tested in `BibleImportService.js` / `BibleLanguageDetectionService.js`.
  The standalone converter module is a clean, dependency-free 14/14-passing
  library, but it duplicates functionality this app already ships and
  tests against real Telugu/Unicode fixtures.

See the audit notes in `IMPLEMENTATION_REPORT.md` (or the assistant's
report) for the full breakdown, confirmed baseline (45/45 syntax check,
18/18 test files, 100% pass), and the platform-packaging gap that
remains open (Windows/macOS have no bundled LibreOffice/Poppler yet —
only Linux is vendored in CI).

## 2.3.1
Two teacher-reported bugs, fixed at the root cause rather than papered over:

- **PowerPoint import crash** (stuck on "Importing PowerPoint" for several
  minutes, then OmniDeck closes; terminal showed exit code `0x8`):
  - The in-webview pdf.js PDF-rendering path (`PdfJsService.renderPdfPagesToPngs`,
    used by the newer PPTX→PDF→PNG pipeline) had no timeout, unlike every
    subprocess path (`soffice`/`pdftoppm`/`pdftotext`), which are all wrapped
    in `run_with_timeout`. A stuck render — e.g. a pdf.js worker that fails to
    initialize cleanly under Tauri's asset protocol — could hang indefinitely
    with the progress overlay never clearing. Now wrapped in the same
    ~120s ceiling as the Rust side, with a clear error on timeout instead of
    an unbounded hang.
  - Added a page-size sanity check before allocating each render canvas: a
    corrupted or unusually-sized PDF page could otherwise try to allocate an
    enormous bitmap and exhaust the renderer's memory, one plausible route to
    the reported crash. Now rejected up front with a clear error.
  - On Windows, a timed-out `soffice` conversion only killed the `soffice.exe`
    launcher PID — LibreOffice's actual worker process (`soffice.bin`) can
    survive that as an orphan, still holding the throwaway profile lock and
    consuming memory, compounding across retries. `run_with_timeout`'s
    timeout path now kills the whole process tree (`taskkill /T /F` on
    Windows) instead of just the one PID.
- **Preview vs. Presentation mismatch** (editor canvas didn't match the
  actual slideshow: positions, spacing, and scaled text all drifted):
  - `.editor-canvas` was missing the `align-items`/`justify-content: center`
    that `.present-slide` has, so slide content sat pinned to the top of the
    editor's preview but centered in the real Present Mode.
  - `.editor-canvas`'s padding and inter-element gap used fixed design
    tokens instead of the slide-width-relative `calc()` present.css already
    used for `.present-slide`/`.present-stage__inner` — so spacing only
    happened to line up at one particular canvas size, not in general.
  - Several `present.css` rules (`.present-stage__inner` gap, media height,
    quiz gap/padding/margin) still used raw `vh` (viewport-relative) left
    over from before the earlier v2.3.0 `--slide-w` fix — converted to the
    same slide-relative formula.
  - The filmstrip thumbnail stage (`.slide-thumb__stage`) never set
    `--slide-w` at all and used a stray `5vw` padding, drifting from both of
    the above.
  - Most significant: `textStyleOverride.js`'s `PRESENT_BASE_CLAMP` table —
    used whenever a teacher applies a custom font size to title/body/
    scripture/reference text (including the scripture-reference "Bible-book
    label") — still held the *old*, pre-`--slide-w` `vw`-based clamp values,
    completely bypassing the earlier fix for any slide with a font-size
    override. Now kept in sync with present.css's real clamp()s, with a new
    regression test (`tests/present-mode-parity.test.mjs`) that fails the
    build if the two are ever allowed to drift apart again.

## 2.2.0 (audit-fix build)
Fixes found in a code audit of the v2.2 source — see README section 7b for
details and how each was verified.

- Present Mode / audience: overlay boxes now render on every slide type; the
  audience window receives the current slide after a display hot-plug; typing
  a quiz answer no longer changes slides; a failed start returns to the editor.
- Tauri: import and audience-window commands no longer run on the main thread.
- Library: an emptied lesson library is not re-seeded; load/delete failures are
  reported instead of silent blank screens.
- Bible view/picker keep search focus and scroll position.
- Media Library asks before deleting a file. Misc: Esc on an empty inline
  field, quiz answer-key shift, real version in Settings.


## 2.3.4 — PowerPoint import and preview parity fixes

- Fixed New Lesson PowerPoint import so every converted PowerPoint slide becomes one OmniDeck image page in original order; the deck is no longer embedded as a mini-presentation with its own navigation.
- New Lesson imports remain transactional: conversion/registration/save failures roll back the media created by that import.
- New Lesson PDF imports also use individual page images when conversion succeeds, preserving the existing embedded-PDF fallback only when page rasterization is unavailable.
- Aligned Scripture preview ordering with Present Mode (verse content first, reference below) and centered default content to match the presentation stage; explicit text alignment remains respected.
- Added regression assertions for one-to-one PowerPoint page creation and Scripture content order.
