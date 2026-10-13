// Static parity checks for the Preview (.editor-canvas) vs Presentation
// (.present-slide / Present Mode) rendering mismatch fix.
//
// Both surfaces render the exact same page data through the same CSS
// classes (present-title, present-body, present-scripture, present-ref,
// present-eyebrow, .present-stage__inner, ...) by design — see the
// comments on .editor-canvas in components.css and on --slide-w in
// slideScale.js. That design only holds if every rule using those
// classes sizes itself relative to the box's own real width
// (`--slide-w`), never relative to the browser viewport (`vw`/`vh`) or a
// fixed design token — either of those computes a different actual pixel
// value in a small editor canvas than in a near-fullscreen Present Mode
// window, which is exactly what drifted before this fix (see
// IMPLEMENTATION_REPORT.md Issues 9/10, and PRESENT_BASE_CLAMP's comment
// in textStyleOverride.js for the specific regression this test guards).
//
// No real browser/layout engine runs in this test suite (see
// tests/helpers/miniDom.mjs), so this can't verify actual computed
// pixels — it verifies the SOURCE-LEVEL invariants that make identical
// pixels possible: no stray viewport-relative unit in the shared slide
// classes, and the font-size-override table kept byte-for-byte in sync
// with present.css's own clamp()s.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./helpers/fakeDisk.mjs";

const { check, done } = makeChecker();
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const stripCssComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "");

const presentCss = stripCssComments(read("src/styles/present.css"));
const componentsCss = stripCssComments(read("src/styles/components.css"));
const textStyleOverrideSrc = read("src/js/utils/textStyleOverride.js");
const lessonEditorSrc = read("src/js/views/lessonEditor.js");
const slideStageSrc = read("src/js/components/slideStage.js");

// ---- no viewport-relative units left in the shared slide-rendering classes ----
// (layout.css's page-shell 100vw/100vh and components.css's modal/quiz-review
// max-width/height are legitimate — those size app chrome against the real
// browser window on purpose, not a slide surface shared with Present Mode.)
const vhVw = /(?<![a-zA-Z-])\d*\.?\d+v[hw]\b/g;

check(
  "present.css has no viewport-relative (vh/vw) units left on slide-content rules",
  (presentCss.match(vhVw) || []).length === 0
);

