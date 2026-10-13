/**
 * Root cause of Issues 9 & 10 (aspect ratio / Present Mode drift):
 *
 * present.css's font sizes were `clamp(min, Nvw, max)` — sized against the
 * whole browser *viewport* width. That's correct ONLY when the element
 * doing the sizing fills the viewport exactly. `.editor-canvas` never
 * does: it's a fixed-max-width, fixed-16:9 box centered inside a scrolling
 * pane, often much narrower than the window. So the same "6vw" computed a
 * different actual pixel size in the editor than it did in a fullscreen
 * Present Mode window — text wrapped differently, titles sat in different
 * places, and the two surfaces drifted apart even though they share the
 * exact same slide-rendering code (see slideStage.js).
 *
 * `.present-stage` had no fixed aspect ratio at all either, so its
 * effective "slide shape" changed with the window's own shape — another
 * source of drift, independent of the vw issue above.
 *
 * The fix: every slide-sized surface (the editor canvas, and Present
 * Mode's letterboxed slide box) exposes its OWN rendered pixel width as
 * the CSS custom property `--slide-w`. present.css's clamp()s then read
 * `calc(var(--slide-w, …) * fraction)` instead of `Nvw` — sized relative
 * to the box actually holding the text, not the window around it. Two
 * boxes of the same 16:9 shape now render text identically no matter how
 * large either one physically is on screen.
 */

/** Keeps `--slide-w` on `el` equal to el's own current rendered width (in
 * px), via ResizeObserver. Call once per element; returns a cleanup
 * function that stops observing (call it when the element is discarded,
 * to avoid leaking observers across re-renders). Safe to call on an
 * element not yet in the document — ResizeObserver picks it up once it's
 * connected and has a real size. */
export function observeSlideWidth(el) {
  if (!el) return () => {};
  const set = () => {
    const w = el.clientWidth;
    if (w > 0) el.style.setProperty("--slide-w", `${w}px`);
  };
  set();
  if (typeof ResizeObserver === "undefined") {
    // No ResizeObserver in this environment (e.g. a non-browser test
    // runner) — fall back to a one-shot size instead of leaving
    // --slide-w unset, which would fall back to clamp()'s own default
    // and still render something reasonable.
    return () => {};
  }
  const ro = new ResizeObserver(set);
  ro.observe(el);
  return () => ro.disconnect();
}

/**
 * Sizes `slideEl` to the largest `ratio`-shaped (default 16:9) box that
 * fits inside `containerEl`, the same letterboxing technique a video
 * player uses — fills whichever dimension is the tighter constraint,
 * centered via the caller's own CSS (this only ever sets width/height).
 * Also keeps `--slide-w` on `slideEl` in sync (see observeSlideWidth), so
 * callers don't need to call both. Returns a cleanup function.
 */
export function fitSlideBox(containerEl, slideEl, ratio = 16 / 9) {
  if (!containerEl || !slideEl) return () => {};
  const set = () => {
    const cw = containerEl.clientWidth;
    const ch = containerEl.clientHeight;
    if (!cw || !ch) return;
    let w = cw;
    let h = w / ratio;
    if (h > ch) {
      h = ch;
      w = h * ratio;
    }
    const fittedWidth = Math.round(w);
    slideEl.style.width = `${fittedWidth}px`;
    slideEl.style.height = `${Math.round(h)}px`;
    slideEl.style.setProperty("--slide-w", `${fittedWidth}px`);

    // WYSIWYG path: preserve the editor canvas's measured layout and upscale
    // it as a single 16:9 surface. This keeps all text wrapping, width caps,
    // CSS clamps, internal padding and overlays proportional at every output
    // resolution instead of recomputing those decisions on the larger screen.
    const designSurface = slideEl.querySelector?.(".present-slide__design");
    if (designSurface) {
      const designWidth = Number(designSurface.dataset?.designWidth) || designSurface.getBoundingClientRect().width;
      if (designWidth > 0) designSurface.style.transform = `scale(${fittedWidth / designWidth})`;
    }
  };
  set();
  if (typeof ResizeObserver === "undefined") {
    window.addEventListener("resize", set);
    return () => window.removeEventListener("resize", set);
  }
  const ro = new ResizeObserver(set);
  ro.observe(containerEl);
  return () => ro.disconnect();
}
