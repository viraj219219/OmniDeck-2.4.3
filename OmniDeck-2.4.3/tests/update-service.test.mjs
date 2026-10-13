// UpdateService behaviour with a MOCKED Tauri updater. This proves the app-side
// control flow (gating, error classification, save-before-install, cancellation,
// deb/rpm handling). It does NOT prove signature verification or a real GitHub
// release — those are enforced by the Rust plugin and need a signed release run.
import { UpdateService, classifyUpdateError, UPDATE_ERRORS, UpdateError } from "../src/js/services/UpdateService.js";
import { makeChecker } from "./helpers/fakeDisk.mjs";
const { check, done } = makeChecker();

const mk = ({ status = { configured: true, canSelfInstall: true, reason: null, version: "2.4.1" }, update, checkErr, flushResult = { ok: true }, restartErr } = {}) => {
  const calls = [];
  const tauri = {
    core: { invoke: async (cmd) => { calls.push(cmd); if (cmd === "updater_status") return status; if (cmd === "restart_app") { if (restartErr) throw restartErr; return; } } },
    updater: { check: async () => { calls.push("check"); if (checkErr) throw checkErr; return update ?? null; } },
  };
  const svc = new UpdateService({ tauri: () => tauri, flush: async () => { calls.push("flush"); return flushResult; } });
  return { svc, calls };
};
const mkUpdate = ({ downloadErr, installErr, events = true } = {}) => {
  const log = [];
  return { log, version: "2.4.2", currentVersion: "2.4.1", body: "Notes", date: "2026-10-01",
    download: async (cb) => { log.push("download"); if (downloadErr) throw downloadErr; if (events) { cb({ event: "Started", data: { contentLength: 100 } }); cb({ event: "Progress", data: { chunkLength: 60 } }); cb({ event: "Progress", data: { chunkLength: 40 } }); cb({ event: "Finished" }); } },
    install: async () => { log.push("install"); if (installErr) throw installErr; },
    close: async () => { log.push("close"); } };
};
const rej = async (f) => { try { await f(); return null; } catch (e) { return e; } };

// --- gating ---
{ const svc = new UpdateService({ tauri: () => undefined });
  check("browser/no-Tauri: unavailable, never throws", (await svc.check()).state === "unavailable"); }
{ const { svc, calls } = mk({ status: { configured: false, reason: "not enabled", canSelfInstall: false } });
  const r = await svc.check();
  check("unconfigured build never contacts the update server", r.state === "unavailable" && !calls.includes("check")); }

// --- check outcomes ---
{ const { svc } = mk(); check("no newer release => up-to-date", (await svc.check()).state === "up-to-date"); }
{ const { svc } = mk({ update: mkUpdate() });
  const r = await svc.check();
  check("newer release => available with version + notes", r.state === "available" && r.version === "2.4.2" && r.notes === "Notes" && r.canSelfInstall === true); }
for (const [name, err, kind] of [
  ["offline", new Error("error sending request for url (https://github.com/...)"), UPDATE_ERRORS.OFFLINE],
  ["DNS failure", new Error("failed to resolve dns name"), UPDATE_ERRORS.OFFLINE],
  ["unavailable release (404)", new Error("Could not fetch a valid release JSON from the remote"), UPDATE_ERRORS.NOT_FOUND],
  ["bad signature", new Error("the signature could not be verified"), UPDATE_ERRORS.INTEGRITY],
]) {
  const { svc } = mk({ checkErr: err });
  const r = await svc.check();
  check(`check error: ${name} -> ${kind}, with a human message and no throw`, r.state === "error" && r.kind === kind && r.message.length > 20);
}
check("classifier: unknown errors fall back safely", classifyUpdateError(new Error("???")) === UPDATE_ERRORS.UNKNOWN);

