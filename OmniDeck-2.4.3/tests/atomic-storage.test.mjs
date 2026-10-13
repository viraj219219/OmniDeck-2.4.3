// Regression tests for crash-safe persistence (atomicFile.js + storageAdapter.js):
// atomic save, .bak maintenance, failed temp write, corrupted primary with
// valid/corrupt backup, missing primary, preservation after failed save,
// per-file serialization, and an exhaustive crash-at-every-step fuzz.

import { FakeDisk, installFakeTauri, makeChecker, CrashError } from "./helpers/fakeDisk.mjs";

const { check, done } = makeChecker();

const disk = new FakeDisk();
installFakeTauri(disk);
const adapter = await import("../src/js/utils/storageAdapter.js");
const atomic = await import("../src/js/utils/atomicFile.js");
const { readJSON, writeJSON, writeJSONStrict, StorageReadError, StorageWriteError } = adapter;
const noSleep = async () => {};
const isArray = Array.isArray;

const V1 = [{ id: "a", title: "Lesson One" }];
const V2 = [{ id: "a", title: "Lesson One (edited)" }, { id: "b", title: "Lesson Two" }];
const V3 = [{ id: "c", title: "Third" }];

// ---- successful atomic save + backup --------------------------------------
check("first save succeeds through the Tauri fs (Windows-style app dir)", (await writeJSON("lessons.json", V1)) === true);
check("primary holds the saved data", JSON.stringify(disk.json("lessons.json")) === JSON.stringify(V1));
check("no .tmp left behind after a successful save", !disk.has("lessons.json.tmp"));
check("first save has no backup yet (nothing to back up)", !disk.has("lessons.json.bak"));
check("pretty-printed format is preserved (schema/format unchanged)", disk.text("lessons.json") === JSON.stringify(V1, null, 2));

await writeJSON("lessons.json", V2);
check("second save replaces the primary", JSON.stringify(disk.json("lessons.json")) === JSON.stringify(V2));
check("backup now holds the previous known-good version", JSON.stringify(disk.json("lessons.json.bak")) === JSON.stringify(V1));
check("no .tmp / .bak.tmp leftovers", !disk.has("lessons.json.tmp") && !disk.has("lessons.json.bak.tmp"));
check("readJSON returns the latest data", JSON.stringify(await readJSON("lessons.json", null)) === JSON.stringify(V2));

// ---- failed temporary write ------------------------------------------------
disk.failOn("write", "lessons.json.tmp", { partial: true });
check("failed tmp write reports failure (false)", (await writeJSON("lessons.json", V3)) === false);
check("primary untouched after failed tmp write", JSON.stringify(disk.json("lessons.json")) === JSON.stringify(V2));
check("backup untouched after failed tmp write", JSON.stringify(disk.json("lessons.json.bak")) === JSON.stringify(V1));
check("partial tmp file cleaned up", !disk.has("lessons.json.tmp"));
let err = null;
disk.failOn("write", "lessons.json.tmp");
try { await writeJSONStrict("lessons.json", V3); } catch (e) { err = e; }
check("strict save throws StorageWriteError with stage tmp-write", err instanceof StorageWriteError && err.stage === "tmp-write");

// ---- write that silently truncates (verify stage) ---------------------------
const realWrite = disk.writeRaw.bind(disk);
disk.writeRaw = async (p, d) => realWrite(p, typeof d === "string" && p.endsWith(".tmp") ? d.slice(0, 5) : d);
err = null;
try { await writeJSONStrict("lessons.json", V3); } catch (e) { err = e; }
disk.writeRaw = realWrite;
check("truncated tmp is caught by read-back verification", err?.stage === "verify");
check("primary intact after verify failure", JSON.stringify(disk.json("lessons.json")) === JSON.stringify(V2));

// ---- failed rename (commit) keeps the old version --------------------------
disk.failOn("rename", "lessons.json.tmp", { times: 99 });
err = null;
try { await atomic.atomicWriteText(disk.ops(), "lessons.json", JSON.stringify(V3), { sleep: noSleep }); } catch (e) { err = e; }
check("failed commit throws stage=commit", err?.stage === "commit");
check("preservation of existing data after failed save (primary)", JSON.stringify(disk.json("lessons.json")) === JSON.stringify(V2));
disk.clearFaults();
check("read after failed commit still returns last good data", JSON.stringify(await readJSON("lessons.json", null)) === JSON.stringify(V2));
check("a later save succeeds and wins", (await writeJSON("lessons.json", V3)) === true && JSON.stringify(disk.json("lessons.json")) === JSON.stringify(V3));

