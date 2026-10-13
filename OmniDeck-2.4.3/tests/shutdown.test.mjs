// Regression tests for the shutdown / Present-Mode flush coordinator
// (ShutdownService + SaveQueue). The native side (Rust CloseGate) has its own
// `cargo test`s; here we drive the JS half of the close handshake with a
// fake Tauri runtime: pending save flush, save failure, hung disk, rapid
// edit -> close, double-click on X, and "never un-closable".

import { makeChecker } from "./helpers/fakeDisk.mjs";
const { check, done } = makeChecker();
const realWarn = console.warn;
console.warn = (...a) => { if (String(a[0]).startsWith("[shutdown]")) return; realWarn(...a); };

const { registerFlusher, flushAll, hasPendingChanges, installCloseHandler } = await import("../src/js/services/ShutdownService.js");
const { SerialSaveQueue } = await import("../src/js/utils/SaveQueue.js");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fakeTauri({ askResult = true, askThrows = false } = {}) {
  const calls = [];
  const listeners = new Map();
  const tauri = {
    core: { invoke: async (name) => { calls.push(name); } },
    event: { listen: async (name, cb) => { listeners.set(name, cb); return () => listeners.delete(name); } },
    dialog: { ask: async (msg, opts) => { calls.push("ask"); if (askThrows) throw new Error("dialog unavailable"); return askResult; } },
  };
  const fire = () => listeners.get("app:close-requested")();
  return { tauri, calls, fire, listeners };
}
async function closeFlow(opts, prep) {
  const t = fakeTauri(opts);
  const handler = await installCloseHandler(t.tauri, { timeoutMs: opts.timeoutMs ?? 300 });
  await prep?.();
  await handler.handleCloseRequested();
  handler.dispose();
  return t.calls;
}

// ---- flushAll basics ------------------------------------------------------------
{
  const un = registerFlusher("t-ok", { flush: async () => {}, isDirty: () => false });
  const r = await flushAll();
  un();
  check("flushAll: ok when every flusher succeeds", r.ok === true && r.failures.length === 0);
}
{
  const un1 = registerFlusher("t-bad", { flush: async () => { throw new Error("disk full"); }, isDirty: () => true });
  let ranOther = false;
  const un2 = registerFlusher("t-other", { flush: async () => { ranOther = true; }, isDirty: () => false });
  const r = await flushAll({ timeoutMs: 500 });
  un1(); un2();
  check("flushAll: a failing flusher is reported (never throws)", r.ok === false && r.failures.some((f) => f.name === "t-bad" && /disk full/.test(f.error.message)));
  check("flushAll: one failure doesn't stop the others from flushing", ranOther);
}
{
  const un = registerFlusher("t-hung", { flush: () => new Promise(() => {}), isDirty: () => true });
  const t0 = Date.now();
  const r = await flushAll({ timeoutMs: 120 });
  un();
  check("flushAll: a hung disk times out instead of wedging shutdown", r.ok === false && r.failures.some((f) => f.name === "timeout") && Date.now() - t0 < 1500);
}
{
  const un = registerFlusher("t-dirty", { flush: async () => {}, isDirty: () => true });
  const r = await flushAll({ timeoutMs: 300 });
  un();
  check("flushAll: a flush that 'succeeds' but leaves dirty state is a failure", r.ok === false && r.failures.some((f) => f.name === "pending"));
}

// ---- pending save flushed BEFORE the app is allowed to exit ---------------------------
{
  let disk = "v0", state = "v0";
  const order = [];
  const q = new SerialSaveQueue(async () => { const snap = state; await tick(30); disk = snap; order.push("write-finished"); }, { name: "t-queue" });
  const t = fakeTauri({});
  t.tauri.core.invoke = async (name) => { t.calls.push(name); order.push(name); }; // before install: the handler captures invoke at install time
  const handler = await installCloseHandler(t.tauri, { timeoutMs: 1000 });
  state = "v1";
  q.request(); // a save is in flight when the teacher hits X
  state = "v2";
  q.request(); // and another edit is queued behind it
  await handler.handleCloseRequested();
  handler.dispose();
  check("close: the final atomic save COMPLETED before confirm_close", order.indexOf("write-finished") !== -1 && order.indexOf("write-finished") < order.indexOf("confirm_close"));
  check("close: disk holds the LATEST state (v2) at exit", disk === "v2");
  check("close: handshake order is close_ack -> flush -> confirm_close", order[0] === "close_ack" && order.at(-1) === "confirm_close");
}