// --- install flow ---
{ const u = mkUpdate(); const { svc, calls } = mk({ update: u }); await svc.check();
  const seen = []; const r = await svc.downloadAndInstall({ onProgress: (p) => seen.push(p.phase) });
  check("happy path installs and restarts", r.installed === true && calls.includes("restart_app"));
  check("saves are flushed AFTER download and BEFORE install", calls.indexOf("flush") > -1 && u.log.join() === "download,install" && calls.indexOf("flush") < calls.indexOf("restart_app"));
  check("progress phases reported in order", seen.join() === "downloading,downloading,downloading,verifying,installing,restarting"); }
{ const u = mkUpdate(); const { svc, calls } = mk({ update: u, flushResult: { ok: false, failures: [{ name: "editor" }] } }); await svc.check();
  const e = await rej(() => svc.downloadAndInstall());
  check("unsaved work that can't be saved BLOCKS the install", e instanceof UpdateError && e.kind === UPDATE_ERRORS.SAVE && !u.log.includes("install") && !calls.includes("restart_app")); }
{ const u = mkUpdate({ downloadErr: new Error("signature verification failed") }); const { svc } = mk({ update: u }); await svc.check();
  const e = await rej(() => svc.downloadAndInstall());
  check("corrupted/forged download is rejected as an integrity failure; never installed", e?.kind === UPDATE_ERRORS.INTEGRITY && !u.log.includes("install") && /Nothing was installed/.test(e.message)); }
{ const u = mkUpdate({ downloadErr: new Error("error sending request") }); const { svc } = mk({ update: u }); await svc.check();
  const e = await rej(() => svc.downloadAndInstall());
  check("network loss mid-download is a clear offline error and leaves the app usable", e?.kind === UPDATE_ERRORS.OFFLINE && svc.busy === false); }
{ const u = mkUpdate({ installErr: new Error("permission denied replacing file") }); const { svc, calls } = mk({ update: u }); await svc.check();
  const e = await rej(() => svc.downloadAndInstall());
  check("failed installation reports 'unchanged' and does not restart", e?.kind === UPDATE_ERRORS.INSTALL && /unchanged/.test(e.message) && !calls.includes("restart_app")); }
{ const u = mkUpdate(); const { svc, calls } = mk({ update: u }); await svc.check();
  const ac = new AbortController();
  const p = svc.downloadAndInstall({ signal: ac.signal, onProgress: (x) => { if (x.phase === "verifying") ac.abort(); } });
  const r = await p;
  check("cancellation discards the download and installs NOTHING", r.cancelled === true && u.log.includes("close") && !u.log.includes("install") && !calls.includes("restart_app")); }
{ const { svc } = mk({ status: { configured: true, canSelfInstall: false, reason: "installed from a .deb package", version: "2.4.1" }, update: mkUpdate() });
  const r = await svc.check();
  check("deb/rpm install: update is ANNOUNCED but marked as not self-installable", r.state === "available" && r.canSelfInstall === false && /deb/.test(r.reason));
  const e = await rej(() => svc.downloadAndInstall());
  check("deb/rpm install: in-app install is refused", e?.kind === UPDATE_ERRORS.INSTALL); }
{ const { svc } = mk({ update: mkUpdate() }); await svc.check();
  const p1 = svc.downloadAndInstall(); const e2 = await rej(() => svc.downloadAndInstall()); await p1;
  check("two installs can't run concurrently", e2 instanceof UpdateError); }
{ const { svc } = mk({ update: mkUpdate() });
  const e = await rej(() => svc.downloadAndInstall());
  check("installing without a checked update is refused", e instanceof UpdateError); }

// --- startup check: quiet by design ---
{ const { svc } = mk({ update: mkUpdate() });
  check("startup check announces a new version once", (await svc.startupCheck()) === "2.4.2" && (await svc.startupCheck()) === null); }
{ const { svc } = mk({ update: mkUpdate() });
  check("startup check stays silent while presenting", (await svc.startupCheck({ isPresenting: () => true })) === null); }
{ const { svc } = mk({ checkErr: new Error("error sending request") });
  check("startup check is silent when offline", (await svc.startupCheck()) === null); }
done();
