import { h } from "../utils/dom.js";
import { renderPresentStage } from "./slideStage.js";
import { applyPageBackground } from "../utils/pageBackground.js";

/**
 * A live miniature of a slide for the Presenter View (next-slide preview and the
 * slide list). It is the SAME renderPresentStage the audience sees, drawn at a
 * fixed 1280x720 virtual size and scaled with a CSS transform (the technique the
 * editor's filmstrip uses), so it can never drift from what the audience gets.
 *
 * Previews are inert: no interaction, and any <video>/<audio> is muted, paused and
 * stripped of controls so a preview can never make sound or steal playback from the
 * real slide.
 */
export function renderPresenterThumb(page, widthPx = 160) {
  let inner;
  try {
    inner = renderPresentStage(page, { interactive: false });
  } catch (err) {
    inner = h("div", { class: "present-stage__inner" }); // a malformed slide must not break the list
  }
  const scale = widthPx / 1280;
  const stage = h("div", { class: "presenter-thumb__stage present-stage", style: { transform: `scale(${scale})` } }, [inner]);
  const box = h("div", { class: "presenter-thumb", style: { width: `${widthPx}px`, height: `${Math.round(widthPx * 9 / 16)}px` }, "aria-hidden": "true" }, [stage]);
  neutralizeMedia(stage);
  try { applyPageBackground(stage, page); } catch { /* background is cosmetic in a thumbnail */ }
  return box;
}

export function neutralizeMedia(root) {
  for (const m of root.querySelectorAll?.("video, audio") ?? []) {
    m.muted = true;
    m.controls = false;
    m.autoplay = false;
    m.removeAttribute?.("autoplay");
    try { m.pause?.(); } catch { /* not playable yet */ }
  }
  root.setAttribute?.("inert", "");
}
