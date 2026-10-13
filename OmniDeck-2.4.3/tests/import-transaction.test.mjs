// Regression tests: PowerPoint / PDF / backup imports are TRANSACTIONAL.
// Either everything is registered and the lesson is saved once (COMMIT), or
// every asset THIS import created is removed and the lesson is untouched
// (ROLLBACK) — never orphan files, ghost records, or a half-built lesson.
// Runs the real ImportService/MediaService/LessonService code against a
// fault-injecting in-memory Tauri filesystem with fake conversion commands.

import { FakeDisk, installFakeTauri, makeChecker, WIN_BASE } from "./helpers/fakeDisk.mjs";

const { check, done } = makeChecker();
const realWarn = console.warn;
console.warn = (...a) => { if (String(a[0]).includes("thumbnail generation failed")) return; realWarn(...a); };

const disk = new FakeDisk();
const PNG = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n, n]);

// ---- fake Rust conversion commands -------------------------------------------------
const converter = { mode: "ok", pages: 3, badPage: null };
const relOf = (absDir) => disk.norm(absDir);
async function convert(args, d) {
  const dir = relOf(args.workDir);
  if (converter.mode === "missing-tool") throw "LibreOffice (the \"soffice\" command) isn't installed or isn't on the system PATH. PowerPoint files can't be converted without it.";
  if (converter.mode === "poppler-missing") throw "poppler-utils (the \"pdftoppm\" command) isn't installed or isn't on the system PATH.";
  const names = [];
  for (let i = 1; i <= converter.pages; i++) {
    const name = `slide-${i}.png`;
    names.push(name);
    if (converter.mode === "skip-page-2" && i === 2) continue; // reported but never written
    d.files.set(`${dir}/${name}`, converter.badPage === i ? new TextEncoder().encode("this is not a png at all") : PNG(i));
  }
  return names;
}
const tauri = installFakeTauri(disk, { commands: { convert_pptx_to_slides: convert, convert_pdf_to_slides: convert } });

let pickedPaths = [];
let pickerCalls = 0;
window.__TAURI__.dialog.open = async () => { pickerCalls++; return pickedPaths.length ? pickedPaths : null; };
const SRC_PPTX = "C:\\Users\\Pat Smith\\Documents\\Lesson Deck.pptx";
const SRC_PDF = "C:\\Users\\Pat Smith\\Documents\\Handout.pdf";
disk.files.set(disk.norm(SRC_PPTX), new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6]));
disk.files.set(disk.norm(SRC_PDF), new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]));

const { mediaService } = await import("../src/js/services/MediaService.js");
const { lessonService } = await import("../src/js/services/LessonService.js");
const { importSlidesAsPages, importFileAsNewLesson, ImportError, ImportTransaction } = await import("../src/js/services/ImportService.js");
const { DependencyError } = await import("../src/js/services/DependencyService.js");
const { importBackup } = await import("../src/js/services/BackupService.js");

const mkLesson = (id, title) => ({ id, title, createdAt: "t0", updatedAt: "t0", pages: [{ id: `${id}-p1`, type: "title", title }] });
disk.files.set("lessons.json", JSON.stringify([mkLesson("L1", "Existing lesson")], null, 2));

const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const libraryIds = () => (disk.has("media-library.json") ? disk.json("media-library.json").map((m) => m.id) : []);
const mediaFiles = () => disk.list("media/");
const lessonsText = () => disk.text("lessons.json");
const snap = () => JSON.stringify({ lessons: lessonsText(), library: libraryIds(), files: mediaFiles() });
const memPages = async (id) => (await lessonService.getLesson(id)).pages.length;

// Fail the Nth write whose path matches (1-based).
function failNthWrite(re, n) {
  const real = disk.writeRaw.bind(disk);
  let seen = 0;
  const restore = () => { disk.writeRaw = real; };
  disk.writeRaw = async (p, d) => {
    if (re.test(disk.norm(p)) && ++seen === n) throw new Error(`injected write failure #${n}`);
    return real(p, d);
  };
  return restore;
}

