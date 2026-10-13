import { readJSON, writeJSON, writeJSONStrict, deleteJSON } from "../utils/storageAdapter.js";
import { BOOK_ORDER } from "../data/books.js";
import { bibleService } from "./BibleService.js";
import { detectLanguage } from "./BibleLanguageDetectionService.js";

const REGISTRY_FILE = "bible-custom-registry.json";

/**
 * Lets a teacher bring their own Bible translation into the app as a real,
 * offline dataset — for a language with no bundled translation (Telugu is
 * "coming soon" by design, see LICENSE-BIBLE.md), or an alternate
 * translation in a language that already has one. This app has no way to
 * verify licensing on the teacher's behalf; the import flow says so
 * plainly rather than implying any endorsement.
 *
 * Two accepted file shapes — see parseBibleJson/parseBibleXml below for the
 * exact expected structure of each. Both are normalized into the same
 * internal shape every BibleProvider serves from:
 *   { language, translationName, attribution, bookNames, verses, meta }
 * where verses[bookKey][chapter][verse] = text (chapter/verse as numeric
 * strings), matching the shape the bundled English WEB dataset already
 * uses — so ImportedBibleProvider in BibleService.js can serve it with the
 * exact same query logic as the bundled translation.
 *
 * Recognized book keys are the standard 66-book set in ../data/books.js
 * (e.g. "genesis", "1samuel", "songofsolomon", "revelation" — lowercase,
 * no spaces). Unrecognized book keys are skipped rather than failing the
 * whole import, so a partial translation (e.g. New Testament only) still
 * imports whatever real content it does contain.
 *
 * Language is no longer a required field the teacher must add by hand —
 * see BibleLanguageDetectionService.js. This file's job is just to feed
 * that service every field it might use (explicit metadata under several
 * conventional names, translation-name/title text, the filename, and the
 * actual verse text for script analysis) and to keep language detection
 * and Bible-structure validation as separate concerns: a file can fail to
 * validate (not real Bible data) independently of whether its language is
 * known, and a plausible-sounding filename never substitutes for real
 * book/chapter/verse content (see normalizeParsed below).
 */

export class AmbiguousLanguageError extends Error {
  constructor(candidates) {
    super("We couldn't confidently identify this Bible's language. Please select the language.");
    this.name = "AmbiguousLanguageError";
    this.candidates = candidates;
  }
}

