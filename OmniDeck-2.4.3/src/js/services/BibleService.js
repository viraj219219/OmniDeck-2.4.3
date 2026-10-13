import { BOOK_ORDER, findBookMeta } from "../data/books.js";
import { readJSON } from "../utils/storageAdapter.js";

/**
 * BibleService — the contract every view/component codes against.
 *
 * BibleService itself never runs in production: it exists purely so the
 * abstract shape is documented in one place and so `RealBibleService`
 * (below) can be unit-tested against it. The runtime singleton exported at
 * the bottom of this file is always a `RealBibleService` instance.
 *
 *   getLanguages()                          -> [{ code, name, available, reason? }]
 *   getBooks(language)                      -> [{ key, name, testament, chapters }]
 *   getChapters(language, bookKey)          -> [chapterNumber, ...]
 *   getVerses(language, bookKey, chapter)   -> [{ number, text }]
 *   search(language, query)                 -> [{ bookKey, book, chapter, verse, text }]
 *
 * `language` is a display string (not an ISO code), e.g. "English" or
 * whatever name a teacher's imported translation used — kept as a string
 * because that's what the existing UI and saved lesson pages already
 * store; RealBibleService maps it internally to the right provider.
 * Only languages with a real dataset registered ever appear from
 * getLanguages() — see RealBibleService's constructor/registerCustomProvider.
 */
export class BibleService {
  async getLanguages() { throw new Error("BibleService is abstract — use RealBibleService"); }
  async getBooks(_language) { throw new Error("BibleService is abstract — use RealBibleService"); }
  async getChapters(_language, _bookKey) { throw new Error("BibleService is abstract — use RealBibleService"); }
  async getVerses(_language, _bookKey, _chapter) { throw new Error("BibleService is abstract — use RealBibleService"); }
  async search(_language, _query) { throw new Error("BibleService is abstract — use RealBibleService"); }
}

/**
 * BibleProvider — one real translation's data source. A provider owns
 * loading its own dataset and answering book/chapter/verse/search queries
 * for that one translation. RealBibleService below just routes a language
 * to the right provider; it has no knowledge of JSON vs. SQLite vs. a
 * remote API, so a future licensed Telugu provider (backed by anything)
 * can be dropped in without touching the UI.
 */
class BibleProvider {
  constructor({ code, name, translationName, attribution, available, unavailableReason }) {
    this.code = code;
    this.name = name;
    this.translationName = translationName;
    this.attribution = attribution;
    this.available = available;
    this.unavailableReason = unavailableReason || null;
  }
  async getBooks() { throw new Error("Not implemented"); }
  async getChapters(_bookKey) { throw new Error("Not implemented"); }
  async getVerses(_bookKey, _chapter) { throw new Error("Not implemented"); }
  async search(_query) { throw new Error("Not implemented"); }
}

/**
 * Real English provider — World English Bible (WEB), public domain.
 * Full source/license documentation: ../data/LICENSE-BIBLE.md
 *
 * Loads the bundled dataset once (lazily, on first use) and serves every
 * query from memory — fully offline, no API key, no network request.
 */
class EnglishWebProvider extends BibleProvider {
  constructor() {
    super({
      code: "en-web",
      name: "English",
      translationName: "World English Bible (WEB)",
      attribution: "World English Bible (WEB) — public domain. Source: ebible.org/web/",
      available: true,
    });
    this._loadPromise = null;
  }

