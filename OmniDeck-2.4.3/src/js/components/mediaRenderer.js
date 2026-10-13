import { h } from "../utils/dom.js";
import { mediaService } from "../services/MediaService.js";

/**
 * Renders the ACTUAL stored image/video/PDF/presentation for a lesson
 * page's `mediaId` — not a filename placeholder. Returns a container
 * synchronously (so callers can insert it into the DOM immediately) and
 * swaps in the real element once the asset URL resolves.
 *
 * Handles the states the production spec calls out explicitly:
 *   - loading (briefly, while the asset URL resolves)
 *   - missing file (the mediaId doesn't exist in the library anymore —
 *     deleted, or the library JSON is out of sync)
 *   - corrupted/undecodable file (bytes exist but the browser can't decode
 *     them as an image, or the <video> element fires an `error` event)
 *   - for "presentation": conversion-not-done-yet / conversion-failed
 *     (LibreOffice/poppler missing or errored — see PPTX-SETUP.md), with a
 *     real Retry action, and real per-slide navigation once converted.
 *
 * `onMissing` / `onError` let the caller (lessonEditor / presentMode) wire
 * up "Locate File / Replace / Remove" actions without this component
 * needing to know about lesson pages at all. `slideIndex`/`onSlideChange`
 * let the caller keep a presentation page's current slide in its own
 * persisted state.
 */
export function renderMediaSlide(mediaId, kind, { fit = "contain", controls = true, onMissing, onError, slideIndex = 0, onSlideChange } = {}) {
  const container = h("div", { class: "media-slide media-slide--loading" }, [
    h("div", { class: "media-slide__status" }, "Loading…"),
  ]);
  let currentIndex = slideIndex;

  async function load() {
    if (!mediaId) {
      renderEmpty(container, `No ${kind} selected yet.`);
      return;
    }
    let item;
    try {
      item = await mediaService.isReferenced(mediaId);
    } catch (err) {
      renderErrorState(container, "Couldn't read the media library.", err, onError);
      return;
    }
    if (!item) {
      renderMissingState(container, onMissing);
      return;
    }

    if (kind === "presentation") {
      await loadPresentation(item);
      return;
    }

    let url;
    try {
      url = await mediaService.getAssetUrl(item);
    } catch (err) {
      renderErrorState(container, "Couldn't locate this file on disk.", err, onError);
      return;
    }
    if (!url) {
      renderMissingState(container, onMissing);
      return;
    }

    container.className = "media-slide";
    container.innerHTML = "";
    if (kind === "image") {
      const img = h("img", {
        src: url,
        alt: item.name,
        style: { width: "100%", height: "100%", objectFit: fit },
        onError: () => renderErrorState(container, `"${item.name}" couldn't be decoded as an image.`, null, onError),
      });
      container.appendChild(img);
    } else if (kind === "video") {
      const video = h("video", {
        src: url,
        controls,
        style: { width: "100%", height: "100%", objectFit: fit, background: "#000" },
        onError: () => renderErrorState(container, `"${item.name}" couldn't be played.`, null, onError),
      });
      container.appendChild(video);
    } else if (kind === "pdf") {
      // Rendered via the webview's own native PDF viewer (Chromium/WebView2
      // on Windows, WebKitGTK on Linux both ship one) rather than a
      // filename placeholder or a bundled PDF.js copy — this gives real
      // page-by-page viewing, zoom, and text selection for free and matches
      // the "embedded PDF viewer" option the production spec calls out.
      const frame = h("iframe", {
        src: url,
        title: item.name,
        style: { width: "100%", height: "100%", border: "none", background: "#fff" },
        onError: () => renderErrorState(container, `"${item.name}" couldn't be displayed.`, null, onError),
      });
      container.appendChild(frame);
    }
  }

  async function loadPresentation(item) {
    if (item.conversionError) {
      renderConversionError(container, item.conversionError, item.id);
      return;
    }
    if (!item.slideFiles?.length) {
      // Import just happened and conversion hasn't finished (or this is the
      // browser dev-preview, where conversion never runs) — not an error,
      // just not ready yet.
      container.className = "media-slide media-slide--loading";
      container.innerHTML = "";
      container.appendChild(h("div", { class: "media-slide__status" }, "Converting slides…"));
      return;
    }

    const clampedIndex = Math.min(Math.max(0, currentIndex), item.slideFiles.length - 1);
    currentIndex = clampedIndex;
    let slideUrl;
    try {
      slideUrl = await mediaService.getSlideAssetUrl(item, item.slideFiles[clampedIndex]);
    } catch (err) {
      renderErrorState(container, "Couldn't load this slide image.", err, onError);
      return;
    }

    container.className = "media-slide media-slide--presentation";
    container.innerHTML = "";
    container.appendChild(h("img", {
      src: slideUrl,
      alt: `Slide ${clampedIndex + 1} of ${item.slideFiles.length}`,
      style: { width: "100%", height: "calc(100% - 34px)", objectFit: "contain" },
      onError: () => renderErrorState(container, "This slide image couldn't be displayed.", null, onError),
    }));

    if (item.slideFiles.length > 1) {
      container.appendChild(h("div", { class: "media-slide__pptx-nav" }, [
        h("button", {
          class: "btn btn--sm",
          disabled: clampedIndex === 0,
          onClick: () => { currentIndex -= 1; onSlideChange?.(currentIndex); load(); },
        }, "‹ Prev"),
        h("span", { class: "field-hint" }, `Slide ${clampedIndex + 1} / ${item.slideFiles.length}`),
        h("button", {
          class: "btn btn--sm",
          disabled: clampedIndex === item.slideFiles.length - 1,
          onClick: () => { currentIndex += 1; onSlideChange?.(currentIndex); load(); },
        }, "Next ›"),
      ]));
    }
  }

  function renderConversionError(container, message, mediaId) {
    container.className = "media-slide media-slide--error";
    container.innerHTML = "";
    const box = h("div", { class: "media-slide__status" }, [
      h("div", {}, "PowerPoint couldn't be rendered"),
      h("div", { class: "field-hint" }, message),
      h("button", {
        class: "btn btn--sm",
        style: { marginTop: "8px" },
        onClick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = "Retrying…";
          try {
            await mediaService.convertPresentation(mediaId);
          } catch (err) {
            console.warn("[mediaRenderer] retry conversion failed", err);
          }
          load();
        },
      }, "Retry Conversion"),
    ]);
    container.appendChild(box);
  }

  load();
  return container;
}

