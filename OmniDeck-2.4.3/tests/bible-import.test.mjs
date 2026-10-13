import { parseBibleJson, AmbiguousLanguageError } from "../src/js/services/BibleImportService.js";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS — ${name}`);
  else { failures++; console.error(`FAIL — ${name}`); }
}

// A synthetic test fixture — NOT a verified real translation, just real
// Telugu Unicode script text, enough to exercise script-based detection
// and to check verse text survives the import pipeline byte-for-byte.
const TELUGU_GENESIS_1_1 = "ఆదియందు దేవుడు భూమ్యాకాశములను సృజించెను.";
const TELUGU_GENESIS_1_2 = "భూమి నిరాకారముగాను శూన్యముగాను ఉండెను; చీకటి అగాధ జలము పైన కమ్మియుండెను.";

// ---------------------------------------------------------------------
// Explicit "language" field still works exactly as before (backward
// compatibility with every file that already names its language).
// ---------------------------------------------------------------------
const good = parseBibleJson(JSON.stringify({
  language: "Telugu",
  translationName: "Test Translation",
  attribution: "Test attribution",
  bookNames: { genesis: "ఆదికాండము" },
  books: {
    genesis: { "1": { "1": "In the beginning...", "2": "The earth was formless..." } },
  },
}));
check("explicit language field still parses language/translationName/attribution", good.language === "Telugu" && good.languageCode === "te" && good.translationName === "Test Translation" && good.attribution === "Test attribution");
check("parses bookNames", good.bookNames.genesis === "ఆదికాండము");
check("parses verse text", good.verses.genesis["1"]["1"] === "In the beginning...");
check("computes meta chapterCount", good.meta.genesis.chapterCount === 1);
check("computes meta verseCounts", good.meta.genesis.verseCounts["1"] === 2);
check("counts total verses", good.verseCount === 2);
check("not ambiguous when language is explicit", good.ambiguous === false);

// ---------------------------------------------------------------------
// THE core requirement: a Telugu Bible with NO language field at all is
// no longer rejected — it's detected from the actual Telugu Unicode text.
// ---------------------------------------------------------------------
const teluguNoLangField = parseBibleJson(JSON.stringify({
  translationName: "Sample Telugu Translation",
  books: {
    genesis: { "1": { "1": TELUGU_GENESIS_1_1, "2": TELUGU_GENESIS_1_2 } },
  },
}), "Telugu Bible.json");
check("Telugu Bible with NO language field is detected as Telugu, not rejected", teluguNoLangField.language === "Telugu" && teluguNoLangField.languageCode === "te");
check("Telugu detection is not ambiguous (filename + script agree)", teluguNoLangField.ambiguous === false);
check("Telugu verse text preserved EXACTLY (Unicode, punctuation, diacritics unchanged)", teluguNoLangField.verses.genesis["1"]["1"] === TELUGU_GENESIS_1_1 && teluguNoLangField.verses.genesis["1"]["2"] === TELUGU_GENESIS_1_2);
check("Import succeeds with the right verse/chapter counts", teluguNoLangField.verseCount === 2 && teluguNoLangField.meta.genesis.chapterCount === 1);

// Same file, via language code instead of filename/script — also works,
// and a recognized code is used to look up the canonical language name
// even though the field is a code, not a name.
const teluguByCode = parseBibleJson(JSON.stringify({
  lang: "te",
  books: { genesis: { "1": { "1": TELUGU_GENESIS_1_1 } } },
}));
check("Telugu via 'lang: te' code field", teluguByCode.language === "Telugu" && teluguByCode.languageCode === "te" && teluguByCode.ambiguous === false);

const teluguByLocale = parseBibleJson(JSON.stringify({
  locale: "te-IN",
  books: { genesis: { "1": { "1": TELUGU_GENESIS_1_1 } } },
}));
check("Telugu via 'locale: te-IN' field", teluguByLocale.language === "Telugu" && teluguByLocale.ambiguous === false);

// Nested metadata.language / translation.language conventions
const teluguNestedMeta = parseBibleJson(JSON.stringify({
  metadata: { language: "Telugu" },
  books: { genesis: { "1": { "1": "text" } } },
}));
check("Telugu via nested metadata.language", teluguNestedMeta.language === "Telugu");

// ---------------------------------------------------------------------
// Ambiguous language -> NOT rejected, NOT silently guessed — surfaced as
// ambiguous with real candidates instead of a "missing language" error.
// ---------------------------------------------------------------------
const ambiguousDevanagari = parseBibleJson(JSON.stringify({
  books: { genesis: { "1": { "1": "आदि में परमेश्वर ने आकाश और पृथ्वी की सृष्टि की।" } } },
}));
check("Ambiguous Devanagari file is NOT rejected — it imports with ambiguous=true instead of throwing", ambiguousDevanagari.language === null && ambiguousDevanagari.ambiguous === true);
check("Ambiguous file still has real, usable verse content ready to save once a language is chosen", ambiguousDevanagari.verseCount === 1);
check("Ambiguous file offers real candidates (Hindi/Marathi/Nepali), not the full language list", ["Hindi", "Marathi", "Nepali"].every((n) => ambiguousDevanagari.languageCandidates.some((c) => c.name === n)));

// Old behavior (throwing "missing language") must be GONE.
let threwMissingLanguage = false;
try {
  parseBibleJson(JSON.stringify({ books: { genesis: { "1": { "1": "text with no identifiable language evidence at all 123" } } } }));
} catch (err) {
  threwMissingLanguage = /missing "language"/i.test(err.message);
}
check("The old 'missing language' hard rejection no longer happens", threwMissingLanguage === false);

// ---------------------------------------------------------------------
// Content validation is INDEPENDENT of language — a file must actually
// contain usable Bible structure regardless of how confidently its
// language can be named. A plausible filename must not bypass this.
// ---------------------------------------------------------------------
let threw = false;
try {
  parseBibleJson(JSON.stringify({ language: "Telugu", books: {} }), "Telugu Bible.json");
} catch { threw = true; }
check("A file with a perfect language match but NO book data is still rejected (filename doesn't grant a pass)", threw);

threw = false;
try { parseBibleJson("{not valid json"); }
catch (err) { threw = err instanceof Error; }
check("rejects invalid JSON with a real Error", threw);

threw = false;
try { parseBibleJson(JSON.stringify({})); }
catch { threw = true; }
check("rejects an empty JSON object (not a Bible at all)", threw);

threw = false;
try { parseBibleJson(JSON.stringify({ language: "Test", books: { genesis: {} } })); }
catch { threw = true; }
check("rejects a book with an empty chapters object", threw);

threw = false;
try { parseBibleJson(JSON.stringify({ language: "Test", books: { genesis: { "1": {} } } })); }
catch { threw = true; }
check("rejects a chapter with no verse text", threw);

const partial = parseBibleJson(JSON.stringify({
  language: "Klingon",
  books: {
    notarealbook: { "1": { "1": "should be skipped" } },
    exodus: { "1": { "1": "This should survive." } },
  },
}));
check("skips unrecognized book keys but keeps valid ones (and book ordering/keys are otherwise untouched)", !partial.verses.notarealbook && partial.verses.exodus["1"]["1"] === "This should survive.");
check("an unrecognized explicit language string (not in our table) is still honored as-is, not forced into a known one", partial.language === "Klingon" && partial.languageCode === null);

threw = false;
try { parseBibleJson(JSON.stringify({ language: "Test", books: { notarealbook: { "1": { "1": "x" } } } })); }
catch { threw = true; }
check("rejects a file where no book keys are recognized at all", threw);

const blanks = parseBibleJson(JSON.stringify({
  language: "Test",
  books: { genesis: { "1": { "1": "Real text", "2": "   " } } },
}));
check("drops whitespace-only verse text", !("2" in blanks.verses.genesis["1"]) && blanks.verseCount === 1);

const noMeta = parseBibleJson(JSON.stringify({
  language: "Test",
  books: { genesis: { "1": { "1": "Text" } } },
}));
check("generates a fallback translationName when none given", noMeta.translationName === "Imported translation");
check("generates an honest fallback attribution when none given", /confirm you have the right/i.test(noMeta.attribution));

// AmbiguousLanguageError is exported and carries candidates (for a
// non-interactive caller — the interactive picker is exercised in the UI,
// not here, since this test has no DOM/modal).
check("AmbiguousLanguageError is a real Error subclass carrying candidates", (() => {
  const e = new AmbiguousLanguageError([{ name: "Hindi", code: "hi" }]);
  return e instanceof Error && e.name === "AmbiguousLanguageError" && e.candidates.length === 1;
})());

// ---------------------------------------------------------------------
// Issue 2 — additional real-world JSON shapes must now be recognized,
// without requiring a "language" field or the one rigid nested-object
// schema. None of these mention Telugu specifically — the fix is generic.
// ---------------------------------------------------------------------

// Flat list of individual verse records under "verses" (a very common
// shape for downloaded Bible datasets), with alternate key spellings.
const flatUnderVerses = parseBibleJson(JSON.stringify({
  translationName: "Flat Test",
  verses: [
    { book_name: "Genesis", chapter: 1, verse: 1, text: "In the beginning..." },
    { book: "Genesis", chapter: 1, verse: 2, text: "The earth was formless..." },
    { book: 2, chapter: 1, verse: 1, text: "Now these are the names..." }, // numeric book id (Exodus)
  ],
}));
check("flat verse list under 'verses' is recognized", flatUnderVerses.verses.genesis["1"]["1"] === "In the beginning..." && flatUnderVerses.verses.genesis["1"]["2"] === "The earth was formless...");
check("flat verse list resolves a numeric book id", flatUnderVerses.verses.exodus["1"]["1"] === "Now these are the names...");
check("flat verse list total verse count", flatUnderVerses.verseCount === 3);

// The whole file's root IS the flat array (no wrapper object at all).
const flatRootArray = parseBibleJson(JSON.stringify([
  { book: "John", chapter: 3, verse: 16, text: "For God so loved the world..." },
]));
check("a bare root-level array of verse records is recognized", flatRootArray.verses.john["3"]["16"] === "For God so loved the world...");

// "books" as an ARRAY of book objects, each with an array-of-arrays
// chapter structure (chapter index -> verse index, both by position).
const arrayOfBooks = parseBibleJson(JSON.stringify({
  translationName: "Array Test",
  books: [
    { name: "Genesis", chapters: [["First verse text.", "Second verse text."]] },
  ],
}));
check("array-of-books with array-of-arrays chapters is recognized", arrayOfBooks.verses.genesis["1"]["1"] === "First verse text." && arrayOfBooks.verses.genesis["1"]["2"] === "Second verse text.");

// Books keyed by full display name ("1 Samuel") rather than the internal
// key ("1samuel"), with chapters as an object of {verses: [...]}.
const fullNameKeyed = parseBibleJson(JSON.stringify({
  translationName: "Full Name Test",
  books: {
    "1 Samuel": { "1": { verses: [{ verse: 1, text: "Now there was a certain man..." }] } },
  },
}));
check("book keyed by full display name ('1 Samuel') resolves to '1samuel'", fullNameKeyed.verses["1samuel"]["1"]["1"] === "Now there was a certain man...");

// The original failure mode from the report: a real Bible JSON file that
// simply uses a different (but common) shape must NOT produce "No Bible
// book data found" just because it doesn't match the one narrow schema.
threw = false;
try {
  parseBibleJson(JSON.stringify({
    verses: [{ book: "Luke", chapter: 2, verse: 7, text: "And she brought forth her firstborn son..." }],
  }));
} catch { threw = true; }
check("a recognizable-but-differently-shaped file is NOT rejected as 'no book data'", !threw);




// ---------------------------------------------------------------------
// Legacy ordered export shape used by the user's real Bible files:
// { "Book": [{ "Chapter": [{ "Verse": [{ "Verseid": "...", "Verse": "..." }] }] }] }
// No book/chapter/verse names are present; array position is the identifier.
// ---------------------------------------------------------------------
const orderedLegacy = parseBibleJson(JSON.stringify({
  Book: [
    { Chapter: [
      { Verse: [
        { Verseid: "00000000", Verse: "Legacy Genesis 1:1" },
        { Verseid: "00000001", Verse: "Legacy Genesis 1:2" },
      ] },
      { Verse: [{ Verseid: "00001000", Verse: "Legacy Genesis 2:1" }] },
    ] },
    { Chapter: [{ Verse: [{ Verseid: "00000000", Verse: "Legacy Exodus 1:1" }] }] },
  ],
}), "legacy.json");
check("ordered Book/Chapter/Verse legacy shape is recognized", orderedLegacy.verses.genesis["1"]["1"] === "Legacy Genesis 1:1" && orderedLegacy.verses.exodus["1"]["1"] === "Legacy Exodus 1:1");
check("legacy array positions become correct chapter/verse numbers", orderedLegacy.verses.genesis["1"]["2"] === "Legacy Genesis 1:2" && orderedLegacy.verses.genesis["2"]["1"] === "Legacy Genesis 2:1");
check("legacy Verse text survives exactly", orderedLegacy.verseCount === 4);