// ---- backup refresh failure aborts without harming anything -----------------
disk.failOn("write", "lessons.json.bak.tmp");
check("backup-refresh failure aborts the save", (await writeJSON("lessons.json", V1)) === false);
check("primary still the last good version", JSON.stringify(disk.json("lessons.json")) === JSON.stringify(V3));

// ---- refuse invalid data ----------------------------------------------------
check("undefined data refused", (await writeJSON("x.json", undefined)) === false && !disk.has("x.json"));
check("validator rejects wrong-shaped data before touching disk",
  (await writeJSON("lessons.json", { not: "array" }, { validate: isArray })) === false &&
  JSON.stringify(disk.json("lessons.json")) === JSON.stringify(V3));

// ---- corrupted primary + valid backup -> auto-recovery ----------------------
const d2 = new FakeDisk();
await atomic.atomicWriteText(d2.ops(), "lessons.json", JSON.stringify(V1, null, 2));
await atomic.atomicWriteText(d2.ops(), "lessons.json", JSON.stringify(V2, null, 2));
d2.files.set("lessons.json", '{"id": "half-writ');
const notices = [];
const off = atomic.onStorageRecovery((n) => notices.push(n));
const recovered = await atomic.readWithRecovery(d2.ops(), "lessons.json", null, { validate: isArray, sleep: noSleep, now: () => 1234 });
off();
check("corrupted primary + valid backup: returns the backup's data", JSON.stringify(recovered) === JSON.stringify(V1));
check("recovered backup restored as the primary on disk", JSON.stringify(d2.json("lessons.json")) === JSON.stringify(V1));
check("backup file itself left intact as a source", JSON.stringify(d2.json("lessons.json.bak")) === JSON.stringify(V1));
check("corrupt original quarantined, not deleted", d2.text("lessons.json.corrupt-1234") === '{"id": "half-writ');
check("recovery announced (log + listener)", notices.length === 1 && notices[0].file === "lessons.json" && notices[0].source === "lessons.json.bak");

// ---- primary valid JSON but wrong shape -> also recovered -------------------
d2.files.set("lessons.json", '{"looks":"fine but is not a lessons array"}');
const recovered2 = await atomic.readWithRecovery(d2.ops(), "lessons.json", null, { validate: isArray, sleep: noSleep });
check("wrong-shaped primary is treated as corrupt and recovered", JSON.stringify(recovered2) === JSON.stringify(V1));

// ---- corrupted primary + corrupted backup -> fail loudly, change nothing ----
const d3 = new FakeDisk();
d3.files.set("lessons.json", "{bad primary");
d3.files.set("lessons.json.bak", "{bad backup");
err = null;
let leaked = "NOT-THROWN";
try { leaked = await atomic.readWithRecovery(d3.ops(), "lessons.json", [], { sleep: noSleep }); } catch (e) { err = e; }
check("both corrupted: throws instead of returning fallback/empty", err instanceof StorageReadError && leaked === "NOT-THROWN");
check("both corrupted: error code is 'corrupt'", err?.code === "corrupt");
check("both corrupted: message says nothing was overwritten", /Nothing was overwritten/.test(err?.message || ""));
check("both corrupted: primary bytes untouched", d3.text("lessons.json") === "{bad primary");
check("both corrupted: backup bytes untouched", d3.text("lessons.json.bak") === "{bad backup");

// corrupted primary, no backup at all
const d4 = new FakeDisk();
d4.files.set("lessons.json", "{bad");
err = null;
try { await atomic.readWithRecovery(d4.ops(), "lessons.json", [], { sleep: noSleep }); } catch (e) { err = e; }
check("corrupted primary with no backup throws 'corrupt' (never empty)", err?.code === "corrupt");

// ---- missing primary + valid backup ------------------------------------------
const d5 = new FakeDisk();
d5.files.set("lessons.json.bak", JSON.stringify(V2, null, 2));
const r5 = await atomic.readWithRecovery(d5.ops(), "lessons.json", null, { sleep: noSleep });
check("missing primary + valid backup: data recovered", JSON.stringify(r5) === JSON.stringify(V2));
check("missing primary: backup restored as primary", JSON.stringify(d5.json("lessons.json")) === JSON.stringify(V2));

// missing primary + corrupt backup must not look like first run
const d6 = new FakeDisk();
d6.files.set("lessons.json.bak", "{bad");
err = null;
try { await atomic.readWithRecovery(d6.ops(), "lessons.json", [], { sleep: noSleep }); } catch (e) { err = e; }
check("missing primary + corrupt backup throws (not first-run fallback)", err?.code === "corrupt");

