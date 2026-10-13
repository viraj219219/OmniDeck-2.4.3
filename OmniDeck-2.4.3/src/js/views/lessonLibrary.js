import { h } from "../utils/dom.js";
import { lessonService } from "../services/LessonService.js";
import { importFileAsNewLesson } from "../services/ImportService.js";
import { dependencyService } from "../services/DependencyService.js";
import { openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { icon } from "../utils/icons.js";
import { exportLessonFlow, importLessonFlow } from "./lessonTransfer.js";

export const title = "Lesson Library";

export async function render(root, { navigate }) {
  let lessons;
  let loadFailed = false;
  try {
    lessons = await lessonService.listLessons();
  } catch (err) {
    // A storage read failure is NOT the same as "no lessons yet" — showing
    // the normal empty state here would look like the teacher's library
    // was wiped. Show an explicit error state instead and keep the New
    // Lesson action available so the app still isn't a dead end.
    loadFailed = true;
    lessons = [];
    toast(err?.message || "Couldn't load your lesson library.", "danger");
  }

  const wrap = h("div", { class: "page" }, [
    h("div", { class: "section-heading" }, [
      h("div", {}, [
        h("h2", {}, "My Lessons"),
        h("p", {}, loadFailed ? "Couldn't load your lessons" : `${lessons.length} lesson${lessons.length === 1 ? "" : "s"}`),
      ]),
      h("div", { class: "action-row" }, [
        h("button", {
          class: "btn",
          title: "Import an OmniDeck lesson file (.omnilesson) made on another computer",
          onClick: () => importLessonFlow(navigate),
        }, [icon("upload"), "Import Lesson"]),
        h("button", {
          class: "btn btn--primary",
          onClick: () => openNewLessonModal(navigate),
        }, [icon("plus"), "New Lesson"]),
      ]),
    ]),
  ]);

  if (loadFailed) {
    wrap.appendChild(
      h("div", { class: "empty-state" }, [
        h("h3", {}, "Couldn't load your lesson library"),
        h("p", {}, "Your lessons have not been deleted. This looks like a storage read problem — try reopening OmniDeck, and check the app's local data folder if it persists."),
      ])
    );
  } else if (!lessons.length) {
    wrap.appendChild(
      h("div", { class: "empty-state" }, [
        h("h3", {}, "No lessons yet"),
        h("p", {}, "Start with a title, then add scripture, media, and a quiz in the Lesson Editor."),
        h("button", { class: "btn btn--primary", onClick: () => openNewLessonModal(navigate) }, [icon("plus"), "New Lesson"]),
      ])
    );
  } else {
    wrap.appendChild(h("div", { class: "lesson-grid" }, lessons.map((lesson) => renderTile(lesson, navigate))));
  }

  root.appendChild(wrap);
}

function renderTile(lesson, navigate) {
  return h("div", {
    class: "lesson-tile",
    tabindex: "0",
    role: "button",
    onClick: () => navigate("editor", { lessonId: lesson.id }),
    onKeydown: (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate("editor", { lessonId: lesson.id }); }
    },
  }, [
    h("div", { class: "lesson-tile__thumb" }, initials(lesson.title)),
    h("div", { class: "lesson-tile__body" }, [
      h("div", { class: "lesson-tile__title" }, lesson.title),
      h("div", { class: "lesson-tile__meta" }, `${lesson.pages.length} page${lesson.pages.length === 1 ? "" : "s"}`),
    ]),
    h("button", {
      class: "lesson-tile__delete lesson-tile__export",
      title: "Export Lesson (portable file to open on another computer)",
      "aria-label": `Export lesson ${lesson.title}`,
      onClick: (e) => { e.stopPropagation(); exportLessonFlow(lesson); },
    }, [icon("download")]),
    h("button", {
      class: "lesson-tile__delete",
      title: "Delete lesson",
      onClick: (e) => {
        e.stopPropagation();
        confirmDeleteLesson(lesson, navigate);
      },
    }, [icon("trash")]),
  ]);
}

