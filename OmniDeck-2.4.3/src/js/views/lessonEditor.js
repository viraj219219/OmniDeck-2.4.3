import { h, clear, uid } from "../utils/dom.js";
import { lessonService, PAGE_TYPES } from "../services/LessonService.js";
import { importSlidesAsPages } from "../services/ImportService.js";
import { replaceAcceptedImage, clearAcceptedImage } from "../services/MediaLifecycle.js";
import { registerFlusher } from "../services/ShutdownService.js";
import { dependencyService } from "../services/DependencyService.js";
import { mediaService } from "../services/MediaService.js";
import { renderMediaSlide } from "../components/mediaRenderer.js";
import { toast } from "../components/toast.js";
import { openModal, closeModal } from "../components/modal.js";
import { icon } from "../utils/icons.js";
import { setBeforeNavigate } from "../app.js";
import { quizService } from "../services/QuizService.js";
import { observeSlideWidth } from "../utils/slideScale.js";
import { FREEFORM_CANVAS_ENABLED } from "../utils/featureFlags.js";
import { paginateVerses, formatReference } from "../utils/scriptureFormat.js";
import { fitPresentText } from "../utils/autoFit.js";
import { applyPageBackground } from "../utils/pageBackground.js";
import { applyTextStyleOverride } from "../utils/textStyleOverride.js";
import { openColorPicker } from "../components/colorPicker.js";
import { renderPresentStage } from "../components/slideStage.js";

const AUTOSAVE_DEBOUNCE_MS = 700;

export const title = "Lesson Editor";

const TYPE_LABEL = Object.fromEntries(PAGE_TYPES.map((t) => [t.type, t.label]));

/** True for quiz pages graded by real text-answer comparison (fill-in-the-blank,
 * short answer) rather than by selecting one of several options. */
function isTextQuiz(page) {
  return page?.questionType === "fill_blank" || page?.questionType === "short_answer";
}

/** Splits pasted text into quiz questions on blank lines (one or more), the
 * way FreeShow-style text-import works — NOT on every newline, so a question
 * that wraps onto more than one line stays a single question. Each block's
 * internal newlines collapse to single spaces; surrounding whitespace is
 * trimmed; empty blocks are dropped. */
function splitQuestionsByBlankLine(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map((block) => block.trim().replace(/\s*\n\s*/g, " "))
    .filter(Boolean);
}

const KIND_LABEL_FOR_PROGRESS = { presentation: "PowerPoint", pdf: "PDF" };

const TYPE_ICON = {
  title: "type",
  scripture: "bible",
  image: "image",
  video: "video",
  pdf: "folder",
  presentation: "presentation",
  quiz: "quiz",
  discussion: "discussion",
  conclusion: "conclusion",
  freeform: "layers",
};