// ---- rapid edit -> close (editor-style debounced autosave) ------------------------------------
{
  let disk = "saved", buffer = "saved";
  let dirty = false, timer = null;
  const q = new SerialSaveQueue(async () => { const snap = buffer; await tick(5); disk = snap; });
  const flushEditor = async () => { if (timer) { clearTimeout(timer); timer = null; } if (dirty) { await q.request(); dirty = false; } };
  const un = registerFlusher("t-editor", { flush: flushEditor, isDirty: () => dirty || !!timer });
  const unq = registerFlusher("t-editor-queue", { flush: () => q.flush(), isDirty: () => q.hasPending });
  // typing: each keystroke schedules a 700ms autosave that hasn't fired yet
  for (const ch of ["h", "e", "l", "l", "o"]) { buffer += ch; dirty = true; if (timer) clearTimeout(timer); timer = setTimeout(() => flushEditor(), 700); }
  check("rapid edit: the change is only in memory when the window is closed", disk === "saved" && hasPendingChanges());
  const calls = await closeFlow({ timeoutMs: 1000 });
  un(); unq();
  check("rapid edit -> close: the debounced edit is flushed to disk before exit", disk === "savedhello" && calls.at(-1) === "confirm_close");
  check("rapid edit -> close: no leftover pending state", !hasPendingChanges());
}

// ---- save failure at close -------------------------------------------------------------------------
{
  const q = new SerialSaveQueue(async () => { throw new Error("disk unplugged"); }, { name: "t-failing-queue" });
  q.request().catch(() => {});
  await tick();
  const yes = await closeFlow({ askResult: true }, null);
  check("save failure at close: teacher is asked, and 'Close without saving' exits", yes.join() === "close_ack,ask,confirm_close");

  q.request().catch(() => {});
  await tick();
  const no = await closeFlow({ askResult: false }, null);
  check("save failure at close: 'Keep editing' cancels the close (window stays open, not stuck)", no.join() === "close_ack,ask,cancel_close");

  q.request().catch(() => {});
  await tick();
  const broken = await closeFlow({ askThrows: true }, null);
  check("save failure + the dialog itself failing: the app still closes (never un-closable)", broken.join() === "close_ack,ask,confirm_close");
  registerFlusher("t-failing-queue", { flush: async () => {}, isDirty: () => false }); // neutralise for later tests
}

// ---- hung disk at close -------------------------------------------------------------------------------
{
  const un = registerFlusher("t-hung-close", { flush: () => new Promise(() => {}), isDirty: () => true });
  const calls = await closeFlow({ askResult: false, timeoutMs: 100 }, null);
  un();
  check("hung disk at close: bounded by the timeout, then the teacher chooses (not frozen forever)", calls.join() === "close_ack,ask,cancel_close");
}

// ---- nothing pending: closes straight away ----------------------------------------------------------------
{
  const calls = await closeFlow({}, null);
  check("nothing pending: close_ack then confirm_close, no prompt", calls.join() === "close_ack,confirm_close");
}

// ---- double click on X while flushing --------------------------------------------------------------------------
{
  const t = fakeTauri({});
  let release;
  const gate = new Promise((r) => { release = r; });
  const un = registerFlusher("t-slow", { flush: () => gate, isDirty: () => false });
  const handler = await installCloseHandler(t.tauri, { timeoutMs: 2000 });
  const first = handler.handleCloseRequested();
  await tick();
  await handler.handleCloseRequested(); // second click while the first is mid-flush
  release();
  await first;
  un();
  handler.dispose();
  check("double-click on X: only one handshake runs (one close_ack, one confirm_close)", t.calls.filter((c) => c === "close_ack").length === 1 && t.calls.filter((c) => c === "confirm_close").length === 1);
}

// ---- close_ack failure doesn't block the flush ------------------------------------------------------------------------
{
  const t = fakeTauri({});
  t.tauri.core.invoke = async (name) => { t.calls.push(name); if (name === "close_ack") throw new Error("ipc hiccup"); };
  let flushed = false;
  const un = registerFlusher("t-flag", { flush: async () => { flushed = true; }, isDirty: () => false });
  const handler = await installCloseHandler(t.tauri, { timeoutMs: 500 });
  await handler.handleCloseRequested();
  un(); handler.dispose();
  check("close_ack failing doesn't stop the save or the exit", flushed && t.calls.at(-1) === "confirm_close");
}

// ---- Present Mode gate (used by app.js navigate("present")) --------------------------------------------------------------
{
  let saved = false;
  const un = registerFlusher("t-present", { flush: async () => { saved = true; }, isDirty: () => !saved });
  const ok = await flushAll();
  un();
  check("entering Present Mode flushes pending changes first", ok.ok && saved);
  const un2 = registerFlusher("t-present-bad", { flush: async () => { throw new Error("nope"); }, isDirty: () => true });
  const bad = await flushAll({ timeoutMs: 300 });
  un2();
  check("…and reports failure so Present Mode is not silently started on unsaved state", bad.ok === false);
}

done();