// ================================================================================
// 1. Successful PPTX import (COMMIT)
// ================================================================================
{
  converter.mode = "ok"; converter.pages = 3;
  pickedPaths = [SRC_PPTX];
  const pagesBefore = await memPages("L1");
  const res = await importSlidesAsPages("L1", "presentation", { mediaService, lessonService });
  check("PPTX success: 3 slides became 3 pages in one step", res.pages.length === 3 && res.slideCount === 3 && (await memPages("L1")) === pagesBefore + 3);
  const saved = disk.json("lessons.json").find((l) => l.id === "L1");
  check("PPTX success: the SAVED lesson has the new pages", saved.pages.length === pagesBefore + 3);
  const ids = new Set(libraryIds());
  check("PPTX success: every page references a media record that exists with a file on disk",
    saved.pages.slice(pagesBefore).every((p) => ids.has(p.background?.mediaId) && disk.has(disk.json("media-library.json").find((m) => m.id === p.background.mediaId).managedPath)));
  check("PPTX success: source deck kept in the library", disk.json("media-library.json").some((m) => m.kind === "presentation"));
}

// ================================================================================
// 2. Failure at each stage -> rollback, nothing left behind
// ================================================================================
async function expectRollback(label, stage, run, { pagesOf = "L1" } = {}) {
  const before = snap();
  const lessonsBefore = lessonsText();
  const pagesBefore = await memPages(pagesOf);
  const err = await run();
  check(`${label}: import fails with an ImportError at stage '${stage}'`, err instanceof ImportError && err.stage === stage);
  check(`${label}: nothing added to the lesson (memory + disk)`, (await memPages(pagesOf)) === pagesBefore && lessonsText() === lessonsBefore);
  check(`${label}: no orphan media files and no ghost library records`, JSON.stringify({ lessons: lessonsText(), library: libraryIds(), files: mediaFiles() }) === before);
  return err;
}
const runPptx = (lessonId = "L1", extra = {}) => async () => rejects(() => importSlidesAsPages(lessonId, "presentation", { mediaService, lessonService, ...extra }));

// Fresh source file each time so duplicate detection doesn't reuse the first import.
let n = 0;
function freshDeck(bytes = 6) {
  n++;
  const p = `C:\\Users\\Pat Smith\\Documents\\Deck ${n}.pptx`;
  disk.files.set(disk.norm(p), new Uint8Array(bytes + n));
  pickedPaths = [p];
  return p;
}

{
  freshDeck(); converter.mode = "missing-tool";
  const err = await expectRollback("conversion fails (LibreOffice missing)", "convert", runPptx());
  check("conversion failure: the user-facing message names LibreOffice", /LibreOffice/.test(err.message));
  check("conversion failure: rollback reported the copied deck as removed", err.rollback.removed.length === 1);
}
{
  freshDeck(); converter.mode = "skip-page-2";
  await expectRollback("slide rendering reports a page it never wrote", "convert", runPptx());
}
{
  freshDeck(); converter.mode = "ok"; converter.badPage = 3;
  const err = await expectRollback("a rendered slide is not a valid image", "render", runPptx());
  check("invalid slide: rollback removed the slides that HAD been registered", err.rollback.removed.length >= 3);
  converter.badPage = null;
}
{
  freshDeck(); converter.mode = "ok";
  disk.failOn("read", /-slides\/slide-2\.png$/, { times: 1 });
  const err = await expectRollback("individual slide (2 of 3) can't be read", "render", runPptx());
  check("slide read failure: slide 1 had already been registered and was rolled back", err.rollback.removed.length >= 2);
}
{
  freshDeck(); converter.mode = "ok";
  const restore = failNthWrite(/^media\/images\/[^/]+\.png$/, 2);
  await expectRollback("media registration fails on slide 2", "register", runPptx());
  restore();
}
{
  freshDeck(); converter.mode = "ok";
  const before = snap();
  const restore = failNthWrite(/^media-library\.json\.tmp$/, 4); // deck + conversion saved, a later slide registration's library save fails
  const e = await runPptx()();
  restore();
  check("library save failing mid-import also rolls back cleanly (no orphans, lesson untouched)", e instanceof ImportError && snap() === before);
}
{
  freshDeck(); converter.mode = "ok";
  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  const err = await expectRollback("final lesson persistence fails", "persist", runPptx());
  check("final persistence failure: rollback removed the deck and all 3 slide images it had created", err.rollback.removed.length === 4);
}