function renderEmpty(container, message) {
  container.className = "media-slide media-slide--empty";
  container.innerHTML = "";
  container.appendChild(h("div", { class: "media-slide__status" }, message));
}

function renderMissingState(container, onMissing) {
  container.className = "media-slide media-slide--missing";
  container.innerHTML = "";
  const box = h("div", { class: "media-slide__status" }, [
    h("div", {}, "Media unavailable"),
    h("div", { class: "field-hint" }, "The original file could not be found."),
  ]);
  if (onMissing) {
    const actions = h("div", { class: "action-row", style: { marginTop: "8px" } }, [
      h("button", { class: "btn btn--sm", onClick: () => onMissing("locate") }, "Locate File"),
      h("button", { class: "btn btn--sm", onClick: () => onMissing("replace") }, "Replace"),
      h("button", { class: "btn btn--sm btn--danger", onClick: () => onMissing("remove") }, "Remove"),
    ]);
    box.appendChild(actions);
  }
  container.appendChild(box);
}

function renderErrorState(container, message, err, onError) {
  if (err) console.warn("[mediaRenderer]", message, err);
  container.className = "media-slide media-slide--error";
  container.innerHTML = "";
  const box = h("div", { class: "media-slide__status" }, [
    h("div", {}, "Couldn't display this file"),
    h("div", { class: "field-hint" }, message),
  ]);
  if (onError) {
    box.appendChild(h("button", { class: "btn btn--sm", style: { marginTop: "8px" }, onClick: onError }, "Replace File"));
  }
  container.appendChild(box);
}
