import { mediaService } from "../services/MediaService.js";

// v2.4 — flicker-free slide changes. Resolving a background image's URL takes
// several async hops (library lookup + native path calls), and the picture then
// still has to be decoded. If a slide were shown first and its background filled
// in afterwards, every imported PowerPoint/PDF slide (whose picture IS its
// background) would flash empty on the projector at each change. So:
//   - resolved URLs are cached by media id (a media id never changes its file),
//     which lets a repeat showing paint synchronously, and
//   - preloadPageBackground() resolves + decodes the image ahead of time, so
//     the presenter/audience windows can keep the previous slide on screen until
//     the next one is fully ready, then swap in one step.
const urlCache = new Map(); // mediaId -> asset URL
const decodeCache = new Map(); // url -> Promise<void>

async function resolveBackgroundUrl(mediaId) {
  if (urlCache.has(mediaId)) return urlCache.get(mediaId);
  const item = await mediaService.isReferenced(mediaId);
  if (!item) return null;
  const url = await mediaService.getAssetUrl(item);
  if (url) urlCache.set(mediaId, url);
  return url;
}

function decodeImage(url) {
  if (typeof Image === "undefined") return Promise.resolve();
  if (decodeCache.has(url)) return decodeCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    const done = () => resolve();
    const timer = setTimeout(done, 2500); // never hold a slide back for a slow disk
    img.onload = () => { clearTimeout(timer); (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(done); };
    img.onerror = () => { clearTimeout(timer); done(); };
    img.src = url;
  });
  decodeCache.set(url, p);
  return p;
}

/** Resolves a page's background image and decodes it so the next paint is instant. Never throws. */
export async function preloadPageBackground(page) {
  const bg = page?.background;
  if (!bg || bg.type !== "image" || !bg.mediaId) return;
  try {
    const url = await resolveBackgroundUrl(bg.mediaId);
    if (url) await decodeImage(url);
  } catch { /* cosmetic — applyPageBackground falls back on its own */ }
}

function paintImageBackground(el, url, bg) {
  el.classList.add("has-custom-bg");
  // `fit: "contain"` is used by imported PowerPoint/PDF slides: the whole
  // slide picture is shown (letterboxed on black if its aspect ratio
  // differs from the 16:9 stage) instead of being cropped to fill.
  const contain = bg.fit === "contain";
  el.style.background = contain ? "#000" : "#14181D";
  el.style.backgroundImage = `url("${url}")`;
  el.style.backgroundSize = contain ? "contain" : "cover";
  el.style.backgroundPosition = "center";
  el.style.backgroundRepeat = "no-repeat";
}

/**
 * Applies a page's custom background (see page.background — set from the
 * Lesson Editor's "Background" panel) to a slide surface element. This is
 * the single application point shared by Present Mode's `.present-stage`,
 * the audience window's `.present-stage`, and the editor's `.editor-canvas`
 * / `.freeform-canvas`, so a background looks identical everywhere a slide
 * is shown — same principle as present.css's shared classes already give
 * text layout.
 *
 * Async because an image background needs its asset URL resolved first;
 * callers don't need to await this (fire-and-forget is fine — the
 * background fills in once resolved, a frame or two after the rest of the
 * slide). Anything missing/unset/broken falls back to the element's normal
 * CSS background (by clearing the inline override) rather than blocking
 * the slide from showing at all.
 */
export async function applyPageBackground(el, page) {
  if (!el) return;
  const bg = page?.background;
  const clear = () => {
    el.style.background = "";
    el.style.backgroundImage = "";
    el.classList.remove("has-custom-bg");
  };

  if (!bg || bg.type === "default" || !bg.type) {
    clear();
    return;
  }

  el.classList.add("has-custom-bg");

  if (bg.type === "solid") {
    el.style.backgroundImage = "";
    el.style.background = bg.color || "#14181D";
    return;
  }

  if (bg.type === "gradient") {
    el.style.backgroundImage = "";
    el.style.background = `linear-gradient(${bg.gradientAngle ?? 135}deg, ${bg.gradientFrom || "#14181D"}, ${bg.gradientTo || "#2A2F36"})`;
    return;
  }

  if (bg.type === "image") {
    if (!bg.mediaId) { clear(); return; }
    // Cache hit: paint synchronously, before the browser's next frame.
    const cached = urlCache.get(bg.mediaId);
    if (cached) { paintImageBackground(el, cached, bg); return; }
    try {
      const url = await resolveBackgroundUrl(bg.mediaId);
      if (!url) { clear(); return; }
      paintImageBackground(el, url, bg);
    } catch (err) {
      // A background image that's missing on disk or fails to load should
      // never block presenting the slide's actual content — quietly fall
      // back to the default background instead of surfacing an error here.
      clear();
    }
    return;
  }

  clear();
}