// ================================================================================
// 3. Pre-existing user media is never touched by a rollback
// ================================================================================
{
  converter.mode = "ok"; converter.pages = 3;
  pickedPaths = [SRC_PPTX]; // already imported in test 1 -> the deck is REUSED, not recreated
  const before = snap();
  const libBefore = new Set(libraryIds());
  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  const err = await rejects(() => importSlidesAsPages("L1", "presentation", { mediaService, lessonService }));
  check("re-import of an already-imported deck that fails at the final save…", err?.stage === "persist");
  check("…leaves every pre-existing media record and file exactly as it was", JSON.stringify({ lessons: lessonsText(), library: libraryIds(), files: mediaFiles() }) === before);
  check("…including the reused source deck", [...libBefore].every((id) => libraryIds().includes(id)));
}

// ================================================================================
// 4. Dependencies & picker
// ================================================================================
{
  const before = snap();
  const calls = pickerCalls;
  const deps = { assertReady: async () => { throw new DependencyError("PowerPoint import needs LibreOffice, which isn't installed or can't be found.", { missing: ["soffice"] }); } };
  const err = await rejects(() => importSlidesAsPages("L1", "presentation", { mediaService, lessonService, dependencies: deps }));
  check("missing LibreOffice is reported BEFORE anything is copied (clear error, stage validate)", err instanceof ImportError && err.stage === "validate" && /LibreOffice/.test(err.message));
  check("…the file picker never opened and nothing changed", pickerCalls === calls && snap() === before);

  pickedPaths = [];
  const r = await importSlidesAsPages("L1", "presentation", { mediaService, lessonService });
  check("cancelled picker: clean no-op", r.cancelled === true && snap() === before);
  const bad = await rejects(() => importSlidesAsPages("L1", "video", { mediaService, lessonService }));
  check("unsupported kind refused up front", bad?.stage === "validate");
}

// ================================================================================
// 5. PDF
// ================================================================================
{
  converter.mode = "ok"; converter.pages = 2;
  pickedPaths = [SRC_PDF];
  const pagesBefore = await memPages("L1");
  const res = await importSlidesAsPages("L1", "pdf", { mediaService, lessonService });
  check("PDF success: one page per PDF page, saved", res.slideCount === 2 && (await memPages("L1")) === pagesBefore + 2 && disk.json("lessons.json").find((l) => l.id === "L1").pages.length === pagesBefore + 2);
}
{
  converter.mode = "poppler-missing";
  const p2 = "C:\\Users\\Pat Smith\\Documents\\Other Handout.pdf";
  disk.files.set(disk.norm(p2), new Uint8Array([0x25, 0x50, 0x44, 0x46, 9, 9, 9]));
  pickedPaths = [p2];
  const pagesBefore = await memPages("L1");
  const res = await importSlidesAsPages("L1", "pdf", { mediaService, lessonService });
  check("PDF without Poppler still imports as ONE embedded-PDF page (working import, not fake slides)", res.embeddedCount === 1 && res.slideCount === 0 && res.pages[0].type === "pdf" && (await memPages("L1")) === pagesBefore + 1);
  check("PDF without Poppler: the teacher is told why", res.warnings.length === 1 && /pdftoppm/.test(res.warnings[0]));
  const saved = disk.json("lessons.json").find((l) => l.id === "L1").pages.at(-1);
  check("…and the embedded page's PDF really is in the library + on disk", disk.json("media-library.json").some((m) => m.id === saved.mediaId) && mediaFiles().some((f) => f.includes(saved.mediaId)));
}
{
  converter.mode = "ok"; converter.pages = 2;
  const p3 = "C:\\Users\\Pat Smith\\Documents\\Third Handout.pdf";
  disk.files.set(disk.norm(p3), new Uint8Array([0x25, 0x50, 0x44, 0x46, 7, 7, 7, 7]));
  pickedPaths = [p3];
  const before = snap();
  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  const err = await rejects(() => importSlidesAsPages("L1", "pdf", { mediaService, lessonService }));
  check("PDF import failing at final save rolls back fully", err?.stage === "persist" && snap() === before);
}

