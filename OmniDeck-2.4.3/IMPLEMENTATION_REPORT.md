# OmniDeck QA Fix Pass — Implementation Report

## 1. Fixed

**Issue 1 — PowerPoint import/rendering.** Root cause: `util.rs`'s renderer
detection was already correct, but nothing ever shipped a bundled renderer.
`tauri.conf.json` never declared a `bundle.resources` entry, so even a
populated `src-tauri/resources/libreoffice/` folder wouldn't be packaged
into the installer — and CI never called the existing (dormant)
`scripts/vendor-libreoffice-linux.sh` in the first place. Fixed both: added
the `bundle.resources` mapping, and wired the vendoring script into
`.github/workflows/build.yml` for both Linux architectures, before
`tauri build`. Also fixed a misleading error message that told users
"reinstalling OmniDeck should restore it" on platforms that never bundled
anything. **Caveat, stated plainly:** Linux is now self-contained by this
fix, assuming the vendoring script's hardcoded download URL/version is
correct — the script's own header already flagged this as "NOT VERIFIED
end-to-end" (written without network access), and I likewise have no
network access in this environment to run it and confirm. Windows/macOS
still have **no vendoring script at all** and depend on a system
LibreOffice install, same as before — documented in
`src-tauri/resources/libreoffice/README.md` rather than silently implied
to be handled.

**Issue 2 — Bible JSON importer.** The importer only ever accepted one
rigid shape (`books: {key: {chapterNum: {verseNum: text}}}`), which is why
real-world files using a different (but common) structure were rejected
with "No book data was found," independent of the language field. Rewrote
the book/chapter/verse recognition to also accept: books as an array of
book objects, chapters as an array-of-arrays, books keyed by full display
name or by a plain 1–66 book number, and a flat list of individual
`{book, chapter, verse, text}` verse records (as the file's root array or
under a `"verses"` key). Language detection itself was already correct
(confirmed via the existing test suite) and untouched. Added 6 new test
cases for the newly-recognized shapes; all 21 pre-existing bible-import
tests still pass unchanged.

**Issue 3 — AI quiz generation removed completely.** Deleted
`QuizGenerationService.js` and `DocumentImportService.js` (the latter had
no other caller once the AI-generation modal is gone), the "Generate Quiz
from Document" toolbar button and its ~150-line modal in `lessonEditor.js`,
the "AI Quiz Generation" settings section and its config load/save in
`settings.js`, and the now-defunct `quiz-generation.test.mjs`. Verified
zero remaining references anywhere in the repo. The Rust-side
`extract_pdf_text`/`extract_docx_text` commands were **not** removed (see
Remaining issues below).

**Issue 4 — PDF import progress feedback.** Added a full-screen overlay
("Processing PDF…" / "This may take a moment. Please don't close OmniDeck.")
with an indeterminate spinner, shown for the duration of
`_importSlides()` in `lessonEditor.js` and guaranteed to clear via a
`finally` block on success, failure, or a cancelled file picker. One known
imperfection, noted rather than hidden: the overlay appears as soon as the
button is clicked, which includes the brief native file-picker wait, not
only the actual multi-minute conversion step — splitting those apart would
require threading a progress callback through the transactional import
pipeline (`ImportService.js`), which felt like more risk than the cosmetic
gain justified for this pass.

**Issue 5 — Quiz text formatting.** Wired the quiz question into the
existing font/color override system (`renderTextStyleControls` /
`applyTextStyleOverride`) that title/subtitle already use — added a
`page.questionStyle` field, a "Question" formatting section in the quiz
properties panel, and applied the override in both the editor canvas and
`slideStage.js`'s Present Mode rendering (both the options-based and
text-answer quiz layouts). Persists with the page like any other property;
no new/incompatible system introduced.

**Issue 6 — Bible chapter navigation. Investigated; already implemented.**
Both Bible-browsing surfaces already support jumping directly to any
chapter: `bible.js`'s reader has a `<select>` of every chapter (plus
Prev/Next), and `scripturePicker.js`'s modal shows a full chapter-number
button grid — both sized dynamically from the real per-book chapter count
via `BibleService.getBooks()`, not hardcoded. No bug was found after
tracing the data flow and checking for CSS/visibility issues; no change
was made here. Reporting this honestly rather than inventing a fix for an
issue that doesn't reproduce in this codebase.

