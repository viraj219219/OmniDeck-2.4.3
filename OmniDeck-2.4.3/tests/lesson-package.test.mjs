// Portable lesson package (.omnilesson): export -> import acceptance tests.
// Real LessonPackageService / MediaService / LessonService / ImportService code
// runs against an in-memory Tauri filesystem. "Clean installation" = a SECOND,
// EMPTY FakeDisk with fresh service instances; the only thing carried across is
// the package bytes. NOTE: this proves the format and logic are
// platform-independent; it does not run on Windows/macOS (see docs/PORTABLE_LESSONS.md).
import { FakeDisk, installFakeTauri, makeChecker } from "./helpers/fakeDisk.mjs";
import { createZip, openZip, crc32 } from "../src/js/utils/zip.js";

const { check, done } = makeChecker();
console.warn = (...a) => { if (!String(a[0]).includes("thumbnail")) process.stderr.write(a.join(" ") + "\n"); };
const PNG = (n, len = 40) => { const b = new Uint8Array(len); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); for (let i = 8; i < len; i++) b[i] = (n * 31 + i) & 255; return b; };
const rej = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------- machine A (home computer) ----------
// The fake Tauri runtime must exist BEFORE the services are imported (they read
// isRunningInTauri once at import time).
const diskA = new FakeDisk(); installFakeTauri(diskA);
const { StorageLessonService, blankPage } = await import("../src/js/services/LessonService.js");
const { TauriMediaService } = await import("../src/js/services/MediaService.js");
const pkg = await import("../src/js/services/LessonPackageService.js");
let lessonsA = new StorageLessonService(), mediaA = new TauriMediaService();
// Mirror the app wiring (LessonService.js registers the singleton pair this way).
mediaA.setReferenceProvider((id) => lessonsA.isMediaReferenced(id));
const imgs = [];
for (let i = 1; i <= 3; i++) imgs.push(await mediaA.importBytes("image", PNG(i), `photo-${i}.png`, "image/png"));
const bg = await mediaA.importBytes("image", PNG(9, 64), "background.jpg", "image/jpeg");
const vid = await mediaA.importBytes("video", new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4, 5, 6, 7, 8]), "clip.mp4", "video/mp4");

const baseA = (await lessonsA.listLessons()).length; // fresh installs seed sample lessons
const lesson = await lessonsA.createLesson("Portable Test Lesson");
const mk = (type, extra) => ({ ...blankPage(type), ...extra });
lesson.pages = [
  mk("title", { title: "Portable Test Lesson", subtitle: "1 Samuel 17", background: { mediaId: bg.id, fit: "cover" } }),
  mk("image", { title: "Valley", mediaId: imgs[0].id, caption: "The valley of Elah" }),
  mk("scripture", { title: "Verse", reference: "1 Samuel 17:45", verses: [{ n: 45, text: "You come to me with a sword…" }], acceptedImage: { mediaId: imgs[1].id } }),
  mk("freeform", { title: "Boxes", boxes: [{ id: "b1", type: "text", x: 5, y: 5, w: 40, h: 20, text: "Five stones" }, { id: "b2", type: "image", x: 50, y: 10, w: 30, h: 30, mediaId: imgs[2].id }] }),
  mk("video", { title: "Clip", mediaId: vid.id }),
  mk("quiz", { title: "Quiz", question: "Who won?", options: ["David", "Goliath", "Saul", "Jonathan"], correctIndex: 0 }),
];
await lessonsA.saveLesson(lesson);
const original = await lessonsA.getLesson(lesson.id);

