// Regression tests for the single serialized persistence pipeline:
//   - SerialSaveQueue itself (at most one write active, coalescing, latest
//     state wins, failure never poisons later saves, flush retries)
//   - LessonService running its REAL code against a fault-injecting
//     in-memory Tauri filesystem: rapid saves, autosave + manual save at
//     once, edits during a pending save, failed-then-successful save, and
//     "final disk state == latest in-memory state".

import { FakeDisk, installFakeTauri, makeChecker } from "./helpers/fakeDisk.mjs";

const { check, done } = makeChecker();

const disk = new FakeDisk();
installFakeTauri(disk);
const mkLesson = (id, title) => ({ id, title, createdAt: "t0", updatedAt: "t0", pages: [{ id: `${id}-p1`, type: "title", title }] });
disk.files.set("lessons.json", JSON.stringify([mkLesson("l1", "One"), mkLesson("l2", "Two")], null, 2));

const { SerialSaveQueue } = await import("../src/js/utils/SaveQueue.js");
const { lessonService } = await import("../src/js/services/LessonService.js");
const { hasPendingChanges, flushAll } = await import("../src/js/services/ShutdownService.js");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}

// =====================================================================
// SerialSaveQueue in isolation
// =====================================================================
{
  let state = 0;
  const written = [];
  let active = 0, maxActive = 0;
  const g = gate();
  let firstWrite = true;
  const q = new SerialSaveQueue(async () => {
    const snapshot = state; // snapshot synchronously at write start
    active++; maxActive = Math.max(maxActive, active);
    if (firstWrite) { firstWrite = false; await g.promise; }
    await tick(1);
    written.push(snapshot);
    active--;
  });

  state = 1;
  const pA = q.request();          // change A -> save A starts
  await tick();
  state = 2;
  const pB = q.request();          // change B while A is saving -> waits
  state = 3;
  const pC = q.request();          // change C while A is saving -> coalesces with B
  check("queue: B and C do not start while A is writing", written.length === 0 && q.writesStarted === 1);
  g.open();
  await Promise.all([pA, pB, pC]);
  check("queue: at most one write ever active", maxActive === 1 && q.maxConcurrent === 1);
  check("queue: A wrote its own snapshot, then ONE coalesced write carried the latest state", JSON.stringify(written) === "[1,3]");
  check("queue: B and C shared a single follow-up write (2 writes for 3 requests)", q.writesStarted === 2);
  check("queue: idle afterwards", !q.hasPending);
}

{
  let calls = 0;
  let boom = true;
  const q = new SerialSaveQueue(async () => { calls++; if (boom) { boom = false; throw new Error("disk full"); } });
  let err = null;
  await q.request().catch((e) => { err = e; });
  check("queue: a failed write rejects its request with the real error", err?.message === "disk full");
  check("queue: failure is remembered (lastError)", q.lastError?.message === "disk full");
  await q.request();
  check("queue: a later request succeeds — failure does not poison the queue", calls === 2 && q.lastError === null);

  boom = true;
  await q.request().catch(() => {});
  await q.flush(); // must make a fresh attempt for the state that only lives in memory
  check("queue: flush() retries after a failed write and then settles", calls === 4 && q.lastError === null && !q.hasPending);
}

{
  const q = new SerialSaveQueue(async () => { throw new Error("still broken"); });
  await q.request().catch(() => {});
  let err = null;
  await q.flush().catch((e) => { err = e; });
  check("queue: flush() rejects if the retry fails too (caller must not assume saved)", err?.message === "still broken");
}

{
  // A waiter's promise must not resolve on a write that started BEFORE it asked.
  let state = "old";
  const seen = [];
  const g = gate();
  let first = true;
  const q = new SerialSaveQueue(async () => {
    const snap = state;
    if (first) { first = false; await g.promise; }
    seen.push(snap);
  });
  const p1 = q.request();
  await tick();
  state = "new";
  let p2Done = false;
  const p2 = q.request().then(() => { p2Done = true; });
  g.open();
  await p1;
  await tick(0);
  check("queue: a request made mid-write is NOT satisfied by the older in-flight write", seen.length >= 1 && (p2Done === false || seen.includes("new")));
  await p2;
  check("queue: …it resolves only after a write that captured the newer state", seen.at(-1) === "new");
}

// =====================================================================
// LessonService on the fault-injecting disk
// =====================================================================
const realWrite = disk.writeRaw.bind(disk);
let writeGate = null;
disk.writeRaw = async (p, d) => {
  if (writeGate && disk.norm(p) === "lessons.json.tmp") await writeGate.promise;
  return realWrite(p, d);
};
const onDisk = () => disk.json("lessons.json");
const titleOnDisk = (id) => onDisk().find((l) => l.id === id)?.title;

const l1 = await lessonService.getLesson("l1");
check("loads the existing library from disk", l1?.title === "One");

// ---- rapid consecutive saves ---------------------------------------------
{
  const before = lessonService._queue.writesStarted;
  const promises = [];
  for (let i = 0; i < 25; i++) {
    l1.title = `Rapid ${i}`;
    promises.push(lessonService.saveLesson(l1));
  }
  await Promise.all(promises);
  check("rapid saves: no path was ever written by two writers at once", disk.maxConcurrentPerPath <= 1);
  check("rapid saves: queue never ran two writes concurrently", lessonService._queue.maxConcurrent === 1);
  check("rapid saves: 25 requests coalesced into far fewer writes", lessonService._queue.writesStarted - before < 25);
  check("rapid saves: final disk state is the LAST edit", titleOnDisk("l1") === "Rapid 24");
}

