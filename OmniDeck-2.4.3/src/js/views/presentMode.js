import { h, clear } from "../utils/dom.js";
import { lessonService } from "../services/LessonService.js";
import { bindKeys } from "../utils/keyboard.js";
import { presentationService } from "../services/PresentationService.js";
import { renderScaledPresentSlide, pageLabel } from "../components/slideStage.js";
import { toast } from "../components/toast.js";
import { fitPresentText } from "../utils/autoFit.js";
import { applyPageBackground, preloadPageBackground } from "../utils/pageBackground.js";
import { fitSlideBox } from "../utils/slideScale.js";
import { createPresenterSession } from "../services/PresenterSession.js";
import { renderPresenterThumb, neutralizeMedia } from "../components/presenterThumb.js";
import { isRunningInTauri } from "../utils/storageAdapter.js";

/**
 * Present Mode — the presenter's own screen, in every church.
 *
 * Single-display churches (the default, and the only path if the room only
 * has one monitor, or the teacher has set Display Mode to "Always use a
 * single display" in Settings): this window fullscreens and IS the
 * classroom output — no second window, nothing else changes from before.
 *
 * Two-display churches (2+ monitors detected, and not overridden to
 * single): this window becomes the PRESENTER VIEW (like PowerPoint's) — live
 * preview of what the audience sees, a next-slide preview, a clickable list
 * of all slides, previous/next, a slide counter, the audience-display status
 * and a display chooser — while a second, chrome-less "audience" window
 * (see src/js/audience.js) shows ONLY the slide on the chosen monitor.
 *
 * All state lives in PresenterSession (services/PresenterSession.js): this
 * file only draws its view and forwards clicks/keys to it. The audience gets
 * the same page object through native Tauri events on every change. Quiz
 * taps/typing and video controls only happen here; the audience mirrors
 * them read-only (and is the only one that plays sound).
 *
 * `onExit()` is provided by the router and is responsible for tearing this
 * view down, exiting native fullscreen, and returning to the editor.
 */