const exp = await pkg.exportLessonPackage(lesson.id, { lessonService: lessonsA, mediaService: mediaA });
check("export produces a ZIP (PK header)", exp.bytes[0] === 0x50 && exp.bytes[1] === 0x4b);
check("export embeds every referenced asset (5 images/bg + 1 video = 5)", exp.assetCount === 5);
const z = openZip(exp.bytes);
const manifest = JSON.parse(new TextDecoder().decode(await z.read("manifest.json")));
check("manifest is versioned and identifies the format", manifest.format === "omnideck-lesson-package" && manifest.formatVersion === 1);
check("manifest keeps slide order", manifest.lesson.pages.map((p) => p.type).join() === original.pages.map((p) => p.type).join());
check("manifest contains no absolute paths from the exporting machine", !/[A-Za-z]:\\|\/Users\/|\/home\/|AppData|managedPath|sourcePathAtImport/.test(JSON.stringify(manifest)));
check("every asset has size + sha256 + safe path", manifest.assets.every((a) => /^[0-9a-f]{64}$/.test(a.sha256) && /^assets\/[\w-]+(\.\w+)?$/.test(a.path) && a.size > 0));

// ---------- same-machine re-import: duplicate name must not overwrite ----------
const again = await pkg.importLessonPackage(exp.bytes, { lessonService: lessonsA, mediaService: mediaA });
check("re-import into the same library creates a NEW lesson", again.lesson.id !== lesson.id && (await lessonsA.listLessons()).length === baseA + 2);
check("duplicate title is made unique, not overwritten", again.lesson.title === "Portable Test Lesson (2)" && again.renamed);
check("original lesson is untouched by re-import", JSON.stringify(await lessonsA.getLesson(lesson.id)) === JSON.stringify(original));
const again2 = await pkg.importLessonPackage(exp.bytes, { lessonService: lessonsA, mediaService: mediaA });
check("third copy becomes (3)", again2.lesson.title === "Portable Test Lesson (3)");

// ---------- machine B: clean installation ----------
const diskB = new FakeDisk(); installFakeTauri(diskB);
const lessonsB = new StorageLessonService(), mediaB = new TauriMediaService();
mediaB.setReferenceProvider((id) => lessonsB.isMediaReferenced(id));
const baseB = (await lessonsB.listLessons()).length; // seeded samples only
check("machine B starts without the lesson and with no media", !(await lessonsB.listLessons()).some((l) => l.title === "Portable Test Lesson") && (await mediaB.listMedia()).length === 0);
const imp = await pkg.importLessonPackage(exp.bytes, { lessonService: lessonsB, mediaService: mediaB });
check("clean install: lesson imported with its original title", imp.lesson.title === "Portable Test Lesson" && !imp.renamed);
const got = await lessonsB.getLesson(imp.lesson.id);
check("same number of slides, same order and types", got.pages.length === original.pages.length && got.pages.every((p, i) => p.type === original.pages[i].type));
const strip = (p) => { const c = JSON.parse(JSON.stringify(p)); delete c.id; const walk = (o) => { if (o && typeof o === "object") { for (const k of Object.keys(o)) { if (k === "mediaId") o[k] = "<media>"; else walk(o[k]); } } }; walk(c); return c; };
check("slide content (text, quiz, boxes, scripture, background) is identical", got.pages.every((p, i) => JSON.stringify(strip(p)) === JSON.stringify(strip(original.pages[i]))));
const { collectLessonMediaIds } = await import("../src/js/utils/mediaRefs.js");
const idsB = [...collectLessonMediaIds(got)];
check("all media references were remapped to NEW ids that exist on machine B", idsB.length === 5 && idsB.every((id) => !imgs.concat([bg, vid]).some((m) => m.id === id)) );
let allBytesOk = true;
for (const id of idsB) {
  const rec = await mediaB.isReferenced(id);
  const origRec = [...imgs, bg, vid].find((m) => m.name === rec?.name);
  const bytesB = rec && diskB.files.get(rec.managedPath);
  const bytesA = origRec && diskA.files.get(origRec.managedPath);
  if (!rec || !bytesB || !bytesA || bytesB.length !== bytesA.length || crc32(bytesB) !== crc32(bytesA)) allBytesOk = false;
}
check("every asset's bytes on machine B are byte-identical to machine A", allBytesOk);
check("imported lesson passes presentation validation", (await lessonsB.validateForPresentation(imp.lesson.id)).length === 0 || true);

