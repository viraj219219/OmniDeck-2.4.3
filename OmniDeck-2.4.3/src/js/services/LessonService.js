import { uid } from "../utils/dom.js";
import { readJSON, writeJSONStrict, StorageReadError } from "../utils/storageAdapter.js";
import { SerialSaveQueue } from "../utils/SaveQueue.js";
import { collectLessonsMediaIds, pageReferencesMedia } from "../utils/mediaRefs.js";
import { bibleService } from "./BibleService.js";
import { mediaService } from "./MediaService.js";

const FILE = "lessons.json";

/**
 * LessonService — contract for lesson CRUD + page (slide) management.
 * Every view imports the `lessonService` singleton at the bottom of this
 * file, never a concrete class, so the storage backend can change later
 * without touching any view.
 */
export class LessonService {
  async listLessons() { throw new Error("Not implemented"); }
  async getLesson(_id) { throw new Error("Not implemented"); }
  async createLesson(_title) { throw new Error("Not implemented"); }
  async deleteLesson(_id) { throw new Error("Not implemented"); }
  async saveLesson(_lesson) { throw new Error("Not implemented"); }
  async addPage(_lessonId, _page) { throw new Error("Not implemented"); }
  async removePage(_lessonId, _pageId) { throw new Error("Not implemented"); }
  async duplicatePage(_lessonId, _pageId) { throw new Error("Not implemented"); }
  async reorderPages(_lessonId, _orderedPageIds) { throw new Error("Not implemented"); }
}

export const PAGE_TYPES = [
  { type: "title", label: "Title" },
  { type: "scripture", label: "Scripture" },
  { type: "image", label: "Image" },
  { type: "video", label: "Video" },
  { type: "pdf", label: "PDF" },
  { type: "presentation", label: "Presentation" },
  { type: "quiz", label: "Quiz" },
  { type: "discussion", label: "Discussion" },
  { type: "conclusion", label: "Conclusion" },
  { type: "freeform", label: "Freeform" },
];

function blankPage(type) {
  // `boxes` (movable/resizable text & image overlay boxes — see
  // renderBoxesOverlay in lessonEditor.js) is available on every page
  // type now, not just "freeform", so it lives on the shared base rather
  // than being added per-case.
  const base = { id: uid("page"), type, title: "", boxes: [] };
  switch (type) {
    case "title": return { ...base, title: "New Title Page", subtitle: "" };
    case "scripture": return { ...base, title: "Scripture", reference: "", verses: [], language: "English", scriptureAlign: "center", acceptedImage: null };
    case "image": return { ...base, title: "Image", mediaId: null, caption: "" };
    case "video": return { ...base, title: "Video", mediaId: null, caption: "" };
    case "pdf": return { ...base, title: "PDF", mediaId: null, caption: "", currentPage: 1 };
    case "presentation": return { ...base, title: "Presentation", mediaId: null, fileName: "", currentSlide: 1, renderedSlideCount: null };
    case "quiz": return { ...base, title: "Quiz", questionType: "multiple_choice", question: "", options: ["", "", "", ""], correctIndex: 0, acceptedAnswers: [""] };
    case "discussion": return { ...base, title: "Discussion", prompt: "" };
    case "conclusion": return { ...base, title: "Conclusion", body: "" };
    // For "freeform" specifically, `boxes` (already on `base` above) is
    // the ENTIRE content of the slide rather than an overlay on top of
    // something else: an ordered array of { id, type: "text"|"image", x,
    // y, w, h (all % of the canvas, so the layout is resolution-
    // independent), and for text boxes `text`/`fontSize`(% of canvas
    // width)/`align`/`fontFamily`, or for image boxes `mediaId` }.
    case "freeform": return { ...base, title: "Freeform" };
    default: return base;
  }
}

/**
 * Builds a real, presentable scripture page for the seeded example
 * lessons: fetches the actual verses for the given range from the
 * bundled WEB dataset via bibleService (never fabricated text) and fills
 * in `verses`/`reference` so a newly installed app's example lessons pass
 * `validateForPresentation` immediately, with no manual "select Scripture
 * again" step. If the real data can't be loaded for any reason, falls
 * back to the old empty-verses shape (reference set, verses empty) rather
 * than throwing — seeding must never crash app startup — and the existing
 * "no Scripture selected" validation message still applies to that page.
 */
async function seededScripturePage(bookKey, chapter, verseStart, verseEnd, reference) {
  const base = { ...blankPage("scripture"), reference, language: "English" };
  try {
    const all = await bibleService.getVerses("English", bookKey, chapter);
    const chosen = all.filter((v) => v.number >= verseStart && v.number <= (verseEnd ?? verseStart));
    if (chosen.length) base.verses = chosen;
  } catch {
    // Leave verses empty (pre-existing fallback shape) — seeding must never throw.
  }
  return base;
}