export async function render(root, { params, onExit }) {
  const lesson = params.lessonId ? await lessonService.getLesson(params.lessonId) : null;
  if (!lesson || !lesson.pages.length) {
    onExit();
    return () => {};
  }

  // Validate before ever entering fullscreen — a lesson with missing
  // Scripture or missing media must not be presentable at all, per the
  // production spec's lesson-validation requirement. An incomplete quiz is
  // deliberately NOT included here: it's a per-slide problem, not a
  // lesson-level one, so it must never block the rest of the lesson from
  // presenting. slideStage.js's "quiz" case already shows a clear
  // "needs to be updated" warning in place when Present Mode reaches that
  // slide, and the teacher can still press Next past it.
  const problems = await lessonService.validateForPresentation(lesson.id);
  if (problems.length) {
    root.appendChild(h("div", { class: "present-stage", style: { alignItems: "center", justifyContent: "center" } }, [
      h("div", { class: "present-stage__inner", style: { maxWidth: "640px" } }, [
        h("div", { class: "present-eyebrow" }, "Lesson can't be presented"),
        h("div", { class: "present-title", style: { fontSize: "1.6rem" } }, `${problems.length} issue${problems.length === 1 ? "" : "s"} found`),
        h("ul", { class: "present-body", style: { textAlign: "left" } }, problems.map((p) =>
          h("li", { style: { marginBottom: "8px" } }, [
            p.message,
            p.pageId ? h("button", {
              class: "present-btn",
              style: { marginLeft: "10px", padding: "2px 10px", fontSize: "0.85rem" },
              onClick: () => onExit({ pageId: p.pageId }),
            }, "Go to page") : null,
          ])
        )),
        h("button", { class: "present-btn present-btn--exit", style: { marginTop: "12px" }, onClick: () => onExit() }, "Back to Editor"),
      ]),
    ]));
    return () => {};
  }

  const session = createPresenterSession({
    lesson,
    service: presentationService,
    notify: toast,
    isTauri: isRunningInTauri,
    labelFor: pageLabel,
    previewSize: params.previewSize,
  });
  await session.start();

  const unbind = bindKeys({
    ArrowRight: () => session.next(),
    ArrowLeft: () => session.prev(),
    PageDown: () => session.next(),
    PageUp: () => session.prev(),
    Home: () => session.goTo(0),
    End: () => session.goTo(lesson.pages.length - 1),
    Escape: () => exit(),
  });

  let stopFitSlideBox = () => {};
  let stopThumbs = [];
  let lastIndex = -1;
  let drawToken = 0; // declared before the first draw() call below (avoids a TDZ error)
  const unsubscribe = session.subscribe((view) => draw(view));
  draw(session.getView());

  async function exit() {
    // Esc pressed twice (or Esc racing the app-close teardown) must tear
    // down exactly once — a second onExit() would navigate to the editor twice.
    if (session.exiting) return;
    drawToken++; // cancel any draw still waiting on a background image
    stopFitSlideBox();
    unsubscribe();
    unbind();
    await session.exit(); // blanks + closes the audience window, leaves fullscreen; never strands the teacher
    onExit();
  }

  /** Builds the live slide exactly as the audience gets it (interactive: quiz taps work here). */
  function buildLiveSlide(view) {
    return renderScaledPresentSlide(view.current, {
      interactive: true,
      quizState: view.quiz,
      onQuizSelect: (i) => session.setQuiz({ quizSelection: i }),
      onQuizSubmit: () => { if (!session.getView().quiz.quizTextAnswer.trim()) return; session.setQuiz({ quizTextSubmitted: true }); refocusQuizInput(); },
      onQuizTextChange: (val) => session.setQuizDraft(val),
    }, params.previewSize);
  }

  /** In two-display mode the AUDIENCE plays the sound; the presenter's copy is muted but still drives play/pause/seek. */
  function wireVideoRelay(slide, view) {
    for (const v of slide.querySelectorAll("video")) {
      if (view.dual) v.muted = true;
      let lastSent = 0;
      const send = () => session.setMediaState({ playing: !v.paused, currentTime: v.currentTime });
      v.addEventListener("play", send);
      v.addEventListener("pause", send);
      v.addEventListener("seeked", send);
      v.addEventListener("timeupdate", () => { const t = Date.now(); if (t - lastSent > 1000 && !v.paused) { lastSent = t; send(); } });
    }
  }

  async function draw(view) {
    // v2.4: have the slide's background picture decoded before swapping, so
    // the previous slide stays up (no black flash) until the next is ready.
    // Cached/solid/no-background slides resolve immediately.
    const token = ++drawToken;
    await preloadPageBackground(view.current);
    if (token !== drawToken) return; // a newer view superseded this one while loading
    clear(root);
    stopFitSlideBox();
    stopThumbs.forEach((f) => f());
    stopThumbs = [];
    const slide = buildLiveSlide(view);
    const stage = h("div", { class: "present-stage" }, [slide]);

    if (!view.dual) {
      // Single-display layout: unchanged from before — this window IS the classroom output.
      root.appendChild(stage);
      mountSlide(stage, slide, view);
      root.appendChild(h("div", { class: "present-controls" }, [
        h("div", { class: "present-controls__progress" }, `${view.counter} · ${view.lessonTitle}`),
        view.output.state === "lost" ? h("div", { class: "present-controls__next", title: view.output.detail }, view.output.label) : null,
        h("div", { class: "present-controls__nav" }, [
          h("button", { class: "present-btn", disabled: !view.canPrev, onClick: () => session.prev() }, "‹ Previous"),
          h("button", { class: "present-btn", disabled: !view.canNext, onClick: () => session.next() }, "Next ›"),
          h("button", { class: "present-btn present-btn--exit", onClick: exit }, "Exit (Esc)"),
        ]),
      ]));
      return;
    }

    // ---- Presenter View (two displays) ----
    const live = h("section", { class: "presenter__live", "aria-label": "Live preview: what the audience sees now" }, [
      h("div", { class: "presenter__label" }, [h("span", {}, "NOW SHOWING"), h("span", { class: "presenter__count" }, `Slide ${view.counter}`)]),
      stage,
    ]);

    const nextBox = h("section", { class: "presenter__next", "aria-label": "Next slide" }, [
      h("div", { class: "presenter__label" }, [h("span", {}, "NEXT SLIDE")]),
      view.next
        ? h("button", { class: "presenter__next-btn", title: `Go to slide ${view.next.index + 1}`, onClick: () => session.next() }, [renderPresenterThumb(view.next.page, 280), h("div", { class: "presenter__caption" }, view.next.label)])
        : h("div", { class: "presenter__end" }, "End of lesson"),
    ]);

    const list = h("nav", { class: "presenter__list", "aria-label": "All slides" }, view.slides.map((s) =>
      h("button", {
        class: "presenter-slide" + (s.isCurrent ? " is-current" : "") + (s.isPast ? " is-past" : ""),
        "aria-current": s.isCurrent ? "step" : null,
        title: `Go to slide ${s.index + 1}: ${s.label}`,
        onClick: () => session.goTo(s.index),
      }, [h("span", { class: "presenter-slide__n" }, String(s.index + 1)), renderPresenterThumb(s.page, 132), h("span", { class: "presenter-slide__label" }, s.label)])));

    const out = view.output;
    const status = h("div", { class: `presenter__status presenter__status--${out.state}`, role: "status", title: out.detail }, [
      h("span", { class: "presenter__dot" }),
      h("div", {}, [h("div", { class: "presenter__status-label" }, out.label), h("div", { class: "presenter__status-detail" }, out.detail)]),
    ]);

    const chooser = view.canChooseDisplay ? h("label", { class: "presenter__choose" }, [
      h("span", {}, "Audience display"),
      h("select", {
        onChange: async (e) => {
          const idx = Number(e.target.value);
          try { await session.chooseAudienceDisplay(idx); toast("Audience display changed.", "success", 3500); }
          catch (err) { toast(err?.message || "Couldn't switch displays.", "danger"); draw(session.getView()); }
        },
      }, [
        view.dual ? null : h("option", { value: "", selected: true }, "Choose…"),
        ...view.audienceChoices.map((m) => h("option", { value: String(m.index), selected: m.index === view.audienceMonitorIndex }, `${m.name || `Display ${m.index + 1}`}${m.width ? ` — ${m.width}×${m.height}` : ""}`)),
      ]),
    ]) : null;

    const bar = h("div", { class: "presenter__bar" }, [
      status,
      chooser,
      h("div", { class: "presenter__nav" }, [
        h("button", { class: "present-btn", disabled: !view.canPrev, onClick: () => session.prev(), "aria-label": "Previous slide" }, "‹ Previous"),
        h("span", { class: "presenter__counter", "aria-live": "polite" }, `${view.index + 1} of ${view.total}`),
        h("button", { class: "present-btn", disabled: !view.canNext, onClick: () => session.next(), "aria-label": "Next slide" }, "Next ›"),
      ]),
      h("button", { class: "present-btn present-btn--exit", onClick: exit, title: "End the presentation on both screens and return to the editor" }, "End show · Editor (Esc)"),
    ]);

    root.appendChild(h("div", { class: "presenter" }, [live, h("aside", { class: "presenter__side" }, [nextBox, h("div", { class: "presenter__label" }, [h("span", {}, "ALL SLIDES")]), list]), bar]));
    mountSlide(stage, slide, view);
    if (view.index !== lastIndex) { list.querySelector(".is-current")?.scrollIntoView?.({ block: "nearest" }); }
    lastIndex = view.index;
  }

  function mountSlide(stage, slide, view) {
    stopFitSlideBox = fitSlideBox(stage, slide);
    const designSurface = slide.querySelector(".present-slide__design");
    const hasPreviewScale = Number.isFinite(Number(params.previewSize?.presentScale)) && Number(params.previewSize.presentScale) > 0;
    // When launched from the editor, its fit is authoritative. Re-running
    // auto-fit here was the source of the remaining drift: different mount
    // context/overflow metrics could leave presentation text at scale 1 even
    // though the preview had already shrunk it to fit.
    if (view.current.type !== "freeform" && !hasPreviewScale) fitPresentText(designSurface || slide);
    applyPageBackground(slide, view.current);
    wireVideoRelay(slide, view);
  }

  function refocusQuizInput() {
    // Refocus after redraw so a wrong-answer retry doesn't require re-clicking.
    requestAnimationFrame(() => { const el = document.querySelector(".present-quiz-text-input"); el?.focus(); });
  }

  // Returned so the router can force-exit (e.g. app close) without the user
  // pressing Escape.
  return exit;
}
