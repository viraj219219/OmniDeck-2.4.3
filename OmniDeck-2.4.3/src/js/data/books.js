// Canonical 66-book list: key, display name, testament, and canonical order.
// This is standard bibliographic reference data (book names/order), not
// Scripture text, and is not translation-specific. Chapter counts and verse
// counts are NOT hardcoded here — they are derived at runtime from whichever
// translation dataset is actually loaded (see BibleService.js), so this file
// can never silently drift out of sync with the real data.
//
// `key` matches the WEB dataset's per-book JSON file naming convention
// (lowercased English book name, no spaces) so a provider can look up a
// book's real chapter/verse data directly by this key.

export const BOOK_ORDER = [
  // ---- Old Testament (39) ----
  { key: "genesis", en: "Genesis", testament: "OT" },
  { key: "exodus", en: "Exodus", testament: "OT" },
  { key: "leviticus", en: "Leviticus", testament: "OT" },
  { key: "numbers", en: "Numbers", testament: "OT" },
  { key: "deuteronomy", en: "Deuteronomy", testament: "OT" },
  { key: "joshua", en: "Joshua", testament: "OT" },
  { key: "judges", en: "Judges", testament: "OT" },
  { key: "ruth", en: "Ruth", testament: "OT" },
  { key: "1samuel", en: "1 Samuel", testament: "OT" },
  { key: "2samuel", en: "2 Samuel", testament: "OT" },
  { key: "1kings", en: "1 Kings", testament: "OT" },
  { key: "2kings", en: "2 Kings", testament: "OT" },
  { key: "1chronicles", en: "1 Chronicles", testament: "OT" },
  { key: "2chronicles", en: "2 Chronicles", testament: "OT" },
  { key: "ezra", en: "Ezra", testament: "OT" },
  { key: "nehemiah", en: "Nehemiah", testament: "OT" },
  { key: "esther", en: "Esther", testament: "OT" },
  { key: "job", en: "Job", testament: "OT" },
  { key: "psalms", en: "Psalms", testament: "OT" },
  { key: "proverbs", en: "Proverbs", testament: "OT" },
  { key: "ecclesiastes", en: "Ecclesiastes", testament: "OT" },
  { key: "songofsolomon", en: "Song of Solomon", testament: "OT" },
  { key: "isaiah", en: "Isaiah", testament: "OT" },
  { key: "jeremiah", en: "Jeremiah", testament: "OT" },
  { key: "lamentations", en: "Lamentations", testament: "OT" },
  { key: "ezekiel", en: "Ezekiel", testament: "OT" },
  { key: "daniel", en: "Daniel", testament: "OT" },
  { key: "hosea", en: "Hosea", testament: "OT" },
  { key: "joel", en: "Joel", testament: "OT" },
  { key: "amos", en: "Amos", testament: "OT" },
  { key: "obadiah", en: "Obadiah", testament: "OT" },
  { key: "jonah", en: "Jonah", testament: "OT" },
  { key: "micah", en: "Micah", testament: "OT" },
  { key: "nahum", en: "Nahum", testament: "OT" },
  { key: "habakkuk", en: "Habakkuk", testament: "OT" },
  { key: "zephaniah", en: "Zephaniah", testament: "OT" },
  { key: "haggai", en: "Haggai", testament: "OT" },
  { key: "zechariah", en: "Zechariah", testament: "OT" },
  { key: "malachi", en: "Malachi", testament: "OT" },
  // ---- New Testament (27) ----
  { key: "matthew", en: "Matthew", testament: "NT" },
  { key: "mark", en: "Mark", testament: "NT" },
  { key: "luke", en: "Luke", testament: "NT" },
  { key: "john", en: "John", testament: "NT" },
  { key: "acts", en: "Acts", testament: "NT" },
  { key: "romans", en: "Romans", testament: "NT" },
  { key: "1corinthians", en: "1 Corinthians", testament: "NT" },
  { key: "2corinthians", en: "2 Corinthians", testament: "NT" },
  { key: "galatians", en: "Galatians", testament: "NT" },
  { key: "ephesians", en: "Ephesians", testament: "NT" },
  { key: "philippians", en: "Philippians", testament: "NT" },
  { key: "colossians", en: "Colossians", testament: "NT" },
  { key: "1thessalonians", en: "1 Thessalonians", testament: "NT" },
  { key: "2thessalonians", en: "2 Thessalonians", testament: "NT" },
  { key: "1timothy", en: "1 Timothy", testament: "NT" },
  { key: "2timothy", en: "2 Timothy", testament: "NT" },
  { key: "titus", en: "Titus", testament: "NT" },
  { key: "philemon", en: "Philemon", testament: "NT" },
  { key: "hebrews", en: "Hebrews", testament: "NT" },
  { key: "james", en: "James", testament: "NT" },
  { key: "1peter", en: "1 Peter", testament: "NT" },
  { key: "2peter", en: "2 Peter", testament: "NT" },
  { key: "1john", en: "1 John", testament: "NT" },
  { key: "2john", en: "2 John", testament: "NT" },
  { key: "3john", en: "3 John", testament: "NT" },
  { key: "jude", en: "Jude", testament: "NT" },
  { key: "revelation", en: "Revelation", testament: "NT" },
];

export function findBookMeta(key) {
  return BOOK_ORDER.find((b) => b.key === key) || null;
}