**Issue 7 — Add Quiz → Text import.** Replaced the plain "Add Quiz" button
with a small chooser ("Blank Quiz" / "From Text"). "From Text" shows a
textarea; questions are split on blank lines (not every newline, so a
question can wrap multiple lines), with a live "N questions detected"
counter, then created as separate quiz pages in one persisted step.

**Issue 8 — Incomplete quiz blocking Present Mode.** Root cause:
`LessonService.validateForPresentation` deliberately excludes quiz
validation (its own comment said so), but `presentMode.js` was
re-running `quizService.validateQuizPage()` over every quiz page and
pushing the results into the same list that blocks the whole lesson from
presenting — directly contradicting the architecture already in place.
`slideStage.js`'s quiz rendering already had correct per-slide warning
handling ("This quiz can't be presented yet: …") that was simply never
being reached because the lesson-level gate blocked everything first.
Removed the duplicate validation from `presentMode.js`'s blocking gate
(Next/Previous were never disabled by quiz validity, so no other change
was needed there) and added a red "⚠ Needs answers" badge to the slide
filmstrip in the editor, sourced from the same `quizService.validateQuizPage`.

**Issues 9 & 10 — Aspect ratio consistency / Present Mode rendering
mismatch.** Root cause, found by tracing the actual rendering pipeline
rather than guessing: `.editor-canvas` is a fixed 16:9 box, but its text
used `vw`-based `clamp()` font sizing — relative to the *whole browser
viewport*, not the (often much narrower, centered, scrollable-pane) canvas
box itself. `.present-stage` had no fixed aspect ratio at all, so its
effective "slide shape" changed with the window's own shape. Both were
real, independent sources of drift between what a teacher sees while
editing and what Present Mode actually shows.

Fix: a new `src/js/utils/slideScale.js` exposes each slide surface's own
real rendered pixel width as a `--slide-w` CSS custom property
(`observeSlideWidth`), and letterboxes Present Mode into an actual
fixed-16:9 `.present-slide` box that fits inside the available window
(`fitSlideBox`), the same shape `.editor-canvas` already is. Every
`vw`-based font-size (and the relevant width-affecting padding/gap values)
in `present.css` now reads `calc(var(--slide-w, …) * fraction)` instead —
sized relative to the box actually holding the text, not the window around
it. Applied to the editor canvas, the presenter's own screen
(`presentMode.js`), and the second-display audience window
(`audience.js`), so all three now render text identically regardless of
each one's actual on-screen size. Caught and fixed two bugs introduced
while making this change, both verified against the existing test suite:
a temporal-dead-zone crash from declaring a `let` after its first use, and
a positioning bug where boxes overlaid on a non-freeform slide would have
been positioned relative to the wrong (now-larger) container after the
restructuring.

