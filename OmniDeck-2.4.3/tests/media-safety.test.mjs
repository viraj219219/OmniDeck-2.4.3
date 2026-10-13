// Regression tests: media deletion is ALWAYS reference-safe, and AI image
// accept/replace can never leave a lesson pointing at a deleted asset.
// Runs the real TauriMediaService + LessonService + MediaLifecycle code
// against a fault-injecting in-memory Tauri filesystem.

import { FakeDisk, installFakeTauri, makeChecker } from "./helpers/fakeDisk.mjs";

const { check, done } = makeChecker();

// Thumbnail generation needs a browser <canvas>/Image; in Node it fails
// (non-fatally, by design) — keep that expected noise out of the test log.
const realWarn = console.warn;
console.warn = (...a) => { if (String(a[0]).includes("thumbnail generation failed")) return; realWarn(...a); };

const disk = new FakeDisk();
installFakeTauri(disk);

const { mediaService, TauriMediaService, MediaInUseError } = await import("../src/js/services/MediaService.js");
const { lessonService } = await import("../src/js/services/LessonService.js");
const { replaceAcceptedImage, clearAcceptedImage, ReplaceMediaError } = await import("../src/js/services/MediaLifecycle.js");
const { collectPageMediaIds } = await import("../src/js/utils/mediaRefs.js");

const PNG = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);
const newImage = async (n, name = `img${n}.png`) => mediaService.importBytes("image", PNG(n), name, "image/png");
const libraryIds = () => (disk.has("media-library.json") ? disk.json("media-library.json").map((m) => m.id) : []);
const fileExists = (rec) => disk.has(rec.managedPath);
const mkLesson = (id, title, pages) => ({ id, title, createdAt: "t0", updatedAt: "t0", pages });
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---- fixtures ------------------------------------------------------------
const mUnused = await newImage(1, "unused.png");
const mPage = await newImage(2, "page.png");
const mAccepted = await newImage(3, "accepted.png");
const mBox = await newImage(4, "box.png");
const mBackground = await newImage(5, "background.png");
const mShared = await newImage(6, "shared.png");
const mOnlySaved = await newImage(7, "only-saved.png");

disk.files.set("lessons.json", JSON.stringify([
  mkLesson("A", "Lesson A", [
    { id: "a1", type: "image", mediaId: mPage.id },
    { id: "a2", type: "scripture", acceptedImage: { mediaId: mAccepted.id } },
    { id: "a3", type: "title", boxes: [{ id: "b", mediaId: mBox.id }] },
    { id: "a4", type: "title", background: { mediaId: mBackground.id } },
    { id: "a5", type: "image", mediaId: mShared.id },
    { id: "a6", type: "image", mediaId: mOnlySaved.id },
  ]),
  mkLesson("B", "Lesson B", [{ id: "b1", type: "image", mediaId: mShared.id }]),
], null, 2));

check("fixtures: every media file exists on disk", [mUnused, mPage, mAccepted, mBox, mBackground, mShared, mOnlySaved].every(fileExists));
check("every reference field is recognised (incl. page.background — previously missed)",
  collectPageMediaIds({ mediaId: "1", acceptedImage: { mediaId: "2" }, boxes: [{ mediaId: "3" }], background: { mediaId: "4" } }).size === 4);

// ---- deletion: unused vs referenced --------------------------------------------
{
  const r = await mediaService.removeMedia(mUnused.id);
  check("unused media can be deleted (legitimate cleanup still works)", r.removed === true && !fileExists(mUnused) && !libraryIds().includes(mUnused.id));
}
for (const [label, rec] of [["page.mediaId", mPage], ["AI accepted image", mAccepted], ["text/image box", mBox], ["page background", mBackground]]) {
  const err = await rejects(() => mediaService.removeMedia(rec.id));
  check(`deletion refused while referenced by ${label}`, err instanceof MediaInUseError && err.code === "in-use");
  check(`…and the ${label} file + record are untouched`, fileExists(rec) && libraryIds().includes(rec.id));
}