  async _load() {
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        const dataUrl = new URL("../data/bible-en-web.json", import.meta.url);
        const metaUrl = new URL("../data/bible-en-web.meta.json", import.meta.url);
        const [dataRes, metaRes] = await Promise.all([fetch(dataUrl), fetch(metaUrl)]);
        if (!dataRes.ok || !metaRes.ok) {
          throw new Error(`Failed to load bundled WEB Bible dataset (data: ${dataRes.status}, meta: ${metaRes.status})`);
        }
        const [verses, meta] = await Promise.all([dataRes.json(), metaRes.json()]);
        return { verses, meta };
      })().catch((err) => {
        this._loadPromise = null; // a failed load must be retryable, not cached forever
        throw err;
      });
    }
    return this._loadPromise;
  }

  async getBooks() {
    const { meta } = await this._load();
    return BOOK_ORDER.map((b) => ({
      key: b.key,
      name: b.en,
      testament: b.testament,
      chapters: meta[b.key]?.chapterCount ?? 0,
    }));
  }

  async getChapters(bookKey) {
    const { meta } = await this._load();
    const count = meta[bookKey]?.chapterCount ?? 0;
    return Array.from({ length: count }, (_, i) => i + 1);
  }

  async getVerses(bookKey, chapter) {
    const { verses, meta } = await this._load();
    const bookMeta = findBookMeta(bookKey);
    const chapterData = verses[bookKey]?.[String(chapter)];
    if (!bookMeta || !chapterData) return [];
    const verseCount = meta[bookKey]?.verseCounts?.[String(chapter)] ?? Object.keys(chapterData).length;
    return Array.from({ length: verseCount }, (_, i) => {
      const num = i + 1;
      return { number: num, text: chapterData[String(num)] || "" };
    });
  }

  async search(query) {
    const q = (query || "").trim();
    if (!q) return [];

    // 1) Reference-style query: "John 3:16", "1 Samuel 17:45", "Genesis 1"
    const refMatch = parseReference(q, await this.getBooks());
    if (refMatch) {
      const verseList = await this.getVerses(refMatch.bookKey, refMatch.chapter);
      const verse = refMatch.verse ? verseList.find((v) => v.number === refMatch.verse) : verseList[0];
      if (verse) {
        return [{
          bookKey: refMatch.bookKey,
          book: refMatch.bookName,
          chapter: refMatch.chapter,
          verse: verse.number,
          text: verse.text,
        }];
      }
    }

    // 2) Free-text search across real verse content (case-insensitive substring).
    const { verses } = await this._load();
    const needle = q.toLowerCase();
    const results = [];
    outer:
    for (const book of BOOK_ORDER) {
      const chapters = verses[book.key];
      if (!chapters) continue;
      for (const chKey of Object.keys(chapters)) {
        for (const vKey of Object.keys(chapters[chKey])) {
          const text = chapters[chKey][vKey];
          if (text.toLowerCase().includes(needle)) {
            results.push({ bookKey: book.key, book: book.en, chapter: Number(chKey), verse: Number(vKey), text });
            if (results.length >= 50) break outer;
          }
        }
      }
    }
    // Keep results in canonical Bible order (book order, then chapter, then verse)
    // rather than the arbitrary object-key iteration order.
    const bookIndex = Object.fromEntries(BOOK_ORDER.map((b, i) => [b.key, i]));
    results.sort((a, b) => (bookIndex[a.bookKey] - bookIndex[b.bookKey]) || (a.chapter - b.chapter) || (a.verse - b.verse));
    return results;
  }
}

function parseReference(query, books) {
  // Matches "Book Chapter", "Book Chapter:Verse", "Book Chapter:Verse-Verse2"
  // where Book may include a leading number (1 Samuel, 2 Corinthians, ...).
  const m = query.match(/^\s*((?:[1-3]\s?)?[A-Za-z][A-Za-z .]*?)\s+(\d+)(?::(\d+)(?:-\d+)?)?\s*$/);
  if (!m) return null;
  const [, rawBook, chapterStr, verseStr] = m;
  const norm = rawBook.trim().toLowerCase().replace(/\s+/g, "");
  const book = books.find((b) => b.name.toLowerCase().replace(/\s+/g, "") === norm)
    || books.find((b) => b.name.toLowerCase().replace(/\s+/g, "").startsWith(norm));
  if (!book) return null;
  return {
    bookKey: book.key,
    bookName: book.name,
    chapter: Number(chapterStr),
    verse: verseStr ? Number(verseStr) : null,
  };
}

/**
 * ImportedBibleProvider — serves a teacher-supplied translation (see
 * BibleImportService.js) from an already-loaded, already-validated
 * in-memory dataset. No lazy fetch needed (unlike EnglishWebProvider):
 * the data was read from local storage before this provider is
 * constructed. `attribution` here is exactly what the teacher's import
 * file said (or a generated "please confirm you have the rights" notice
 * if it said nothing) — this app cannot verify licensing on their behalf.
 */
class ImportedBibleProvider extends BibleProvider {
  constructor(slug, language, { translationName, attribution, bookNames, verses, meta }) {
    super({ code: `custom-${slug}`, name: language, translationName, attribution, available: true });
    this.slug = slug;
    this.bookNames = bookNames || {};
    this.verses = verses || {};
    this.meta = meta || {};
  }

  async getBooks() {
    return BOOK_ORDER
      .filter((b) => this.meta[b.key])
      .map((b) => ({ key: b.key, name: this.bookNames[b.key] || b.en, testament: b.testament, chapters: this.meta[b.key].chapterCount }));
  }

  async getChapters(bookKey) {
    const chapters = this.verses[bookKey];
    if (!chapters) return [];
    return Object.keys(chapters).map(Number).sort((a, b) => a - b);
  }

  async getVerses(bookKey, chapter) {
    const chapterData = this.verses[bookKey]?.[String(chapter)];
    if (!chapterData) return [];
    return Object.keys(chapterData).map(Number).sort((a, b) => a - b)
      .map((num) => ({ number: num, text: chapterData[String(num)] || "" }));
  }