export async function render(root, { params, navigate, setTitle, setActions }) {
  let lesson = params.lessonId ? await lessonService.getLesson(params.lessonId) : null;

  if (!lesson) {
    root.appendChild(
      h("div", { class: "page" }, [
        h("div", { class: "empty-state" }, [
          h("h3", {}, "No lesson selected"),
          h("p", {}, "Choose a lesson from the Lesson Library, or start a new one."),
          h("button", { class: "btn btn--primary", onClick: () => navigate("library") }, "Go to Lesson Library"),
        ]),
      ])
    );
    setTitle("Lesson Editor");
    return;
  }

  let activeId = (params.pageId && lesson.pages.some((p) => p.id === params.pageId))
    ? params.pageId
    : lesson.pages[0]?.id || null;

  // Which box (if any) is selected on the currently-open "freeform" page's
  // canvas. Cleared whenever the active page changes.
  let freeformSelectedBoxId = null;

  // ---------------- Save reliability: dirty tracking, debounce, status ----------------
  let dirty = false;
  let editVersion = 0; // bumped on every edit, so a save knows if MORE edits arrived while it ran
  let saveStatus = "saved"; // "saved" | "saving" | "failed"
  let autosaveTimer = null;
  const statusEl = h("span", { class: "save-status" }, "");

  function renderSaveStatus() {
    statusEl.className = "save-status save-status--" + saveStatus;
    statusEl.textContent = saveStatus === "saving" ? "Saving…" : saveStatus === "failed" ? "Save failed" : "Saved";
    clear(statusEl);
    if (saveStatus === "failed") {
      statusEl.appendChild(h("span", {}, "Save failed — "));
      statusEl.appendChild(h("button", { class: "btn btn--ghost btn--sm", style: { padding: "0 4px" }, onClick: () => flushSave() }, "Retry"));
    } else {
      statusEl.textContent = saveStatus === "saving" ? "Saving…" : "Saved";
    }
  }

  /** The one real write path. Every save — debounced, immediate, manual, or
   * the final one at Present/close — goes through here and then through
   * lessonService's single serialized save queue, so status/dirty state and
   * error handling stay in one place and this never silently swallows a
   * storage failure. Returns true if the lesson is on disk, false if not.
   *
   * Overlapping calls are safe (the queue serializes them and coalesces
   * edits made mid-write into one follow-up write); `dirty` is only cleared
   * if NO further edit arrived while this write was running.
   */
  async function flushSave() {
    if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
    const versionAtStart = editVersion;
    saveStatus = "saving";
    renderSaveStatus();
    try {
      await lessonService.saveLesson(lesson);
      if (editVersion === versionAtStart) {
        dirty = false;
        saveStatus = "saved";
      } // else: newer edits are dirty and have their own autosave pending
      return true;
    } catch (err) {
      console.warn("[lessonEditor] save failed", err);
      saveStatus = "failed";
      toast("Couldn't save this lesson — your edits are kept on screen. Tap Retry.", "danger");
      return false;
    } finally {
      renderSaveStatus();
    }
  }

  /** Immediate save for discrete actions (add/remove/reorder page, file
   * pick, radio toggle, Accept) — no debounce, since these are single
   * deliberate clicks, not continuous typing. Resolves true/false. */
  async function persist() {
    dirty = true;
    editVersion++;
    return flushSave();
  }

  /** Like persist(), but THROWS when the save fails — for transactional
   * flows (scripture-page image accept) that must not proceed on a failed save. */
  async function persistOrThrow() {
    if (!(await persist())) throw new Error("The lesson couldn't be saved to disk.");
  }

  /** Debounced save for continuous text input, so every keystroke doesn't
   * hit disk, while still not depending solely on blur/change. */
  function scheduleAutosave() {
    dirty = true;
    editVersion++;
    saveStatus = "saving";
    renderSaveStatus();
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { autosaveTimer = null; flushSave(); }, AUTOSAVE_DEBOUNCE_MS);
  }

  // Any pending autosave is flushed before Present Mode, another lesson,
  // or any other screen — never left to lose an edit on navigation. Also
  // registered with the shutdown coordinator so closing the app flushes the
  // debounced edit (see ShutdownService / the native close flow in main.rs).
  const flushPending = async () => {
    if (!dirty && !autosaveTimer) return;
    if (!(await flushSave())) throw new Error("The lesson couldn't be saved.");
  };
  setBeforeNavigate(async () => { if (dirty || autosaveTimer) await flushPending(); });
  registerFlusher("lesson-editor", { flush: flushPending, isDirty: () => dirty || !!autosaveTimer });

  /** Wraps an async UI action so a thrown error (a failed save inside
   * lessonService.addPage/removePage/reorderPages, a file-picker failure,
   * etc.) always surfaces as a toast instead of an unhandled rejection. */
  function safe(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (err) {
        console.warn("[lessonEditor] action failed", err);
        toast(err?.message || "Something went wrong.", "danger");
      }
    };
  }

  /** Issue 4: PowerPoint/PDF conversion can take up to ~2 minutes with no
   * feedback otherwise, which reads as a frozen app. Appended to `root`
   * (not `layout`), so it survives redraw() untouched, and always removed
   * in a `finally` in _importSlides below — success, failure, or a
   * cancelled file picker all clear it the same way. */
  function showImportProgress(label) {
    const overlay = h("div", { class: "import-progress-overlay" }, [
      h("div", { class: "import-progress-overlay__spinner" }),
      h("div", { class: "import-progress-overlay__title" }, `Processing ${label}…`),
      h("div", { class: "import-progress-overlay__hint" }, "This may take a moment. Please don't close OmniDeck."),
    ]);
    root.appendChild(overlay);
    return () => overlay.remove();
  }

  const layout = h("div", { class: "editor-layout" });
  let stopObservingCanvasWidth = () => {};
  root.appendChild(h("div", { class: "page--full" }, [
    h("div", { class: "editor-toolbar" }, buildToolbar()),
    layout,
  ]));

  setTitle(lesson.title);
  renderSaveStatus();

  // Capture the actual visible slide surface before Present Mode hides the
  // editor shell. Output uses this as its logical canvas and scales it up,
  // rather than inventing a second layout at the projector's dimensions.
  function measurePreviewSize() {
    const page = lesson.pages.find((p) => p.id === activeId);
    const selector = page?.type === "freeform" ? ".freeform-canvas" : ".editor-canvas";
    const canvas = layout.querySelector(selector) || layout.querySelector(".editor-canvas, .freeform-canvas");
    if (!canvas) return { width: 860, height: 483.75, slideWidth: 858 };
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return { width: 860, height: 483.75, slideWidth: 858 };
    // fitPresentText() stores the preview's final auto-fit factor on the
    // canvas itself. Preserve that exact factor in Present Mode instead of
    // asking a differently mounted surface to solve the fit a second time;
    // its overflow metrics can differ even when the logical dimensions match.
    const fittedScale = Number.parseFloat(canvas.style.getPropertyValue?.("--present-scale") || "");
    return {
      width: rect.width,
      height: rect.height,
      slideWidth: canvas.clientWidth,
      ...(Number.isFinite(fittedScale) && fittedScale > 0 ? { presentScale: fittedScale } : {}),
    };
  }

  setActions([
    statusEl,
    h("button", {
      class: "btn btn--primary",
      onClick: safe(async () => {
        // Present Mode must show the latest SAVED lesson: flush first, and
        // if that fails don't silently present unsaved state.
        let allowUnsaved = false;
        if ((dirty || autosaveTimer) && !(await flushSave())) {
          if (!(await confirmPresentUnsaved())) return;
          allowUnsaved = true;
        }
        navigate("present", { lessonId: lesson.id, allowUnsaved, previewSize: measurePreviewSize() });
      }),
    }, [icon("play"), "Present"]),
  ]);

  /** Save failed right before Present: make the teacher choose knowingly. */
  function confirmPresentUnsaved() {
    return new Promise((resolve) => {
      openModal("Your latest edits aren't saved", (close) => h("div", {}, [
        h("p", {}, "OmniDeck couldn't save this lesson just now (for example, the disk is full or unavailable). Presenting now would show edits that are NOT on disk."),
        h("div", { class: "modal__actions" }, [
          h("button", { class: "btn", onClick: () => { close(); resolve(false); } }, "Stay and retry"),
          h("button", { class: "btn btn--danger", onClick: () => { close(); resolve(true); } }, "Present anyway"),
        ]),
      ]));
    });
  }

  function buildToolbar() {
    const titleInput = h("input", {
      type: "text",
      value: lesson.title,
      class: "lesson-title-input",
      "aria-label": "Lesson title",
    });
    titleInput.addEventListener("input", () => {
      lesson.title = titleInput.value;
      setTitle(lesson.title || "Untitled Lesson");
      scheduleAutosave();
    });
    return [
      titleInput,
      ...PAGE_TYPES.filter((t) => t.type !== "freeform" || FREEFORM_CANVAS_ENABLED).map((t) =>
        h("button", {
          class: "btn btn--sm",
          onClick: t.type === "quiz" ? safe(openAddQuizChooser) : () => addPage(t.type),
          // "freeform" is a whole NEW slide that's nothing but movable
          // text/image boxes — distinct from the "+ Text Box" button in
          // the properties panel, which adds a single box onto whichever
          // slide is already active. Labeled to avoid confusing the two.
        }, [icon(TYPE_ICON[t.type] || "plus"), t.type === "freeform" ? "Blank Canvas" : `Add ${t.label}`])
      ),
    ];
  }

  /** "Add Quiz" offers a blank quiz (existing behavior) or pasting several
   * questions as plain text (Issue 7 — a simple FreeShow-style text-import
   * workflow: blank line between questions is the separator, so a question
   * that wraps onto more than one line still stays one question). */
  async function openAddQuizChooser() {
    openModal("Add Quiz", (close) => {
      const body = h("div", {}, [
        h("p", {}, "Start with a blank quiz, or paste several questions at once as plain text."),
        h("div", { class: "action-row" }, [
          h("button", { class: "btn btn--primary", onClick: safe(async () => { close(); await addPage("quiz"); }) }, "Blank Quiz"),
          h("button", { class: "btn", onClick: () => renderTextImport() }, "From Text"),
        ]),
      ]);
      return body;

      function renderTextImport() {
        clear(body);
        const textarea = h("textarea", {
          rows: 12,
          placeholder: "Who built the ark?\n\nWhat was the name of Jesus' mother?\n\nWhere was Jesus born?",
          style: { width: "100%", minHeight: "220px" },
        });
        const hint = h("div", { class: "field-hint" }, "Separate each question with a blank line. Each block becomes one quiz question — you'll fill in the answer options afterward.");
        const preview = h("div", { class: "field-hint" }, "");
        const updatePreview = () => {
          const n = splitQuestionsByBlankLine(textarea.value).length;
          preview.textContent = n ? `${n} question${n === 1 ? "" : "s"} detected.` : "";
        };
        textarea.addEventListener("input", updatePreview);
        body.append(field("Paste your questions", textarea), hint, preview);

        const footer = h("div", { class: "action-row", style: { marginTop: "16px" } });
        const cancelBtn = h("button", { class: "btn", onClick: close }, "Cancel");
        const createBtn = h("button", { class: "btn btn--primary", onClick: safe(async () => {
          const questions = splitQuestionsByBlankLine(textarea.value);
          if (!questions.length) { toast("Paste at least one question first.", "danger"); return; }
          createBtn.disabled = true;
          let lastPage = null;
          for (const question of questions) {
            const page = await lessonService.addPage(lesson.id, "quiz", { persist: false });
            page.question = question;
            lastPage = page;
          }
          await lessonService.saveLesson(lesson);
          lesson = await lessonService.getLesson(lesson.id);
          activeId = lastPage.id;
          toast(`Added ${questions.length} quiz question(s) to this lesson.`, "success");
          close();
          redraw();
        }) }, "Create");
        footer.append(cancelBtn, createBtn);
        body.appendChild(footer);
      }
    });
  }

  async function _addPage(type) {
    if (type === "scripture") {
      openScripturePicker();
      return;
    }
    if (type === "presentation") {
      await _addPresentationPages();
      return;
    }
    if (type === "pdf") {
      await _addPdfPages();
      return;
    }
    if (type === "image" || type === "video") {
      const picked = await mediaService.pickFiles(type);
      if (!picked.length) return;
      // One page per selected file (multiple files create multiple pages,
      // in the order they were picked) rather than silently dropping all
      // but the first file.
      let lastPage = null;
      for (const item of picked) {
        const page = await lessonService.addPage(lesson.id, type, { persist: false });
        page.mediaId = item.id;
        page.fileName = item.name;
        lastPage = page;
      }
      await lessonService.saveLesson(lesson); // one save for all the new pages
      lesson = await lessonService.getLesson(lesson.id);
      activeId = lastPage.id;
      if (picked.length > 1) toast(`Added ${picked.length} pages, one per file.`, "success");
      redraw();
      return;
    }
    const page = await lessonService.addPage(lesson.id, type);
    lesson = await lessonService.getLesson(lesson.id);
    activeId = page.id;
    redraw();
  }
  const addPage = safe(_addPage);

  /**
   * PowerPoint / PDF import: each real slide/page of the picked file(s)
   * becomes its own individual "image" page in the Lesson Editor — so a
   * teacher can reorder, delete, or drop other content between them like
   * any other page.
   *
   * The whole import is TRANSACTIONAL (see services/ImportService.js): the
   * conversion, every page image, and the media records are prepared first,
   * and the lesson only gains its new pages in ONE persisted step at the
   * end. If anything fails, the media this import created is removed again
   * and the lesson is left exactly as it was — never half-imported. A PDF
   * that can't be split into images (poppler missing) is still added as one
   * embedded-PDF page; a PowerPoint that can't be converted fails cleanly
   * with the reason (e.g. LibreOffice not installed).
   */
  async function _importSlides(kind) {
    // Unsaved edits go to disk first so the import's single persist can't
    // be confused with (or lose) them.
    if (dirty || autosaveTimer) await flushSave();

    const hideProgress = showImportProgress(KIND_LABEL_FOR_PROGRESS[kind] || "file");
    let result;
    try {
      result = await importSlidesAsPages(lesson.id, kind, { dependencies: dependencyService });
    } catch (err) {
      const cleaned = err?.rollback && (err.rollback.removed.length || err.rollback.kept.length || err.rollback.failed.length)
        ? " Nothing was added to the lesson." : "";
      toast(`${err?.message || "Import failed."}${cleaned}`, "danger");
      return;
    } finally {
      hideProgress();
    }
    if (result.cancelled) return;

    lesson = await lessonService.getLesson(lesson.id);
    activeId = result.pages[0].id;
    redraw();

    const noun = kind === "pdf" ? "page" : "slide";
    if (result.slideCount > 0) {
      toast(`Added ${result.slideCount} ${noun}${result.slideCount === 1 ? "" : "s"} as individual page${result.slideCount === 1 ? "" : "s"}.`, "success");
    }
    for (const warning of result.warnings) toast(warning, "danger");
  }
  const _addPresentationPages = () => _importSlides("presentation");
  const _addPdfPages = () => _importSlides("pdf");

  async function _handleMissingMedia(page, action) {
    if (action === "remove") {
      page.mediaId = null;
      page.fileName = null;
      await persist();
      renderCanvasOnly();
      redrawProperties();
      return;
    }
    // "locate" and "replace" both resolve to: pick a real file and point
    // this page at it. There is no way to "re-link" the original missing
    // file without asking the user to find it again, so both actions open
    // the same native picker.
    const picked = await mediaService.pickFiles(page.type);
    if (!picked.length) return;
    page.mediaId = picked[0].id;
    page.fileName = picked[0].name;
    await persist();
    renderCanvasOnly();
    redrawProperties();
  }
  const handleMissingMedia = safe(_handleMissingMedia);

  /**
   * Adds the chosen passage to the lesson. Long passages are automatically
   * paginated across as many "scripture" pages as it takes so no slide's
   * text gets cut off in Present Mode — each resulting page keeps the same
   * translation/language and gets its own correct sub-reference (e.g.
   * "John 3:16-18" / "John 3:19-21"), re-derived from the real book name
   * and chapter the picker selected rather than reusing the whole
   * passage's combined reference string.
   */
  function openScripturePicker() {
    import("../components/scripturePicker.js").then(({ openScripturePickerModal }) => {
      openScripturePickerModal(safe(async ({ reference, verses, language, bookName, chapter }) => {
        const chunks = paginateVerses(verses);
        let firstPage = null;
        for (const chunk of chunks) {
          const page = await lessonService.addPage(lesson.id, "scripture", { persist: false });
          page.reference = chunks.length > 1 && bookName != null && chapter != null
            ? formatReference(bookName, chapter, chunk.map((v) => v.number))
            : reference;
          page.verses = chunk;
          page.language = language;
          if (!firstPage) firstPage = page;
        }
        await lessonService.saveLesson(lesson);
        lesson = await lessonService.getLesson(lesson.id);
        activeId = firstPage.id;
        redraw();
        toast(chunks.length > 1
          ? `Added ${reference} across ${chunks.length} slides to "${lesson.title}"`
          : `Added ${reference} to "${lesson.title}"`, "success");
      }));
    });
  }

  async function _removePage(pageId) {
    if (lesson.pages.length <= 1) {
      toast("A lesson needs at least one page.", "danger");
      return;
    }
    await lessonService.removePage(lesson.id, pageId);
    lesson = await lessonService.getLesson(lesson.id);
    if (activeId === pageId) activeId = lesson.pages[0]?.id || null;
    redraw();
  }
  const removePage = safe(_removePage);

  async function _reorder(orderedIds) {
    await lessonService.reorderPages(lesson.id, orderedIds);
    lesson = await lessonService.getLesson(lesson.id);
    redraw();
  }
  const reorder = safe(_reorder);

  async function _duplicatePage(pageId) {
    const copy = await lessonService.duplicatePage(lesson.id, pageId);
    lesson = await lessonService.getLesson(lesson.id);
    activeId = copy.id;
    redraw();
  }
  const duplicatePage = safe(_duplicatePage);

  async function movePage(pageId, direction) {
    const ids = lesson.pages.map((p) => p.id);
    const from = ids.indexOf(pageId);
    const to = from + direction;
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    await reorder(ids);
  }

  function goToAdjacentPage(direction) {
    const ids = lesson.pages.map((p) => p.id);
    const from = ids.indexOf(activeId);
    const to = from + direction;
    if (to < 0 || to >= ids.length) return;
    activeId = ids[to];
    freeformSelectedBoxId = null;
    redraw();
  }

  function redraw() {
    clear(layout);
    layout.appendChild(renderSlideList());
    layout.appendChild(renderCanvasPane());
    layout.appendChild(renderPropertiesPane());
    setTitle(lesson.title);
    fitActiveCanvas();
  }

  /** Mirrors the same content-aware shrink Present Mode uses (see
   * fitPresentText/autoFit.js) onto the editor's own `.editor-canvas`, so
   * a long Scripture passage or Quiz question looks — and fits — exactly
   * the same while editing as it will when actually presented, instead of
   * silently scrolling in the editor and then clipping in Present Mode.
   * Also applies the page's custom background (see pageBackground.js) to
   * whichever slide-surface element is actually on screen for this page
   * type — `.editor-canvas` for every fixed-layout type, `.freeform-canvas`
   * for the freeform type, which doesn't use fitPresentText's shrink logic
   * (it sizes its own boxes via applyFreeformFontSizes instead). */
  function fitActiveCanvas() {
    const page = lesson.pages.find((p) => p.id === activeId);
    if (!page) return;
    if (page.type === "freeform") {
      const freeformEl = layout.querySelector(".freeform-canvas");
      if (freeformEl) applyPageBackground(freeformEl, page);
      return;
    }
    const canvasEl = layout.querySelector(".editor-canvas");
    if (canvasEl) {
      fitPresentText(canvasEl);
      applyPageBackground(canvasEl, page);
    }
  }

  // ---------------- Left: slide list ----------------
  /** A real, live miniature of what the slide actually looks like —
   * built from the exact same renderPresentStage used by Present Mode
   * (not a separate simplified summary), scaled down with CSS transform
   * inside a fixed-aspect-ratio box. Because it's real re-rendered DOM
   * from the page's current data rather than a cached/generated image,
   * it's automatically "live": any call that refreshes it (see
   * refreshActiveThumbPreview) shows the page's latest content, no
   * separate thumbnail-generation step to keep in sync. */
  function renderSlideThumbPreview(page) {
    let stageInner;
    try {
      stageInner = renderPresentStage(page, { interactive: false });
    } catch (err) {
      // A malformed/incomplete page (e.g. a quiz mid-edit with no
      // options yet) should never break the slide list — fall back to a
      // blank stage rather than let a preview crash the whole editor.
      stageInner = h("div", { class: "present-stage__inner" });
    }
    const stageEl = h("div", { class: "slide-thumb__stage present-stage" }, [stageInner]);
    // Pages with a custom background (including imported PowerPoint/PDF
    // slides, whose picture IS the background) must show it in the filmstrip.
    try { applyPageBackground(stageEl, page); } catch { /* cosmetic */ }
    return h("div", { class: "slide-thumb__preview" }, [stageEl]);
  }

  /** Re-renders just the active slide's sidebar thumbnail in place, so an
   * edit on the canvas (typing committed on blur, a freeform box being
   * dragged/resized, an image accepted, etc.) is reflected in the
   * sidebar immediately without needing a full redraw() / page switch. */
  function refreshActiveThumbPreview() {
    const page = lesson.pages.find((p) => p.id === activeId);
    if (!page) return;
    const slot = layout.querySelector(`.slide-thumb.is-active .slide-thumb__preview`);
    if (!slot) return;
    slot.replaceWith(renderSlideThumbPreview(page));
  }

  function renderSlideList() {
    let dragId = null;
    const list = h("div", { class: "slide-list" },
      lesson.pages.map((page, idx) =>
        h("div", {
          class: "slide-thumb" + (page.id === activeId ? " is-active" : ""),
          draggable: true,
          onClick: () => { activeId = page.id; freeformSelectedBoxId = null; redraw(); },
          onDragstart: () => { dragId = page.id; },
          onDragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("is-dragover"); },
          onDragleave: (e) => e.currentTarget.classList.remove("is-dragover"),
          onDrop: (e) => {
            e.preventDefault();
            e.currentTarget.classList.remove("is-dragover");
            if (!dragId || dragId === page.id) return;
            const ids = lesson.pages.map((p) => p.id);
            const from = ids.indexOf(dragId);
            const to = ids.indexOf(page.id);
            ids.splice(to, 0, ids.splice(from, 1)[0]);
            reorder(ids);
          },
        }, [
          renderSlideThumbPreview(page),
          h("span", { class: "slide-thumb__index" }, String(idx + 1)),
          h("div", { class: "slide-thumb__body" }, [
            h("div", { class: "slide-thumb__title" }, pageDisplayTitle(page)),
            h("div", { class: "slide-thumb__type" }, [
              TYPE_LABEL[page.type],
              page.type === "quiz" && quizService.validateQuizPage(page).length
                ? h("span", {
                    class: "slide-thumb__warning",
                    title: quizService.validateQuizPage(page).join(" "),
                  }, "⚠ Needs answers")
                : null,
            ]),
          ]),
          h("div", { class: "slide-thumb__actions" }, [
            h("button", {
              class: "slide-thumb__action-btn", title: "Move up", disabled: idx === 0,
              onClick: (e) => { e.stopPropagation(); movePage(page.id, -1); },
            }, [icon("arrowUp")]),
            h("button", {
              class: "slide-thumb__action-btn", title: "Move down", disabled: idx === lesson.pages.length - 1,
              onClick: (e) => { e.stopPropagation(); movePage(page.id, 1); },
            }, [icon("arrowDown")]),
            h("button", {
              class: "slide-thumb__action-btn", title: "Duplicate page",
              onClick: (e) => { e.stopPropagation(); duplicatePage(page.id); },
            }, [icon("copy")]),
            h("button", {
              class: "slide-thumb__action-btn", title: "Remove page",
              onClick: (e) => { e.stopPropagation(); removePage(page.id); },
            }, [icon("trash")]),
          ]),
        ])
      )
    );
    return h("div", { class: "editor-pane" }, [
      h("div", { class: "editor-pane__header" }, [
        "Pages",
        h("span", { class: "editor-pane__count" }, String(lesson.pages.length)),
      ]),
      list,
    ]);
  }

  // ---------------- Center: canvas preview ----------------
  function renderCanvasPane() {
    const page = lesson.pages.find((p) => p.id === activeId);
    const idx = lesson.pages.findIndex((p) => p.id === activeId);
    return h("div", { class: "editor-canvas-wrap" }, [
      h("div", { class: "editor-canvas-toprow" }, [
        h("span", {}, [
          "Slide ",
          h("strong", {}, String(idx + 1)),
          ` of ${lesson.pages.length}`,
        ]),
        page ? h("span", { class: "badge badge--muted" }, TYPE_LABEL[page.type]) : null,
      ]),
      h("div", { class: "editor-canvas-scroll" }, [
        page ? renderCanvasFor(page) : h("div", {}, "Select a page"),
      ]),
      h("div", { class: "editor-bottombar" }, [
        h("button", {
          class: "btn btn--sm", disabled: idx <= 0,
          onClick: () => goToAdjacentPage(-1),
        }, [icon("chevronLeft"), "Previous"]),
        h("button", {
          class: "btn btn--sm", disabled: idx === -1 || idx >= lesson.pages.length - 1,
          onClick: () => goToAdjacentPage(1),
        }, ["Next", icon("chevronRight")]),
      ]),
    ]);
  }

  /**
   * A canvas text node you can double-click to type into directly, instead
   * of routing every edit through the right-side properties field. Starts
   * read-only (so single clicks, selection-for-copy, etc. behave normally);
   * a double-click turns on contenteditable and focuses it. Blur (click
   * away, or Escape/Enter for single-line fields) commits the text back
   * into the page object via `onChange`, schedules the normal autosave,
   * and refreshes the properties sidebar so it never goes stale.
   * `multiline: false` makes Enter commit-and-blur instead of inserting a
   * line break (title/eyebrow-style fields); omit/true for body text.
   */
  function editableCanvasText(className, value, placeholder, onChange, { multiline = true, align } = {}) {
    const el = h("div", {
      class: `${className} editor-canvas__editable`,
      contenteditable: "false",
      spellcheck: "false",
      style: align ? { textAlign: align } : undefined,
    }, value || placeholder);
    if (!value) el.classList.add("is-placeholder");

    const startEditing = () => {
      el.classList.remove("is-placeholder");
      el.textContent = value || "";
      el.setAttribute("contenteditable", "true");
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };

    const commit = () => {
      el.setAttribute("contenteditable", "false");
      const next = el.textContent.trim();
      value = next;
      if (!next) { el.textContent = placeholder; el.classList.add("is-placeholder"); }
      onChange(next);
      redrawProperties();
    };

    el.addEventListener("dblclick", (e) => { e.preventDefault(); startEditing(); });
    el.addEventListener("blur", commit);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // Revert to what was there before editing. Blur commits whatever the
        // element holds, so for an EMPTY field this must be "" (the
        // placeholder is only shown after commit) — otherwise Esc would save
        // the placeholder text as the slide's real content.
        e.preventDefault(); el.textContent = value || ""; el.blur();
      }
      else if (e.key === "Enter" && !multiline) { e.preventDefault(); el.blur(); }
      // Don't let the canvas-level box nudge/delete shortcuts (see
      // wireBoxCanvasInteractions) fire while typing here — e.g. pressing
      // Backspace to edit this text must never also delete a freeform box
      // that happens to be selected elsewhere on the same slide. Mirrors
      // the same guard the freeform box's own text editing already has.
      e.stopPropagation();
    });
    return el;
  }

  /** Sets the persisted alignment for one text field on `page` (a key like
   * "titleAlign", "bodyAlign", "questionAlign") and saves it. Paired with
   * `alignControl` below for every inline-editable field that supports
   * left/center/right alignment — the exact same `page[alignKey]` value is
   * read by slideStage.js so Present Mode always shows the alignment the
   * teacher actually picked, never the default. */
  async function _setTextAlign(page, alignKey, value) {
    page[alignKey] = value;
    await persist();
    renderCanvasOnly();
    redrawProperties();
  }
  const setTextAlign = safe(_setTextAlign);

  /** A small left/center/right alignment control for one inline-editable
   * text field. Shown directly above the field it controls (always
   * visible, not a hover-reveal) so it's discoverable and never fights
   * with contenteditable's own focus/blur timing. */
  function alignControl(page, alignKey, defaultValue = "left") {
    const current = page[alignKey] || defaultValue;
    const opt = (value, iconName, label) => h("button", {
      class: "align-control__btn" + (current === value ? " is-active" : ""),
      title: label,
      onClick: () => setTextAlign(page, alignKey, value),
    }, [icon(iconName)]);
    return h("div", { class: "align-control" }, [
      opt("left", "alignLeft", "Align left"),
      opt("center", "alignCenter", "Align center"),
      opt("right", "alignRight", "Align right"),
    ]);
  }

  function alignmentField(page, alignKey, labelText, defaultValue = "left") {
    return h("div", { style: { marginTop: "10px" } }, [
      h("div", { class: "field-hint", style: { fontWeight: 700, marginBottom: "4px" } }, labelText),
      alignControl(page, alignKey, defaultValue),
    ]);
  }

  // ---------------- "freeform" page type: box-based canvas ----------------
  // See /areas/omnideck-canvas-editor.md — this is step 2 of that plan
  // (the box renderer + drag/resize/insert), behind FREEFORM_CANVAS_ENABLED.
  // Every box position/size is stored as a % of the canvas (box.x/y/w/h,
  // box.fontSize also a % — of canvas *width*), so layout is the same
  // shape here, in Present Mode (slideStage.js), and at any window size.

  function clampPct(n, min, max) { return Math.min(Math.max(n, min), max); }

  async function _addFreeformBox(page, type) {
    const box = { id: uid("box"), type, x: 15, y: 40, w: 70, h: 20 };
    if (type === "text") {
      box.text = "Double-click to edit";
      box.fontSize = 6;
      box.align = "center";
    } else {
      const picked = await mediaService.pickFiles("image");
      if (!picked.length) return; // cancelled — don't add an empty image box
      box.mediaId = picked[0].id;
    }
    page.boxes.push(box);
    freeformSelectedBoxId = box.id;
    await persist();
    renderCanvasOnly();
    redrawProperties();
  }
  const addFreeformBox = safe(_addFreeformBox);

  async function _removeFreeformBox(page, boxId) {
    page.boxes = page.boxes.filter((b) => b.id !== boxId);
    if (freeformSelectedBoxId === boxId) freeformSelectedBoxId = null;
    await persist();
    renderCanvasOnly();
    redrawProperties();
  }
  const removeFreeformBox = safe(_removeFreeformBox);

  async function _duplicateFreeformBox(page, boxId) {
    const box = page.boxes.find((b) => b.id === boxId);
    if (!box) return;
    // Slight offset so the copy is visibly a separate box, not hidden
    // exactly under the original; clamped so it can't be dragged off-canvas
    // by the offset alone.
    const copy = { ...box, id: uid("box"), x: clampPct(box.x + 4, 0, 100 - box.w), y: clampPct(box.y + 4, 0, 100 - box.h) };
    const idx = page.boxes.indexOf(box);
    page.boxes.splice(idx + 1, 0, copy);
    freeformSelectedBoxId = copy.id;
    await persist();
    renderCanvasOnly();
    redrawProperties();
  }
  const duplicateFreeformBox = safe(_duplicateFreeformBox);

  /** Stacking order is just array order — a later box in `page.boxes`
   * paints on top with no explicit z-index needed, so "bring
   * forward"/"send backward" is a swap with the neighboring array entry.
   * `direction` is +1 (forward/up) or -1 (backward/down). */
  async function _reorderFreeformBox(page, boxId, direction) {
    const idx = page.boxes.findIndex((b) => b.id === boxId);
    const to = idx + direction;
    if (idx === -1 || to < 0 || to >= page.boxes.length) return;
    [page.boxes[idx], page.boxes[to]] = [page.boxes[to], page.boxes[idx]];
    await persist();
    renderCanvasOnly();
  }
  const reorderFreeformBox = safe(_reorderFreeformBox);

  async function _nudgeFreeformBox(page, box, dx, dy) {
    box.x = clampPct(box.x + dx, 0, 100 - box.w);
    box.y = clampPct(box.y + dy, 0, 100 - box.h);
    await persist();
    renderCanvasOnly();
  }
  const nudgeFreeformBox = safe(_nudgeFreeformBox);

  async function _setFreeformTextStyle(page, box, changes) {
    Object.assign(box, changes);
    await persist();
    renderCanvasOnly();
    redrawProperties();
  }
  const setFreeformTextStyle = safe(_setFreeformTextStyle);

  /** Precise numeric counterpart to dragging/resizing a box by hand — used
   * by the "Position & Size" fields in the properties panel. Width/height
   * are clamped first, then position is clamped against that (possibly
   * new) size, so typing a bigger width never gets silently discarded
   * just because the box's current x would push it off-canvas — the
   * position yields instead, matching how a drag already behaves
   * (clampPct(x, 0, 100 - w)). */
  async function _setFreeformBoxRect(page, box, changes) {
    const next = { ...box, ...changes };
    box.w = clampPct(next.w, 5, 100);
    box.h = clampPct(next.h, 5, 100);
    box.x = clampPct(next.x, 0, 100 - box.w);
    box.y = clampPct(next.y, 0, 100 - box.h);
    await persist();
    renderCanvasOnly();
    redrawProperties();
  }
  const setFreeformBoxRect = safe(_setFreeformBoxRect);

  /** After the canvas is actually in the DOM (so clientWidth is real),
   * sizes each text box's font relative to the canvas's current rendered
   * width. Re-run after every render and after resize-drag ends. Known
   * follow-up: doesn't re-run on a live window resize mid-edit — only on
   * the next render/redraw — so text can be briefly under/oversized until
   * something else triggers a re-render. */
  function applyFreeformFontSizes(canvasEl, page) {
    requestAnimationFrame(() => {
      const w = canvasEl.clientWidth || canvasEl.getBoundingClientRect().width;
      if (!w) return;
      for (const box of page.boxes) {
        if (box.type !== "text") continue;
        const textEl = canvasEl.querySelector(`[data-box-id="${box.id}"] .freeform-box__text`);
        if (textEl) textEl.style.fontSize = `${(w * (box.fontSize || 6)) / 100}px`;
      }
    });
  }

  /** Selecting and dragging a not-yet-selected box now happens in ONE
   * gesture (mousedown → move → up), instead of requiring a first click
   * just to select before a second click could drag. The handles/mini
   * toolbar that only exist on a selected box aren't added to the DOM
   * until pointerup, specifically so a re-render never interrupts an
   * in-progress drag. While dragging, the box snaps to the canvas's own
   * center (both axes, PowerPoint-style smart guide) and shows a thin
   * guide line for as long as it's snapped. */
  function startFreeformDrag(e, page, box, el, canvasEl) {
    if (e.target.closest(".freeform-box__delete") || e.target.closest(".freeform-box__toolbar") || e.target.closest(".freeform-box__resize")) return;
    const textEl = el.querySelector(".freeform-box__text");
    if (textEl?.getAttribute("contenteditable") === "true") return; // let text selection/typing happen

    e.preventDefault();
    canvasEl.focus();
    const wasSelected = freeformSelectedBoxId === box.id;
    const canvasRect = canvasEl.getBoundingClientRect();
    const guideV = canvasEl.querySelector(".freeform-guide--v");
    const guideH = canvasEl.querySelector(".freeform-guide--h");
    const startX = e.clientX, startY = e.clientY;
    const startBoxX = box.x, startBoxY = box.y;
    const SNAP = 1.5; // % of canvas — how close to dead-center before it snaps
    let moved = false;

    function onMove(ev) {
      const dxPct = ((ev.clientX - startX) / canvasRect.width) * 100;
      const dyPct = ((ev.clientY - startY) / canvasRect.height) * 100;
      if (Math.abs(dxPct) > 0.3 || Math.abs(dyPct) > 0.3) moved = true;
      let newX = clampPct(startBoxX + dxPct, 0, 100 - box.w);
      let newY = clampPct(startBoxY + dyPct, 0, 100 - box.h);
      const snappedX = Math.abs(newX + box.w / 2 - 50) < SNAP;
      const snappedY = Math.abs(newY + box.h / 2 - 50) < SNAP;
      if (snappedX) newX = 50 - box.w / 2;
      if (snappedY) newY = 50 - box.h / 2;
      box.x = newX;
      box.y = newY;
      el.style.left = `${box.x}%`;
      el.style.top = `${box.y}%`;
      if (guideV) guideV.style.opacity = snappedX ? "1" : "0";
      if (guideH) guideH.style.opacity = snappedY ? "1" : "0";
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (guideV) guideV.style.opacity = "0";
      if (guideH) guideH.style.opacity = "0";
      freeformSelectedBoxId = box.id;
      if (moved) scheduleAutosave();
      if (moved || !wasSelected) { renderCanvasOnly(); redrawProperties(); }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startFreeformResize(e, box, el, canvasEl, page) {
    e.preventDefault();
    e.stopPropagation();
    const canvasRect = canvasEl.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startW = box.w, startH = box.h;

    function onMove(ev) {
      const dwPct = ((ev.clientX - startX) / canvasRect.width) * 100;
      const dhPct = ((ev.clientY - startY) / canvasRect.height) * 100;
      box.w = clampPct(startW + dwPct, 5, 100 - box.x);
      box.h = clampPct(startH + dhPct, 5, 100 - box.y);
      el.style.width = `${box.w}%`;
      el.style.height = `${box.h}%`;
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      scheduleAutosave();
      applyFreeformFontSizes(canvasEl, page); // text box may have been resized
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /** The mini toolbar shown above a selected box: reorder/duplicate/delete
   * for every box, plus alignment + font-size steppers for text boxes.
   * Kept as real buttons (not keyboard-only) since a teacher building a
   * slide on a touchscreen or with a mouse only has no other way to reach
   * these. */
  function renderFreeformBoxToolbar(page, box, idx) {
    const buttons = [
      h("button", {
        class: "freeform-box__tool-btn", title: "Send backward", disabled: idx === 0,
        onClick: (e) => { e.stopPropagation(); reorderFreeformBox(page, box.id, -1); },
      }, [icon("arrowDown")]),
      h("button", {
        class: "freeform-box__tool-btn", title: "Bring forward", disabled: idx === page.boxes.length - 1,
        onClick: (e) => { e.stopPropagation(); reorderFreeformBox(page, box.id, 1); },
      }, [icon("arrowUp")]),
      h("button", {
        class: "freeform-box__tool-btn", title: "Duplicate",
        onClick: (e) => { e.stopPropagation(); duplicateFreeformBox(page, box.id); },
      }, [icon("copy")]),
    ];
    if (box.type === "text") {
      buttons.push(
        h("span", { class: "freeform-box__tool-sep" }),
        h("button", {
          class: "freeform-box__tool-btn" + (box.align === "left" ? " is-active" : ""), title: "Align left",
          onClick: (e) => { e.stopPropagation(); setFreeformTextStyle(page, box, { align: "left" }); },
        }, [icon("alignLeft")]),
        h("button", {
          class: "freeform-box__tool-btn" + (box.align !== "left" && box.align !== "right" ? " is-active" : ""), title: "Align center",
          onClick: (e) => { e.stopPropagation(); setFreeformTextStyle(page, box, { align: "center" }); },
        }, [icon("alignCenter")]),
        h("button", {
          class: "freeform-box__tool-btn" + (box.align === "right" ? " is-active" : ""), title: "Align right",
          onClick: (e) => { e.stopPropagation(); setFreeformTextStyle(page, box, { align: "right" }); },
        }, [icon("alignRight")]),
        h("span", { class: "freeform-box__tool-sep" }),
        h("button", {
          class: "freeform-box__tool-btn", title: "Smaller text",
          onClick: (e) => { e.stopPropagation(); setFreeformTextStyle(page, box, { fontSize: clampPct((box.fontSize || 6) - 1, 1, 30) }); },
        }, "A−"),
        h("button", {
          class: "freeform-box__tool-btn", title: "Bigger text",
          onClick: (e) => { e.stopPropagation(); setFreeformTextStyle(page, box, { fontSize: clampPct((box.fontSize || 6) + 1, 1, 30) }); },
        }, "A+"),
      );
    }
    return h("div", { class: "freeform-box__toolbar" }, buttons);
  }

  function renderFreeformBox(page, box, canvasEl, idx) {
    const isSelected = box.id === freeformSelectedBoxId;
    const el = h("div", {
      class: "freeform-box" + (isSelected ? " is-selected" : ""),
      "data-box-id": box.id,
      style: { left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` },
    });

    if (box.type === "text") {
      const textEl = h("div", {
        class: "freeform-box__text",
        contenteditable: "false",
        spellcheck: "false",
        style: {
          textAlign: box.align || "center",
          ...(box.fontFamily ? { fontFamily: box.fontFamily } : {}),
          ...(box.color ? { color: box.color } : {}),
        },
      }, box.text || "");
      textEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        textEl.setAttribute("contenteditable", "true");
        textEl.focus();
        const range = document.createRange();
        range.selectNodeContents(textEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
      textEl.addEventListener("blur", () => {
        textEl.setAttribute("contenteditable", "false");
        box.text = textEl.textContent.trim() || "Double-click to edit";
        textEl.textContent = box.text;
        scheduleAutosave();
      });
      textEl.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); textEl.textContent = box.text || ""; textEl.blur(); }
        e.stopPropagation(); // don't let canvas-level nudge/delete shortcuts fire while typing
      });
      textEl.addEventListener("pointerdown", (e) => {
        if (textEl.getAttribute("contenteditable") === "true") e.stopPropagation();
      });
      el.appendChild(textEl);
    } else {
      el.appendChild(renderMediaSlide(box.mediaId, "image", { fit: "cover" }));
    }

    el.addEventListener("pointerdown", (e) => startFreeformDrag(e, page, box, el, canvasEl));

    if (isSelected) {
      el.appendChild(renderFreeformBoxToolbar(page, box, idx));
      el.appendChild(h("button", {
        class: "freeform-box__delete", title: "Delete box",
        onClick: (e) => { e.stopPropagation(); removeFreeformBox(page, box.id); },
      }, [icon("trash")]));
      const handle = h("div", { class: "freeform-box__resize", title: "Drag to resize" });
      handle.addEventListener("pointerdown", (e) => startFreeformResize(e, box, el, canvasEl, page));
      el.appendChild(handle);
    }

    return el;
  }

  /** Wires up the shared box-canvas interactions on any container that
   * hosts `page.boxes` — deselect-on-empty-click, and (once it has
   * focus, which clicking any box gives it) arrow-key nudge, Delete/
   * Backspace to remove, Escape to deselect. Shared by the dedicated
   * "Freeform" page type's own canvas AND the generalized box overlay
   * available on every other page type (see renderBoxesOverlay), so
   * boxes behave identically everywhere a teacher can place one. Never
   * fires while a text box is mid-edit — its own keydown handler stops
   * that from bubbling here. */
  function wireBoxCanvasInteractions(canvasEl, page) {
    canvasEl.addEventListener("pointerdown", (e) => {
      if (e.target === canvasEl && freeformSelectedBoxId !== null) {
        freeformSelectedBoxId = null;
        renderCanvasOnly();
        redrawProperties();
      }
    });
    canvasEl.addEventListener("keydown", (e) => {
      if (!freeformSelectedBoxId) return;
      const box = (page.boxes || []).find((b) => b.id === freeformSelectedBoxId);
      if (!box) return;
      const step = e.shiftKey ? 5 : 1;
      if (e.key === "ArrowLeft") { e.preventDefault(); nudgeFreeformBox(page, box, -step, 0); }
      else if (e.key === "ArrowRight") { e.preventDefault(); nudgeFreeformBox(page, box, step, 0); }
      else if (e.key === "ArrowUp") { e.preventDefault(); nudgeFreeformBox(page, box, 0, -step); }
      else if (e.key === "ArrowDown") { e.preventDefault(); nudgeFreeformBox(page, box, 0, step); }
      else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeFreeformBox(page, box.id); }
      else if (e.key === "Escape") { freeformSelectedBoxId = null; renderCanvasOnly(); redrawProperties(); }
    });
  }

  /**
   * Adds the SAME movable/resizable text & image boxes used by the
   * dedicated "Freeform" page type onto any OTHER page type's canvas, as
   * an overlay on top of that page's own content (title text, scripture,
   * media, ...) — this is what makes "+ Text Box" / "+ Image Box" in the
   * properties panel work on every slide, not just Freeform ones.
   * `canvasEl` must already be `position: relative` (`.editor-canvas` is)
   * so the boxes' percentage-based positions anchor to it correctly.
   */
  function renderBoxesOverlay(canvasEl, page) {
    page.boxes = page.boxes || [];
    canvasEl.setAttribute("tabindex", "0");
    wireBoxCanvasInteractions(canvasEl, page);
    canvasEl.append(
      h("div", { class: "freeform-guide freeform-guide--v" }),
      h("div", { class: "freeform-guide freeform-guide--h" }),
    );
    page.boxes.forEach((box, idx) => canvasEl.appendChild(renderFreeformBox(page, box, canvasEl, idx)));
    applyFreeformFontSizes(canvasEl, page);
  }

  function renderFreeformCanvas(page) {
    page.boxes = page.boxes || [];
    const canvas = h("div", { class: "freeform-canvas", tabindex: "0" });
    wireBoxCanvasInteractions(canvas, page);
    // Smart-guide lines for the center-snap in startFreeformDrag — hidden
    // (opacity 0) except while a drag is actively snapped to center.
    canvas.append(
      h("div", { class: "freeform-guide freeform-guide--v" }),
      h("div", { class: "freeform-guide freeform-guide--h" }),
    );
    page.boxes.forEach((box, idx) => canvas.appendChild(renderFreeformBox(page, box, canvas, idx)));
    applyFreeformFontSizes(canvas, page);

    return h("div", { class: "freeform-canvas-wrap" }, [
      h("div", { class: "freeform-toolbar" }, [
        h("button", { class: "btn btn--sm", onClick: () => addFreeformBox(page, "text") }, [icon("type"), "Text Box"]),
        h("button", { class: "btn btn--sm", onClick: () => addFreeformBox(page, "image") }, [icon("image"), "Image Box"]),
        page.boxes.length ? h("div", { class: "field-hint" }, "Click a box (or click-drag to move it in one motion). Arrow keys nudge, Delete removes, corner handle resizes.") : null,
      ]),
      canvas,
    ]);
  }

  function renderCanvasFor(page) {
    if (page.type === "freeform") return renderFreeformCanvas(page);

    // Render the exact same stage tree used by Present Mode, but leave boxes
    // out so the editor can add its selectable/drag handles once. The old
    // per-type preview recreated slide content separately (and even showed
    // quiz answers as plain text), which allowed layout and sizing to drift.
    const canvasEl = h("div", { class: "editor-canvas" }, [
      renderPresentStage(page, {
        interactive: false,
        editorPreview: true,
        omitBoxes: true,
        onMissing: (action) => handleMissingMedia(page, action),
        onError: () => handleMissingMedia(page, "replace"),
        onSlideChange: (idx) => { page.currentSlide = idx + 1; persist(); },
      }),
    ]);

    const makeEditable = (selector, value, placeholder, onChange, options = {}) => {
      const current = canvasEl.querySelector(selector);
      if (!current) return null;
      const editable = editableCanvasText(current.className, value, placeholder, onChange, options);
      current.replaceWith(editable);
      return editable;
    };

    switch (page.type) {
      case "title": {
        const title = makeEditable(".present-title", page.title, "Untitled",
          (v) => { page.title = v; scheduleAutosave(); }, { multiline: false, align: page.titleAlign || "left" });
        applyTextStyleOverride(title, "present-title", page.titleStyle);
        const subtitle = makeEditable(".present-body", page.subtitle, "Add a subtitle…",
          (v) => { page.subtitle = v; scheduleAutosave(); }, { multiline: false, align: page.subtitleAlign || "left" });
        applyTextStyleOverride(subtitle, "present-body", page.subtitleStyle);
        break;
      }
      case "image":
      case "video":
      case "pdf": {
        const title = makeEditable(".present-title", page.title, TYPE_LABEL[page.type],
          (v) => { page.title = v; scheduleAutosave(); }, { multiline: false, align: page.titleAlign || "left" });
        applyTextStyleOverride(title, "present-title", page.titleStyle);
        makeEditable(".present-caption", page.caption, "Add a caption…",
          (v) => { page.caption = v; scheduleAutosave(); }, { align: page.captionAlign || "left" });
        break;
      }
      case "presentation": {
        const title = makeEditable(".present-title", page.title, "Presentation",
          (v) => { page.title = v; scheduleAutosave(); }, { multiline: false, align: page.titleAlign || "left" });
        applyTextStyleOverride(title, "present-title", page.titleStyle);
        break;
      }
      case "quiz": {
        const question = makeEditable(".present-title", page.question, "Untitled question",
          (v) => { page.question = v; scheduleAutosave(); }, { multiline: false, align: page.questionAlign || "left" });
        applyTextStyleOverride(question, "present-title", page.questionStyle);
        break;
      }
      case "discussion":
        makeEditable(".present-body", page.prompt, "Add a discussion prompt.",
          (v) => { page.prompt = v; scheduleAutosave(); }, { align: page.bodyAlign || "left" });
        break;
      case "conclusion":
        makeEditable(".present-body", page.body, "Add closing thoughts.",
          (v) => { page.body = v; scheduleAutosave(); }, { align: page.bodyAlign || "left" });
        break;
      // Scripture's formatting is controlled from the properties panel; the
      // shared renderer remains untouched here, including its saved font size.
    }

    // Movable/resizable text and image boxes are an editor-only interaction
    // layer over the shared slide render; the output renderer owns their
    // read-only visual counterpart.
    renderBoxesOverlay(canvasEl, page);
    stopObservingCanvasWidth();
    stopObservingCanvasWidth = observeSlideWidth(canvasEl);
    return canvasEl;
  }

  // ---------------- Right: properties ----------------
  function renderPropertiesPane() {
    const page = lesson.pages.find((p) => p.id === activeId);
    const pane = h("div", { class: "editor-pane editor-pane--properties" }, [
      h("div", { class: "editor-pane__header" }, page ? `Edit ${TYPE_LABEL[page.type]} Slide` : "Edit Slide"),
    ]);
    const list = h("div", { class: "properties-list" });
    if (page) list.appendChild(propertiesFor(page));
    pane.appendChild(list);
    return pane;
  }

  function field(labelText, inputEl) {
    return h("div", { class: "field" }, [h("label", {}, labelText), inputEl]);
  }

  /** A labeled numeric input that only commits on change (blur/Enter/
   * spinner), not per-keystroke — same commit model as editableCanvasText
   * — so a box doesn't jump around mid-typing while a teacher clears the
   * field to type a new value. Used for the freeform box "Position &
   * Size" fields, where precise typed values are the point (dragging
   * already covers the by-hand case). */
  function numberField(labelText, value, onCommit, { min = 0, max = 100, step = 1 } = {}) {
    const input = h("input", { type: "number", value: String(Math.round(value * 10) / 10), min, max, step });
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) onCommit(v);
    });
    return field(labelText, input);
  }

  /** A clickable color swatch + hex readout that opens the custom color
   * picker (colorPicker.js) — used everywhere a color choice is offered
   * (background fills/gradients, and the text-style controls below)
   * instead of `<input type="color">`, for a consistent wheel+eyedropper
   * picker regardless of OS/webview. `onLiveChange` previews as the
   * teacher drags/eyedrops; `onCommit` is called once, on "Use this
   * color", and is where the caller should actually persist(). */
  function colorSwatchField(labelText, hex, onLiveChange, onCommit) {
    const displayHex = hex || "#14181D";
    const btn = h("button", { class: "color-swatch-btn", type: "button", style: { background: displayHex } });
    const readout = h("span", { class: "field-hint" }, displayHex);
    btn.addEventListener("click", () => {
      openColorPicker({
        initialHex: displayHex,
        onLiveChange: (next) => { btn.style.background = next; readout.textContent = next; onLiveChange?.(next); },
        onCommit: (next) => { readout.textContent = next; onCommit(next); },
      });
    });
    return field(labelText, h("div", { class: "action-row", style: { gap: "8px", flexWrap: "nowrap" } }, [btn, readout]));
  }

  /** Font family + size + color controls for one of a slide's inline
   * text elements (title, subtitle, etc.) — the fix for those elements
   * having no styling controls at all (they were edited in place via
   * double-click but always rendered at present.css's fixed size/color).
   * `style` is read from/written to `page[styleKey]` (e.g. "titleStyle");
   * `className` is the present.css class that element renders with (see
   * PRESENT_BASE_CLAMP in textStyleOverride.js), used to scale font size
   * sensibly relative to that class's own default. */
  function renderTextStyleControls(page, styleKey, className, sectionLabel) {
    const wrap = h("div", { style: { marginTop: "12px" } });
    wrap.append(h("div", { class: "field-hint", style: { fontWeight: 700, marginBottom: "4px" } }, sectionLabel));
    const style = page[styleKey] || {};

    const commit = async (changes) => {
      page[styleKey] = { ...(page[styleKey] || {}), ...changes };
      await persist();
      renderCanvasOnly();
      redrawProperties();
    };

    const sizeRow = h("div", { class: "action-row" }, [
      h("button", {
        class: "btn btn--sm", type: "button", title: "Smaller text",
        onClick: () => commit({ fontSize: Math.max(0.5, Math.round(((style.fontSize || 1) - 0.1) * 10) / 10) }),
      }, "A−"),
      h("div", { class: "field-hint", style: { minWidth: "40px", textAlign: "center" } }, `${Math.round((style.fontSize || 1) * 100)}%`),
      h("button", {
        class: "btn btn--sm", type: "button", title: "Bigger text",
        onClick: () => commit({ fontSize: Math.min(2, Math.round(((style.fontSize || 1) + 0.1) * 10) / 10) }),
      }, "A+"),
    ]);
    wrap.append(field("Size", sizeRow));

    const fontSelect = h("select", {}, FONT_FAMILY_OPTIONS.map((opt) =>
      h("option", { value: opt.value, selected: (style.fontFamily || "") === opt.value }, opt.label)
    ));
    fontSelect.addEventListener("change", () => commit({ fontFamily: fontSelect.value || undefined }));
    wrap.append(field("Font", fontSelect));

    wrap.append(colorSwatchField(
      "Color",
      style.color || "#F6F4EE",
      (hex) => { const el = layout.querySelector(`.editor-canvas .${className}`); if (el) el.style.color = hex; },
      (hex) => commit({ color: hex }),
    ));

    if (style.fontFamily || style.fontSize || style.color) {
      wrap.append(h("button", {
        class: "btn btn--sm btn--ghost", style: { marginTop: "4px" },
        onClick: () => commit({ fontFamily: undefined, fontSize: undefined, color: undefined }),
      }, "Reset to Default"));
    }

    return wrap;
  }

  function propertiesFor(page) {
    const box = h("div", {});
    const save = async () => { await persist(); };

    if (page.type === "title") {
      box.append(h("div", { class: "field-hint" }, "Double-click the title or subtitle on the slide to type. Use the controls below to change how each looks."));
      box.append(alignmentField(page, "titleAlign", "Title Alignment"));
      box.append(renderTextStyleControls(page, "titleStyle", "present-title", "Title"));
      box.append(alignmentField(page, "subtitleAlign", "Subtitle Alignment"));
      box.append(renderTextStyleControls(page, "subtitleStyle", "present-body", "Subtitle"));
    }

    if (page.type === "scripture") {
      box.append(
        h("div", { class: "field" }, [
          h("label", {}, "Translation"),
          h("div", { class: "field-hint" }, page.language || "English"),
        ]),
        h("div", { class: "field" }, [
          h("label", {}, "Reference"),
          h("div", { class: "badge" }, page.reference || "None selected"),
        ]),
        h("button", { class: "btn btn--sm btn--block", onClick: openScripturePicker }, "Change Passage"),
        h("div", { style: { height: "12px" } }),
        alignmentField(page, "scriptureAlign", "Scripture Alignment", "center"),
        renderTextStyleControls(page, "scriptureStyle", "present-scripture", "Scripture Text"),
        h("div", { style: { height: "8px" } }),
        renderScriptureImageBlock(page)
      );
    }

    if (page.type === "image" || page.type === "video" || page.type === "pdf") {
      box.append(
        h("div", { class: "field" }, [h("label", {}, "File"), h("div", { class: "badge badge--muted" }, page.fileName || "None")]),
        h("button", {
          class: "btn btn--sm btn--block",
          onClick: safe(async () => {
            const picked = await mediaService.pickFiles(page.type);
            if (!picked.length) return;
            page.mediaId = picked[0].id;
            page.fileName = picked[0].name;
            await save();
            renderCanvasOnly();
            redrawProperties();
          }),
        }, "Replace File"),
        h("div", { class: "field-hint", style: { marginTop: "8px" } }, "Title and caption are edited right on the slide — double-click either one to type.")
      );
      box.append(alignmentField(page, "titleAlign", "Title Alignment"), alignmentField(page, "captionAlign", "Caption Alignment"));
    }

    if (page.type === "presentation") {
      box.append(
        h("div", { class: "field" }, [h("label", {}, "File"), h("div", { class: "badge badge--muted" }, page.fileName || "None")]),
        h("button", {
          class: "btn btn--sm btn--block",
          onClick: safe(async () => {
            const picked = await mediaService.pickFiles("presentation");
            if (!picked.length) return;
            page.mediaId = picked[0].id;
            page.fileName = picked[0].name;
            await save();
            renderCanvasOnly();
            redrawProperties();
          }),
        }, "Choose .pptx File"),
        alignmentField(page, "titleAlign", "Title Alignment")
      );
    }

    if (page.type === "quiz") {
      box.append(h("div", { class: "field-hint" }, "The question is edited right on the slide — double-click it to type."));
      box.append(alignmentField(page, "questionAlign", "Question Alignment"));
      box.append(renderTextStyleControls(page, "questionStyle", "present-title", "Question"));

      const typeSelect = h("select", {}, [
        h("option", { value: "multiple_choice", selected: (page.questionType || "multiple_choice") === "multiple_choice" }, "Multiple Choice"),
        h("option", { value: "true_false", selected: page.questionType === "true_false" }, "True / False"),
        h("option", { value: "fill_blank", selected: page.questionType === "fill_blank" }, "Fill in the Blank"),
        h("option", { value: "short_answer", selected: page.questionType === "short_answer" }, "Short Answer"),
      ]);
      typeSelect.addEventListener("change", safe(async () => {
        page.questionType = typeSelect.value;
        if (page.questionType === "true_false") {
          page.options = ["True", "False"];
          if (page.correctIndex !== 0 && page.correctIndex !== 1) page.correctIndex = 0;
        } else if (page.questionType === "multiple_choice" && (!page.options || page.options.length < 2)) {
          page.options = ["", "", "", ""];
          page.correctIndex = 0;
        } else if ((page.questionType === "fill_blank" || page.questionType === "short_answer") && !page.acceptedAnswers?.length) {
          page.acceptedAnswers = [""];
        }
        renderCanvasOnly();
        await persist();
        redrawProperties();
      }));
      box.append(field("Question Type", typeSelect));

      if (isTextQuiz(page)) {
        (page.acceptedAnswers || [""]).forEach((ans, i) => {
          const row = h("div", { class: "quiz-option-row" });
          const text = h("input", { type: "text", value: ans, placeholder: `Accepted answer ${i + 1}` });
          text.addEventListener("input", () => { page.acceptedAnswers[i] = text.value; scheduleAutosave(); });
          const removeBtn = h("button", { class: "btn btn--sm btn--ghost", title: "Remove this accepted answer" }, "✕");
          removeBtn.addEventListener("click", safe(async () => {
            page.acceptedAnswers.splice(i, 1);
            if (!page.acceptedAnswers.length) page.acceptedAnswers = [""];
            await persist();
            redrawProperties();
          }));
          row.append(text, removeBtn);
          box.appendChild(row);
        });
        box.appendChild(h("button", {
          class: "btn btn--sm",
          onClick: safe(async () => { page.acceptedAnswers = [...(page.acceptedAnswers || []), ""]; await persist(); redrawProperties(); }),
        }, "+ Add Accepted Answer"));
        box.appendChild(h("div", { class: "field-hint" }, "Grading ignores case, extra spaces, and trailing punctuation. Add every wording you'd accept (e.g. \"David\" and \"king David\")."));
      } else {
        page.options.forEach((opt, i) => {
          const row = h("div", { class: "quiz-option-row" });
          const radio = h("input", { type: "radio", name: "correct", checked: page.correctIndex === i });
          radio.addEventListener("change", safe(async () => { page.correctIndex = i; renderCanvasOnly(); await persist(); }));
          const text = h("input", { type: "text", value: opt, placeholder: `Option ${i + 1}`, disabled: page.questionType === "true_false" });
          text.addEventListener("input", () => { page.options[i] = text.value; renderCanvasOnly(); scheduleAutosave(); });
          row.append(radio, text);
          box.appendChild(row);
        });
        box.appendChild(h("div", { class: "field-hint" }, "Select the radio button next to the correct answer."));
      }
    }

    if (page.type === "discussion") {
      box.append(h("div", { class: "field-hint" }, "The discussion prompt is edited right on the slide — double-click it to type."));
      box.append(alignmentField(page, "bodyAlign", "Prompt Alignment"));
    }

    if (page.type === "conclusion") {
      box.append(h("div", { class: "field-hint" }, "Closing thoughts are edited right on the slide — double-click to type."));
      box.append(alignmentField(page, "bodyAlign", "Body Alignment"));
    }

    if (page.type === "freeform") {
      box.append(h("div", { class: "field-hint" }, "This whole slide is a canvas of boxes — drag to move, drag the corner handle to resize, double-click text to type."));
    }
    // Every page type — including Freeform — gets the same box panel:
    // "+ Text Box" / "+ Image Box" to add one to THIS slide, and, once a
    // box is selected on the canvas, font size/family + alignment controls
    // for it right here (not just the small floating toolbar over the box
    // itself). See renderBoxesOverlay for how the boxes themselves render.
    box.appendChild(renderBoxesPanel(page));
    box.appendChild(renderBackgroundPanel(page));

    return box;
  }

  const FONT_FAMILY_OPTIONS = [
    { label: "Serif (default)", value: "" },
    { label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
    { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
    { label: "Garamond", value: "Garamond, 'Palatino Linotype', 'Book Antiqua', serif" },
    { label: "Sans-Serif", value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', 'Helvetica Neue', Arial, sans-serif" },
    { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
    { label: "Trebuchet MS", value: "'Trebuchet MS', Helvetica, sans-serif" },
    { label: "Rounded", value: "'Segoe UI Rounded', Verdana, Geneva, sans-serif" },
    { label: "Comic Sans MS", value: "'Comic Sans MS', 'Comic Sans', cursive" },
    { label: "Impact", value: "Impact, 'Arial Narrow Bold', sans-serif" },
    { label: "Monospace", value: "'Courier New', Courier, monospace" },
  ];

  /** The properties-panel counterpart to "+ Text Box" / "+ Image Box" and
   * the per-box floating toolbar — lets a teacher add a box to THIS slide
   * and, once one is selected, change its font size/family and alignment
   * from the right-hand panel instead of only the small toolbar that
   * floats over the box itself on the canvas. */
  function renderBoxesPanel(page) {
    const wrap = h("div", {});
    wrap.append(
      h("div", { class: "field-hint" }, "Add movable, resizable text or image boxes on top of this slide — drag to move, drag the corner handle to resize."),
      h("div", { class: "action-row", style: { marginTop: "8px", marginBottom: "12px" } }, [
        h("button", { class: "btn btn--sm", onClick: () => addFreeformBox(page, "text") }, [icon("type"), "+ Text Box"]),
        h("button", { class: "btn btn--sm", onClick: () => addFreeformBox(page, "image") }, [icon("image"), "+ Image Box"]),
      ]),
    );

    const selectedBox = (page.boxes || []).find((b) => b.id === freeformSelectedBoxId);
    if (!selectedBox) {
      wrap.append(h("div", { class: "field-hint" },
        (page.boxes?.length ? `${page.boxes.length} box${page.boxes.length === 1 ? "" : "es"} on this slide. Click one to adjust its font and alignment here.` : "No boxes on this slide yet.")));
      return wrap;
    }

    wrap.append(h("div", { class: "field-hint", style: { fontWeight: 700, marginBottom: "4px" } }, "Selected box"));

    wrap.append(h("div", { class: "field-hint", style: { fontWeight: 700, marginTop: "4px" } }, "Position & Size (%)"));
    wrap.append(
      h("div", { class: "action-row" }, [
        numberField("X", selectedBox.x, (v) => setFreeformBoxRect(page, selectedBox, { x: v })),
        numberField("Y", selectedBox.y, (v) => setFreeformBoxRect(page, selectedBox, { y: v })),
      ]),
      h("div", { class: "action-row" }, [
        numberField("Width", selectedBox.w, (v) => setFreeformBoxRect(page, selectedBox, { w: v }), { min: 5 }),
        numberField("Height", selectedBox.h, (v) => setFreeformBoxRect(page, selectedBox, { h: v }), { min: 5 }),
      ]),
    );

    if (selectedBox.type === "text") {
      // Font size
      const sizeRow = h("div", { class: "action-row" }, [
        h("button", {
          class: "btn btn--sm", title: "Smaller text",
          onClick: () => setFreeformTextStyle(page, selectedBox, { fontSize: clampPct((selectedBox.fontSize || 6) - 1, 1, 30) }),
        }, "A−"),
        h("div", { class: "field-hint", style: { minWidth: "40px", textAlign: "center" } }, `${(selectedBox.fontSize || 6).toFixed(0)}`),
        h("button", {
          class: "btn btn--sm", title: "Bigger text",
          onClick: () => setFreeformTextStyle(page, selectedBox, { fontSize: clampPct((selectedBox.fontSize || 6) + 1, 1, 30) }),
        }, "A+"),
      ]);
      wrap.append(field("Font Size", sizeRow));

      // Font family
      const fontSelect = h("select", {}, FONT_FAMILY_OPTIONS.map((opt) =>
        h("option", { value: opt.value, selected: (selectedBox.fontFamily || "") === opt.value }, opt.label)
      ));
      fontSelect.addEventListener("change", () => setFreeformTextStyle(page, selectedBox, { fontFamily: fontSelect.value || undefined }));
      wrap.append(field("Font", fontSelect));

      // Text color
      wrap.append(colorSwatchField(
        "Color",
        selectedBox.color || "#F6F4EE",
        (hex) => { const el = layout.querySelector(`[data-box-id="${selectedBox.id}"] .freeform-box__text`); if (el) el.style.color = hex; },
        (hex) => setFreeformTextStyle(page, selectedBox, { color: hex }),
      ));

      // Alignment — same three states as the floating per-box toolbar,
      // exposed here too since that's exactly what was asked for.
      const alignRow = h("div", { class: "action-row" }, [
        h("button", {
          class: "btn btn--sm" + (selectedBox.align === "left" ? " btn--primary" : ""), title: "Align left",
          onClick: () => setFreeformTextStyle(page, selectedBox, { align: "left" }),
        }, [icon("alignLeft")]),
        h("button", {
          class: "btn btn--sm" + (selectedBox.align !== "left" && selectedBox.align !== "right" ? " btn--primary" : ""), title: "Align center",
          onClick: () => setFreeformTextStyle(page, selectedBox, { align: "center" }),
        }, [icon("alignCenter")]),
        h("button", {
          class: "btn btn--sm" + (selectedBox.align === "right" ? " btn--primary" : ""), title: "Align right",
          onClick: () => setFreeformTextStyle(page, selectedBox, { align: "right" }),
        }, [icon("alignRight")]),
      ]);
      wrap.append(field("Alignment", alignRow));
    } else {
      wrap.append(h("div", { class: "field-hint" }, "Image box — drag to move, drag the corner handle to resize."));
    }

    wrap.append(h("div", { class: "action-row", style: { marginTop: "8px" } }, [
      h("button", { class: "btn btn--sm", onClick: () => duplicateFreeformBox(page, selectedBox.id) }, [icon("copy"), "Duplicate"]),
      h("button", { class: "btn btn--sm btn--ghost", onClick: () => removeFreeformBox(page, selectedBox.id) }, [icon("trash"), "Delete"]),
    ]));

    return wrap;
  }

  const BACKGROUND_PRESET_GRADIENTS = [
    { label: "Theatre (charcoal → slate)", from: "#14181D", to: "#2A2F36", angle: 135 },
    { label: "Deep blue", from: "#0B1F3A", to: "#1E4C8C", angle: 135 },
    { label: "Warm dusk", from: "#3A1F1B", to: "#8C4A2E", angle: 135 },
    { label: "Forest", from: "#0E2A1E", to: "#2E6B4A", angle: 135 },
  ];

  async function _setPageBackground(page, changes) {
    page.background = { ...(page.background || { type: "default" }), ...changes };
    await persist();
    renderCanvasOnly();
    redrawProperties();
  }
  const setPageBackground = safe(_setPageBackground);

  /** Background controls for the whole slide — solid color, a gradient
   * (a few named presets, since picking two colors and an angle from
   * scratch is a lot to ask for a quick background), or a
   * teacher-uploaded image, applied identically in the editor and
   * Present Mode via applyPageBackground (see autoFit.js's sibling,
   * pageBackground.js). "Default" clears any override and falls back to
   * the app's normal dark theatre background. */
  function renderBackgroundPanel(page) {
    const wrap = h("div", { style: { marginTop: "20px", borderTop: "1px solid var(--color-border)", paddingTop: "14px" } });
    wrap.append(h("div", { class: "field-hint", style: { fontWeight: 700, marginBottom: "6px" } }, "Background"));

    const bgType = page.background?.type || "default";
    const typeSelect = h("select", {}, [
      h("option", { value: "default", selected: bgType === "default" }, "Default (theatre)"),
      h("option", { value: "solid", selected: bgType === "solid" }, "Solid Color"),
      h("option", { value: "gradient", selected: bgType === "gradient" }, "Gradient"),
      h("option", { value: "image", selected: bgType === "image" }, "Image"),
    ]);
    typeSelect.addEventListener("change", () => setPageBackground(page, { type: typeSelect.value }));
    wrap.append(field("Type", typeSelect));

    if (bgType === "solid") {
      wrap.append(colorSwatchField(
        "Color",
        page.background?.color || "#14181D",
        (hex) => { const el = layout.querySelector(page.type === "freeform" ? ".freeform-canvas" : ".editor-canvas"); if (el) applyPageBackground(el, { background: { type: "solid", color: hex } }); },
        (hex) => setPageBackground(page, { color: hex }),
      ));
    }

    if (bgType === "gradient") {
      const presetSelect = h("select", {}, [
        h("option", { value: "" }, "Custom…"),
        ...BACKGROUND_PRESET_GRADIENTS.map((p, i) => h("option", { value: String(i) }, p.label)),
      ]);
      presetSelect.addEventListener("change", () => {
        const preset = BACKGROUND_PRESET_GRADIENTS[Number(presetSelect.value)];
        if (preset) setPageBackground(page, { gradientFrom: preset.from, gradientTo: preset.to, gradientAngle: preset.angle });
      });
      wrap.append(field("Preset", presetSelect));

      const liveGradientPreview = (patch) => {
        const el = layout.querySelector(page.type === "freeform" ? ".freeform-canvas" : ".editor-canvas");
        if (!el) return;
        applyPageBackground(el, { background: {
          type: "gradient",
          gradientFrom: page.background?.gradientFrom || "#14181D",
          gradientTo: page.background?.gradientTo || "#2A2F36",
          gradientAngle: page.background?.gradientAngle ?? 135,
          ...patch,
        } });
      };
      wrap.append(h("div", { class: "action-row" }, [
        colorSwatchField("From", page.background?.gradientFrom || "#14181D",
          (hex) => liveGradientPreview({ gradientFrom: hex }),
          (hex) => setPageBackground(page, { gradientFrom: hex })),
        colorSwatchField("To", page.background?.gradientTo || "#2A2F36",
          (hex) => liveGradientPreview({ gradientTo: hex }),
          (hex) => setPageBackground(page, { gradientTo: hex })),
      ]));
      wrap.append(numberField("Angle (°)", page.background?.gradientAngle ?? 135, (v) => setPageBackground(page, { gradientAngle: v }), { min: 0, max: 360, step: 5 }));
    }

    if (bgType === "image") {
      wrap.append(h("div", { class: "field-hint" }, page.background?.mediaId ? "Custom background image set." : "No background image chosen yet."));
      wrap.append(h("div", { class: "action-row" }, [
        h("button", {
          class: "btn btn--sm",
          onClick: safe(async () => {
            const picked = await mediaService.pickFiles("image");
            if (!picked.length) return;
            await setPageBackground(page, { mediaId: picked[0].id });
          }),
        }, page.background?.mediaId ? "Replace Image" : "Choose Image"),
        page.background?.mediaId ? h("button", {
          class: "btn btn--sm btn--ghost",
          onClick: () => setPageBackground(page, { mediaId: undefined }),
        }, "Remove") : null,
      ]));
      wrap.append(h("div", { class: "field-hint" }, page.background?.fit === "contain" ? "The whole picture is shown on the slide (nothing is cropped). Add text or image boxes on top of it." : "The image is stretched to fill the slide; text keeps a soft shadow so it stays readable over busy backgrounds."));
    }

    if (bgType !== "default") {
      wrap.append(h("button", {
        class: "btn btn--sm btn--ghost", style: { marginTop: "8px" },
        onClick: () => setPageBackground(page, { type: "default", color: undefined, gradientFrom: undefined, gradientTo: undefined, mediaId: undefined }),
      }, "Reset to Default"));
    }

    return wrap;
  }

  /** Renders a scripture page's attached image, if one has been chosen
   * (see renderScriptureImageBlock — manual "Choose Image" picker, the
   * same mechanism page backgrounds use; there is no AI generation here). */
  function renderScriptureIllustration(page) {
    if (page.acceptedImage?.mediaId) {
      return h("div", { class: "editor-canvas__media" }, [
        renderMediaSlide(page.acceptedImage.mediaId, "image", { fit: "contain" }),
      ]);
    }
    return null;
  }

  /** Lets a teacher attach an existing image (from the media library or
   * picked fresh from disk) to a scripture page — same "Choose Image" /
   * "Replace Image" / "Remove" pattern as a page background, reusing
   * MediaLifecycle's transaction-safe accept/clear so a failed save never
   * leaves the lesson pointing at a missing file. */
  function renderScriptureImageBlock(page) {
    const container = h("div", { class: "field" }, [
      h("label", {}, "Image"),
    ]);
    const hasAccepted = !!page.acceptedImage?.mediaId;

    const preview = h("div", { class: "imagegen-preview" });
    if (hasAccepted) {
      preview.appendChild(renderMediaSlide(page.acceptedImage.mediaId, "image", { fit: "cover" }));
    } else {
      preview.textContent = "No image yet";
    }
    container.appendChild(preview);

    const actions = h("div", { class: "action-row", style: { marginTop: "8px" } });
    const chooseBtn = h("button", { class: "btn btn--sm" }, hasAccepted ? "Replace Image" : "Choose Image");
    chooseBtn.addEventListener("click", safe(async () => {
      const picked = await mediaService.pickFiles("image");
      if (!picked.length) return;
      chooseBtn.disabled = true;
      try {
        const outcome = await replaceAcceptedImage({
          page,
          reuseRecord: picked[0], // already imported by pickFiles — no re-import
          generatedAt: null,
          persist: persistOrThrow,
          verifyPersisted: (id) => lessonService.getPersistedMediaIds().has(id),
          mediaService,
        });
        if (outcome.oldMedia.status === "delete-failed") {
          console.warn("[lessonEditor] old image couldn't be deleted (kept as an unused file)", outcome.oldMedia.error);
        }
        toast("Image saved to this lesson.", "success");
      } catch (err) {
        toast(`Couldn't set this image: ${err?.message || err}. The lesson still uses its previous image.`, "danger");
      } finally {
        chooseBtn.disabled = false;
        renderCanvasOnly();
        redrawProperties();
      }
    }));
    actions.appendChild(chooseBtn);

    if (hasAccepted) {
      const removeBtn = h("button", { class: "btn btn--sm btn--danger" }, "Remove");
      removeBtn.addEventListener("click", safe(async () => {
        // Reference cleared and SAVED first; the file is deleted only
        // after that succeeded (and only if nothing else uses it). On a
        // failed save the image stays exactly as it was.
        await clearAcceptedImage({ page, persist: persistOrThrow, mediaService });
        renderCanvasOnly();
        redrawProperties();
      }));
      actions.appendChild(removeBtn);
    }

    container.appendChild(actions);
    return container;
  }

  function renderCanvasOnly() {
    const scroll = layout.querySelector(".editor-canvas-scroll");
    if (!scroll) return;
    clear(scroll);
    const page = lesson.pages.find((p) => p.id === activeId);
    scroll.appendChild(page ? renderCanvasFor(page) : h("div", {}, "Select a page"));
    const thumbTitle = layout.querySelector(`.slide-thumb.is-active .slide-thumb__title`);
    if (thumbTitle && page) thumbTitle.textContent = pageDisplayTitle(page);
    refreshActiveThumbPreview();
    fitActiveCanvas();
  }

  function redrawProperties() {
    const old = layout.querySelector(".editor-pane--properties");
    if (!old) return;
    const fresh = renderPropertiesPane();
    old.replaceWith(fresh);
  }

  redraw();
}

function pageDisplayTitle(page) {
  switch (page.type) {
    case "title": return page.title || "Untitled";
    case "scripture": return page.reference || "Scripture";
    case "quiz": return page.question || "Quiz";
    case "image": case "video": case "pdf": case "presentation": return page.fileName || TYPE_LABEL[page.type];
    case "discussion": return page.prompt ? page.prompt.slice(0, 24) : "Discussion";
    case "conclusion": return "Conclusion";
    case "freeform": return page.title || "Blank Canvas";
    default: return TYPE_LABEL[page.type] || "Page";
  }
}