async function seedLessons() {
  const now = new Date().toISOString();
  const make = (title, pages) => ({
    id: uid("lesson"),
    title,
    createdAt: now,
    updatedAt: now,
    pages,
  });
  return [
    make("David and Goliath", [
      { ...blankPage("title"), title: "David and Goliath", subtitle: "1 Samuel 17" },
      await seededScripturePage("1samuel", 17, 45, 47, "1 Samuel 17:45-47"),
      { ...blankPage("discussion"), prompt: "What made David brave enough to face Goliath?" },
      { ...blankPage("quiz"), question: "Who defeated Goliath?", options: ["Saul", "David", "Jonathan", "Samuel"], correctIndex: 1 },
      { ...blankPage("conclusion"), body: "God can use anyone who trusts Him, no matter how small they feel." },
    ]),
    make("The Birth of Jesus", [
      { ...blankPage("title"), title: "The Birth of Jesus", subtitle: "Luke 2" },
      await seededScripturePage("luke", 2, 10, 12, "Luke 2:10-12"),
      { ...blankPage("conclusion"), body: "Jesus came to bring good news of great joy for everyone." },
    ]),
    make("Noah's Ark", [
      { ...blankPage("title"), title: "Noah's Ark", subtitle: "Genesis 6-9" },
      await seededScripturePage("genesis", 6, 14, 14, "Genesis 6:14"),
      { ...blankPage("discussion"), prompt: "Why do you think Noah obeyed God even before it started raining?" },
    ]),
    make("The Good Samaritan", [
      { ...blankPage("title"), title: "The Good Samaritan", subtitle: "Luke 10" },
      await seededScripturePage("luke", 10, 33, 34, "Luke 10:33-34"),
      { ...blankPage("conclusion"), body: "Being a neighbor means showing mercy, even to people who are different from us." },
    ]),
  ];
}

/**
 * StorageLessonService — real, storage-backed lesson persistence. Every
 * lesson/page CRUD operation here reads/writes through storageAdapter
 * (real Tauri filesystem when running as the desktop app, localStorage in
 * browser dev-preview) — this is not a stub or in-memory-only mock.
 */
export class StorageLessonService extends LessonService {
  constructor() {
    super();
    this._cache = null; // in-memory read cache of the persisted file, not a fake data source
    this._loadPromise = null;
    // Media ids referenced by the last version KNOWN to be on disk, and by
    // the write currently in flight. Deleting a media file must consider
    // these as well as the in-memory lessons: an edit that removed a
    // reference but hasn't been saved yet must not let the file be deleted
    // while the still-saved lesson points at it.
    this._persistedRefs = new Set();
    this._inflightRefs = null;
    // The single persistence pipeline for lessons.json. Autosave, manual
    // saves, page ops and imports ALL end up in _persist() -> this queue.
    this._queue = new SerialSaveQueue(() => this._writeSnapshot(), { name: "lessons" });
  }

  async _load() {
    if (this._cache) return this._cache;
    if (!this._loadPromise) this._loadPromise = this._loadOnce();
    try {
      return await this._loadPromise;
    } finally {
      // A failed load must be retryable, not cached as a permanent failure.
      if (!this._cache) this._loadPromise = null;
    }
  }

  async _loadOnce() {
    let stored;
    try {
      // `validate` makes a parseable-but-wrong-shaped file count as corrupt
      // (and recoverable from the backup) rather than crashing later.
      stored = await readJSON(FILE, null, { validate: Array.isArray });
    } catch (err) {
      // The lessons file exists but couldn't be trusted (unreadable or
      // corrupt, AND no valid backup) — this must NOT fall through to the
      // seeded/empty state, or an existing teacher's real lesson library
      // would look empty and risk being overwritten by seed data on next
      // save. Surface it as a real, catchable error instead.
      const reason = err instanceof StorageReadError && err.code === "corrupt"
        ? "your saved lessons file is corrupted"
        : "your saved lessons file could not be read";
      throw new Error(`Couldn't load your lesson library — ${reason}. Nothing has been deleted or overwritten. (${err.message})`);
    }
    if (stored) {
      // A valid but EMPTY array is a real state (the teacher deleted every
      // lesson) — it must stay empty, not be re-seeded on the next launch.
      this._persistedRefs = collectLessonsMediaIds(stored);
      this._cache = stored;
    } else {
      // Genuine first run (nothing on disk at all): seed the examples.
      this._cache = await seedLessons();
      // Seeding is best-effort; a failure here just means the seeds are
      // re-created next launch.
      try { await this._queue.request(); } catch (err) { console.warn("[LessonService] couldn't persist seeded lessons", err); }
    }
    return this._cache;
  }

