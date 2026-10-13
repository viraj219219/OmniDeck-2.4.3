import { h, clear } from "../utils/dom.js";
import { mediaService, MEDIA_KINDS, MediaInUseError } from "../services/MediaService.js";
// Imported for its side effect: loading LessonService registers the reference
// checker MediaService.removeMedia requires before it will delete anything.
import "../services/LessonService.js";
import { toast } from "../components/toast.js";
import { openModal } from "../components/modal.js";
import { icon } from "../utils/icons.js";

export const title = "Media";

const KIND_LABEL = { image: "Images", video: "Videos", presentation: "PowerPoint", pdf: "PDF" };
const KIND_ICON = { image: "image", video: "video", presentation: "presentation", pdf: "layers" };

export async function render(root, { setActions }) {
  let filter = "all";
  const wrap = h("div", { class: "page" });
  root.appendChild(wrap);
  setActions([]);

  async function redraw() {
    clear(wrap);

    let items;
    let loadFailed = false;
    try {
      items = filter === "all" ? await mediaService.listMedia() : await mediaService.listMedia(filter);
    } catch (err) {
      // A storage read failure must never be presented as "no media yet" —
      // that would look like an empty library and invite the teacher to
      // re-add files that may still be safely on disk. Show an explicit
      // error state instead (see storageAdapter.js read-safety contract).
      loadFailed = true;
      items = [];
      toast(err?.message || "Couldn't load your media library.", "danger");
    }

    wrap.appendChild(h("div", { class: "section-heading" }, [
      h("div", {}, [
        h("h2", {}, "Media Library"),
        h("p", {}, "Images, video, PowerPoint files, and PDFs used across your lessons."),
      ]),
      h("div", { class: "action-row" },
        MEDIA_KINDS.map((kind) =>
          h("button", {
            class: "btn btn--sm",
            onClick: async () => {
              let added;
              try {
                added = await mediaService.pickFiles(kind);
              } catch (err) {
                // Covers file-picker failure, permission failure, filesystem
                // write failure, and unsupported/failed import — every
                // rejection from pickFiles surfaces as a toast instead of an
                // unhandled promise rejection. Dialog cancellation is not an
                // error: pickFiles resolves to [] for that case and never
                // reaches this catch.
                toast(err?.message || `Couldn't add that ${KIND_LABEL[kind].toLowerCase().replace(/s$/, "")}.`, "danger");
                return;
              }
              if (added.length) toast(`Added ${added.length} ${KIND_LABEL[kind].toLowerCase()} file${added.length > 1 ? "s" : ""}.`, "success");
              // A file that was stored but couldn't be converted (e.g. LibreOffice
              // or poppler missing) says so plainly instead of looking fine.
              for (const item of added) {
                if (item.conversionError) toast(`"${item.name}" was added, but: ${item.conversionError}`, "danger");
              }
              redraw();
            },
          }, [icon(KIND_ICON[kind] || "plus"), `Add ${kind === "presentation" ? "Presentation" : KIND_LABEL[kind].replace(/s$/, "")}`])
        )
      ),
    ]));

    wrap.appendChild(h("div", { class: "action-row", style: { marginBottom: "16px" } }, [
      h("button", { class: "btn btn--sm" + (filter === "all" ? " btn--primary" : ""), onClick: () => { filter = "all"; redraw(); } }, "All"),
      ...MEDIA_KINDS.map((kind) =>
        h("button", { class: "btn btn--sm" + (filter === kind ? " btn--primary" : ""), onClick: () => { filter = kind; redraw(); } }, KIND_LABEL[kind])
      ),
    ]));

    if (loadFailed) {
      wrap.appendChild(h("div", { class: "empty-state" }, [
        h("h3", {}, "Couldn't load your media library"),
        h("p", {}, "Your files have not been deleted. This looks like a storage read problem — try reopening OmniDeck, and check the app's local data folder if it persists."),
      ]));
      return;
    }

    if (!items.length) {
      wrap.appendChild(h("div", { class: "empty-state" }, [
        h("h3", {}, "No media yet"),
        h("p", {}, "Add images, videos, PowerPoint files, or PDFs to use them in your lessons."),
      ]));
      return;
    }

    wrap.appendChild(h("div", { class: "media-grid" },
      items.map((item) =>
        h("div", { class: "media-tile" }, [
          h("div", { class: "media-tile__thumb" }, [icon(KIND_ICON[item.kind] || "image")]),
          h("div", { class: "media-tile__body" }, [
            h("div", { class: "media-tile__name" }, item.name),
            h("div", { class: "media-tile__meta" }, formatDate(item.addedAt)),
            h("button", {
              class: "btn btn--ghost btn--sm",
              style: { marginTop: "6px" },
              onClick: () => confirmRemove(item, redraw),
            }, [icon("trash"), "Remove"]),
          ]),
        ])
      )
    ));
  }

  await redraw();
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  catch { return ""; }
}

function confirmRemove(item, redraw) {
  // The file is deleted from disk (not just hidden), so ask first — the same
  // way deleting a lesson does. If a lesson still uses it, removeNow() then
  // explains that instead of deleting.
  openModal("Delete File", (close) => h("div", {}, [
    h("p", {}, `Permanently delete "${item.name}" from the media library? This cannot be undone.`),
    h("div", { class: "modal__actions" }, [
      h("button", { class: "btn", onClick: close }, "Cancel"),
      h("button", {
        class: "btn btn--danger",
        onClick: (e) => {
          e.currentTarget.disabled = true; // a double-click must not delete twice
          close();
          removeNow(item, redraw);
        },
      }, [icon("trash"), "Delete"]),
    ]),
  ]));
}

async function removeNow(item, redraw) {
  // Deletion is reference-safe at the MediaService layer: it refuses (with
  // MediaInUseError) if any lesson still uses the file, so there is no
  // "remove anyway" path — a lesson must never be left pointing at a
  // deleted file. Remove it from those lessons first, then delete.
  try {
    await mediaService.removeMedia(item.id);
    redraw();
    return;
  } catch (err) {
    if (!(err instanceof MediaInUseError) || err.code !== "in-use") {
      toast(err?.message || "Couldn't remove this file.", "danger");
      return;
    }
    const lessons = err.lessons || [];
    openModal("This file is in use", (close) => h("div", {}, [
      lessons.length
        ? h("p", {}, `"${item.name}" is used by ${lessons.length} lesson${lessons.length === 1 ? "" : "s"}, so it can't be deleted:`)
        : h("p", {}, `"${item.name}" is still used by the last saved version of a lesson, so it can't be deleted yet.`),
      lessons.length
        ? h("ul", { style: { margin: "8px 0 16px", paddingLeft: "20px" } }, lessons.slice(0, 8).map((l) => h("li", {}, l.title)))
        : null,
      h("p", { class: "field-hint" }, "Remove the image or file from those lesson pages first, then delete it here."),
      h("div", { class: "modal__actions" }, [
        h("button", { class: "btn btn--primary", onClick: close }, "OK"),
      ]),
    ]));
  }
}