function slugify(name) {
  const slug = (name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
  return slug || "custom";
}

/** Pulls every conventional field name that might carry language
 * information out of a parsed JSON object — explicit `language`/`lang`/
 * `locale` at the top level, or nested under `metadata.*`/`translation.*`.
 * The first non-empty value for each kind wins; this does not guess
 * between conflicting fields, it just widens what counts as "the file
 * told us explicitly" beyond a single hardcoded key name. */
function extractLanguageFields(raw) {
  const pick = (...values) => values.find((v) => typeof v === "string" && v.trim()) || "";
  return {
    explicitLanguage: pick(raw.language, raw.metadata?.language, raw.translation?.language),
    explicitCode: pick(raw.lang, raw.languageCode, raw.metadata?.lang, raw.metadata?.languageCode, raw.translation?.lang),
    explicitLocale: pick(raw.locale, raw.metadata?.locale, raw.translation?.locale),
  };
}

/** Normalizes a book identifier — a key like "genesis", a full name like
 * "1 Samuel"/"First Samuel"/"I Samuel", or a 1-66 book number — down to a
 * bare alphanumeric token for matching against BOOK_ORDER. Not used to
 * detect language; only to recognize which of the 66 standard books a
 * given entry is, regardless of how this particular file spells it. */
function normalizeBookToken(raw) {
  let t = String(raw ?? "").trim().toLowerCase();
  if (!t) return "";
  t = t.replace(/^(\d)(?:st|nd|rd|th)\b/, "$1");
  t = t.replace(/^(first|second|third|i{1,3})\b/, (m, g1) => ({ first: "1", second: "2", third: "3", i: "1", ii: "2", iii: "3" }[g1] || g1));
  return t.replace(/[^a-z0-9]+/g, "");
}

const BOOK_KEY_BY_TOKEN = (() => {
  const map = new Map();
  BOOK_ORDER.forEach((b, idx) => {
    map.set(normalizeBookToken(b.key), b.key);
    map.set(normalizeBookToken(b.en), b.key);
    map.set(String(idx + 1), b.key); // plain book number, 1-66
  });
  return map;
})();

/** Resolves any of the book-identifier spellings above to a canonical
 * BOOK_ORDER key, or null if it isn't recognized as one of the 66 books. */
function resolveBookKey(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  return BOOK_KEY_BY_TOKEN.get(normalizeBookToken(raw)) || null;
}

/** Folds a chapter's worth of verses — an array (index+1 = verse number,
 * entries either plain strings or {verse/number, text/content} objects) or
 * an object keyed by verse number — into `target[chNum][vNum] = text`. */
function foldVersesInto(target, bookKey, chNum, versesRaw) {
  if (!versesRaw || !bookKey || !chNum) return;
  const put = (vNum, text) => {
    text = String(text ?? "").trim();
    if (!vNum || !text) return;
    target[bookKey] = target[bookKey] || {};
    target[bookKey][chNum] = target[bookKey][chNum] || {};
    target[bookKey][chNum][String(vNum)] = text;
  };
  if (Array.isArray(versesRaw)) {
    versesRaw.forEach((v, idx) => {
      if (v && typeof v === "object") {
        put(v.verse ?? v.number ?? v.v ?? idx + 1, v.text ?? v.content ?? v.verseText ?? v.Verse ?? v.verse_text ?? "");
      } else {
        put(idx + 1, v);
      }
    });
  } else if (typeof versesRaw === "object") {
    for (const [vKey, text] of Object.entries(versesRaw)) put(vKey, text);
  }
}

/** Folds one book's worth of chapters — an array (index+1 = chapter number;
 * each entry either an array of verses, or an object with verses/chapter
 * number) or an object keyed by chapter number — into `target[bookKey]`. */
function foldChaptersInto(target, bookKey, chaptersRaw) {
  if (!chaptersRaw || !bookKey) return;
  if (Array.isArray(chaptersRaw)) {
    chaptersRaw.forEach((chapter, idx) => {
      if (Array.isArray(chapter)) {
        foldVersesInto(target, bookKey, String(idx + 1), chapter);
      } else if (chapter && typeof chapter === "object") {
        const chNum = String(chapter.chapter ?? chapter.number ?? idx + 1);
        foldVersesInto(target, bookKey, chNum, chapter.verses ?? chapter);
      }
    });
  } else if (typeof chaptersRaw === "object") {
    for (const [chKey, versesRaw] of Object.entries(chaptersRaw)) {
      const unwrapped = (versesRaw && typeof versesRaw === "object" && !Array.isArray(versesRaw) && versesRaw.verses !== undefined)
        ? versesRaw.verses
        : versesRaw;
      foldVersesInto(target, bookKey, chKey, unwrapped);
    }
  }
}

/** Accepts the two most common real-world "books" container shapes:
 *   - keyed by book key/name: { "Genesis": { "1": { "1": "text" } }, ... }
 *     (chapters may also be an array-of-arrays, or the value may itself be
 *     `{ name, chapters }`)
 *   - an array of book objects: [{ name/book/key, chapters/verses: [...] }]
 * Unrecognized book identifiers are skipped, not fatal — a partial
 * translation still imports whatever it does contain. */
function normalizeBooksContainer(booksRaw) {
  const out = {};
  if (!booksRaw) return out;
  if (Array.isArray(booksRaw)) {
    for (const entry of booksRaw) {
      if (!entry || typeof entry !== "object") continue;
      const bookKey = resolveBookKey(entry.key ?? entry.name ?? entry.book ?? entry.book_name ?? entry.abbrev);
      if (!bookKey) continue;
      foldChaptersInto(out, bookKey, entry.chapters ?? entry.verses ?? entry.data);
    }
  } else if (typeof booksRaw === "object") {
    for (const [rawKey, value] of Object.entries(booksRaw)) {
      const bookKey = resolveBookKey(rawKey) || resolveBookKey(value?.name);
      if (!bookKey || !value) continue;
      const chaptersSrc = (value.chapters !== undefined) ? value.chapters : value;
      foldChaptersInto(out, bookKey, chaptersSrc);
    }
  }
  return out;
}

/** Recognizes a flat list of individual verse records — the shape many
 * downloaded Bible datasets actually use, e.g.:
 *   [{ "book": "Genesis", "chapter": 1, "verse": 1, "text": "..." }, ...]
 * with common alternate key spellings (book_name/bookName/b, chapter/c,
 * verse/v, text/verse_text/content), and either a book name or a plain
 * 1-66 book number. */
/**
 * Supports legacy Bible exports shaped like:
 * {
 *   "Book": [
 *     { "Chapter": [
 *       { "Verse": [
 *         { "Verseid": "00000000", "Verse": "..." },
 *         ...
 *       ] },
 *       ...
 *     ] },
 *     ...
 *   ]
 * }
 *
 * These files intentionally omit book/chapter/verse names and rely on
 * canonical Bible order plus array position. Position is the only safe
 * identifier available, so we preserve it exactly: Book[0] = Genesis,
 * Chapter[0] = chapter 1, Verse[0] = verse 1.
 */
function normalizeLegacyBookArray(bookList) {
  const out = {};
  if (!Array.isArray(bookList)) return out;

  for (let bookIndex = 0; bookIndex < bookList.length; bookIndex++) {
    const book = bookList[bookIndex];
    const bookKey = BOOK_ORDER[bookIndex]?.key;
    if (!bookKey || !book || typeof book !== "object") continue;

    const chaptersRaw = book.Chapter ?? book.chapter ?? book.Chapters ?? book.chapters;
    if (!Array.isArray(chaptersRaw)) continue;

    chaptersRaw.forEach((chapter, chapterIndex) => {
      if (!chapter || typeof chapter !== "object") return;
      const versesRaw = chapter.Verse ?? chapter.verse ?? chapter.Verses ?? chapter.verses;
      if (Array.isArray(versesRaw)) {
        // Array position is authoritative because this legacy format has no
        // separate chapter/verse number fields.
        foldVersesInto(out, bookKey, String(chapterIndex + 1), versesRaw);
      } else if (versesRaw && typeof versesRaw === "object") {
        foldVersesInto(out, bookKey, String(chapterIndex + 1), versesRaw);
      }
    });
  }

  return out;
}

function normalizeFlatVerseList(list) {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const bookKey = resolveBookKey(entry.book ?? entry.book_name ?? entry.bookName ?? entry.b);
    const chNum = String(entry.chapter ?? entry.chapter_number ?? entry.c ?? "").trim();
    const vNum = String(entry.verse ?? entry.verse_number ?? entry.v ?? "").trim();
    const text = entry.text ?? entry.verse_text ?? entry.verseText ?? entry.content ?? "";
    if (!bookKey || !chNum || !vNum) continue;
    foldVersesInto(out, bookKey, chNum, { [vNum]: text });
  }
  return out;
}

