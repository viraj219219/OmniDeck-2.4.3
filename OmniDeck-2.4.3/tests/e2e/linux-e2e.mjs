// Real-runtime E2E — the main scenario suite. Plumbing lives in ./lib.mjs.
import { check, done, DATA_HOME, BIN, OUT, DATA, FIX, sleep, sh, isRunning, startDriver, stopDriver, newSession, page, screenshot, dirList, readJson, rejects } from "./lib.mjs";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";

try {
  await startDriver();
  await newSession();

  // ================= A. real runtime boots =================================================
  // The fs/dialog plugin bindings are non-enumerable on window.__TAURI__, so probe them by type, not Object.keys.
  const boot = await page(`return { keys: Object.keys(window.__TAURI__), plugins: { fs: typeof window.__TAURI__.fs, dialog: typeof window.__TAURI__.dialog }, title: document.title }`);
  check("A. app boots in a real WebKitGTK webview with all Tauri plugin globals", boot.plugins.fs === "object" && boot.plugins.dialog === "object" && ["core", "event", "path"].every((k) => boot.keys.includes(k)));
  const seeded = await page(`const { lessonService } = await M("js/services/LessonService.js"); return (await lessonService.listLessons()).length`);
  check("A. first run seeds the example lessons through the real filesystem", seeded > 0 && existsSync(join(DATA, "lessons.json")));

  // ================= B. atomic storage on the REAL fs plugin + ACL ==============================
  await page(`const s = await M("js/utils/storageAdapter.js"); await s.writeJSONStrict("e2e-a.json", { v: 1 }); await s.writeJSONStrict("e2e-a.json", { v: 2 }); return true`);
  check("B. atomic save: primary v2, backup v1, no leftover .tmp (real rename permission works)", readJson("e2e-a.json").v === 2 && readJson("e2e-a.json.bak").v === 1 && !existsSync(join(DATA, "e2e-a.json.tmp")));
  writeFileSync(join(DATA, "e2e-a.json"), '{"v": 3, "trunc');   // simulate a torn write from a power cut
  const rec = await page(`const s = await M("js/utils/storageAdapter.js"); const v = await s.readJSON("e2e-a.json", null); return { v, events: s.getRecoveryEvents().length }`);
  check("B. corrupted primary + valid backup: recovered from .bak with a notice", rec.v.v === 1 && rec.events >= 1);
  check("B. …the primary was restored on disk and the corrupt file quarantined (not deleted)", readJson("e2e-a.json").v === 1 && dirList(DATA).some((f) => f.startsWith("e2e-a.json.corrupt-")));
  writeFileSync(join(DATA, "e2e-a.json"), "garbage"); writeFileSync(join(DATA, "e2e-a.json.bak"), "also garbage");
  const both = await rejects(() => page(`const s = await M("js/utils/storageAdapter.js"); return await s.readJSON("e2e-a.json", "EMPTY-FALLBACK")`));
  check("B. corrupted primary + corrupted backup: fails loudly (never the empty fallback)", both?.code === "corrupt" && readFileSync(join(DATA, "e2e-a.json"), "utf8") === "garbage");
  const forbidden = await page(`try { await window.__TAURI__.fs.writeTextFile("/tmp/e2e-forbidden.txt", "x"); return "WRITTEN"; } catch (e) { return "denied"; }`);
  check("B. the ACL is really enforced: writing outside app data is denied", forbidden === "denied" && !existsSync("/tmp/e2e-forbidden.txt"));

  // ================= C. rapid saves on the real fs ===================================================
  const rapid = await page(`
    const { lessonService } = await M("js/services/LessonService.js");
    const l = (await lessonService.listLessons())[0];
    const before = lessonService._queue.writesStarted;
    const ps = [];
    for (let i = 0; i < 40; i++) { l.title = "Rapid " + i; ps.push(lessonService.saveLesson(l)); }
    await Promise.all(ps);
    return { id: l.id, writes: lessonService._queue.writesStarted - before, maxConcurrent: lessonService._queue.maxConcurrent };`);
  const savedLesson = readJson("lessons.json").find((x) => x.id === rapid.id);
  check("C. 40 rapid saves: never concurrent, coalesced, final disk = last edit", rapid.maxConcurrent === 1 && rapid.writes < 40 && savedLesson.title === "Rapid 39");
  check("C. …no .tmp left, backup is a valid library", !existsSync(join(DATA, "lessons.json.tmp")) && Array.isArray(readJson("lessons.json.bak")));

  // ================= D. dependency readiness, real =====================================================
  const deps = await page(`return await window.__TAURI__.core.invoke("check_import_dependencies")`);
  check("D. real detection finds LibreOffice + Poppler on PATH", deps.soffice.found && deps.pdftoppm.found && deps.pdftotext.found && /soffice/.test(deps.soffice.path));
  await page(`document.querySelector('[data-route="settings"]').click(); return true`);
  await sleep(1500);
  const settingsText = await page(`return document.body.innerText`);
  check("D. Settings shows 'Import Tools' with PowerPoint/PDF ✓ Ready", /Import Tools/.test(settingsText) && /Ready/.test(settingsText));
  await screenshot("01-settings-import-tools");

  // ================= E. real PPTX / PDF import ============================================================
  const SRC = join(DATA, "e2e-src");
  mkdirSync(SRC, { recursive: true });
  copyFileSync(join(FIX, "three-slides.pptx"), join(SRC, "Sunday Deck.pptx"));
  copyFileSync(join(FIX, "two-pages.pdf"), join(SRC, "Handout.pdf"));
  writeFileSync(join(SRC, "Broken.pptx"), "this is not a presentation");
  const abs = (f) => join(SRC, f);
  const stubPicker = (p) => `window.__TAURI__.dialog.open = async () => [${JSON.stringify(p)}];`;
  const listMedia = () => dirList(join(DATA, "media", "images")).length + dirList(join(DATA, "media", "presentations")).length + dirList(join(DATA, "media", "pdfs")).length;

  // E1. "Import as new lesson": a title page + one presentation page backed by the converted deck.
  const imp = await page(`${stubPicker(abs("Sunday Deck.pptx"))}
    const { importFileAsNewLesson } = await M("js/services/ImportService.js");
    const { mediaService } = await M("js/services/MediaService.js");
    const { lessonService } = await M("js/services/LessonService.js");
    const res = await importFileAsNewLesson("E2E imported deck", "presentation", { mediaService, lessonService });
    return { id: res.lesson.id, types: res.lesson.pages.map((p) => p.type), deckId: res.lesson.pages[1].mediaId };`);
  const onDisk = readJson("lessons.json").find((l) => l.id === imp.id);
  check("E. real LibreOffice: a PPTX becomes a saved lesson (title page + presentation page)", imp.types.join() === "title,presentation" && onDisk?.pages.length === 2);
  const isPng = (f) => existsSync(f) && readFileSync(f).subarray(0, 4).toString("hex") === "89504e47" && statSync(f).size > 1000;
  const deck = readJson("media-library.json").find((m) => m.id === imp.deckId);
  check("E. the deck was really converted: 3 slide PNGs on disk, all valid", deck?.slideFiles?.length === 3 && deck.slideFiles.every((f) => isPng(join(DATA, deck.slidesDir, f))));
  check("E. the temporary LibreOffice profile was cleaned up", !existsSync(join(DATA, deck.slidesDir, "lo-profile")));

  // E2. Corrupt deck: refused, rolled back.
  const beforeBad = { lessons: readJson("lessons.json").length, media: listMedia(), lib: readJson("media-library.json").length };
  const bad = await rejects(() => page(`${stubPicker(abs("Broken.pptx"))}
    const { importFileAsNewLesson } = await M("js/services/ImportService.js");
    const { mediaService } = await M("js/services/MediaService.js");
    const { lessonService } = await M("js/services/LessonService.js");
    return await importFileAsNewLesson("Should not exist", "presentation", { mediaService, lessonService });`));
  check("E. a corrupt PPTX is refused with a clear message (no fake slides)", bad?.stage === "convert" && /valid PowerPoint/.test(bad.message));
  check("E. …rollback left no lesson, no orphan files, no ghost media records", readJson("lessons.json").length === beforeBad.lessons && listMedia() === beforeBad.media && readJson("media-library.json").length === beforeBad.lib);

  // E3. Slides as individual pages (importSlidesAsPages), one save.
  copyFileSync(join(FIX, "three-slides.pptx"), join(SRC, "Second Deck.pptx"));
  const sl = await page(`${stubPicker(abs("Second Deck.pptx"))}
    const { importSlidesAsPages } = await M("js/services/ImportService.js");
    const { mediaService } = await M("js/services/MediaService.js");
    const { lessonService } = await M("js/services/LessonService.js");
    const r = await importSlidesAsPages(${JSON.stringify(imp.id)}, "presentation", { mediaService, lessonService });
    return { slides: r.slideCount, mediaIds: r.pages.map((p) => p.mediaId) };`);
  const libNow2 = readJson("media-library.json");
  check("E. real LibreOffice+Poppler: 3 slides become 3 image pages, saved in ONE step", sl.slides === 3 && readJson("lessons.json").find((l) => l.id === imp.id).pages.length === 5);
  check("E. every slide page references a real, valid PNG on disk", sl.mediaIds.every((id) => { const m = libNow2.find((x) => x.id === id); return m && isPng(join(DATA, m.managedPath)); }));

  // E4. PDF pages.
  const pdfRes = await page(`${stubPicker(abs("Handout.pdf"))}
    const { importSlidesAsPages } = await M("js/services/ImportService.js");
    const { mediaService } = await M("js/services/MediaService.js");
    const { lessonService } = await M("js/services/LessonService.js");
    const r = await importSlidesAsPages(${JSON.stringify(imp.id)}, "pdf", { mediaService, lessonService });
    return { slides: r.slideCount, embedded: r.embeddedCount };`);
  check("E. real Poppler: a 2-page PDF adds 2 image pages to the lesson, saved", pdfRes.slides === 2 && pdfRes.embedded === 0 && readJson("lessons.json").find((l) => l.id === imp.id).pages.length === 7);

  // ================= F. reference-safe deletion, real fs ===========================================================
  const del = await rejects(() => page(`const { mediaService } = await M("js/services/MediaService.js"); return await mediaService.removeMedia(${JSON.stringify(sl.mediaIds[0])})`));
  const inUse = readJson("media-library.json").find((m) => m.id === sl.mediaIds[0]);
  check("F. deleting an in-use slide image is refused and the file survives", del?.code === "in-use" && isPng(join(DATA, inUse.managedPath)));
  const orphan = await page(`const { mediaService } = await M("js/services/MediaService.js");
    const rec = await mediaService.importBytes("image", new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]), "unused.png", "image/png");
    const r = await mediaService.removeMedia(rec.id);
    return { id: rec.id, path: rec.managedPath, removed: r.removed };`);
  check("F. an UNUSED image is deleted normally (cleanup still works)", orphan.removed === true && !existsSync(join(DATA, orphan.path)));

  // ================= G. real two-monitor Present Mode ================================================================
  const mons = await page(`return await window.__TAURI__.core.invoke("list_monitors")`);
  check("G. the real webview reports two monitors, exactly one primary", mons.length === 2 && mons.filter((m) => m.isPrimary || m.is_primary).length === 1);
  const winsBefore = sh("wmctrl -lG");
  const mainGeom = winsBefore.split("\n").find((l) => /OmniDeck/.test(l));
  const primaryIdx = mons.findIndex((m) => m.isPrimary || m.is_primary);
  const audIdx = mons.findIndex((_, i) => i !== primaryIdx);
  const sameErr = await rejects(() => page(`return await window.__TAURI__.core.invoke("open_audience_window", { monitorIndex: ${primaryIdx} })`));
  check("G. role invariant: the audience window can't be opened on the presenter's own monitor", !!sameErr);
  await page(`return await window.__TAURI__.core.invoke("open_audience_window", { monitorIndex: ${audIdx} })`);
  await sleep(2500);
  const wins = sh("wmctrl -lG").split("\n");
  await screenshot("02-two-monitors-audience-open");
  const audLine = wins.find((l) => /audience|OmniDeck.*Audience/i.test(l)) || wins.filter((l) => /OmniDeck/.test(l))[1];
  const audX = audLine ? Number(audLine.split(/\s+/)[2]) : -1;
  const mainX = Number(mainGeom?.split(/\s+/)[2] ?? -1);
  check("G. the audience window really opened on the second monitor (x >= 1920) while the presenter stays on the first", audX >= 1920 && mainX < 1920);
  await page(`return await window.__TAURI__.core.invoke("close_audience_window")`);
  await sleep(1000);
  check("G. closing the audience window leaves the presenter running", isRunning());

  // ================= H. native close handshake, ack path =================================================================
  await page(`
    const ss = await M("js/services/ShutdownService.js");
    let pending = true;
    ss.registerFlusher("e2e-slow-save", { isDirty: () => pending, flush: async () => {
      await new Promise((r) => setTimeout(r, 6500));   // LONGER than Rust's 5s watchdog on purpose
      await window.__TAURI__.fs.writeTextFile("e2e-close-marker.txt", "flushed-before-exit", { baseDir: window.__TAURI__.fs.BaseDirectory.AppLocalData });
      pending = false; } });
    return true;`);
  const t0 = Date.now();
  sh(`wmctrl -c OmniDeck`);   // the window manager's real "close window" (WM_DELETE_WINDOW)
  await sleep(2000);
  check("H. closing the window does NOT exit while a save is pending (close was intercepted)", isRunning());
  for (let i = 0; i < 40 && isRunning(); i++) await sleep(500);
  const dt = (Date.now() - t0) / 1000;
  check("H. the app exited only AFTER the pending save finished (past the 5s watchdog: the ack disarmed it)", !isRunning() && dt >= 6.4 && existsSync(join(DATA, "e2e-close-marker.txt")));
  check("H. …and the pending write really reached disk", existsSync(join(DATA, "e2e-close-marker.txt")) && readFileSync(join(DATA, "e2e-close-marker.txt"), "utf8") === "flushed-before-exit");
  stopDriver();

  // ================= I. watchdog: unresponsive webview can't make the window un-closable ==================================
  await startDriver();
  await newSession();
  await page(`window.location.href = "about:blank"; return true`).catch(() => {});
  await sleep(1500);
  const t1 = Date.now();
  sh(`wmctrl -c OmniDeck`);
  for (let i = 0; i < 40 && isRunning(); i++) await sleep(500);
  const dt2 = (Date.now() - t1) / 1000;
  check("I. with no webview to acknowledge, the Rust watchdog closes the app (~5s)", !isRunning() && dt2 >= 4 && dt2 < 12);
  stopDriver();

  // ================= J. failed final save: real native dialog, both choices ========================================================
  await startDriver();
  await newSession();
  await page(`
    const ss = await M("js/services/ShutdownService.js");
    ss.registerFlusher("e2e-failing-save", { isDirty: () => true, flush: async () => { throw new Error("simulated disk failure"); } });
    return true;`);
  const dialogOpen = () => /Unsaved changes/.test(sh("wmctrl -l"));
  const clickDialog = (which) => {   // "keep" = right button, "close" = left button
    const wid = sh(`xdotool search --onlyvisible --name "Unsaved changes" | tail -1`);
    const g = Object.fromEntries(sh(`xdotool getwindowgeometry --shell ${wid}`).split("\n").map((l) => l.split("=")));
    const x = Number(g.X) + Number(g.WIDTH) * (which === "keep" ? 0.75 : 0.25), y = Number(g.Y) + Number(g.HEIGHT) - 22;
    console.log(`   [debug] dialog ${wid} geometry X=${g.X} Y=${g.Y} W=${g.WIDTH} H=${g.HEIGHT} -> click ${Math.round(x)},${Math.round(y)} (${which})`);
    sh(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}`); sh(`xdotool click 1`);
  };
  sh(`wmctrl -c OmniDeck`);
  for (let i = 0; i < 20 && !dialogOpen(); i++) await sleep(500);
  check("J. a failed final save shows the native 'Unsaved changes' dialog", dialogOpen());
  await sleep(7000);   // longer than the 5s watchdog: the dialog must still be waiting for the teacher
  check("J. …and the app waits for the teacher's answer (watchdog disarmed, no silent exit)", isRunning() && dialogOpen());
  await screenshot("03-unsaved-changes-dialog");
  clickDialog("keep");
  await sleep(2000);
  check("J. 'Keep editing' dismisses the dialog and the app stays open and usable", isRunning() && !dialogOpen() && (await page(`return document.querySelector("#app-shell") !== null`)));
  sh(`wmctrl -c OmniDeck`);          // a NEW close attempt starts the handshake afresh
  for (let i = 0; i < 20 && !dialogOpen(); i++) await sleep(500);
  check("J. after 'Keep editing', closing again asks again (never stuck, never silent)", dialogOpen() && isRunning());
  clickDialog("close");
  for (let i = 0; i < 20 && isRunning(); i++) await sleep(500);
  check("J. 'Close without saving' really exits the app", !isRunning());
  stopDriver();
} catch (err) {
  console.error("E2E ABORTED:", err);
  check("E2E completed without aborting", false);
} finally {
  stopDriver();
  sh("pkill -x omnideck");
}
done();