const editorCanvasRule = /\.editor-canvas\s*\{[\s\S]*?\n\}/.exec(componentsCss)?.[0] || "";
check("components.css's .editor-canvas rule was found", editorCanvasRule.length > 0);
check(
  ".editor-canvas has no viewport-relative (vh/vw) units",
  (editorCanvasRule.match(vhVw) || []).length === 0
);
check(
  ".editor-canvas centers its content (align-items + justify-content), matching .present-slide",
  /align-items:\s*center/.test(editorCanvasRule) && /justify-content:\s*center/.test(editorCanvasRule)
);
check(
  ".editor-canvas's padding is --slide-w-relative (not a fixed design token), matching .present-slide",
  /padding:\s*calc\(var\(--slide-w/.test(editorCanvasRule)
);
check(
  ".editor-canvas's gap is --slide-w-relative (not a fixed design token), matching .present-stage__inner",
  /gap:\s*calc\(var\(--slide-w/.test(editorCanvasRule)
);
check(
  "editor preview uses the shared presentation renderer instead of rebuilding slide markup",
  /renderPresentStage\(page,\s*\{[\s\S]*?interactive:\s*false,[\s\S]*?editorPreview:\s*true,[\s\S]*?omitBoxes:\s*true/.test(lessonEditorSrc)
    && /case "scripture":\s*return renderScriptureStage\(page,/.test(slideStageSrc)
);
check(
  "editor Scripture preview no longer builds a separate verse/reference layout",
  !/case "scripture"[\s\S]*?renderVerseList\(page\.verses/.test(lessonEditorSrc)
);
check(
  "Scripture stage applies saved alignment and text-size overrides",
  /page\.scriptureAlign/.test(slideStageSrc) &&
    /applyTextStyleOverride\(verses, "present-scripture", page\.scriptureStyle\)/.test(slideStageSrc)
);
check(
  "Scripture properties expose alignment and size/font styling controls",
  /alignmentField\(page, "scriptureAlign", "Scripture Alignment", "center"\)/.test(lessonEditorSrc) &&
    /renderTextStyleControls\(page, "scriptureStyle", "present-scripture", "Scripture Text"\)/.test(lessonEditorSrc)
);

// ---- Present Mode must scale the preview canvas as one surface ----
const presentModeSrc = read("src/js/views/presentMode.js");
const audienceSrc = read("src/js/audience.js");
const presenterSessionSrc = read("src/js/services/PresenterSession.js");
const slideScaleSrc = read("src/js/utils/slideScale.js");
check(
  "scaled slide renderer uses the actual editor canvas as its logical design surface",
  /export function renderScaledPresentSlide\(page, opts = \{\}, previewSize = \{\}\)/.test(slideStageSrc) &&
    /class: `present-slide__design \$\{surfaceClass\}`/.test(slideStageSrc) &&
    /data-design-width/.test(slideStageSrc) &&
    /renderPresentStage\(page, \{ \...opts, editorPreview: true \}\)/.test(slideStageSrc)
);
check(
  "Present button measures the active editor/freeform canvas before navigation",
  /function measurePreviewSize\(\)/.test(lessonEditorSrc) &&
    /page\?\.type === "freeform" \? "\.freeform-canvas" : "\.editor-canvas"/.test(lessonEditorSrc) &&
    /previewSize: measurePreviewSize\(\)/.test(lessonEditorSrc)
);
check(
  "preview measurement captures the exact auto-fit scale used by the editor canvas",
  /canvas\.style\.getPropertyValue\?\.\("--present-scale"\)/.test(lessonEditorSrc) &&
    /presentScale:\s*fittedScale/.test(lessonEditorSrc)
);
check(
  "scaled presentation surface preserves the preview's captured auto-fit scale",
  /previewSize\.presentScale/.test(slideStageSrc) &&
    /surface\.style\.setProperty\("--present-scale", String\(previewScale\)\)/.test(slideStageSrc)
);
check(
  "single-display Present Mode does not recompute auto-fit when an authoritative preview scale exists",
  /hasPreviewScale/.test(presentModeSrc) &&
    /!hasPreviewScale\) fitPresentText\(designSurface \|\| slide\)/.test(presentModeSrc)
);
check(
  "audience/projector output reuses the captured preview scale rather than recomputing it",
  /hasPreviewScale/.test(audienceSrc) &&
    /!hasPreviewScale\) fitPresentText\(designSurface \|\| slide\)/.test(audienceSrc)
);
check(
  "single-display presentation uses the measured preview dimensions",
  /renderScaledPresentSlide\(view\.current,[\s\S]*?params\.previewSize\)/.test(presentModeSrc) &&
    /previewSize: params\.previewSize/.test(presentModeSrc)
);
check(
  "audience output receives the same measured design dimensions",
  /previewSize: designSize/.test(presenterSessionSrc) &&
    /renderScaledPresentSlide\(state\.page,[\s\S]*?state\.previewSize/.test(audienceSrc)
);
check(
  "output scales the whole design surface uniformly without recomputing its logical width",
  /designSurface\.style\.transform = `scale\(\$\{fittedWidth \/ designWidth\}\)`/.test(slideScaleSrc)
);
const freeformTextRule = /(?:^|\n)\.present-freeform-box__text\s*\{([^}]*)\}/m.exec(presentCss)?.[1] || "";
check(
  "freeform output text keeps the same 4px inset as the editor preview",
  /padding:\s*4px/.test(freeformTextRule)
);

const slideThumbStageRule = /\.slide-thumb__stage\s*\{[\s\S]*?\n\}/.exec(componentsCss)?.[0] || "";
check("components.css's .slide-thumb__stage rule was found", slideThumbStageRule.length > 0);
check(
  ".slide-thumb__stage sets its own --slide-w (it's a fixed 1280px virtual stage, not measured by ResizeObserver)",
  /--slide-w:\s*1280px/.test(slideThumbStageRule)
);
check(
  ".slide-thumb__stage has no viewport-relative (vh/vw) units",
  (slideThumbStageRule.match(vhVw) || []).length === 0
);

// ---- PRESENT_BASE_CLAMP (textStyleOverride.js) matches present.css's own clamp()s exactly ----
// This is the specific regression this whole file exists to catch: a
// font-size OVERRIDE on title/body/scripture/reference text is computed
// from PRESENT_BASE_CLAMP, a hand-copied table — not from present.css
// directly — so it can silently drift out of sync with present.css's
// real clamp()s (as it did: it still held the pre-fix `vw` values) even
// after present.css itself is fixed, unless the two are cross-checked.
function clampFor(cssText, className) {
  // `.className` can also appear as part of a combined selector list on an
  // unrelated rule (e.g. ".present-title, .present-body, .present-scripture
  // { align-self: stretch; }") — that block has no font-size, so it must be
  // skipped rather than letting a non-greedy match run past it into the
  // next rule's font-size by accident. Every `.className { ... }` block is
  // checked in turn; the one that actually declares font-size wins.
  const blockRe = new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`, "g");
  for (const m of cssText.matchAll(blockRe)) {
    const body = m[1];
    const fs = /font-size:\s*calc\(var\(--present-scale,\s*1\)\s*\*\s*(clamp\([^;]+\))\);/.exec(body);
    if (fs) return fs[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

const overrideMatch = /export const PRESENT_BASE_CLAMP = \{([\s\S]*?)\};/.exec(textStyleOverrideSrc);
check("textStyleOverride.js's PRESENT_BASE_CLAMP was found", !!overrideMatch);
const overrideEntries = {};
if (overrideMatch) {
  for (const m of overrideMatch[1].matchAll(/["']([a-z-]+)["']:\s*["']([^"']+)["']/g)) {
    overrideEntries[m[1]] = m[2].replace(/\s+/g, " ").trim();
  }
}

for (const className of ["present-title", "present-body", "present-scripture", "present-ref"]) {
  const fromCss = clampFor(presentCss, className);
  check(`present.css has a font-size clamp() for .${className}`, !!fromCss);
  check(
    `PRESENT_BASE_CLAMP["${className}"] matches present.css's .${className} clamp() exactly (no stale/duplicated value)`,
    !!fromCss && overrideEntries[className] === fromCss
  );
  check(
    `PRESENT_BASE_CLAMP["${className}"] is --slide-w-relative, not vw-relative`,
    !!overrideEntries[className] && overrideEntries[className].includes("var(--slide-w") && !/\dvw/.test(overrideEntries[className])
  );
}

done();