/** True when an array looks like a flat verse-record list (has scalar
 * chapter/verse fields) rather than an array of whole books (which would
 * have a `chapters`/`verses` sub-collection instead). */
function looksLikeFlatVerseList(arr) {
  const sample = Array.isArray(arr) && arr.find((x) => x && typeof x === "object");
  if (!sample) return false;
  const hasChapter = "chapter" in sample || "chapter_number" in sample || "c" in sample;
  const hasVerse = "verse" in sample || "verse_number" in sample || "v" in sample;
  return hasChapter && hasVerse && !("chapters" in sample);
}

/**
 * Expected JSON shape (the "native" OmniDeck shape — still fully
 * supported):
 * {
 *   "language": "Telugu",                          // optional — see language detection below
 *   "translationName": "Some Licensed Telugu Translation",
 *   "attribution": "Optional credit/license line — shown in the app",
 *   "bookNames": { "genesis": "ఆదికాండము", ... },   // optional, English used as fallback
 *   "books": {
 *     "genesis": { "1": { "1": "In the beginning...", "2": "..." }, "2": { ... } },
 *     ...
 *   }
 * }
 *
 * Several other common real-world shapes are also recognized (see
 * normalizeBooksContainer/normalizeFlatVerseList above): books keyed by
 * full book name instead of the internal key, chapters as an array
 * instead of an object, and a flat top-level list of individual
 * `{book, chapter, verse, text}` verse records (optionally under a
 * `"verses"` key, or as the JSON file's root array).
 */