// ---- autosave + manual save simultaneously ---------------------------------
{
  l1.title = "Autosave text";
  const autosave = lessonService.saveLesson(l1);   // what the debounce timer does
  l1.title = "Manual save text";
  const manual = lessonService.saveLesson(l1);     // the explicit Save/Retry click
  await Promise.all([autosave, manual]);
  check("autosave + manual save share one pipeline and the later state wins", titleOnDisk("l1") === "Manual save text");
  check("autosave + manual save: still never concurrent on any path", disk.maxConcurrentPerPath <= 1);
}

// ---- multiple edits during a pending save ------------------------------------
{
  const startBefore = lessonService._queue.writesStarted;
  writeGate = gate();
  l1.title = "Edit A";
  const a = lessonService.saveLesson(l1);
  await tick(10); // A's write is now blocked mid-flight
  check("edits during a pending save: A is in flight", lessonService._queue.hasPending && titleOnDisk("l1") === "Manual save text");
  l1.title = "Edit B";
  const b = lessonService.saveLesson(l1);
  l1.title = "Edit C";
  l1.pages.push({ id: "l1-p2", type: "conclusion", body: "added during the save" });
  const c = lessonService.saveLesson(l1);
  check("edits during a pending save: nothing overlaps while A is stuck", disk.maxConcurrentPerPath <= 1 && lessonService._queue.writesStarted - startBefore === 1);
  const open = writeGate.open;
  writeGate = null;
  open();
  await Promise.all([a, b, c]);
  check("edits during a pending save: exactly one follow-up write (B+C coalesced)", lessonService._queue.writesStarted - startBefore === 2);
  check("edits during a pending save: disk has the LATEST state (C + the new page)", titleOnDisk("l1") === "Edit C" && onDisk().find((l) => l.id === "l1").pages.length === 2);
}

// ---- failed save followed by a successful save ---------------------------------
{
  const goodTitle = titleOnDisk("l1");
  disk.failOn("write", "lessons.json.tmp", { times: 1, partial: true });
  l1.title = "Edit that fails to save";
  l1.pages.push({ id: "l1-p3", type: "discussion", prompt: "kept in memory" });
  let err = null;
  await lessonService.saveLesson(l1).catch((e) => { err = e; });
  check("failed save: the caller gets a real error", /Failed to save lessons/.test(err?.message || ""));
  check("failed save: the previously saved version is untouched on disk", titleOnDisk("l1") === goodTitle);
  check("failed save: the primary is still a complete valid document", Array.isArray(onDisk()));
  check("failed save: the edit is still in memory (not silently discarded)", l1.title === "Edit that fails to save");

  l1.title = "Edit after the failure";
  await lessonService.saveLesson(l1);
  check("failed then successful save: disk = latest state", titleOnDisk("l1") === "Edit after the failure");
  check("failed then successful save: the earlier failed edit's page was persisted too", onDisk().find((l) => l.id === "l1").pages.some((p) => p.id === "l1-p3"));
}

// ---- flush() retries a failed save ------------------------------------------------
{
  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  l1.title = "Flush me";
  await lessonService.saveLesson(l1).catch(() => {});
  check("flush setup: the save failed and the edit is unsaved", titleOnDisk("l1") !== "Flush me");
  await lessonService.flush();
  check("flush(): retries the failed save and persists the latest state", titleOnDisk("l1") === "Flush me");
}

// ---- rollback of create / delete / append on failed save ------------------------------
{
  const count = () => onDisk().length;
  const n = count();

  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  await lessonService.insertLesson(mkLesson("ghost", "Ghost")).catch(() => {});
  check("failed create: no ghost lesson in memory", !(await lessonService.getLesson("ghost")));
  check("failed create: nothing changed on disk", count() === n);

  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  await lessonService.deleteLesson("l2").catch(() => {});
  check("failed delete: the lesson is still there (no pretend-delete)", !!(await lessonService.getLesson("l2")));
  check("failed delete: still on disk", onDisk().some((l) => l.id === "l2"));

  const pagesBefore = l1.pages.length;
  disk.failOn("write", "lessons.json.tmp", { times: 1 });
  await lessonService.appendPages("l1", [{ id: "imp1", type: "image" }, { id: "imp2", type: "image" }]).catch(() => {});
  check("failed appendPages: none of the imported pages are left in the lesson", l1.pages.length === pagesBefore && !l1.pages.some((p) => p.id === "imp1"));

  await lessonService.appendPages("l1", [{ id: "imp3", type: "image" }]);
  check("successful appendPages persists all pages in one save", onDisk().find((l) => l.id === "l1").pages.some((p) => p.id === "imp3"));
}

// ---- persisted-reference tracking (used by delete-safety) ---------------------------------
{
  l1.pages.push({ id: "l1-img", type: "image", mediaId: "media-A" });
  check("unsaved reference is not yet in the persisted set", !lessonService.getPersistedMediaIds().has("media-A"));
  await lessonService.saveLesson(l1);
  check("after a successful save the reference is in the persisted set", lessonService.getPersistedMediaIds().has("media-A"));
}

// ---- final disk state equals latest valid in-memory state ------------------------------------
{
  await lessonService.flush();
  const memory = JSON.parse(JSON.stringify(await lessonService.listLessons()));
  check("final disk state equals the latest in-memory state", JSON.stringify(onDisk()) === JSON.stringify(memory));
  check("no .tmp left behind and the backup is a valid array", !disk.has("lessons.json.tmp") && Array.isArray(disk.json("lessons.json.bak")));
  check("nothing pending after everything settled", !hasPendingChanges());
  const r = await flushAll();
  check("flushAll() reports ok when nothing is pending", r.ok === true);
}

done();