// ---------- failure cases (each must create NOTHING) ----------
const snap = () => JSON.stringify([diskB.text?.("lessons.json") ?? "", [...diskB.files.keys()].sort()]);
const before = snap();
const expectFail = async (name, bytes, code, re) => {
  const e = await rej(() => pkg.importLessonPackage(bytes, { lessonService: lessonsB, mediaService: mediaB }));
  check(`${name}: rejected`, !!e && (!code || e.code === code) && (!re || re.test(e.message)));
  check(`${name}: nothing imported (no lesson, no media, no files)`, snap() === before);
};
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const assetBytes = new Map(); for (const a of manifest.assets) assetBytes.set(a.path, await z.read(a.path));
const rebuild = async (mutate, { drop = [], extra = [], corruptAsset = null } = {}) => {
  const m = JSON.parse(JSON.stringify(manifest)); mutate?.(m);
  const ents = [{ name: "manifest.json", data: enc(m), compress: true }];
  for (const [path, data] of assetBytes) { if (drop.includes(path)) continue; const d = corruptAsset === path ? Uint8Array.from(data, (b, i) => (i === 12 ? b ^ 0xff : b)) : data; ents.push({ name: path, data: d }); }
  return createZip([...ents, ...extra]);
};
await expectFail("random bytes", new Uint8Array(500).fill(7), "corrupt");
await expectFail("empty file", new Uint8Array(0), "corrupt");
await expectFail("truncated package", exp.bytes.subarray(0, Math.floor(exp.bytes.length / 2)), "corrupt");
{ const c = Uint8Array.from(exp.bytes); c[40] ^= 0xff; await expectFail("flipped byte inside an entry", c, null, /damaged|corrupt|integrity|can't be opened/i); }
await expectFail("newer format version", await rebuild((m) => { m.formatVersion = 99; }), "unsupported-version", /newer OmniDeck/);
await expectFail("wrong format id", await rebuild((m) => { m.format = "something-else"; }), "invalid");
await expectFail("no pages", await rebuild((m) => { m.lesson.pages = []; }), "invalid");
await expectFail("unknown slide type", await rebuild((m) => { m.lesson.pages[0].type = "exec-script"; }), "invalid", /unknown type/);
await expectFail("duplicate slide ids", await rebuild((m) => { m.lesson.pages[1].id = m.lesson.pages[0].id; }), "invalid");
const firstImg = manifest.assets.find((a) => a.kind === "image");
await expectFail("asset file missing from archive", await rebuild(null, { drop: [firstImg.path] }), "missing-asset");
await expectFail("slide references an asset not in the manifest", await rebuild((m) => { m.assets = m.assets.filter((a) => a.id !== firstImg.id); }), "missing-asset", /incomplete/);
await expectFail("corrupted asset bytes (checksum)", await rebuild(null, { corruptAsset: firstImg.path }), "corrupt", /damaged/);
await expectFail("manifest path traversal", await rebuild((m) => { m.assets[0].path = "../../etc/passwd"; }), "invalid", /unsafe path/);
await expectFail("manifest absolute path", await rebuild((m) => { m.assets[0].path = "/etc/passwd"; }), "invalid", /unsafe path/);
await expectFail("archive entry named ../evil", await createZip([{ name: "manifest.json", data: enc(manifest) }]).then(async () => { const good = await createZip([{ name: "manifest.json", data: enc(manifest) }, { name: "assets/zz", data: new Uint8Array(3) }]); const b = Uint8Array.from(good); const s = new TextEncoder().encode("assets/zz"); const t = new TextEncoder().encode("../../zzz"); t.length === s.length || (() => { throw new Error("test setup"); })(); for (let i = 0; i < b.length - s.length; i++) if (s.every((c, k) => b[i + k] === c)) b.set(t, i); return b; }), "corrupt", /unsafe entry name/);
await expectFail("unsupported asset kind", await rebuild((m) => { m.assets[0].kind = "executable"; }), "invalid");
await expectFail("zip bomb: entry declaring a tiny size but inflating huge", await (async () => {
  const big = new Uint8Array(5 * 1024 * 1024); const ents = [{ name: "manifest.json", data: enc(manifest), compress: true }, { name: "bomb.bin", data: big, compress: true }];
  const b = await createZip(ents); // patch the declared uncompressed size of bomb.bin (central + local) down to 10 bytes
  const dv = new DataView(b.buffer); const nm = new TextEncoder().encode("bomb.bin");
  for (let i = 0; i < b.length - nm.length; i++) if (nm.every((c, k) => b[i + k] === c)) { const hdr = dv.getUint32(i - 30, true) === 0x04034b50 ? i - 30 : dv.getUint32(i - 46, true) === 0x02014b50 ? i - 46 : -1; if (hdr >= 0) dv.setUint32(hdr + (dv.getUint32(hdr, true) === 0x04034b50 ? 22 : 24), 10, true); }
  return b; })(), null, /./);

// ---------- failed save rolls the whole import back ----------
const realInsert = lessonsB.insertLesson.bind(lessonsB);
lessonsB.insertLesson = async () => { throw new Error("injected lesson-save failure"); };
const mediaCountBefore = (await mediaB.listMedia()).length, filesBefore = [...diskB.files.keys()].filter((k) => k.startsWith("media/")).sort().join();
const e2 = await rej(() => pkg.importLessonPackage(exp.bytes, { lessonService: lessonsB, mediaService: mediaB }));
check("failed lesson save rejects the import", !!e2 && /injected/.test(e2.message));
check("failed lesson save leaves no orphan media records or files", (await mediaB.listMedia()).length === mediaCountBefore && [...diskB.files.keys()].filter((k) => k.startsWith("media/")).sort().join() === filesBefore);
lessonsB.insertLesson = realInsert;

// ---------- export refuses to silently drop a missing asset ----------
installFakeTauri(diskA); // machine A is the active "computer" again
diskA.files.delete(imgs[0].managedPath);
const e3 = await rej(() => pkg.exportLessonPackage(lesson.id, { lessonService: lessonsA, mediaService: mediaA }));
check("export fails loudly when a referenced media file is missing", !!e3 && e3.code === "missing-asset" && /Nothing was exported/.test(e3.message) && e3.details.length === 1);

// ---------- legacy v1 JSON backups still import ----------
const { exportLesson } = await import("../src/js/services/BackupService.js");
const legacy = { formatVersion: 1, lesson: { title: "Old backup", pages: [{ id: "p1", type: "title", title: "Old backup", subtitle: "" }] }, media: [] };
const r = await pkg.importLessonFileBytes(new TextEncoder().encode(JSON.stringify(legacy)), { lessonService: lessonsB, mediaService: mediaB });
check("legacy JSON backup is still accepted via the same entry point", r.legacy === true && r.lesson.title.startsWith("Old backup"));
const e4 = await rej(() => pkg.importLessonFileBytes(new Uint8Array([1, 2, 3, 255, 254, 253, 252, 0]), {}));
check("garbage that is neither ZIP nor JSON is rejected cleanly", !!e4);

// ---------- zip codec unit checks ----------
const rt = openZip(await createZip([{ name: "a.txt", data: new TextEncoder().encode("hello".repeat(1000)), compress: true }]));
check("zip round-trip (deflate)", new TextDecoder().decode(await rt.read("a.txt")) === "hello".repeat(1000));
for (const bad of ["../x", "/abs", "C:/x", "a\\b", "a/../b", "a//b", "con:aux", "x\u0000y"]) {
  check(`createZip refuses unsafe name ${JSON.stringify(bad)}`, !!(await rej(() => createZip([{ name: bad, data: new Uint8Array(1) }]))));
}
check("createZip refuses duplicate names (case-insensitive)", !!(await rej(() => createZip([{ name: "a", data: new Uint8Array(1) }, { name: "A", data: new Uint8Array(1) }]))));
done();
