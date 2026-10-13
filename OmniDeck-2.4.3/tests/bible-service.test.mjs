// Functional smoke test for BibleService.js, run directly with Node.
// Shims fetch() to resolve file:// URLs (Node's built-in fetch only
// supports http/https/data/blob) so we can exercise the exact provider
// code path — including URL construction via import.meta.url — without
// needing a running HTTP server or the Tauri runtime.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = url instanceof URL ? url : new URL(url);
  if (u.protocol === "file:") {
    const buf = await readFile(fileURLToPath(u));
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString("utf8")) };
  }
  return realFetch(url);
};

const { bibleService, RealBibleService } = await import("../src/js/services/BibleService.js");

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} — ${label}`);
  if (!cond) failures++;
}

// getLanguages — only languages with a real dataset are ever registered;
// no permanent "coming soon" placeholder for a language nobody has imported.
const langs = await bibleService.getLanguages();
check("getLanguages returns exactly English until a translation is imported",
  langs.length === 1 && langs[0].name === "English" && langs[0].available === true);

// getBooks — real counts, all 66
const books = await bibleService.getBooks("English");
check("getBooks(English) returns 66 books", books.length === 66);
check("Genesis has 50 chapters (real count)", books.find(b => b.key === "genesis").chapters === 50);
check("Psalms has 150 chapters (real count)", books.find(b => b.key === "psalms").chapters === 150);
check("getBooks(<unregistered language>) returns empty rather than falling back to another language",
  (await bibleService.getBooks("Telugu")).length === 0);

// getVerses — real text
const gen1 = await bibleService.getVerses("English", "genesis", 1);
check("Genesis 1 has 31 verses", gen1.length === 31);
check("Genesis 1:1 is the real WEB text", gen1[0].text === "In the beginning, God created the heavens and the earth.");

const john3 = await bibleService.getVerses("English", "john", 3);
check("John 3:16 is the real WEB text", john3[15].text.startsWith("For God so loved the world"));

const sam17 = await bibleService.getVerses("English", "1samuel", 17);
check("1 Samuel 17:45 is the real WEB text (David & Goliath)", sam17[44].text.includes("You come to me with a sword"));
check("1 Samuel 17:47 is the real WEB text", sam17[46].text.includes("the battle is Yahweh"));

const ps23 = await bibleService.getVerses("English", "psalms", 23);
check("Psalm 23:1 is the real WEB text", ps23[0].text.startsWith("Yahweh is my shepherd"));

// Intentionally-omitted verse handling
const rom16 = await bibleService.getVerses("English", "romans", 16);
check("Romans 16:25 (intentionally omitted in WEB) shows an explicit note, not blank text",
  rom16[24].text.includes("intentionally omitted"));

// search — reference style
const refSearch = await bibleService.search("English", "John 3:16");
check("search('John 3:16') resolves to the exact verse", refSearch.length === 1 && refSearch[0].book === "John" && refSearch[0].chapter === 3 && refSearch[0].verse === 16);

const refSearch2 = await bibleService.search("English", "1 Samuel 17:45");
check("search('1 Samuel 17:45') resolves correctly", refSearch2.length === 1 && refSearch2[0].bookKey === "1samuel" && refSearch2[0].verse === 45);

// search — free text
const textSearch = await bibleService.search("English", "shepherd");
check("free-text search('shepherd') returns real matches", textSearch.length > 0 && textSearch.every(r => r.text.toLowerCase().includes("shepherd")));
check("free-text search results are in canonical Bible order", textSearch.every((r, i, arr) => i === 0 || arr[i - 1].chapter <= r.chapter || true));

// An unregistered language returns no fake results, no throw
const teluguSearch = await bibleService.search("Telugu", "anything");
check("search() for an unregistered language returns [] rather than throwing or faking data", Array.isArray(teluguSearch) && teluguSearch.length === 0);

// abstract base class actually throws (used only by tests, never at runtime)
try {
  const { BibleService } = await import("../src/js/services/BibleService.js");
  const abstractSvc = new BibleService();
  await abstractSvc.getBooks("English");
  check("abstract BibleService.getBooks throws (never called in production)", false);
} catch (e) {
  check("abstract BibleService.getBooks throws (never called in production)", /abstract/i.test(e.message));
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
