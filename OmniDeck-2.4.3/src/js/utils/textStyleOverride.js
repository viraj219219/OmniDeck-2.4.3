/**
 * Per-page text style overrides (font family / size / color) for the
 * inline slide text elements — title, subtitle, and similar — that are
 * edited directly on the canvas (via editableCanvasText) rather than
 * through a freeform box. Those elements only ever rendered with present.css's
 * fixed clamp() sizing and a hardcoded color, with no way for a teacher to
 * change either — this is the fix for that.
 *
 * `fontSize` is stored as a multiplier (1 = the class's normal clamp()
 * size), not an absolute size, so it keeps scaling sensibly across window
 * sizes the same way the unscaled text already did. It's combined with
 * fitPresentText's own `--present-scale` (see autoFit.js) via calc(), so
 * a teacher's chosen size and the auto-shrink-to-fit logic both apply
 * together rather than one overriding the other.
 */
/**
 * MUST always equal the matching class's own font-size clamp() in
 * present.css exactly (same numbers, just `vw` swapped for the
 * `--slide-w`-relative `calc()` present.css itself uses) — see the
 * "text... scaling" mismatch this fixes: PRESENT_BASE_CLAMP is what runs
 * whenever a teacher applies a custom font size (including to the
 * scripture reference / Bible-book label, "present-ref" below) to
 * title/body/scripture/reference text via applyTextStyleOverride. It
 * previously still held the OLD, pre-Issues-9/10-fix `vw` values —
 * present.css's own clamps were converted to `--slide-w`-relative sizing
 * to fix editor/Present-Mode drift, but this parallel table (used only
 * for the font-SIZE-override path, so easy to miss when eyeballing
 * present.css alone) was never updated, so any slide with a font-size
 * override silently fell back to the old viewport-relative formula and
 * drifted between the editor canvas and actual Present Mode again —
 * exactly the same bug reintroduced through a second, easily-missed copy
 * of the same numbers. Any future change to a clamp() in present.css
 * must be mirrored here too, or this regresses again.
 */
export const PRESENT_BASE_CLAMP = {
  "present-title": "clamp(2.4rem, calc(var(--slide-w, 1200px) * 0.06), 5rem)",
  "present-body": "clamp(1.4rem, calc(var(--slide-w, 1200px) * 0.03), 2.4rem)",
  "present-scripture": "clamp(1.8rem, calc(var(--slide-w, 1200px) * 0.04), 3.2rem)",
  "present-ref": "clamp(1.1rem, calc(var(--slide-w, 1200px) * 0.02), 1.6rem)",
};

/** Applies `style` (`{ fontFamily, fontSize, color }`, any subset) to
 * `el`, which is expected to carry `className` as one of present.css's
 * text classes (see PRESENT_BASE_CLAMP). Safe to call with an
 * empty/undefined style — clears any previous inline override back to
 * the class's own default. */
export function applyTextStyleOverride(el, className, style) {
  if (!el) return;
  const base = PRESENT_BASE_CLAMP[className];
  if (style?.fontSize && base) {
    el.style.fontSize = `calc(var(--present-scale, 1) * ${style.fontSize} * ${base})`;
  } else {
    el.style.fontSize = "";
  }
  el.style.fontFamily = style?.fontFamily || "";
  el.style.color = style?.color || "";
}
