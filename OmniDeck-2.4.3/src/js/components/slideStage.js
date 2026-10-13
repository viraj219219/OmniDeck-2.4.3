import { h } from "../utils/dom.js";
import { renderMediaSlide } from "./mediaRenderer.js";
import { quizService } from "../services/QuizService.js";
import { renderVerseList } from "../utils/scriptureFormat.js";
import { applyTextStyleOverride } from "../utils/textStyleOverride.js";

/**
 * Renders a single lesson page's stage content — used by both:
 *   - the presenter window (single-display Present Mode, or the presenter's
 *     own screen in two-display mode), where `interactive: true` wires up
 *     quiz tap/typing handlers, and
 *   - the audience window (two-display mode's classroom/projector output),
 *     where `interactive: false` renders the exact same visual state
 *     (including which quiz answer is selected and whether it was correct)
 *     but with no click/typing handlers — quiz interaction always happens
 *     on the presenter's screen and is mirrored, not duplicated.
 *
 * `quizState` carries whatever the presenter has already decided
 * (quizSelection / quizTextAnswer / quizTextSubmitted) so the audience
 * window can reproduce it without owning any state of its own.
 */
export function renderPresentStage(page, opts = {}) {
  const base = renderBaseStage(page, opts);
  // Movable text/image boxes can be added on top of ANY slide type in the
  // editor (see renderBoxesOverlay in lessonEditor.js). Freeform slides
  // already render their boxes as their whole content; every other type
  // gets them layered over its normal content here, so what a teacher
  // builds is what the room sees (presenter screen, audience window and
  // slide thumbnails all go through this function).
  if (opts.omitBoxes || page.type === "freeform" || !Array.isArray(page.boxes) || !page.boxes.length) return base;
  return h("div", { class: "present-layered" }, [
    base,
    buildBoxesLayer(page, "present-freeform present-freeform--overlay"),
  ]);
}

/**
 * Wraps a rendered slide in the same logical canvas the teacher sees in the
 * editor, then scales that canvas uniformly to the available presentation
 * display. This is deliberately different from re-laying out the slide at
 * the projector's pixel dimensions: every line break, max-width decision,
 * font clamp, gap, freeform box, and auto-fit measurement is calculated at
 * the preview size first, then the complete result is enlarged as one unit.
 *
 * `previewSize` is measured from the active editor surface before the editor
 * shell is hidden. For older/direct entry points without a measurement we use
 * the editor canvas's normal max-width as a safe fallback.
 */
export function renderScaledPresentSlide(page, opts = {}, previewSize = {}) {
  const valid = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
  const width = valid(previewSize.width) ? Number(previewSize.width) : 860;
  const height = valid(previewSize.height) ? Number(previewSize.height) : width * 9 / 16;
  const slideWidth = valid(previewSize.slideWidth) ? Number(previewSize.slideWidth) : Math.max(1, width - 2);
  const surfaceClass = page?.type === "freeform" ? "freeform-canvas" : "editor-canvas";
  const surface = h("div", {
    class: `present-slide__design ${surfaceClass}`,
    "data-design-width": String(width),
    style: {
      width: `${width}px`,
      height: `${height}px`,
      maxWidth: "none",
      background: "transparent",
      borderColor: "transparent",
      boxShadow: "none",
      transform: "scale(1)",
    },
  }, [renderPresentStage(page, { ...opts, editorPreview: true })]);
  // Set a real custom property (Object.assign does not assign CSS variables
  // consistently across WebViews). Keep it at the preview's own content width
  // so even the existing clamp/min/max typography is computed exactly as in
  // the editor before the parent transform scales it up.
  surface.style.setProperty("--slide-w", `${slideWidth}px`);
  // The preview auto-fit factor is part of the preview's visual layout, just
  // like its dimensions. Use the exact factor captured when Present was
  // clicked; do not recalculate it against a separately mounted stage, whose
  // scroll metrics can differ and otherwise make the output's text larger.
  const previewScale = Number(previewSize.presentScale);
  if (Number.isFinite(previewScale) && previewScale > 0) {
    surface.style.setProperty("--present-scale", String(previewScale));
  }
  return h("div", { class: "present-slide present-slide--scaled" }, [surface]);
}