  async search(query) {
    const q = (query || "").trim();
    if (!q) return [];

    const refMatch = parseReference(q, await this.getBooks());
    if (refMatch) {
      const verseList = await this.getVerses(refMatch.bookKey, refMatch.chapter);
      const verse = refMatch.verse ? verseList.find((v) => v.number === refMatch.verse) : verseList[0];
      if (verse) {
        return [{ bookKey: refMatch.bookKey, book: refMatch.bookName, chapter: refMatch.chapter, verse: verse.number, text: verse.text }];
      }
    }

    const needle = q.toLowerCase();
    const results = [];
    outer:
    for (const book of BOOK_ORDER) {
      const chapters = this.verses[book.key];
      if (!chapters) continue;
      for (const chKey of Object.keys(chapters)) {
        for (const vKey of Object.keys(chapters[chKey])) {
          const text = chapters[chKey][vKey];
          if (text.toLowerCase().includes(needle)) {
            results.push({ bookKey: book.key, book: this.bookNames[book.key] || book.en, chapter: Number(chKey), verse: Number(vKey), text });
            if (results.length >= 50) break outer;
          }
        }
      }
    }
    const bookIndex = Object.fromEntries(BOOK_ORDER.map((b, i) => [b.key, i]));
    results.sort((a, b) => (bookIndex[a.bookKey] - bookIndex[b.bookKey]) || (a.chapter - b.chapter) || (a.verse - b.verse));
    return results;
  }
}

/** Stand-in for a language name that has no registered provider at all
 * (never imported, or just removed) — real "not available" behavior
 * (empty lists, no results) rather than throwing or silently falling
 * back to a different language's content. */
const UNAVAILABLE_PROVIDER = {
  code: "unavailable", name: "", available: false, translationName: null, attribution: null,
  unavailableReason: "This language hasn't been imported yet.",
  async getBooks() { return []; },
  async getChapters() { return []; },
  async getVerses() { return []; },
  async search() { return []; },
};

export class RealBibleService extends BibleService {
  constructor() {
    super();
    // Only languages with a REAL dataset behind them are ever registered —
    // no placeholder/"coming soon" entries for languages nobody has
    // imported. English (bundled WEB) is always available; every other
    // language appears only once a teacher actually imports it via
    // BibleImportService (see registerCustomProvider) — the Bible section
    // and scripture picker both render their language buttons directly
    // from this list, so an un-imported language simply doesn't show up
    // rather than appearing as a permanently-disabled button.
    this.providers = {
      English: new EnglishWebProvider(),
    };
    this._customLoadPromise = null;
  }

  /** Loads any teacher-imported translations (see BibleImportService.js)
   * from local storage, once, lazily — mirrors EnglishWebProvider's own
   * lazy `_load()` pattern. A translation imported earlier in the same
   * running session is already registered via registerCustomProvider and
   * doesn't need this; this covers translations from a previous launch. */
  async _ensureCustomLoaded() {
    if (!this._customLoadPromise) {
      this._customLoadPromise = (async () => {
        let registry;
        try {
          registry = await readJSON("bible-custom-registry.json", []);
        } catch (err) {
          console.warn("[BibleService] couldn't read the custom translation list, skipping", err);
          registry = [];
        }
        for (const entry of registry || []) {
          if (this.providers[entry.language]?.slug === entry.slug) continue; // already registered this session
          try {
            const data = await readJSON(entry.dataFile, null);
            if (data) this.providers[entry.language] = new ImportedBibleProvider(entry.slug, entry.language, data);
          } catch (err) {
            console.warn(`[BibleService] couldn't load imported translation "${entry.language}", skipping it`, err);
          }
        }
      })();
    }
    return this._customLoadPromise;
  }

  /** Makes a just-imported translation selectable immediately, without
   * waiting for the next app launch. Any language name — a brand new one,
   * or the same name as a translation imported earlier — becomes (or
   * replaces) a real, selectable language. */
  registerCustomProvider(slug, language, data) {
    this.providers[language] = new ImportedBibleProvider(slug, language, data);
  }

  /** Reverses registerCustomProvider — the language simply stops being
   * offered (no placeholder is restored in its place), matching the rule
   * that only languages with a real dataset ever appear. */
  unregisterCustomProvider(slug) {
    for (const [lang, provider] of Object.entries(this.providers)) {
      if (provider.slug === slug) delete this.providers[lang];
    }
  }

  /** Never silently substitutes another language's real content for one
   * that hasn't been registered (no such provider yet, or it was just
   * removed) — that would be a confusing, silently-wrong result rather
   * than the honest "not available" state the rest of the app expects.
   * Returns a real, inert "unavailable" stand-in instead. */
  _provider(language) {
    return this.providers[language] || UNAVAILABLE_PROVIDER;
  }

  async getLanguages() {
    await this._ensureCustomLoaded();
    return Object.values(this.providers).map((p) => ({
      code: p.code,
      name: p.name,
      available: p.available,
      translationName: p.translationName,
      attribution: p.attribution,
      reason: p.unavailableReason,
    }));
  }

  async isLanguageAvailable(language) {
    await this._ensureCustomLoaded();
    return !!this._provider(language)?.available;
  }

  async getBooks(language) {
    await this._ensureCustomLoaded();
    return this._provider(language).getBooks();
  }

  async getChapters(language, bookKey) {
    await this._ensureCustomLoaded();
    return this._provider(language).getChapters(bookKey);
  }

  async getVerses(language, bookKey, chapter) {
    await this._ensureCustomLoaded();
    return this._provider(language).getVerses(bookKey, chapter);
  }

  async search(language, query) {
    await this._ensureCustomLoaded();
    return this._provider(language).search(query);
  }
}

// Singleton used throughout the app.
export const bibleService = new RealBibleService();
