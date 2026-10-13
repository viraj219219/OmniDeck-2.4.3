// ShutdownService — coordinates "flush everything that's pending" for app
// close, entering Present Mode, and any other point where unsaved work must
// reach disk first.
//
// Pieces that hold pending state register a flusher:
//   registerFlusher("lessons", { flush: () => queue.flush(), isDirty: () => queue.hasPending })
// The lesson editor registers its debounced-autosave flusher the same way.
//
// Real app close is driven by the NATIVE lifecycle, not by `beforeunload`
// (an async filesystem write can't be awaited from it, and Tauri doesn't
// even fire it when the window is closed): src-tauri/src/main.rs intercepts
// the window's CloseRequested event, keeps the window open, and emits
// "app:close-requested". installCloseHandler() below answers it: flush
// everything (bounded by a timeout so a hung disk can't wedge the app), then
// tell Rust to proceed; if the flush fails, ask the teacher whether to close
// anyway or keep editing. Rust also has its own watchdog so an unresponsive
// webview can never make the window impossible to close.

const flushers = new Map();

/** Registers (or replaces) a named flusher. Returns an unregister function. */
export function registerFlusher(name, { flush, isDirty }) {
  const entry = { flush, isDirty: isDirty || (() => false) };
  flushers.set(name, entry);
  return () => { if (flushers.get(name) === entry) flushers.delete(name); };
}

export function hasPendingChanges() {
  for (const f of flushers.values()) {
    try { if (f.isDirty()) return true; } catch { return true; }
  }
  return false;
}

/**
 * Flushes every registered flusher. Never throws: returns
 * { ok, failures: [{name, error}] } so callers can decide what to do.
 * Flushers run in registration order (editor first, then the queues it
 * feeds), and a failure in one doesn't stop the others from trying.
 */
export async function flushAll({ timeoutMs = 8000 } = {}) {
  let errors = new Map();
  const run = (async () => {
    // Two passes: an editor flush may itself enqueue a lesson save, and a
    // failed write gets one more attempt.
    for (let pass = 0; pass < 2; pass++) {
      errors = new Map();
      for (const [name, f] of [...flushers]) {
        try {
          await f.flush();
        } catch (error) {
          errors.set(name, error);
        }
      }
      if (errors.size === 0 && !hasPendingChanges()) break;
    }
  })();

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([run.then(() => "done"), timeout]);
  clearTimeout(timer);

  const failures = [...errors].map(([name, error]) => ({ name, error }));
  if (outcome === "timeout") {
    failures.push({ name: "timeout", error: new Error(`Saving didn't finish within ${Math.round(timeoutMs / 1000)}s.`) });
  } else if (failures.length === 0 && hasPendingChanges()) {
    // A flush that "succeeded" but left dirty state behind is a failure too.
    failures.push({ name: "pending", error: new Error("Some changes are still unsaved.") });
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Wires the native close flow. `tauri` is window.__TAURI__ (injected so
 * this can be tested without a real runtime). Returns { handleCloseRequested,
 * dispose } — handleCloseRequested is exposed for tests.
 *
 * Sequence on "app:close-requested":
 *   1. invoke("close_ack")      tell Rust the webview is alive (disarms its watchdog)
 *   2. flushAll()               final atomic saves
 *   3a. success  -> invoke("confirm_close")           app exits
 *   3b. failure  -> ask "Close without saving?"
 *          yes -> invoke("confirm_close")             (teacher's informed choice)
 *          no  -> invoke("cancel_close")              window stays open, editing continues
 *   If even the dialog fails, close: the flush already failed and there is
 *   nothing more that can be done, and the app must never be un-closable.
 */
export async function installCloseHandler(tauri, { flush = flushAll, timeoutMs = 8000 } = {}) {
  const { invoke } = tauri.core;
  const { listen } = tauri.event;
  const ask = tauri.dialog?.ask;
  let busy = false;

  async function handleCloseRequested() {
    if (busy) return; // a second click on X while we're already flushing
    busy = true;
    try {
      try { await invoke("close_ack"); } catch (err) { console.warn("[shutdown] close_ack failed", err); }
      const result = await flush({ timeoutMs });
      if (result.ok) {
        await invoke("confirm_close");
        return;
      }
      console.warn("[shutdown] final save failed", result.failures);
      let closeAnyway;
      try {
        closeAnyway = await ask(
          "Some of your latest changes couldn't be saved. Close OmniDeck anyway and lose them?",
          { title: "Unsaved changes", kind: "warning", okLabel: "Close without saving", cancelLabel: "Keep editing" }
        );
      } catch (err) {
        console.warn("[shutdown] confirmation dialog failed; closing", err);
        closeAnyway = true;
      }
      if (closeAnyway) await invoke("confirm_close");
      else await invoke("cancel_close");
    } finally {
      busy = false;
    }
  }

  const unlisten = await listen("app:close-requested", () => { handleCloseRequested(); });
  return { handleCloseRequested, dispose: () => unlisten?.() };
}
