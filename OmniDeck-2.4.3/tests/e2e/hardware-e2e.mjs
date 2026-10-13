// Real-runtime E2E for the two things that need a real OS to be meaningful:
//   K. the NATIVE file-picker dialogs (GTK open + save) — driven like a human:
//      type a path, press Enter, or press Escape;
//   L. display HOT-PLUG during Present Mode — a second monitor is unplugged
//      and re-plugged while presenting, using real RandR monitor add/remove
//      events on the X server (the same events a driver raises when a cable is
//      pulled), with the real two-window Present Mode.
// Run through run-linux-e2e.sh (it builds the two-monitor X display first):
//   E2E_SCRIPT=tests/e2e/hardware-e2e.mjs bash tests/e2e/run-linux-e2e.sh
import { check, done, DATA, FIX, OUT, BIN, sleep, sh, isRunning, startDriver, stopDriver, newSession, page, screenshot, dirList, readJson, rejects } from "./lib.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

const PICK = "/tmp/omnideck-picker";
rmSync(PICK, { recursive: true, force: true });
mkdirSync(join(PICK, "out"), { recursive: true });
sh(`convert -size 96x96 gradient:blue-white "${PICK}/Photo One.png"`);
copyFileSync(join(FIX, "three-slides.pptx"), join(PICK, "Deck With Space.pptx"));
const libLen = () => (existsSync(join(DATA, "media-library.json")) ? readJson("media-library.json").length : 0);
const isPng = (f) => existsSync(f) && readFileSync(f).subarray(0, 4).toString("hex") === "89504e47" && statSync(f).size > 200;

const windows = () => sh("wmctrl -lG").split("\n").filter(Boolean).map((l) => { const p = l.split(/\s+/); return { id: p[0], x: Number(p[2]), y: Number(p[3]), w: Number(p[4]), h: Number(p[5]), title: p.slice(7).join(" ") }; });
const findDialog = () => windows().find((w) => !/^OmniDeck$/.test(w.title) && !/Audience Display/.test(w.title));
const audienceWin = () => windows().find((w) => /Audience Display/.test(w.title));
const mainWin = () => windows().find((w) => /^OmniDeck$/.test(w.title));

async function waitFor(fn, ms = 15000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step); }
  return null;
}
// Drives a real GTK file chooser: Ctrl+L (location bar), type the path, Enter.
async function chooseInDialog(path) {
  const dlg = await waitFor(findDialog, 20000);
  if (!dlg) return false;
  await sleep(600);
  sh(`xdotool windowfocus ${dlg.id}`);
  sh(`xdotool key --clearmodifiers ctrl+l`);
  await sleep(400);
  sh(`xdotool type --delay 25 --clearmodifiers "${path}"`);
  await sleep(500);
  sh(`xdotool key Return`);
  if (await waitFor(() => !findDialog(), 6000)) return true;
  sh(`xdotool key Return`);                       // some GTK versions need a second Enter to activate
  return !!(await waitFor(() => !findDialog(), 8000));
}