// ---- cross-lesson references ---------------------------------------------------------
{
  const lessonA = await lessonService.getLesson("A");
  lessonA.pages = lessonA.pages.filter((p) => p.id !== "a5"); // A no longer uses it…
  await lessonService.saveLesson(lessonA);
  const err = await rejects(() => mediaService.removeMedia(mShared.id));
  check("image still used by ANOTHER lesson is kept", err instanceof MediaInUseError && fileExists(mShared));
  check("…and the error names the lesson that still uses it", err?.lessons?.[0]?.title === "Lesson B");
  const lessonB = await lessonService.getLesson("B");
  lessonB.pages = [];
  await lessonService.saveLesson(lessonB);
  const r = await mediaService.removeMedia(mShared.id);
  check("once no lesson references it, it can be deleted", r.removed === true && !fileExists(mShared));
}

// ---- unsaved removal of a reference must not free the file --------------------------------
{
  const lessonA = await lessonService.getLesson("A");
  lessonA.pages = lessonA.pages.filter((p) => p.id !== "a6"); // removed in memory, NOT saved
  const err = await rejects(() => mediaService.removeMedia(mOnlySaved.id));
  check("reference removed in memory but still in the SAVED lesson: deletion refused", err instanceof MediaInUseError && fileExists(mOnlySaved));
  await lessonService.saveLesson(lessonA);
  const r = await mediaService.removeMedia(mOnlySaved.id);
  check("after the lesson save succeeds the file can go", r.removed === true && !fileExists(mOnlySaved));
}

// ---- fails closed --------------------------------------------------------------------------
{
  const bare = new TauriMediaService(); // no reference checker registered
  const keep = await newImage(9, "fail-closed.png");
  const e1 = await rejects(() => bare.removeMedia(keep.id));
  check("no reference checker registered: deletion refused (fails closed)", e1 instanceof MediaInUseError && e1.code === "unverifiable" && fileExists(keep));
  bare.setReferenceProvider(async () => { throw new Error("lessons unreadable"); });
  const e2 = await rejects(() => bare.removeMedia(keep.id));
  check("reference check itself failing: deletion refused", e2?.code === "unverifiable" && fileExists(keep));
  const r = await mediaService.removeMedia("does-not-exist");
  check("deleting an unknown id is a harmless no-op", r.removed === false);
  await mediaService.removeMedia(keep.id);
}

// ---- deletion failure modes -----------------------------------------------------------------
{
  const rec = await newImage(10, "stuck.png");
  disk.failOn("remove", rec.managedPath, { times: 1 });
  const err = await rejects(() => mediaService.removeMedia(rec.id));
  check("file that can't be deleted: error surfaced, record KEPT so it can be retried", !!err && libraryIds().includes(rec.id) && fileExists(rec));
  const r = await mediaService.removeMedia(rec.id);
  check("retry after the transient failure succeeds", r.removed === true && !fileExists(rec));

  const rec2 = await newImage(11, "persist-fail.png");
  disk.failOn("write", "media-library.json.tmp", { times: 1 });
  const err2 = await rejects(() => mediaService.removeMedia(rec2.id));
  check("library save failing after the file is gone: record put back, error thrown", !!err2 && libraryIds().includes(rec2.id));
  await mediaService.removeMedia(rec2.id);
}

// ---- lesson / page deletion never physically deletes media --------------------------------------
{
  const keep = await newImage(12, "survivor.png");
  const l = mkLesson("C", "Lesson C", [{ id: "c1", type: "image", mediaId: keep.id }, { id: "c2", type: "title" }]);
  await lessonService.insertLesson(l);
  await lessonService.removePage("C", "c1");
  await lessonService.deleteLesson("C");
  check("deleting a page / lesson leaves the media file alone (never deletes it unsafely)", fileExists(keep) && libraryIds().includes(keep.id));
  await mediaService.removeMedia(keep.id);
}