function confirmDeleteLesson(lesson, navigate) {
  openModal("Delete Lesson", (close) => {
    return h("div", {}, [
      h("p", {}, `Delete "${lesson.title}"? This cannot be undone.`),
      h("div", { class: "modal__actions" }, [
        h("button", { class: "btn", onClick: close }, "Cancel"),
        h("button", {
          class: "btn btn--danger",
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true; // a double-click must not delete twice
            try {
              await lessonService.deleteLesson(lesson.id);
            } catch (err) {
              // deleteLesson rolls back on a failed save — tell the teacher
              // (the lesson is still there) instead of failing silently.
              btn.disabled = false;
              toast(err?.message || "Couldn't delete this lesson.", "danger");
              return;
            }
            close();
            toast(`Deleted "${lesson.title}".`, "success");
            navigate("library");
          },
        }, [icon("trash"), "Delete"]),
      ]),
    ]);
  });
}

function initials(title) {
  return title.trim().charAt(0).toUpperCase() || "?";
}

function openNewLessonModal(navigate) {
  openModal("New Lesson", (close) => {
    const input = h("input", { type: "text", placeholder: "e.g. The Battle Between David and Goliath" });
    // Guards against a lesson being created twice from a single intended
    // click — e.g. pressing Enter and then also clicking "Create Lesson"
    // before the first request resolves, or a rapid double-click/double
    // Enter. Without this, two concurrent createLesson() calls can each
    // complete and persist, producing a duplicate lesson.
    let submitting = false;

    const guardTitle = () => {
      const value = input.value.trim();
      if (!value) {
        toast("Give the lesson a title first.", "danger");
        return null;
      }
      return value;
    };

    const withSubmitLock = async (busyLabel, fn) => {
      if (submitting) return;
      submitting = true;
      [createBtn, importPptxBtn, importPdfBtn].forEach((b) => (b.disabled = true));
      input.disabled = true;
      const restoreLabel = createBtn.textContent;
      createBtn.textContent = busyLabel;
      try {
        await fn();
      } catch (err) {
        toast(err?.message || "Couldn't create the lesson.", "danger");
      } finally {
        submitting = false;
        [createBtn, importPptxBtn, importPdfBtn].forEach((b) => (b.disabled = false));
        input.disabled = false;
        createBtn.textContent = restoreLabel;
      }
    };

    const submit = () => withSubmitLock("Creating…", async () => {
      const value = guardTitle();
      if (!value) return;
      const lesson = await lessonService.createLesson(value);
      close();
      navigate("editor", { lessonId: lesson.id });
    });

    // Shared by "Import PowerPoint" and "Import PDF": each converted slide/page
    // becomes its own OmniDeck page, in source order. The importer creates the
    // complete lesson in one transaction; a failed import leaves no half-made
    // lesson or orphaned media. PowerPoint is never embedded as a mini-deck.
    const importAsPage = (kind) => withSubmitLock("Importing…", async () => {
      const value = guardTitle();
      if (!value) return;
      let result;
      try {
        result = await importFileAsNewLesson(value, kind, { dependencies: dependencyService });
      } catch (err) {
        throw new Error(`${err?.message || "Import failed."} No lesson was created.`);
      }
      if (result.cancelled) return; // teacher cancelled the file picker
      close();
      navigate("editor", { lessonId: result.lesson.id });
    });

    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    setTimeout(() => input.focus(), 0);

    const createBtn = h("button", { class: "btn btn--primary", onClick: submit }, "Create Lesson");
    const importPptxBtn = h("button", { class: "btn btn--sm", onClick: () => importAsPage("presentation") }, [icon("presentation"), "Import PowerPoint"]);
    const importPdfBtn = h("button", { class: "btn btn--sm", onClick: () => importAsPage("pdf") }, [icon("folder"), "Import PDF"]);

    return h("div", {}, [
      h("div", { class: "field" }, [
        h("label", {}, "Lesson Title"),
        input,
        h("div", { class: "field-hint" }, "Enter a title above, then either create a blank lesson or start it from an existing file."),
      ]),
      h("div", { class: "action-row", style: { marginTop: "8px" } }, [importPptxBtn, importPdfBtn]),
      h("div", { class: "modal__actions" }, [
        h("button", { class: "btn", onClick: close }, "Cancel"),
        createBtn,
      ]),
    ]);
  });
}
