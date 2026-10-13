import { h, clear } from "../utils/dom.js";
import { bibleService } from "../services/BibleService.js";
import { lessonService } from "../services/LessonService.js";
import { openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";
import { icon } from "../utils/icons.js";

export const title = "Bible";

export async function render(root, { navigate, setActions }) {
  let languages = await bibleService.getLanguages();
  let language = languages.find((l) => l.available)?.name || "English";
  let books = [];
  let activeBookKey = null;
  let activeChapter = 1;
  let verses = [];
  let selected = new Set();
  let searchQuery = "";
  let searchResults = null; // null = not searching, [] = no results

  const layout = h("div", { class: "bible-layout" });
  root.appendChild(layout);
  setActions([]);

  await loadBooks();
  drawAll();

  async function switchLanguage(lang) {
    language = lang;
    searchQuery = "";
    searchResults = null;
    await loadBooks();
    drawAll({ resetNav: true, resetReader: true });
  }

  async function loadBooks() {
    books = await bibleService.getBooks(language);
    activeBookKey = books[0]?.key || null;
    activeChapter = 1;
    selected = new Set();
    await loadVerses();
  }

  async function chooseBook(key) {
    activeBookKey = key;
    activeChapter = 1;
    selected = new Set();
    await loadVerses();
    drawAll({ resetReader: true });
  }

  async function chooseChapter(n) {
    activeChapter = n;
    selected = new Set();
    await loadVerses();
    drawAll({ resetReader: true });
  }

  async function loadVerses() {
    verses = activeBookKey ? await bibleService.getVerses(language, activeBookKey, activeChapter) : [];
  }

  async function runSearch(q) {
    searchQuery = q;
    if (!q.trim()) {
      searchResults = null;
      drawAll();
      return;
    }
    const results = await bibleService.search(language, q);
    if (q !== searchQuery) return; // the teacher kept typing: a newer search owns the screen
    searchResults = results;
    drawAll();
  }

  async function selectSearchResult(result) {
    searchQuery = "";
    searchResults = null;
    activeBookKey = result.bookKey;
    activeChapter = result.chapter;
    selected = new Set([result.verse]);
    await loadVerses();
    drawAll({ resetNav: true, resetReader: true });
  }

  /**
   * Rebuilds the whole layout, but keeps what the teacher was doing: the
   * scroll position of the book list and of the reader (both are their own
   * scroll containers that get re-created), and focus + caret in the search
   * box — without this, typing in search dropped focus after every letter and
   * tapping a verse in a long chapter jumped back to verse 1.
   * `resetNav`/`resetReader` start that pane at the top (new chapter, etc.).
   */
  function drawAll({ resetNav = false, resetReader = false } = {}) {
    const oldNav = layout.querySelector(".bible-nav");
    const oldReader = layout.querySelector(".bible-reader");
    const navTop = resetNav ? 0 : oldNav?.scrollTop ?? 0;
    const readerTop = resetReader ? 0 : oldReader?.scrollTop ?? 0;
    const oldSearch = layout.querySelector(".bible-search-input");
    const searchHadFocus = !!oldSearch && document.activeElement === oldSearch;
    const caretStart = searchHadFocus ? oldSearch.selectionStart : null;
    const caretEnd = searchHadFocus ? oldSearch.selectionEnd : null;

    clear(layout);
    const nav = renderNav();
    const reader = renderReader();
    layout.appendChild(nav);
    layout.appendChild(reader);

    nav.scrollTop = navTop;
    reader.scrollTop = readerTop;
    if (searchHadFocus) {
      const fresh = layout.querySelector(".bible-search-input");
      if (fresh) {
        fresh.focus();
        try { fresh.setSelectionRange(caretStart, caretEnd); } catch { /* not supported for this input type */ }
      }
    }
  }

  function renderNav() {
    const grouped = { OT: books.filter((b) => b.testament === "OT"), NT: books.filter((b) => b.testament === "NT") };
    const nav = h("div", { class: "bible-nav" });

    nav.appendChild(h("div", { class: "action-row", style: { marginBottom: "12px" } },
      languages.map((l) =>
        h("button", {
          class: "btn btn--sm" + (language === l.name ? " btn--primary" : "") + (!l.available ? " btn--disabled" : ""),
          disabled: !l.available,
          title: l.available ? "" : (l.reason || "Coming soon"),
          onClick: () => l.available && switchLanguage(l.name),
        }, l.available ? l.name : `${l.name} (Coming soon)`)
      )
    ));

    if (!languages.find((l) => l.name === language)?.available) {
      nav.appendChild(searchAndNavPlaceholder());
      return nav;
    }

    const searchInput = h("input", {
      type: "text",
      class: "bible-search-input",
      placeholder: "Search Scripture (e.g. John 3:16, or a word/phrase)",
      value: searchQuery,
      style: { marginBottom: "10px" },
    });
    searchInput.addEventListener("input", () => runSearch(searchInput.value));
    nav.appendChild(searchInput);

    if (searchResults !== null) {
      nav.appendChild(renderSearchResults());
      return nav;
    }

    for (const [label, list] of [["Old Testament", grouped.OT], ["New Testament", grouped.NT]]) {
      nav.appendChild(h("div", { class: "bible-nav__group" }, [
        h("div", { class: "bible-nav__group-title" }, label),
        ...list.map((b) =>
          h("button", {
            class: "bible-book-btn" + (b.key === activeBookKey ? " is-active" : ""),
            onClick: () => chooseBook(b.key),
          }, b.name)
        ),
      ]));
    }
    return nav;
  }

  function renderSearchResults() {
    const box = h("div", { class: "bible-nav__group" });
    box.appendChild(h("div", { class: "bible-nav__group-title" }, `${searchResults.length} result${searchResults.length === 1 ? "" : "s"}`));
    if (searchResults.length === 0) {
      box.appendChild(h("div", { class: "field-hint" }, "No verses matched. Try a reference like \"John 3:16\" or a shorter phrase."));
    }
    for (const r of searchResults) {
      box.appendChild(h("button", {
        class: "list-row",
        style: { cursor: "pointer", width: "100%", textAlign: "left" },
        onClick: () => selectSearchResult(r),
      }, [
        h("div", { class: "list-row__main" }, [
          h("div", { class: "list-row__title" }, `${r.book} ${r.chapter}:${r.verse}`),
          h("div", { class: "field-hint" }, r.text.length > 90 ? r.text.slice(0, 90) + "…" : r.text),
        ]),
      ]));
    }
    return box;
  }

  function searchAndNavPlaceholder() {
    const info = languages.find((l) => l.name === language);
    return h("div", { class: "empty-state" }, [
      h("h3", {}, `${language} isn't available yet`),
      h("p", {}, info?.reason || "This translation hasn't been added yet."),
    ]);
  }

  function renderReader() {
    const info = languages.find((l) => l.name === language);
    const reader = h("div", { class: "bible-reader" });

    if (!info?.available) {
      reader.appendChild(h("div", { class: "empty-state" }, [
        h("h3", {}, `${language} Scripture coming soon`),
        h("p", {}, info?.reason || "No licensed translation is available for this language yet."),
      ]));
      return reader;
    }

    const book = books.find((b) => b.key === activeBookKey);
    if (!book) return reader;

    reader.appendChild(h("div", { class: "bible-reader__header" }, [
      h("div", { class: "bible-reader__ref" }, `${book.name} ${activeChapter}`),
      h("div", { class: "chapter-pager" }, [
        h("button", { class: "btn btn--sm", disabled: activeChapter <= 1, onClick: () => chooseChapter(activeChapter - 1) }, [icon("chevronLeft"), "Prev"]),
        h("select", {
          onChange: (e) => chooseChapter(Number(e.target.value)),
        }, Array.from({ length: book.chapters }, (_, i) => i + 1).map((n) =>
          h("option", { value: n, selected: n === activeChapter }, `Chapter ${n}`)
        )),
        h("button", { class: "btn btn--sm", disabled: activeChapter >= book.chapters, onClick: () => chooseChapter(activeChapter + 1) }, ["Next", icon("chevronRight")]),
      ]),
    ]));

    if (!verses.length) {
      reader.appendChild(h("div", { class: "empty-state" }, [
        h("h3", {}, "Loading…"),
      ]));
    } else {
      reader.appendChild(h("div", {},
        verses.map((v) =>
          h("span", {
            class: "verse" + (selected.has(v.number) ? " is-selected" : ""),
            onClick: () => { toggleVerse(v.number); drawAll(); },
          }, [h("span", { class: "verse__num" }, String(v.number)), v.text + " "])
        )
      ));
    }

    reader.appendChild(h("div", { class: "selection-bar" }, [
      h("div", {}, selected.size
        ? h("span", { class: "badge" }, referenceLabel(book.name))
        : h("span", { class: "field-hint" }, "Tap verses, then add them straight into a lesson.")),
      h("button", {
        class: "btn btn--primary btn--sm",
        disabled: selected.size === 0,
        onClick: () => addSelectionToLesson(book.name),
      }, [icon("plus"), "Add to Lesson"]),
    ]));

    reader.appendChild(h("div", { class: "field-hint", style: { marginTop: "10px", opacity: "0.7" } }, info.attribution));

    return reader;
  }

  function toggleVerse(num) {
    if (selected.has(num)) selected.delete(num);
    else selected.add(num);
  }

  function referenceLabel(bookName) {
    const nums = [...selected].sort((a, b) => a - b);
    const isRange = nums.length > 1 && nums[nums.length - 1] - nums[0] === nums.length - 1;
    const versesLabel = isRange ? `${nums[0]}-${nums[nums.length - 1]}` : nums.join(",");
    return `${bookName} ${activeChapter}:${versesLabel}`;
  }

  // A single present-scripture slide comfortably fits about this many
  // characters of verse text before it starts overflowing the stage at
  // the app's largest scripture font size. Splitting on this boundary
  // (and never mid-verse) is how a long passage "continues on the next
  // slide" instead of being crammed/cut off on one.
  const MAX_CHARS_PER_SLIDE = 320;

  /** Groups verses into one or more slides' worth, never splitting a verse
   * across two slides, so a long passage spills onto additional pages. */
  function paginateVerses(chosenVerses) {
    const groups = [];
    let current = [];
    let currentLen = 0;
    for (const v of chosenVerses) {
      const len = v.text.length;
      if (current.length && currentLen + len > MAX_CHARS_PER_SLIDE) {
        groups.push(current);
        current = [];
        currentLen = 0;
      }
      current.push(v);
      currentLen += len;
    }
    if (current.length) groups.push(current);
    return groups;
  }

  function groupReferenceLabel(bookName, group, groupIndex) {
    const nums = group.map((v) => v.number);
    const isRange = nums.length > 1 && nums[nums.length - 1] - nums[0] === nums.length - 1;
    const versesLabel = isRange ? `${nums[0]}-${nums[nums.length - 1]}` : nums.join(",");
    const base = `${bookName} ${activeChapter}:${versesLabel}`;
    return groupIndex === 0 ? base : `${base} (cont.)`;
  }

  async function addSelectionToLesson(bookName) {
    const ordered = [...selected].sort((a, b) => a - b);
    const chosenVerses = verses.filter((v) => ordered.includes(v.number));
    const reference = referenceLabel(bookName);
    const groups = paginateVerses(chosenVerses);
    const lessons = await lessonService.listLessons();

    async function fillPage(page, group, groupIndex) {
      page.reference = groupReferenceLabel(bookName, group, groupIndex);
      page.verses = group;
      page.language = language;
    }

    openModal("Add to Lesson", (close) => {
      const box = h("div", {});
      const pageNote = groups.length > 1
        ? `Adding ${reference} as ${groups.length} scripture pages — it's too long for one slide, so it continues across pages.`
        : `Adding ${reference} as a new scripture page.`;
      box.appendChild(h("p", { class: "field-hint", style: { marginBottom: "12px" } }, pageNote));
      if (lessons.length) {
        box.appendChild(h("div", { class: "field" }, [
          h("label", {}, "Choose a lesson"),
          h("div", {},
            lessons.slice(0, 6).map((lesson) =>
              h("button", {
                class: "list-row",
                style: { cursor: "pointer", width: "100%" },
                onClick: async () => {
                  for (let i = 0; i < groups.length; i++) {
                    const page = await lessonService.addPage(lesson.id, "scripture", { persist: false });
                    await fillPage(page, groups[i], i);
                  }
                  await lessonService.saveLesson(lesson);
                  close();
                  toast(`Added ${reference} to "${lesson.title}"`, "success");
                  navigate("editor", { lessonId: lesson.id });
                },
              }, [
                h("div", { class: "list-row__main" }, [h("div", { class: "list-row__title" }, lesson.title)]),
              ])
            )
          ),
        ]));
      }
      box.appendChild(h("button", {
        class: "btn btn--block",
        onClick: async () => {
          const lesson = await lessonService.createLesson(reference);
          const firstPage = lesson.pages[0];
          firstPage.type = "scripture";
          await fillPage(firstPage, groups[0], 0);
          for (let i = 1; i < groups.length; i++) {
            const page = await lessonService.addPage(lesson.id, "scripture", { persist: false });
            await fillPage(page, groups[i], i);
          }
          await lessonService.saveLesson(lesson);
          close();
          navigate("editor", { lessonId: lesson.id });
        },
      }, [icon("plus"), "Start a New Lesson With This"]));
      return box;
    });
  }
}