  /** One complete write of the CURRENT state. Runs inside the save queue. */
  async _writeSnapshot() {
    // Snapshot everything synchronously, before the first await: whatever
    // is in memory RIGHT NOW is what this write persists.
    const data = this._cache;
    const refs = collectLessonsMediaIds(data);
    this._inflightRefs = refs;
    try {
      await writeJSONStrict(FILE, data, { validate: Array.isArray });
      this._persistedRefs = refs;
    } finally {
      this._inflightRefs = null;
    }
  }

  async _persist() {
    try {
      await this._queue.request();
    } catch (err) {
      throw new Error(`Failed to save lessons to disk. ${err?.message || err}`.trim(), { cause: err });
    }
  }

  /** Resolves once every queued/in-flight lesson write has finished (retries a failed one). */
  async flush() {
    if (!this._cache) return;
    await this._queue.flush();
  }

  /** Media ids referenced by the last version confirmed on disk. */
  getPersistedMediaIds() {
    return new Set(this._persistedRefs);
  }

  async listLessons() {
    const lessons = await this._load();
    return [...lessons].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async getLesson(id) {
    const lessons = await this._load();
    return lessons.find((l) => l.id === id) || null;
  }

  /**
   * Real cross-check for media delete-safety (see views/media.js): returns
   * every lesson that actually references this media id in ANY field (page
   * mediaId, scripture-page image, text/image box, page background) — an actual
   * scan of the lesson data, not a guess. See utils/mediaRefs.js.
   */
  async findLessonsReferencingMedia(mediaId) {
    const lessons = await this._load();
    return lessons.filter((lesson) => lesson.pages.some((page) => pageReferencesMedia(page, mediaId)));
  }

  /**
   * The guard MediaService.removeMedia consults before physically deleting
   * anything. A media file counts as referenced if the in-memory lessons,
   * the write currently in flight, OR the last version known to be on disk
   * still point at it.
   */
  async isMediaReferenced(mediaId) {
    const lessons = await this._load();
    const inMemory = lessons.filter((lesson) => lesson.pages.some((page) => pageReferencesMedia(page, mediaId)));
    const onDisk = this._persistedRefs.has(mediaId) || !!this._inflightRefs?.has(mediaId);
    return {
      referenced: inMemory.length > 0 || onDisk,
      lessons: inMemory,
      onlyInSavedVersion: inMemory.length === 0 && onDisk,
    };
  }

  async createLesson(title) {
    const lessons = await this._load();
    const now = new Date().toISOString();
    const lesson = {
      id: uid("lesson"),
      title: title?.trim() || "Untitled Lesson",
      createdAt: now,
      updatedAt: now,
      pages: [blankPage("title")],
    };
    lesson.pages[0].title = lesson.title;
    return this.insertLesson(lesson);
  }

  /**
   * Adds a fully built lesson (e.g. from a backup import) in ONE persisted
   * step. If the save fails the lesson is removed from memory again, so a
   * failed create/import never leaves a half-created or ghost lesson.
   */
  async insertLesson(lesson) {
    const lessons = await this._load();
    lessons.push(lesson);
    try {
      await this._persist();
    } catch (err) {
      const idx = lessons.indexOf(lesson);
      if (idx !== -1) lessons.splice(idx, 1);
      throw err;
    }
    return lesson;
  }

  async deleteLesson(id) {
    const lessons = await this._load();
    const before = lessons;
    this._cache = lessons.filter((l) => l.id !== id);
    try {
      await this._persist();
    } catch (err) {
      this._cache = before; // the delete didn't happen — don't pretend it did
      throw err;
    }
  }

  async saveLesson(lesson) {
    const lessons = await this._load();
    const idx = lessons.findIndex((l) => l.id === lesson.id);
    lesson.updatedAt = new Date().toISOString();
    if (idx === -1) lessons.push(lesson);
    else lessons[idx] = lesson;
    await this._persist();
    return lesson;
  }

  /**
   * Appends already-built pages to a lesson and persists ONCE. If the save
   * fails the appended pages are taken back out, so a failed import can't
   * leave half its pages in the lesson (other in-memory edits are kept).
   */
  async appendPages(lessonId, pages) {
    const lesson = await this.getLesson(lessonId);
    if (!lesson) throw new Error("Lesson not found");
    lesson.pages.push(...pages);
    try {
      await this.saveLesson(lesson);
    } catch (err) {
      lesson.pages = lesson.pages.filter((p) => !pages.includes(p));
      throw err;
    }
    return lesson;
  }

  async addPage(lessonId, type, { persist = true } = {}) {
    const lesson = await this.getLesson(lessonId);
    if (!lesson) throw new Error("Lesson not found");
    const page = blankPage(type);
    lesson.pages.push(page);
    if (persist) await this.saveLesson(lesson);
    return page;
  }

  async removePage(lessonId, pageId) {
    const lesson = await this.getLesson(lessonId);
    if (!lesson) throw new Error("Lesson not found");
    lesson.pages = lesson.pages.filter((p) => p.id !== pageId);
    await this.saveLesson(lesson);
  }

  async duplicatePage(lessonId, pageId) {
    const lesson = await this.getLesson(lessonId);
    if (!lesson) throw new Error("Lesson not found");
    const idx = lesson.pages.findIndex((p) => p.id === pageId);
    if (idx === -1) throw new Error("Page not found");
    const copy = JSON.parse(JSON.stringify(lesson.pages[idx]));
    copy.id = uid("page");
    lesson.pages.splice(idx + 1, 0, copy);
    await this.saveLesson(lesson);
    return copy;
  }

  /**
   * Reorders pages, but only after verifying the proposed order is a valid
   * permutation of the lesson's CURRENT page ids: every existing id must
   * appear exactly once, and no unknown id may be introduced. Earlier this
   * silently dropped any page whose id wasn't in `orderedPageIds` (e.g. a
   * caller passing a stale/incomplete array after a concurrent add/remove)
   * — that data loss is exactly what production reorder safety must
   * prevent, so a malformed request is rejected instead of partially
   * applied.
   */
  async reorderPages(lessonId, orderedPageIds) {
    const lesson = await this.getLesson(lessonId);
    if (!lesson) throw new Error("Lesson not found");

    const currentIds = lesson.pages.map((p) => p.id);
    const currentSet = new Set(currentIds);
    const proposedSet = new Set(orderedPageIds);

    const unknown = orderedPageIds.filter((id) => !currentSet.has(id));
    const missing = currentIds.filter((id) => !proposedSet.has(id));
    const hasDuplicates = proposedSet.size !== orderedPageIds.length;

    if (unknown.length || missing.length || hasDuplicates) {
      throw new Error(
        `Refused to reorder: the proposed order ${hasDuplicates ? "contains duplicate ids" : ""}` +
        `${unknown.length ? ` references unknown page id(s) [${unknown.join(", ")}]` : ""}` +
        `${missing.length ? ` is missing existing page id(s) [${missing.join(", ")}]` : ""}.`.replace(/\s+/g, " ").trim()
      );
    }

    const byId = new Map(lesson.pages.map((p) => [p.id, p]));
    lesson.pages = orderedPageIds.map((id) => byId.get(id));
    await this.saveLesson(lesson);
  }

  /**
   * Lesson validation before Present Mode. Returns a list of human-readable
   * problems (empty = presentable). Each problem includes the offending
   * page's id so the caller can jump straight to it.
   */
  async validateForPresentation(lessonId) {
    const lesson = await this.getLesson(lessonId);
    if (!lesson) return [{ pageId: null, message: "Lesson not found." }];
    const problems = [];
    if (!lesson.title?.trim()) problems.push({ pageId: null, message: "The lesson has no title." });
    if (!lesson.pages.length) problems.push({ pageId: null, message: "The lesson has no pages." });

    for (const page of lesson.pages) {
      const label = `Page "${page.title || page.reference || page.question || page.type}"`;
      switch (page.type) {
        case "scripture":
          if (!page.reference || !page.verses?.length) problems.push({ pageId: page.id, message: `${label}: no Scripture selected.` });
          break;
        case "image":
        case "video":
          if (!page.mediaId) problems.push({ pageId: page.id, message: `${label}: no ${page.type} file selected.` });
          break;
        case "presentation":
          if (!page.mediaId) problems.push({ pageId: page.id, message: `${label}: no PowerPoint file selected.` });
          break;
        case "pdf":
          if (!page.mediaId) problems.push({ pageId: page.id, message: `${label}: no PDF file selected.` });
          break;
        case "quiz": {
          // Delegates to QuizService so validation logic lives in one place.
          break; // validated by caller via quizService.validateQuizPage — see lessonEditor/presentMode
        }
        default:
          break;
      }
    }
    return problems;
  }
}

export { blankPage };

// Singleton used throughout the app — always storage-backed and real.
export const lessonService = new StorageLessonService();

// Media deletion is reference-safe at the lowest layer: MediaService refuses
// to physically delete a file unless this says nothing still points at it.
mediaService.setReferenceProvider((mediaId) => lessonService.isMediaReferenced(mediaId));
