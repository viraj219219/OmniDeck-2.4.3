import { h } from "../utils/dom.js";
import { lessonService } from "../services/LessonService.js";
import { icon } from "../utils/icons.js";
import { toast } from "../components/toast.js";

export const title = "Home";

export async function render(root, { navigate }) {
  let lessons = [];
  let loadError = null;
  try {
    lessons = await lessonService.listLessons();
  } catch (err) {
    // Home is the first screen at launch. A library that can't be read must
    // say so — not render blank, and not pretend the teacher has no lessons.
    loadError = err;
    toast(err?.message || "Couldn't load your lesson library.", "danger");
  }
  const recent = lessons.slice(0, 4);

  root.appendChild(
    h("div", { class: "page" }, [
      h("div", { class: "home-hero" }, [
        h("h2", {}, "Welcome back"),
        h("p", {}, "Build a lesson, pull in scripture, and step straight into Present Mode when your class is ready — everything here works offline."),
        h("div", { class: "action-row", style: { marginTop: "16px" } }, [
          h("button", { class: "btn btn--primary", onClick: () => navigate("library") }, [icon("plus"), "New Lesson"]),
          h("button", { class: "btn", onClick: () => navigate("bible") }, [icon("bible"), "Open Bible"]),
        ]),
      ]),

      h("div", { class: "section-heading" }, [
        h("div", {}, [
          h("h2", {}, "Continue a lesson"),
          h("p", {}, loadError ? "Couldn't load your lessons" : recent.length ? "Your most recently updated lessons" : "No lessons yet"),
        ]),
        h("button", { class: "btn btn--ghost", onClick: () => navigate("library") }, "View all"),
      ]),

      recent.length
        ? h("div", { class: "home-grid" }, recent.map((lesson) =>
            h("button", {
              class: "home-tile",
              onClick: () => navigate("editor", { lessonId: lesson.id }),
            }, [
              h("h3", {}, lesson.title),
              h("p", {}, `${lesson.pages.length} page${lesson.pages.length === 1 ? "" : "s"} · updated ${formatDate(lesson.updatedAt)}`),
            ])
          ))
        : loadError
        ? h("div", { class: "empty-state" }, [
            h("h3", {}, "Couldn't load your lesson library"),
            h("p", {}, "Your lessons have not been deleted. This looks like a storage read problem — try reopening OmniDeck, and check the app's local data folder if it persists."),
          ])
        : h("div", { class: "empty-state" }, [
            h("h3", {}, "Create your first lesson"),
            h("p", {}, "Lessons live in the Lesson Library. Add scripture, images, video, and a quiz, then present it in class."),
            h("button", { class: "btn btn--primary", onClick: () => navigate("library") }, [icon("plus"), "New Lesson"]),
          ]),
    ])
  );
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