function renderBaseStage(page, {
  interactive = true,
  editorPreview = false,
  quizState = {},
  onQuizSelect,
  onQuizSubmit,
  onQuizTextChange,
  onMissing,
  onError,
  onSlideChange,
} = {}) {
  const { quizSelection = null, quizTextAnswer = "", quizTextSubmitted = false } = quizState;

  switch (page.type) {
    case "title": {
      // No app branding on presented slides — the room should see the
      // lesson's own title, not "OmniDeck".
      const titleEl = h("div", { class: "present-title", style: { textAlign: page.titleAlign || "left" } }, page.title || "Untitled");
      applyTextStyleOverride(titleEl, "present-title", page.titleStyle);
      const subtitleEl = (page.subtitle || editorPreview) ? h("div", { class: "present-body", style: { textAlign: page.subtitleAlign || "left" } }, page.subtitle || "") : null;
      if (subtitleEl) applyTextStyleOverride(subtitleEl, "present-body", page.subtitleStyle);
      return h("div", { class: "present-stage__inner" }, [titleEl, subtitleEl]);
    }
    case "scripture":
      return renderScriptureStage(page, { onMissing, onError });
    case "image":
    case "video":
    case "pdf": {
      const titleEl = h("div", { class: "present-title", style: { textAlign: page.titleAlign || "left" } }, page.title || ({ image: "Image", video: "Video", pdf: "PDF" }[page.type]));
      applyTextStyleOverride(titleEl, "present-title", page.titleStyle);
      const captionEl = (page.caption || editorPreview)
        ? h("div", { class: "present-body present-caption", style: { textAlign: page.captionAlign || "left" } }, page.caption || "")
        : null;
      return h("div", { class: "present-stage__inner present-stage__inner--media" }, [
        titleEl,
        page.mediaId
          ? renderMediaSlide(page.mediaId, page.type, { fit: "contain", controls: page.type === "video", onMissing, onError })
          : h("div", { class: "present-body" }, `No ${page.type} selected`),
        captionEl,
      ]);
    }
    case "presentation": {
      const titleEl = h("div", { class: "present-title", style: { textAlign: page.titleAlign || "left" } }, page.title || "Presentation");
      applyTextStyleOverride(titleEl, "present-title", page.titleStyle);
      return h("div", { class: "present-stage__inner present-stage__inner--media" }, [
        titleEl,
        page.mediaId
          ? renderMediaSlide(page.mediaId, "presentation", {
              slideIndex: (page.currentSlide || 1) - 1,
              onSlideChange,
              onMissing,
              onError,
            })
          : h("div", { class: "present-body" }, "No file selected"),
      ]);
    }
    case "quiz": {
      const problems = quizService.validateQuizPage(page);
      if (problems.length) {
        const questionEl = h("div", { class: "present-title", style: { textAlign: page.questionAlign || "left" } }, page.question || "Untitled question");
        applyTextStyleOverride(questionEl, "present-title", page.questionStyle);
        return h("div", { class: "present-stage__inner" }, [
          questionEl,
          h("div", { class: "present-body", style: { color: "#C96A5B" } }, [
            "This quiz can't be presented yet:",
            h("ul", {}, problems.map((p) => h("li", {}, p))),
          ]),
        ]);
      }
      if (page.questionType === "fill_blank" || page.questionType === "short_answer") {
        return renderTextQuiz(page, { interactive, showHint: editorPreview, quizTextAnswer, quizTextSubmitted, onQuizSubmit, onQuizTextChange });
      }
      const answered = quizSelection !== null;
      const isCorrectSelection = answered && quizService.checkAnswer(page, quizSelection);
      const questionEl = h("div", { class: "present-title", style: { textAlign: page.questionAlign || "left" } }, page.question || "Untitled question");
      applyTextStyleOverride(questionEl, "present-title", page.questionStyle);
      return h("div", { class: "present-stage__inner" }, [
        questionEl,
        h("div", { class: "present-quiz" },
          (page.options || []).map((opt, i) => ({ opt, i })).filter(({ opt }) => opt.trim()).map(({ opt, i }) => {
            const isSelected = quizSelection === i;
            const isThisCorrect = i === page.correctIndex;
            let cls = "present-quiz-option";
            // Only the option actually tapped gets marked — the correct
            // answer is never highlighted for an option nobody selected.
            if (answered && isSelected) cls += isThisCorrect ? " is-correct" : " is-incorrect";
            return h("button", {
              class: cls,
              disabled: !interactive || answered,
              onClick: interactive ? () => onQuizSelect?.(i) : undefined,
            }, opt);
          })
        ),
        answered
          ? h("div", { class: "present-quiz-feedback" + (isCorrectSelection ? " is-correct" : " is-incorrect") },
              isCorrectSelection ? "Correct!" : "Incorrect")
          : h("div", { class: "present-body", style: { fontSize: "1rem", opacity: 0.7 } }, interactive ? "Tap an answer" : ""),
      ]);
    }
    case "discussion":
      return h("div", { class: "present-stage__inner" }, [
        h("div", { class: "present-eyebrow" }, "Let's Talk About It"),
        h("div", { class: "present-body", style: { textAlign: page.bodyAlign || "left" } }, page.prompt || ""),
      ]);
    case "conclusion":
      return h("div", { class: "present-stage__inner" }, [
        h("div", { class: "present-eyebrow" }, "Conclusion"),
        h("div", { class: "present-body", style: { textAlign: page.bodyAlign || "left" } }, page.body || ""),
      ]);
    case "freeform":
      return buildBoxesLayer(page, "present-freeform");
    default:
      return h("div", { class: "present-stage__inner" }, "");
  }
}

/**
 * The Scripture page's single source of truth. The editor canvas and every
 * presentation surface use this exact markup, so passage wrapping, optional
 * image placement, reference alignment, and font overrides cannot drift.
 * `scriptureAlign` applies to both the passage and its reference; the
 * `scriptureStyle.fontSize` multiplier is also shared with auto-fit.
 */