// ================================================================================
// 6. "Import as new lesson": no half-created lesson, ever
// ================================================================================
{
  converter.mode = "ok"; converter.pages = 3;
  const p = "C:\\Users\\Pat Smith\\Documents\\New Lesson Deck.pptx";
  disk.files.set(disk.norm(p), new Uint8Array(20));
  pickedPaths = [p];
  const before = snap();
  const count = (await lessonService.listLessons()).length;
  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  const err = await rejects(() => importFileAsNewLesson("Brand new", "presentation", { mediaService, lessonService }));
  check("new-lesson import: persistence failure -> ImportError(persist)", err instanceof ImportError && err.stage === "persist");
  check("new-lesson import: NO lesson exists afterwards (memory or disk) and nothing is orphaned", (await lessonService.listLessons()).length === count && snap() === before);

  converter.mode = "missing-tool";
  const err2 = await rejects(() => importFileAsNewLesson("Brand new", "presentation", { mediaService, lessonService }));
  check("new-lesson import: conversion failure -> no lesson, no orphans, clear message", err2?.stage === "convert" && /LibreOffice/.test(err2.message) && snap() === before && (await lessonService.listLessons()).length === count);

  converter.mode = "ok";
  const res = await importFileAsNewLesson("Brand new", "presentation", { mediaService, lessonService });
  const savedNewLesson = res.lesson && disk.json("lessons.json").find((l) => l.id === res.lesson.id);
  check("new-lesson import: success creates the lesson in ONE persisted step", !res.cancelled && savedNewLesson && savedNewLesson.pages.length === 3);
  check("new-lesson import: every PowerPoint slide becomes one ordered canvas slide (no title/embedded-deck page)", savedNewLesson?.pages.every((p) => p.type === "freeform") && savedNewLesson.pages.every((p) => p.background?.type === "image" && disk.json("media-library.json").some((m) => m.id === p.background.mediaId && m.kind === "image")));
  check("new-lesson import: slides have no Image title/caption chrome and keep every editor feature (boxes[] present, no mediaId/caption)", savedNewLesson.pages.every((p) => Array.isArray(p.boxes) && p.boxes.length === 0 && p.mediaId === undefined && p.caption === undefined));
  check("new-lesson import: slides are named Slide 1..N and show the full picture (fit: contain)", savedNewLesson.pages.map((p) => p.title).join("|") === "Slide 1|Slide 2|Slide 3" && savedNewLesson.pages.every((p) => p.background.fit === "contain"));
}

// ================================================================================
// 7. Backup import
// ================================================================================
{
  const b64 = (u8) => Buffer.from(u8).toString("base64");
  const backup = {
    formatVersion: 1,
    lesson: { id: "orig", title: "Backed up", pages: [
      { id: "p1", type: "image", mediaId: "old-1" },
      { id: "p2", type: "title", background: { mediaId: "old-2" } },
    ] },
    media: [
      { record: { id: "old-1", kind: "image", name: "one.png", mime: "image/png" }, base64: b64(PNG(1)) },
      { record: { id: "old-2", kind: "image", name: "two.png", mime: "image/png" }, base64: b64(PNG(2)) },
    ],
  };
  const before = snap();
  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  const err = await rejects(() => importBackup(JSON.stringify(backup)));
  check("backup import failing at the final save: error surfaced", !!err);
  check("backup import failure: the media it re-imported is rolled back (no orphans) and no lesson was created", snap() === before);

  const res = await importBackup(JSON.stringify(backup));
  const saved = disk.json("lessons.json").find((l) => l.id === res.lesson.id);
  const ids = new Set(libraryIds());
  check("backup import success: lesson saved once with every reference (incl. background) remapped to real media", saved && ids.has(saved.pages[0].mediaId) && ids.has(saved.pages[1].background.mediaId));

  const bad = await rejects(() => importBackup(JSON.stringify({ formatVersion: 1, lesson: { title: "x", pages: [null] }, media: [] })));
  check("malformed backup pages rejected before touching anything", !!bad);
}

// ================================================================================
// 8. ImportTransaction bookkeeping
// ================================================================================
{
  const tx = new ImportTransaction({ mediaService });
  const rec = await tx.importBytes("image", PNG(50), "tx.png", "image/png");
  check("transaction tracks only what it created", tx.has(rec.id) && tx.createdIds.length === 1);
  const out = await tx.rollback();
  check("rollback removes exactly the tracked media", out.removed.length === 1 && !libraryIds().includes(rec.id));
  const tx2 = new ImportTransaction({ mediaService });
  const rec2 = await tx2.importBytes("image", PNG(51), "tx2.png", "image/png");
  tx2.commit();
  const out2 = await tx2.rollback();
  check("a committed transaction can no longer roll anything back", out2.removed.length === 0 && libraryIds().includes(rec2.id));
}

done();
