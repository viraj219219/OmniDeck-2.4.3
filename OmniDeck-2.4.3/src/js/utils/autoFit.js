/**
 * Content-aware text auto-fit for Present Mode / the editor canvas.
 *
 * Previously Scripture/Quiz text only scaled with `clamp(..., Nvw, ...)`,
 * which responds to *window* width, not to how much text is actually on
 * the slide — a one-verse reference and a fifteen-verse passage got the
 * exact same font size, so long passages could overflow the fixed-size
 * stage (clipped off-screen in real Present Mode, since .present-root has
 * no scroll; shown with a scrollbar in the editor canvas).
 *
 * This sets a `--present-scale` CSS custom property on the bounding
 * element (present.css's font-size rules read it via
 * `calc(var(--present-scale, 1) * clamp(...))`), shrinking it step by
 * step only until the content actually fits — so short content stays at
 * its normal, full-size clamp() value, and long content shrinks only as
 * much as it needs to (never below `min`, so it can't vanish into
 * unreadable text either).
 *
 * v2.4 — no more "glitch" on long passages. The old version reset the scale
 * to 1 in one animation frame and only shrank it in the NEXT one, so every
 * slide change painted the passage at full size (overflowing the screen) for
 * a frame or two before snapping down. The fit is now computed in the same
 * task as the change (the measuring reads force layout, they don't paint),
 * so the browser's first paint already has the final size. It re-checks once
 * on the next frame (fonts/images may settle) and whenever the slide's own
 * box is resized (e.g. entering fullscreen), all without ever painting an
 * unfitted state.
 */
function fitNow(el, { min, step, maxSteps }) {
  if (!el || !el.isConnected) return false;
  if (!el.clientHeight) return false; // not laid out yet — caller retries next frame
  let scale = 1;
  let guard = 0;
  el.style.setProperty("--present-scale", "1");
  while (el.scrollHeight > el.clientHeight + 1 && scale > min && guard < maxSteps) {
    scale = Math.max(min, scale - step);
    el.style.setProperty("--present-scale", String(scale));
    guard++;
  }
  return true;
}

export function fitPresentText(el, { min = 0.5, step = 0.04, maxSteps = 20 } = {}) {
  if (!el) return;
  const opts = { min, step, maxSteps };

  // Immediately (before the first paint of this slide).
  fitNow(el, opts);

  // Once more after the next layout pass; harmless if nothing changed.
  requestAnimationFrame(() => { fitNow(el, opts); });

  // Re-fit when the slide box changes size (window resize, fullscreen).
  if (typeof ResizeObserver !== "undefined" && !el.__fitObserver) {
    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    let queued = false;
    const ro = new ResizeObserver(() => {
      if (!el.isConnected) { ro.disconnect(); el.__fitObserver = null; return; }
      if (el.clientWidth === lastW && el.clientHeight === lastH) return;
      lastW = el.clientWidth;
      lastH = el.clientHeight;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fitNow(el, opts); });
    });
    ro.observe(el);
    el.__fitObserver = ro;
  }
}
