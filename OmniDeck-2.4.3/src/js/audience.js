import { h, clear } from "./utils/dom.js";
import { renderScaledPresentSlide } from "./components/slideStage.js";
import { fitPresentText } from "./utils/autoFit.js";
import { applyPageBackground, preloadPageBackground } from "./utils/pageBackground.js";
import { fitSlideBox } from "./utils/slideScale.js";

/**
 * Entry point for the audience/classroom display window (two-display
 * Present Mode only). This window owns no state of its own — it just
 * listens for "presenter:slide-state" events broadcast by the main window
 * (see PresentationService.broadcastSlideState, called from presentMode.js
 * on every draw) and re-renders the same stage read-only, via the same
 * renderPresentStage used by the presenter, so the two screens are always
 * visually identical for the current slide (quiz taps included) even
 * though only the presenter's screen has any controls or handlers.
 *
 * This window's own module load (and therefore this listener registration)
 * happens asynchronously and isn't guaranteed to finish before the
 * presenter draws and broadcasts the very first slide — a broadcast with
 * nobody listening yet is simply lost. To make sure the first slide is
 * never missed, this window emits "audience:ready" immediately after it
 * starts listening; the presenter is already waiting for that signal (see
 * PresentationService.onAudienceReady, subscribed before this window is
 * even opened) and re-sends the current slide state when it arrives.
 */
const root = document.getElementById("audience-root");

drawWaiting();

const { listen, emit } = window.__TAURI__.event;
await listen("presenter:slide-state", (event) => {
  draw(event.payload);
});
// The presenter relays its video's play/pause/seek here; this window is the ONLY one with sound.
await listen("presenter:media-state", (event) => applyMedia(event.payload));
await emit("audience:ready");

function drawWaiting() {
  clear(root);
  // No app branding here either — this window is what the classroom
  // actually sees on the projector, same rule as renderPresentStage's
  // title case: the room should see the lesson, not "OmniDeck".
  root.appendChild(h("div", { class: "present-stage" }, [
    h("div", { class: "present-slide" }, [
      h("div", { class: "present-stage__inner" }, [
        h("div", { class: "present-body" }, "Waiting for the lesson to start…"),
      ]),
    ]),
  ]));
}

let stopFitSlideBox = () => {};

let currentIndex = null;

let drawToken = 0;

async function draw(state) {
  // { page: null } is the presenter's explicit "show ended": never leave the last slide on the projector.
  if (!state || !state.page) { drawToken++; currentIndex = null; drawWaiting(); return; }
  const token = ++drawToken;
  // v2.4: get the next slide's background picture ready BEFORE touching the
  // screen, so the projector goes straight from one slide to the next with no
  // blank/black frame in between (the previous slide stays up meanwhile).
  await preloadPageBackground(state.page);
  if (token !== drawToken) return; // a newer slide arrived while this one was loading
  currentIndex = state.index;
  clear(root);
  const slide = renderScaledPresentSlide(state.page, {
    interactive: false,
    quizState: {
      quizSelection: state.quizSelection ?? null,
      quizTextAnswer: state.quizTextAnswer ?? "",
      quizTextSubmitted: !!state.quizTextSubmitted,
    },
  }, state.previewSize);
  const stage = h("div", { class: "present-stage" }, [slide]);
  root.appendChild(stage);
  stopFitSlideBox();
  stopFitSlideBox = fitSlideBox(stage, slide);
  const designSurface = slide.querySelector(".present-slide__design");
  const hasPreviewScale = Number.isFinite(Number(state.previewSize?.presentScale)) && Number(state.previewSize.presentScale) > 0;
  // Mirror the same scale measured from the editor preview. A second fit in
  // this window can make long Scripture passages visibly larger than the
  // presenter/editor copy even though both use the same design dimensions.
  if (state.page.type !== "freeform" && !hasPreviewScale) fitPresentText(designSurface || slide);
  applyPageBackground(slide, state.page);
  const video = slide.querySelector("video");
  if (video) { video.controls = false; video.muted = false; }   // audience: no controls, real audio
  if (state.media) applyMedia({ index: state.index, media: state.media });
}

function applyMedia(payload) {
  if (!payload || payload.index !== currentIndex) return; // a late relay for a slide that's no longer showing
  const video = root.querySelector("video");
  const m = payload.media;
  if (!video || !m) return;
  // Follow the presenter; only seek when meaningfully out of step so playback stays smooth.
  if (Math.abs(video.currentTime - m.currentTime) > 0.75) { try { video.currentTime = m.currentTime; } catch { /* metadata not loaded yet */ } }
  if (m.playing && video.paused) video.play?.().catch(() => {});
  else if (!m.playing && !video.paused) video.pause();
}