// ---- converted-page folders are cleaned with the record -------------------------------------------
{
  const rec = await mediaService.importBytes("pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]), "deck.pdf", "application/pdf");
  disk.files.set(`media/pdfs/${rec.id}-slides/slide-1.png`, PNG(1));
  disk.files.set(`media/pdfs/${rec.id}-slides/slide-2.png`, PNG(2));
  await mediaService.removeMedia(rec.id);
  check("deleting a converted PDF also removes its page-image folder (even if slidesDir wasn't recorded)", disk.list(`media/pdfs/${rec.id}-slides`).length === 0);
}

// ==========================================================================================
// AI image accept / replace transaction
// ==========================================================================================
async function setupLesson(id, oldRec, extraPages = []) {
  const page = { id: `${id}-scr`, type: "scripture", reference: "John 3:16", acceptedImage: oldRec ? { mediaId: oldRec.id, reference: "John 3:16", generatedAt: "t" } : null };
  const lesson = mkLesson(id, `Lesson ${id}`, [page, ...extraPages]);
  await lessonService.insertLesson(lesson);
  return { lesson, page };
}
const persistFor = (lesson) => async () => { await lessonService.saveLesson(lesson); };
const savedAccepted = (lessonId) => disk.json("lessons.json").find((l) => l.id === lessonId).pages[0].acceptedImage?.mediaId;

// ---- successful replacement -------------------------------------------------------------------------
{
  const old = await newImage(20, "old-illustration.png");
  const { lesson, page } = await setupLesson("R1", old);
  const res = await replaceAcceptedImage({
    page, bytes: PNG(21), mime: "image/png", name: "new-illustration.png", generatedAt: "t2",
    persist: persistFor(lesson), verifyPersisted: (id) => lessonService.getPersistedMediaIds().has(id), mediaService,
  });
  check("replace: new image exists on disk and in the library", fileExists(res.record) && libraryIds().includes(res.record.id));
  check("replace: the SAVED lesson points at the new image", savedAccepted("R1") === res.record.id && page.acceptedImage.mediaId === res.record.id);
  check("replace: old image deleted only after the save (unused -> removed)", res.oldMedia.status === "removed" && !fileExists(old) && !libraryIds().includes(old.id));
}

// ---- failed lesson save ---------------------------------------------------------------------------------
{
  const old = await newImage(22, "still-needed.png");
  const { lesson, page } = await setupLesson("R2", old);
  const recordsBefore = libraryIds().length;
  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  const err = await rejects(() => replaceAcceptedImage({
    page, bytes: PNG(23), mime: "image/png", name: "n.png", generatedAt: "t3",
    persist: persistFor(lesson), verifyPersisted: (id) => lessonService.getPersistedMediaIds().has(id), mediaService,
  }));
  check("failed save: ReplaceMediaError at stage 'persist'", err instanceof ReplaceMediaError && err.stage === "persist");
  check("failed save: OLD media kept (file + record)", fileExists(old) && libraryIds().includes(old.id));
  check("failed save: lesson (memory) goes back to the old image — not left pointing at a phantom", page.acceptedImage.mediaId === old.id);
  check("failed save: the saved lesson on disk still points at the old, existing image", savedAccepted("R2") === old.id);
  check("failed save: NEW media kept for recovery/retry (nothing deleted on a failed path)", !!err.newMediaId && libraryIds().includes(err.newMediaId) && libraryIds().length === recordsBefore + 1);

  // Retry reuses the already-imported asset instead of importing a duplicate.
  const res = await replaceAcceptedImage({
    page, bytes: PNG(23), mime: "image/png", name: "n.png", generatedAt: "t3",
    persist: persistFor(lesson), verifyPersisted: (id) => lessonService.getPersistedMediaIds().has(id), mediaService,
    reuseRecord: { id: err.newMediaId },
  });
  check("retry after a failed save reuses the imported asset (no duplicate: library size back to what it was, old one released)", res.record.id === err.newMediaId && libraryIds().length === recordsBefore);
  check("retry: the lesson now saves with the new image and the old one is released", savedAccepted("R2") === err.newMediaId && !fileExists(old));
}

// ---- old image referenced elsewhere ----------------------------------------------------------------------
{
  const shared = await newImage(24, "used-twice.png");
  const other = mkLesson("R3-other", "Other lesson", [{ id: "o1", type: "image", mediaId: shared.id }]);
  await lessonService.insertLesson(other);
  const { lesson, page } = await setupLesson("R3", shared);
  const res = await replaceAcceptedImage({ page, bytes: PNG(25), mime: "image/png", name: "n3.png", generatedAt: "t4", persist: persistFor(lesson), mediaService });
  check("old image also used by another lesson: replacement succeeds…", savedAccepted("R3") === res.record.id);
  check("…but the old image is KEPT", res.oldMedia.status === "kept-referenced" && fileExists(shared) && libraryIds().includes(shared.id));
}

// ---- new image import failure ------------------------------------------------------------------------------
{
  const old = await newImage(26, "safe-old.png");
  const { lesson, page } = await setupLesson("R4", old);
  const filesBefore = disk.list("media/images").length;
  const idsBefore = libraryIds().length;
  disk.failOn("write", /^media\/images\/.*\.png$/, { times: 1, partial: true });
  const err = await rejects(() => replaceAcceptedImage({ page, bytes: PNG(27), mime: "image/png", name: "n4.png", generatedAt: "t5", persist: persistFor(lesson), mediaService }));
  check("new image import failure: ReplaceMediaError at stage 'import'", err instanceof ReplaceMediaError && err.stage === "import");
  check("…lesson untouched, still on the old image", page.acceptedImage.mediaId === old.id && savedAccepted("R4") === old.id);
  check("…old media kept", fileExists(old) && libraryIds().includes(old.id));
  check("…no orphan file or ghost record from the failed import", disk.list("media/images").length === filesBefore && libraryIds().length === idsBefore);
  const err2 = await rejects(() => replaceAcceptedImage({ page, bytes: new Uint8Array(0), mime: "image/png", name: "empty.png", generatedAt: "t", persist: persistFor(lesson), mediaService }));
  check("an empty image is refused rather than saved", err2?.stage === "import" && page.acceptedImage.mediaId === old.id);
}

// ---- deletion failure AFTER a successful save -----------------------------------------------------------------
{
  const old = await newImage(28, "undeletable.png");
  const { lesson, page } = await setupLesson("R5", old);
  disk.failOn("remove", old.managedPath, { times: 5 });
  const res = await replaceAcceptedImage({ page, bytes: PNG(29), mime: "image/png", name: "n5.png", generatedAt: "t6", persist: persistFor(lesson), verifyPersisted: (id) => lessonService.getPersistedMediaIds().has(id), mediaService });
  check("deletion failure after a successful save is NOT fatal: the lesson has the new image", savedAccepted("R5") === res.record.id && fileExists(res.record));
  check("…the failure is reported (delete-failed) and the old file is simply kept", res.oldMedia.status === "delete-failed" && fileExists(old) && libraryIds().includes(old.id));
  disk.clearFaults();
}

// ---- persistence verification -----------------------------------------------------------------------------------
{
  const old = await newImage(30, "verify-old.png");
  const { lesson, page } = await setupLesson("R6", old);
  const err = await rejects(() => replaceAcceptedImage({ page, bytes: PNG(31), mime: "image/png", name: "n6.png", generatedAt: "t7", persist: persistFor(lesson), verifyPersisted: () => false, mediaService }));
  check("save 'succeeded' but doesn't contain the new reference: treated as failure, old kept", err?.stage === "verify-persist" && page.acceptedImage.mediaId === old.id && fileExists(old));
}

// ---- Remove accepted image ----------------------------------------------------------------------------------------------
{
  const old = await newImage(32, "to-clear.png");
  const { lesson, page } = await setupLesson("R7", old);
  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  const err = await rejects(() => clearAcceptedImage({ page, persist: persistFor(lesson), mediaService }));
  check("Remove with a failed save: reference restored, file NOT deleted", !!err && page.acceptedImage?.mediaId === old.id && fileExists(old) && savedAccepted("R7") === old.id);
  const res = await clearAcceptedImage({ page, persist: persistFor(lesson), mediaService });
  check("Remove with a successful save: reference cleared and saved, then the unused file is deleted", page.acceptedImage === null && savedAccepted("R7") === undefined && res.oldMedia.status === "removed" && !fileExists(old));
}

done();