export function renderScriptureStage(page, { onMissing, onError } = {}) {
  const align = ["left", "center", "right"].includes(page.scriptureAlign)
    ? page.scriptureAlign
    : "center";
  const verses = renderVerseList(page.verses, {
    wrapClass: "present-scripture",
    rowClass: "present-scripture-row",
    numberClass: "present-scripture-num",
    textClass: "present-scripture-text",
  });
  verses.style.textAlign = align;
  applyTextStyleOverride(verses, "present-scripture", page.scriptureStyle);

  return h("div", { class: "present-stage__inner" }, [
    page.acceptedImage?.mediaId
      ? h("div", { class: "present-stage__inner--media", style: { height: "40%", marginBottom: "16px" } }, [
          renderMediaSlide(page.acceptedImage.mediaId, "image", { fit: "contain", onMissing, onError }),
        ])
      : null,
    verses,
    h("div", { class: "present-ref", style: { textAlign: align } }, page.reference || ""),
  ]);
}

/**
 * The box layer shared by "freeform" slides (where it IS the slide) and the
 * overlay on every other slide type. Positions/sizes are % of the layer, and
 * text size is a % of the layer's own width (see lessonEditor.js), so it is
 * resolution-independent.
 */
function buildBoxesLayer(page, className) {
  const container = h("div", { class: className },
    (page.boxes || []).map((box) => {
      const style = { left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` };
      if (box.type === "text") {
        return h("div", { class: "present-freeform-box", "data-box-id": box.id, style }, [
          h("div", {
            class: "present-freeform-box__text",
            style: {
              textAlign: box.align || "center",
              ...(box.fontFamily ? { fontFamily: box.fontFamily } : {}),
              ...(box.color ? { color: box.color } : {}),
            },
          }, box.text || ""),
        ]);
      }
      return h("div", { class: "present-freeform-box", "data-box-id": box.id, style }, [
        renderMediaSlide(box.mediaId, "image", { fit: "cover" }),
      ]);
    })
  );
  // Text size is resolved in px after the layer is mounted (the caller
  // appends it synchronously, well before the next frame, so by the time
  // this fires `container` has its real rendered width).
  requestAnimationFrame(() => {
    const w = container.clientWidth || container.getBoundingClientRect().width;
    if (!w) return;
    for (const box of page.boxes || []) {
      if (box.type !== "text") continue;
      const textEl = container.querySelector(`[data-box-id="${box.id}"] .present-freeform-box__text`);
      if (textEl) textEl.style.fontSize = `${(w * (box.fontSize || 6)) / 100}px`;
    }
  });
  return container;
}

function renderTextQuiz(page, { interactive, showHint = false, quizTextAnswer, quizTextSubmitted, onQuizSubmit, onQuizTextChange }) {
  const input = h("input", {
    type: "text",
    value: quizTextAnswer,
    disabled: !interactive || quizTextSubmitted,
    placeholder: page.questionType === "fill_blank" ? "Type the missing word or phrase…" : "Type the answer…",
    class: "present-quiz-text-input",
  });
  if (interactive) {
    input.addEventListener("input", () => onQuizTextChange?.(input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !quizTextSubmitted) onQuizSubmit?.(); });
  }

  const submitBtn = h("button", {
    class: "present-btn",
    disabled: !interactive || quizTextSubmitted,
    onClick: interactive ? () => onQuizSubmit?.() : undefined,
  }, "Check Answer");

  const isCorrect = quizTextSubmitted && quizService.checkAnswer(page, quizTextAnswer);
  const questionEl = h("div", { class: "present-title", style: { textAlign: page.questionAlign || "left" } }, page.question || "Untitled question");
  applyTextStyleOverride(questionEl, "present-title", page.questionStyle);

  return h("div", { class: "present-stage__inner" }, [
    questionEl,
    h("div", { class: "present-quiz present-quiz--text" }, [input, submitBtn]),
    quizTextSubmitted
      ? h("div", { class: "present-quiz-feedback" + (isCorrect ? " is-correct" : " is-incorrect") },
          isCorrect ? "Correct!" : `Not quite. Accepted answer${page.acceptedAnswers.length > 1 ? "s" : ""}: ${page.acceptedAnswers.filter((a) => a.trim()).join(" / ")}`)
      : h("div", { class: "present-body", style: { fontSize: "1rem", opacity: 0.7 } }, (interactive || showHint) ? "Type an answer and press Check Answer" : ""),
  ]);
}

/** Short "Next: …" label for a page, used by the presenter's upcoming-slide chip. */
export function pageLabel(page) {
  if (!page) return "";
  switch (page.type) {
    case "title": return page.title || "Title";
    case "scripture": return page.reference || "Scripture";
    case "image": return page.caption || "Image";
    case "video": return page.caption || "Video";
    case "pdf": return page.caption || "PDF";
    case "presentation": return "Slides";
    case "quiz": return page.question || "Quiz";
    case "discussion": return "Discussion";
    case "conclusion": return "Conclusion";
    case "freeform": return page.title || "Slide";
    default: return "Slide";
  }
}