export function parseBibleJson(jsonText, filename) {
  let raw;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error("This file isn't valid JSON.");
  }
  if (!raw || typeof raw !== "object") throw new Error("This file isn't valid JSON.");

  const rootIsArray = Array.isArray(raw);
  const booksSource = rootIsArray ? raw : (raw.books ?? raw.data ?? raw.bookList);
  const legacyBookSource = !rootIsArray && Array.isArray(raw.Book) ? raw.Book : undefined;
  const flatSource = !rootIsArray && Array.isArray(raw.verses) ? raw.verses : undefined;

  return normalizeParsed({
    ...(rootIsArray ? {} : extractLanguageFields(raw)),
    translationName: rootIsArray ? undefined : raw.translationName,
    title: rootIsArray ? undefined : raw.title,
    description: rootIsArray ? undefined : raw.description,
    attribution: rootIsArray ? undefined : raw.attribution,
    bookNames: rootIsArray ? undefined : raw.bookNames,
    books: booksSource,
    flatVerses: flatSource,
    legacyBooks: legacyBookSource,
    filename,
  });
}

/**
 * Expected XML shape:
 * <bible language="Telugu" translationName="..." attribution="...">
 *   <book key="genesis" name="ఆదికాండము">
 *     <chapter number="1">
 *       <verse number="1">In the beginning...</verse>
 *       <verse number="2">...</verse>
 *     </chapter>
 *   </book>
 * </bible>
 */
export function parseBibleXml(xmlText, filename) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlText, "application/xml");
  } catch {
    throw new Error("This file isn't valid XML.");
  }
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("This file isn't valid XML (parse error).");
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "bible") {
    throw new Error('This XML file needs a <bible> root element (with <book>/<chapter>/<verse> inside).');
  }

  const explicitLanguage = root.getAttribute("language") || "";
  const explicitCode = root.getAttribute("lang") || root.getAttribute("languageCode") || "";
  const explicitLocale = root.getAttribute("locale") || "";
  const translationName = root.getAttribute("translationName");
  const attribution = root.getAttribute("attribution");
  const bookNames = {};
  const books = {};

  for (const bookEl of Array.from(root.children).filter((e) => e.tagName.toLowerCase() === "book")) {
    const key = (bookEl.getAttribute("key") || "").trim().toLowerCase();
    if (!key) continue;
    const name = bookEl.getAttribute("name");
    if (name) bookNames[key] = name;

    const chapters = {};
    for (const chEl of Array.from(bookEl.children).filter((e) => e.tagName.toLowerCase() === "chapter")) {
      const chNum = chEl.getAttribute("number");
      if (!chNum) continue;
      const verses = {};
      for (const vEl of Array.from(chEl.children).filter((e) => e.tagName.toLowerCase() === "verse")) {
        const vNum = vEl.getAttribute("number");
        const text = (vEl.textContent || "").trim();
        if (vNum && text) verses[vNum] = text;
      }
      if (Object.keys(verses).length) chapters[chNum] = verses;
    }
    if (Object.keys(chapters).length) books[key] = chapters;
  }

  return normalizeParsed({ explicitLanguage, explicitCode, explicitLocale, translationName, attribution, bookNames, books, filename });
}

/**
 * Validates and coerces raw parsed input into the internal dataset shape,
 * THEN (separately) detects the language. These are deliberately two
 * independent checks (PART 11): a file with a plausible language but no
 * real book/chapter/verse content is still rejected — this function never
 * lets language evidence (e.g. a filename saying "Telugu Bible") stand in
 * for actually validating the content is a usable Bible translation.
 * Never fabricates content: anything malformed is dropped rather than
 * guessed at, and an import with zero usable verses is a hard error.
 */
