# Bible data — source, license, attribution

## English — World English Bible (WEB)

- **Translation:** World English Bible (WEB), an update of the 1901 American
  Standard Version.
- **Publisher / official source:** eBible.org (https://ebible.org/web/)
- **License:** Public domain. The WEB's copyright was deliberately waived by
  its editor-in-chief (Michael Paul Johnson) specifically so it could be
  freely copied, distributed, and embedded in software without a license
  agreement, attribution requirement, or royalty. This is documented on the
  WEB's official site and corroborated by the translation's Wikipedia entry.
- **Attribution requirement:** None legally required, but this app credits
  "World English Bible (WEB), public domain" in Settings → About and in the
  Bible reader footer as a courtesy and for transparency with teachers.
- **Online/offline requirement:** None. Because the text is public domain,
  the full translation is bundled into the app (`bible-en-web.json`,
  ~31,103 verses / 66 books) and read entirely from local disk. No network
  access or API key is required to read Scripture, search, or present it.
- **Local storage:** Explicitly allowed — there is no license restricting
  redistribution, so bundling and locally caching the full text is fine.

### Exact data pipeline used (for future audit / re-verification)

1. Verse-level JSON transcription pulled from the `TehShrike/world-english-bible`
   GitHub repository, which itself parses and republishes the WEB HTML
   published at ebible.org/web/. This repo was used only as a transcription
   convenience — the underlying text is public domain regardless of how any
   particular repository packages it, so the app's use of the text does not
   depend on that repository's own package license.
2. A conversion script (`build_bible.js`, not shipped with the app) merged
   "paragraph text" and "line text" fragments (prose and poetic-line verses,
   respectively) in document order into one string per verse, and verified:
   - all 66 books present
   - chapter numbering is gap-free and sequential per book
   - verse numbering is gap-free and sequential per chapter
   - no verse text is empty, except 5 verse numbers that the WEB
     intentionally leaves blank for manuscript reasons (see below)
   - spot checks against known text (Genesis 1:1, Psalm 23:1, John 3:16,
     1 Samuel 17:45-47) matched the authoritative WEB wording.
3. Result: 31,103 verses across 66 books, 0 unexplained data problems.

### Intentionally blank verse numbers

Five traditionally-numbered verses are blank in the WEB source text itself
(the translators kept the KJV-tradition verse number for cross-reference
continuity, but the manuscript basis they followed omits the verse):
**Luke 17:36, Acts 8:37, Acts 15:34, Acts 24:7, Romans 16:25** (this
numbering — note some editions place the Romans doxology at a different
verse number; WEB's numbering is used here). The app displays an explicit
note for these rather than a blank line or a fabricated verse.

## Telugu — not bundled (v1)

No Telugu translation is bundled. Per explicit instruction, the app does
**not** fabricate, paraphrase, or use placeholder Telugu Scripture text.
Rather than show a permanently-disabled "Telugu (Coming soon)" button,
the language selector only ever lists languages that have a real dataset
behind them — so until a translation is bundled or imported, Telugu
simply doesn't appear as an option at all. Public domain/openly-licensed
Telugu Bible text is genuinely hard to source — most modern Telugu
translations are copyrighted by the Bible Society of India or similar
bodies — so bundling one will likely require either a licensing
agreement or locating a specific public-domain-old Telugu edition (e.g. a
pre-1900s translation) and verifying its status before it can ship.

A teacher can fill this gap themselves right now via **Settings → Bible
Translations → Import Bible Translation**, which accepts a JSON or XML
file (see `BibleImportService.js` for the exact format) and makes it
immediately selectable in the app — the moment it's imported, its
language button appears in the Bible section and the scripture picker
exactly like English does. This is a teacher-supplied import, not a
bundled/verified app dataset — the app cannot verify the source or
licensing of an imported file the way the WEB pipeline above was
verified, and the import flow says so plainly rather than implying any
endorsement. Importing a translation for "Telugu" (or any other language
name) simply adds that language as a new selectable option; removing it
later (Settings → Bible Translations → Remove) makes it disappear again
rather than reverting to any placeholder state.

## Architecture note

The Bible UI and presentation code talk only to `BibleService`, which
delegates to a `BibleProvider` per language (see `BibleService.js`). Adding
a licensed Telugu translation later means writing one new provider file
that reads whatever format the licensed data ships in (JSON, SQLite, API)
and registering it — no changes to the Bible view, scripture picker, lesson
editor, or Present Mode are required.