// genuine first run
check("nothing on disk at all -> fallback (first run)", (await atomic.readWithRecovery(new FakeDisk().ops(), "lessons.json", "FALLBACK", { sleep: noSleep })) === "FALLBACK");

// ---- unreadable primary is not "recovered" over ------------------------------
const d7 = new FakeDisk();
await atomic.atomicWriteText(d7.ops(), "lessons.json", JSON.stringify(V1));
await atomic.atomicWriteText(d7.ops(), "lessons.json", JSON.stringify(V2));
d7.failOn("read", "lessons.json", { times: 1 });
err = null;
try { await atomic.readWithRecovery(d7.ops(), "lessons.json", [], { sleep: noSleep }); } catch (e) { err = e; }
check("unreadable primary throws 'unreadable' (no silent recovery over a locked file)", err?.code === "unreadable");
check("unreadable primary left alone", JSON.stringify(d7.json("lessons.json")) === JSON.stringify(V2));

// ---- corrupt primary must never overwrite the good backup on next save ------
const d8 = new FakeDisk();
await atomic.atomicWriteText(d8.ops(), "lessons.json", JSON.stringify(V1));
await atomic.atomicWriteText(d8.ops(), "lessons.json", JSON.stringify(V2));
d8.files.set("lessons.json", "{corrupt");
await atomic.atomicWriteText(d8.ops(), "lessons.json", JSON.stringify(V3));
check("saving over a corrupt primary keeps the older valid backup", JSON.stringify(d8.json("lessons.json.bak")) === JSON.stringify(V1));
check("…and writes the new version", JSON.stringify(d8.json("lessons.json")) === JSON.stringify(V3));

// ---- uncommitted-but-complete tmp is used when nothing else is ---------------
const d9 = new FakeDisk();
d9.files.set("lessons.json.tmp", JSON.stringify(V3));
const r9 = await atomic.readWithRecovery(d9.ops(), "lessons.json", null, { sleep: noSleep });
check("interrupted very first save: complete tmp is promoted", JSON.stringify(r9) === JSON.stringify(V3) && d9.has("lessons.json") && !d9.has("lessons.json.tmp"));

// ---- per-file serialization in the adapter ------------------------------------
const d10 = new FakeDisk();
installFakeTauri(d10);
await Promise.all(Array.from({ length: 12 }, (_, i) => writeJSON("busy.json", [{ n: i }])));
check("12 overlapping writeJSON calls never write the same path concurrently", d10.maxConcurrentPerPath <= 1);
check("last queued write wins on disk", JSON.stringify(d10.json("busy.json")) === JSON.stringify([{ n: 11 }]));
installFakeTauri(disk);

// ---- deleteJSON removes every sibling ------------------------------------------
await writeJSON("gone.json", [1]);
await writeJSON("gone.json", [2]);
await adapter.deleteJSON("gone.json");
check("deleteJSON removes main/.bak/.tmp", disk.list("gone.json").length === 0);

// ---- crash-at-every-step fuzz: a power cut anywhere never loses BOTH versions --
{
  let worst = "ok";
  let steps = 0;
  for (let k = 1; k <= 40; k++) {
    const d = new FakeDisk();
    await atomic.atomicWriteText(d.ops(), "lessons.json", JSON.stringify(V1, null, 2));
    await atomic.atomicWriteText(d.ops(), "lessons.json", JSON.stringify(V2, null, 2));
    d.mutations = 0; d.crashAt = k;
    let crashed = false;
    try { await atomic.atomicWriteText(d.ops(), "lessons.json", JSON.stringify(V3, null, 2), { sleep: noSleep }); }
    catch (e) { crashed = e instanceof CrashError || e instanceof StorageWriteError; }
    if (!crashed) break; // finished before reaching mutation k: every step covered
    steps = k;
    d.dead = false; d.crashAt = null; // "restart the app"
    let data, threw = null;
    try { data = await atomic.readWithRecovery(d.ops(), "lessons.json", null, { validate: isArray, sleep: noSleep }); } catch (e) { threw = e; }
    const s = JSON.stringify(data);
    if (threw || (s !== JSON.stringify(V2) && s !== JSON.stringify(V3))) { worst = `crash at mutation ${k}: ${threw ? threw.message : s}`; break; }
  }
  check(`crash injected at each of ${steps} steps of a save: restart always yields the old or new version (${worst})`, worst === "ok" && steps >= 4);
}

done();