function normalizeParsed({ explicitLanguage, explicitCode, explicitLocale, translationName, title, description, attribution, bookNames, books, flatVerses, legacyBooks, filename }) {
  // --- Content validation first, independent of language ---------------
  // Try the "books" container first (however it's shaped — see
  // normalizeBooksContainer); if that yields nothing, fall back to a flat
  // list of individual verse records, whether it arrived as `verses: [...]`
  // or as the whole `books` value being that flat array itself (e.g. the
  // file's root was a bare array of verse records).
  let normalizedBooks = normalizeBooksContainer(books);
  if (!Object.keys(normalizedBooks).length && Array.isArray(legacyBooks)) {
    normalizedBooks = normalizeLegacyBookArray(legacyBooks);
  }
  if (!Object.keys(normalizedBooks).length) {
    if (Array.isArray(flatVerses)) {
      normalizedBooks = normalizeFlatVerseList(flatVerses);
    } else if (Array.isArray(books) && looksLikeFlatVerseList(books)) {
      normalizedBooks = normalizeFlatVerseList(books);
    }
  }
  if (!Object.keys(normalizedBooks).length) {
    throw new Error("No book data was found in this file.");
  }

  const validKeys = new Set(BOOK_ORDER.map((b) => b.key));
  const verses = {};
  const meta = {};
  let verseCount = 0;

  for (const [rawKey, chapters] of Object.entries(normalizedBooks)) {
    const key = String(rawKey).trim().toLowerCase();
    if (!validKeys.has(key) || !chapters || typeof chapters !== "object") continue;

    const chapterNums = Object.keys(chapters).filter((c) => /^\d+$/.test(c));
    if (!chapterNums.length) continue;

    const bookVerses = {};
    const verseCounts = {};
    for (const chNum of chapterNums) {
      const versesInChapter = chapters[chNum];
      if (!versesInChapter || typeof versesInChapter !== "object") continue;
      const verseNums = Object.keys(versesInChapter).filter((v) => /^\d+$/.test(v));
      if (!verseNums.length) continue;

      const chapterVerses = {};
      for (const vNum of verseNums) {
        const text = String(versesInChapter[vNum] ?? "").trim();
        if (!text) continue;
        chapterVerses[vNum] = text;
        verseCount++;
      }
      if (Object.keys(chapterVerses).length) {
        bookVerses[chNum] = chapterVerses;
        verseCounts[chNum] = Object.keys(chapterVerses).length;
      }
    }
    if (Object.keys(bookVerses).length) {
      verses[key] = bookVerses;
      meta[key] = { chapterCount: Object.keys(bookVerses).length, verseCounts };
    }
  }

  if (!verseCount) {
    throw new Error("No usable verses were found — check that book keys, chapter numbers, and verse numbers match the expected format.");
  }

  // --- Language detection, independent of the content check above ------
  const detected = detectLanguage({
    explicitLanguage,
    explicitCode,
    explicitLocale,
    translationName,
    title,
    description,
    filename,
    verses,
  });

  return {
    language: detected.language, // may be null when ambiguous — see AmbiguousLanguageError below
    languageCode: detected.languageCode,
    languageConfidence: detected.confidence,
    languageSource: detected.source,
    ambiguous: detected.ambiguous,
    languageCandidates: detected.candidates,
    translationName: (translationName || "").trim() || "Imported translation",
    attribution: (attribution || "").trim() || `Imported by the teacher on ${new Date().toLocaleDateString()} — please confirm you have the right to use this text.`,
    bookNames: (bookNames && typeof bookNames === "object") ? bookNames : {},
    verses,
    meta,
    verseCount,
  };
}