**"Blue line" in Present Mode.** I could not visually run the app to
confirm the exact source, so I want to be upfront about that rather than
claim certainty. After ruling out present.css itself (no blue anywhere in
it) and the editor-only freeform snap-guides (scoped to the editor canvas,
never present in Present Mode's own rendering path), the most defensible,
cross-platform-relevant candidate is a native focus ring: `base.css` only
resets `:focus-visible` (assuming a browser that shows the native ring for
keyboard focus only), but WebKitGTK's heuristic for *when* to paint that
ring differs by version and can still show it on a clicked/tapped button,
quiz option, or the fill-in-the-blank input. Added an explicit
`outline: none` for buttons/inputs/`[tabindex]` scoped to `.present-root`
only (never touching the editor's own legitimate selection outlines) as a
defensive, low-risk fix for this specific, plausible cause. **This is
flagged as unverified** — if the blue line persists, it has a different
source than the one addressed here.

## 2. Files changed

- `.github/workflows/build.yml` — vendor LibreOffice into Linux builds before `tauri build` (Issue 1)
- `src-tauri/tauri.conf.json` — declare `bundle.resources` so the vendored renderer actually ships (Issue 1)
- `src-tauri/resources/libreoffice/README.md` — new; documents the bundling story per platform (Issue 1)
- `src/js/services/DependencyService.js` — accurate (not misleading) PowerPoint-unavailable message (Issue 1)
- `src/js/services/BibleImportService.js` — generic book/chapter/verse shape recognition (Issue 2)
- `tests/bible-import.test.mjs` — 6 new test cases for the new shapes (Issue 2)
- `src/js/services/QuizGenerationService.js` — **deleted** (Issue 3)
- `src/js/services/DocumentImportService.js` — **deleted**, dead after the above (Issue 3)
- `tests/quiz-generation.test.mjs` — **deleted**, tested the removed service (Issue 3)
- `src/js/views/settings.js` — removed AI quiz config UI; fixed a settings-copy edit mistake along the way (Issue 3)
- `src/js/views/lessonEditor.js` — removed AI quiz modal/button; added Add-Quiz-from-text chooser (Issue 7); PDF/PPTX progress overlay (Issue 4); quiz question style controls (Issue 5); filmstrip warning badge (Issue 8); `--slide-w` observer wiring (Issues 9/10)
- `src/js/views/presentMode.js` — removed quiz from the lesson-blocking gate (Issue 8); `.present-slide` letterbox wiring (Issues 9/10)
- `src/js/audience.js` — same `.present-slide` letterbox wiring, for the second-display window (Issues 9/10)
- `src/js/components/slideStage.js` — apply `questionStyle` override in both quiz render paths (Issue 5)
- `src/js/utils/slideScale.js` — new; `--slide-w` / letterbox-fit utilities (Issues 9/10)
- `src/styles/present.css` — `.present-slide` box; `vw` → `--slide-w`-relative sizing; focus-ring reset (Issues 9/10, blue line)
- `src/styles/components.css` — import-progress-overlay styles (Issue 4); filmstrip warning badge styles (Issue 8)

## 3. Tests run

- `node tests/syntax-check.mjs` — **45/45 files OK** (final state; re-run after every edit throughout)
- `node tests/run-all.mjs` — **16/16 test files passed, ALL PASS** (478 individual assertions; re-run after every meaningful change, not just once at the end)
- `node tests/bible-import.test.mjs` (individually, while iterating on Issue 2) — all pass, including the 6 new cases
- `node tests/regressions-v2-2.test.mjs` (individually, to check the Issues 9/10 DOM restructuring against existing overlay-box regression coverage) — all pass, including the present.css brace-balance check
- Verified with `python3 -m json.tool` / `pyyaml` that the edited `tauri.conf.json` and `build.yml` are syntactically valid
- **Not run: `cargo check` / `cargo test`.** No Rust toolchain is available in this environment. I did not touch any `.rs` file in this pass — only `tauri.conf.json` (bundling config) and the CI workflow — so Rust-side compilation risk from my changes specifically is low, but this is genuinely untested, not just "expected to pass," and should be verified in CI before a release build.
- **Not run: the actual `scripts/vendor-libreoffice-linux.sh` download**, or a real `tauri build` / installed-app PowerPoint import. No network access in this environment. The script's own header already disclosed it was unverified end-to-end before I touched it.

## 4. Remaining issues

- **Windows/macOS have no bundled PowerPoint renderer.** Only Linux is vendored via CI. Documented, not silently glossed over — see `src-tauri/resources/libreoffice/README.md`.
- **`scripts/vendor-libreoffice-linux.sh`'s download URL/version is unverified** (no network access to confirm it actually resolves and produces a working `soffice`). Needs a real CI run to confirm before relying on it for a release.
- **Rust-side `extract_pdf_text`/`extract_docx_text` commands are now dead code** (their only caller, the AI quiz modal, was removed). Left in place rather than removed, since they're generic/tested infrastructure unrelated to the AI-specific parts of Issue 3, and I have no Rust compiler here to verify a clean removal wouldn't break something else registered around them (e.g. `docx_reader.rs`). Flagging as a candidate for a follow-up cleanup pass with a real Rust toolchain available.
- **Issue 4's progress overlay spans the file-picker wait, not only the conversion step** — see the note under Issue 4 above. Cosmetically slightly early, functionally correct (never shows nothing during the slow part).
- **The "blue line" fix is unverified** — I addressed the most plausible cause I could find through static investigation, but couldn't visually confirm the actual bug. If it persists, please point me at what you're actually seeing (a screenshot or which slide type) and I can dig further.
- **`.present-stage__inner`'s vertical `gap` and the media-slide height (`.present-stage__inner--media .media-slide`) still use `vh`** rather than being converted to `--slide-w`-relative sizing. Lower-impact than the font-size fix (vertical spacing/media sizing, not the width-driven text-wrapping mismatches the issue specifically described), left as-is given the scope of this pass — flagging in case it matters for your specific projector setups.
- **Cargo/Rust build was not actually run** (see Tests run above) — please run `cargo check` / `cargo test` in CI before shipping.