try {
  await startDriver();
  await newSession();

  // ======================= K. native file pickers =======================================
  
  // K1: REAL open dialog (no stub), path outside app data with a space in its name.
  const k1 = page(`const { mediaService } = await M("js/services/MediaService.js");
    const r = await mediaService.pickFiles("image");
    return r.map((x) => ({ id: x.id, name: x.name, path: x.managedPath }));`);
  const driven = await chooseInDialog(`${PICK}/Photo One.png`);
  check("K. the native GTK 'open' dialog appears and accepts a typed path", driven);
  const r1 = await k1;
  check("K. the picked file is imported through the real dialog (outside app data; permission granted by the dialog)", r1.length === 1 && r1[0].name === "Photo One.png" && isPng(join(DATA, r1[0].path)));
  check("K. …and the original file is untouched", isPng(`${PICK}/Photo One.png`));
  await screenshot("05-native-open-dialog-done");

  // K2: cancel with Escape -> nothing changes.
  const libBefore = libLen();
  const k2 = page(`const { mediaService } = await M("js/services/MediaService.js"); const r = await mediaService.pickFiles("image"); return r.length;`);
  const dlg2 = await waitFor(findDialog, 20000);
  check("K. the dialog opens again for a second pick", !!dlg2);
  await sleep(600);
  await screenshot("06-native-open-dialog");
  sh(`xdotool windowfocus ${dlg2?.id}`);
  sh(`xdotool key Escape`);
  const n2 = await k2;
  check("K. cancelling the native dialog (Escape) is a clean no-op", n2 === 0 && libLen() === libBefore && !findDialog());

  // K3: a PPTX through the real dialog + real LibreOffice.
  const k3 = page(`const { importFileAsNewLesson } = await M("js/services/ImportService.js");
    const { mediaService } = await M("js/services/MediaService.js");
    const { lessonService } = await M("js/services/LessonService.js");
    const res = await importFileAsNewLesson("Picked with a real dialog", "presentation", { mediaService, lessonService });
    return { cancelled: !!res.cancelled, types: res.lesson?.pages.map((p) => p.type) };`);
  await chooseInDialog(`${PICK}/Deck With Space.pptx`);
  const r3 = await k3;
  check("K. PPTX chosen in the real dialog is converted by real LibreOffice and saved as a lesson", !r3.cancelled && r3.types.join() === "title,presentation" && readJson("lessons.json").some((l) => l.title === "Picked with a real dialog"));

  // K4: real SAVE dialog, then write outside app data (allowed only because the dialog granted it).
  const outPath = `${PICK}/out/omnideck-backup-e2e.json`;
  const k4 = page(`const { save } = window.__TAURI__.dialog;
    const { writeTextFile, readTextFile } = window.__TAURI__.fs;
    const path = await save({ defaultPath: "omnideck-backup.json", filters: [{ name: "OmniDeck Backup", extensions: ["json"] }] });
    if (!path) return { path: null };
    await writeTextFile(path, '{"backup":"ok"}');
    return { path, back: await readTextFile(path) };`);
  const dlg4 = await waitFor(findDialog, 20000);
  await sleep(700);
  await screenshot("07-native-save-dialog");
  sh(`xdotool windowfocus ${dlg4?.id}`);
  sh(`xdotool key --clearmodifiers ctrl+a`);      // the name field pre-selects only "omnideck-backup"
  sh(`xdotool type --delay 25 --clearmodifiers "${outPath}"`);
  await sleep(500);
  sh(`xdotool key Return`);
  if (!(await waitFor(() => !findDialog(), 6000))) sh(`xdotool key Return`);
  const r4 = await k4;
  check("K. the native 'save' dialog returns the chosen path and the app can write there", r4.path === outPath && r4.back === '{"backup":"ok"}' && existsSync(outPath));
  const denied = await page(`try { await window.__TAURI__.fs.writeTextFile(${JSON.stringify(PICK + "/out/not-picked.txt")}, "x"); return "WRITTEN"; } catch (e) { return "denied"; }`);
  check("K. …while a path the user did NOT pick is still denied", denied === "denied" && !existsSync(`${PICK}/out/not-picked.txt`));

  // ======================= L. display hot-plug during Present Mode ==========================
  const lessonId = await page(`const { lessonService } = await M("js/services/LessonService.js");
    for (const l of await lessonService.listLessons()) { if (!(await lessonService.validateForPresentation(l.id)).length && l.pages.length > 1) return l.id; }
    return null;`);
  check("L. a presentable lesson exists for the hot-plug scenario", !!lessonId);
  await page(`const present = await M("js/views/presentMode.js");
    const root = document.createElement("div"); root.id = "e2e-present"; root.style.cssText = "position:fixed;inset:0;z-index:99999;background:#000";
    document.body.appendChild(root);
    window.__e2eExited = false;
    window.__e2eCleanup = await present.render(root, { params: { lessonId: ${JSON.stringify(lessonId)} }, onExit: () => { window.__e2eExited = true; root.remove(); } });
    return true;`);
  const aud1 = await waitFor(audienceWin, 20000);
  await sleep(1500);
  const mainX0 = mainWin()?.x ?? -1;
  check("L. Present Mode with two displays: the audience window is on the SECOND monitor", !!aud1 && audienceWin().x >= 1920);
  check("L. …and the presenter window stays on the first monitor", mainX0 >= 0 && mainX0 < 1920);
  await screenshot("08-hotplug-1-two-displays");

  // ---- unplug the second monitor while presenting
  sh(`xrandr --delmonitor DP-2`);
  await sleep(500);
  const gone = await waitFor(() => !audienceWin(), 15000, 400);
  const covering = audienceWin() && audienceWin().x < 1920;
  await screenshot("09-hotplug-2-unplugged");
  check("L. HOT-UNPLUG: the audience window is closed (it never stays over the presenter's screen)", !!gone && !covering);
  check("L. …the presenter keeps running on its own monitor", isRunning() && mainWin() && mainWin().x < 1920);
  const toastText = await page(`return document.getElementById("toast-root")?.innerText || ""`);
  console.log("   [toast shown to the teacher]:", JSON.stringify(toastText));
  check("L. …and the teacher is told what happened (a visible on-screen message explaining the display loss)", /second display was disconnected|ended up on your presenter screen|no longer available/i.test(toastText));

  // ---- plug it back
  sh(`xrandr --setmonitor DP-2 1920/508x1080/286+1920+0 none`);
  const back = await waitFor(audienceWin, 20000, 400);
  await sleep(1200);
  await screenshot("10-hotplug-3-replugged");
  check("L. HOT-REPLUG: the audience display reopens by itself on the second monitor", !!back && audienceWin().x >= 1920);
  check("L. …roles are unchanged: presenter still on the first monitor", mainWin()?.x < 1920);

  // ---- a different display appears under a NEW name/position (index/name reuse)
  sh(`xrandr --delmonitor DP-2`);
  await waitFor(() => !audienceWin(), 15000, 400);
  sh(`xrandr --setmonitor HDMI-9 1920/508x1080/286+1920+0 none`);
  const back2 = await waitFor(audienceWin, 20000, 400);
  check("L. a re-plug as a differently-named display is handled the same way", !!back2 && audienceWin().x >= 1920 && mainWin()?.x < 1920);

  // ---- leaving Present Mode cleans up
  await page(`window.__e2eCleanup?.(); const b = [...document.querySelectorAll("button")].find((x) => /back to editor|exit/i.test(x.textContent)); if (b) b.click(); return true;`);
  await page(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
  const closed = await waitFor(() => !audienceWin(), 10000, 400);
  check("L. leaving Present Mode closes the audience window", !!closed);
  check("L. the app is still healthy after all the hot-plugging", isRunning());
  stopDriver();
} catch (err) {
  console.error("HARDWARE E2E ABORTED:", err);
  check("hardware E2E completed without aborting", false);
} finally {
  stopDriver();
  sh("pkill -x omnideck");
}
done();
