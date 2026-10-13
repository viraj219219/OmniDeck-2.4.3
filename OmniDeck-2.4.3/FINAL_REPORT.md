# OmniDeck 2.4.3 — final report

## Changed
- **Preview-to-presentation sizing:** Present Mode measures the active editor slide canvas before leaving the editor. Presentation and the audience display render at those logical dimensions and uniformly scale the full canvas to fit the output area.
- **Authoritative text auto-fit:** The editor's measured `--present-scale` is passed along with the design dimensions and applied to both the single-display presentation and audience/projector renderer. When the preview scale is provided, the output no longer independently re-runs auto-fit and risks a different text size/wrapping result.
- **All slide types:** The scaled-canvas path covers Scripture, title, quiz, media, discussion/conclusion, mixed text/image-box overlays, and freeform slides. The same measured design dimensions are sent to the second-screen audience window.
- **Freeform parity:** Matched the text-box inner padding between the editor and presentation.
- **Version:** 2.4.3 in package metadata, lockfiles, Tauri/Cargo, lesson-package exports, release documentation, and updater test fixtures.

## Verification
- `node tests/run-all.mjs`: 29/29 test files passed; 0 failed. PowerShell behavioral tests inside the Windows LibreOffice test suite were skipped because `pwsh` is not installed in this environment.
- `node tests/syntax-check.mjs`: 51/51 JavaScript files passed.
- `node tests/release-config.test.mjs`: app version consistency and release configuration checks passed.
- Added regression checks for measuring the editor surface, transporting dimensions and the captured auto-fit factor, directly testing that `renderScaledPresentSlide` applies that factor, and confirming both output paths do not re-fit authoritative preview-scale slides.

## Not verified / open
- No native Windows/macOS/Linux Tauri installer build or physical-projector visual comparison was run in this authoring environment. Browser-based visual verification was blocked because this environment's browser sandbox refused local and localhost pages.
- Automated unit/source tests verify the sizing handoff but do not prove pixel-for-pixel parity in the Windows WebView; the updated source still needs to be rebuilt/launched and visually checked on the target machine.
