import { h, clear } from "../utils/dom.js";
import { bibleService } from "../services/BibleService.js";
import { openModal } from "./modal.js";
import { formatReference } from "../utils/scriptureFormat.js";

/**
 * Opens a modal for choosing Testament → Book → Chapter → Verse(s) and
 * invokes `onAdd({ reference, verses, language, bookName, chapter })` when
 * the teacher clicks "Add to Lesson". `bookName`/`chapter` (alongside the
 * already-combined `reference` string) let the caller re-derive a correct
 * per-chunk reference if it paginates a long passage across multiple
 * slides (see lessonEditor.js's openScripturePicker). Shared by the
 * Lesson Editor's "+ Add Scripture" and "Change Passage" actions.
 */
export function openScripturePickerModal(onAdd) {
  let language = "English";
  let languages = [];
  let books = [];
  let activeBookKey = null;
  let activeChapter = null;
  let verses = [];
  let selected = new Set();

  openModal("Add Scripture", (close) => {
    const root = h("div", { style: { width: "560px", maxWidth: "80vw" } });
    draw(root, close);
    loadLanguages(root, close);
    return root;
  });

  async function loadLanguages(root, close) {
    languages = await bibleService.getLanguages();
    language = languages.find((l) => l.available)?.name || language;
    await loadBooks(root, close);
  }

  async function loadBooks(root, close) {
    books = await bibleService.getBooks(language);
    draw(root, close);
  }

  function draw(root, close) {
    // The verse list is its own scroll container and is re-created on every
    // redraw; remember where it was so tapping verse 100 of a long chapter
    // doesn't jump back to verse 1.
    const prevVerseScroller = root.querySelector('[data-scroll="verses"]');
    const keepVerseScroll = prevVerseScroller ? prevVerseScroller.scrollTop : 0;
    clear(root);

    const langSwitch = h("div", { class: "action-row", style: { marginBottom: "12px" } },
      languages.length
        ? languages.map((l) =>
            h("button", {
              class: "btn btn--sm" + (language === l.name ? " btn--primary" : ""),
              disabled: !l.available,
              onClick: async () => { language = l.name; activeBookKey = null; activeChapter = null; selected = new Set(); await loadBooks(root, close); },
            }, l.name)
          )
        : [h("button", { class: "btn btn--sm btn--primary" }, language)]
    );
    root.appendChild(langSwitch);

    if (!books.length) {
      root.appendChild(h("div", { class: "empty-state" }, [
        h("h3", {}, `${language} isn't available yet`),
        h("p", {}, "No licensed translation is available for this language yet."),
      ]));
      return;
    }

    if (!activeBookKey) {
      const grouped = { OT: books.filter((b) => b.testament === "OT"), NT: books.filter((b) => b.testament === "NT") };
      root.appendChild(h("div", { style: { maxHeight: "360px", overflowY: "auto" } }, [
        renderBookGroup("Old Testament", grouped.OT, root, close),
        renderBookGroup("New Testament", grouped.NT, root, close),
      ]));
      return;
    }

    if (!activeChapter) {
      const book = books.find((b) => b.key === activeBookKey);
      root.appendChild(h("div", {}, [
        backRow(() => { activeBookKey = null; draw(root, close); }, book.name),
        h("div", {
          style: { display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: "6px", maxHeight: "320px", overflowY: "auto" },
        }, Array.from({ length: book.chapters }, (_, i) => i + 1).map((n) =>
          h("button", { class: "btn btn--sm", onClick: async () => { activeChapter = n; await loadVerses(root, close); } }, String(n))
        )),
      ]));
      return;
    }

    const book = books.find((b) => b.key === activeBookKey);
    root.appendChild(h("div", {}, [
      backRow(() => { activeChapter = null; selected = new Set(); draw(root, close); }, `${book.name} ${activeChapter}`),
      h("div", { "data-scroll": "verses", style: { maxHeight: "320px", overflowY: "auto", marginBottom: "12px" } },
        verses.map((v) =>
          h("span", {
            class: "verse" + (selected.has(v.number) ? " is-selected" : ""),
            onClick: () => { toggleVerse(v.number); draw(root, close); },
          }, [h("span", { class: "verse__num" }, String(v.number)), v.text + " "])
        )
      ),
      h("div", { class: "selection-bar" }, [
        h("div", {}, selected.size
          ? h("span", { class: "badge" }, referenceLabel(book.name))
          : h("span", { class: "field-hint" }, "Tap verses to select them")),
        h("div", { style: { display: "flex", gap: "8px" } }, [
          h("button", {
            class: "btn btn--ghost btn--sm",
            disabled: selected.size === 0,
            onClick: () => {
              selected = new Set();
              draw(root, close);
            },
          }, "Clear Selection"),
          h("button", {
            class: "btn btn--primary btn--sm",
            disabled: selected.size === 0,
            onClick: () => {
              const ordered = [...selected].sort((a, b) => a - b);
              const chosen = verses.filter((v) => ordered.includes(v.number));
              onAdd({ reference: referenceLabel(book.name), verses: chosen, language, bookName: book.name, chapter: activeChapter });
              close();
            },
          }, "Add to Lesson"),
        ]),
      ]),
    ]));
    const verseScroller = root.querySelector('[data-scroll="verses"]');
    if (verseScroller) verseScroller.scrollTop = keepVerseScroll;
  }

  function toggleVerse(num) {
    if (selected.has(num)) selected.delete(num);
    else selected.add(num);
  }

  function referenceLabel(bookName) {
    return formatReference(bookName, activeChapter, selected);
  }

  async function loadVerses(root, close) {
    verses = await bibleService.getVerses(language, activeBookKey, activeChapter);
    draw(root, close);
  }

  function renderBookGroup(label, list, root, close) {
    return h("div", { class: "bible-nav__group" }, [
      h("div", { class: "bible-nav__group-title" }, label),
      ...list.map((b) =>
        h("button", {
          class: "bible-book-btn",
          style: { display: "block", padding: "4px 0" },
          onClick: () => { activeBookKey = b.key; draw(root, close); },
        }, b.name)
      ),
    ]);
  }

  function backRow(onClick, label) {
    return h("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" } }, [
      h("button", { class: "btn btn--ghost btn--sm", onClick }, "← Back"),
      h("strong", {}, label),
    ]);
  }
}