/**
 * Opens the native file picker for a .json or .xml file, reads + parses +
 * validates it, detects its language, saves it to local storage, and
 * registers it with bibleService immediately (no restart needed). Returns
 * null if the teacher cancels the picker; returns a short summary on
 * success; throws a clear, user-facing error on anything invalid or
 * unreadable.
 *
 * `resolveLanguage(candidates)`, if given, is called ONLY when detection
 * is genuinely ambiguous — it should show the teacher a language picker
 * (candidates first, full list as a fallback) and resolve to
 * `{ name, code }`, or to null/undefined if the teacher cancels (in which
 * case the whole import is treated as canceled, same as canceling the
 * file picker — nothing is saved). Without a resolveLanguage callback, an
 * ambiguous file throws AmbiguousLanguageError instead, so this function
 * still has a sane non-interactive behavior (e.g. for tests, or a future
 * caller that wants to handle the prompt differently).
 */
export async function pickAndImportBible({ resolveLanguage } = {}) {
  const { open } = window.__TAURI__.dialog;
  const path = await open({ multiple: false, filters: [{ name: "Bible Data", extensions: ["json", "xml"] }] });
  if (!path) return null;

  const { readTextFile } = window.__TAURI__.fs;
  let text;
  try {
    text = await readTextFile(path);
  } catch (err) {
    throw new Error(`Couldn't read "${path.split(/[\\/]/).pop()}": ${err?.message || err}`);
  }

  const filename = path.split(/[\\/]/).pop();
  const isXml = path.toLowerCase().endsWith(".xml");
  let parsed = isXml ? parseBibleXml(text, filename) : parseBibleJson(text, filename);

  if (parsed.ambiguous) {
    if (!resolveLanguage) throw new AmbiguousLanguageError(parsed.languageCandidates);
    const chosen = await resolveLanguage(parsed.languageCandidates);
    if (!chosen) return null; // teacher canceled the language prompt — treat like canceling the whole import
    parsed = { ...parsed, language: chosen.name, languageCode: chosen.code, ambiguous: false, languageSource: "manual" };
  }

  const slug = slugify(parsed.language);
  const dataFile = `bible-custom-${slug}.json`;
  const savedData = {
    translationName: parsed.translationName,
    attribution: parsed.attribution,
    bookNames: parsed.bookNames,
    verses: parsed.verses,
    meta: parsed.meta,
    languageCode: parsed.languageCode,
  };
  if (!(await writeJSON(dataFile, savedData))) {
    throw new Error("The translation was read successfully but couldn't be saved to disk.");
  }

  const registry = (await readJSON(REGISTRY_FILE, [])) || [];
  const updated = [
    ...registry.filter((r) => r.slug !== slug),
    { slug, language: parsed.language, languageCode: parsed.languageCode, translationName: parsed.translationName, dataFile },
  ];
  if (!(await writeJSON(REGISTRY_FILE, updated))) {
    throw new Error("The translation was saved, but the translation list couldn't be updated.");
  }

  bibleService.registerCustomProvider(slug, parsed.language, savedData);

  return { language: parsed.language, translationName: parsed.translationName, verseCount: parsed.verseCount };
}

export async function listCustomBibleImports() {
  return (await readJSON(REGISTRY_FILE, [])) || [];
}

/** Removes an imported translation: deletes its saved data file (real
 * cleanup, not just hiding it), drops it from the registry, and
 * unregisters it from the live bibleService so it stops appearing
 * immediately. Non-fatal if the underlying file is already gone. */
export async function removeCustomBibleImport(slug) {
  const registry = (await readJSON(REGISTRY_FILE, [])) || [];
  const entry = registry.find((r) => r.slug === slug);
  if (!entry) return;

  const remaining = registry.filter((r) => r.slug !== slug);
  // The registry entry must be gone (and saved) BEFORE the data file is
  // deleted: a failed save has to abort here, not leave a registry that
  // still lists a Bible whose file was already removed.
  await writeJSONStrict(REGISTRY_FILE, remaining);
  bibleService.unregisterCustomProvider(slug);

  try {
    // Removes the data file AND its .bak/.tmp siblings (crash-safe storage).
    await deleteJSON(entry.dataFile);
  } catch (err) {
    console.warn(`[BibleImportService] couldn't delete ${entry.dataFile} (non-fatal — it's just an orphaned file now)`, err);
  }
}
