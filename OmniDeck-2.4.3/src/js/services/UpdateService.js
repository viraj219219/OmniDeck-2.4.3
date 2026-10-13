import { flushAll } from "./ShutdownService.js";

/**
 * Secure in-app updates from GitHub Releases (Tauri v2 updater plugin).
 *
 * Trust model (all enforced by the Rust plugin, NOT by this file):
 *   - releases are listed in latest.json served over HTTPS from this repo's
 *     GitHub Releases (endpoint is injected at release-build time);
 *   - every artifact is signed with the release private key; the plugin
 *     verifies the minisign signature against the PUBLIC key compiled into the
 *     app and refuses anything that doesn't verify. This file only decides
 *     WHEN to ask and how to explain the outcome.
 *
 * Builds without a configured key (dev, PRs) report { configured: false } and
 * never register the updater at all.
 *
 * Cancellation honesty: the plugin has no abort for an in-flight download.
 * "Cancel" therefore stops the flow at the next safe point: the downloaded file is
 * discarded and NOTHING is installed.
 */

export const UPDATE_ERRORS = Object.freeze({
  OFFLINE: "offline",
  NOT_FOUND: "not-found",
  INTEGRITY: "integrity",
  INSTALL: "install",
  SAVE: "save",
  UNKNOWN: "unknown",
});

const MESSAGES = {
  [UPDATE_ERRORS.OFFLINE]: "Couldn't reach the update server. Check your internet connection — OmniDeck keeps working normally offline.",
  [UPDATE_ERRORS.NOT_FOUND]: "No update information is published yet for this release channel. Try again later.",
  [UPDATE_ERRORS.INTEGRITY]: "The downloaded update failed its security check and was discarded. Nothing was installed.",
  [UPDATE_ERRORS.INSTALL]: "The update couldn't be installed. Your current version is unchanged and still works.",
  [UPDATE_ERRORS.SAVE]: "Your work couldn't be saved first, so the update was not installed. Save your changes and try again.",
  [UPDATE_ERRORS.UNKNOWN]: "Updating failed unexpectedly. Your current version is unchanged.",
};

export function classifyUpdateError(err) {
  const text = String(err?.message ?? err ?? "").toLowerCase();
  if (/signature|verif|minisign|checksum|hash|decod|invalid (?:public )?key/.test(text)) return UPDATE_ERRORS.INTEGRITY;
  if (/error sending request|network|dns|connect|timed? ?out|offline|unreachable|resolve|tls|ssl|certificate/.test(text)) return UPDATE_ERRORS.OFFLINE;
  if (/404|not found|valid release json|status code|no release|could not fetch/.test(text)) return UPDATE_ERRORS.NOT_FOUND;
  if (/install|permission|denied|access|rename|replace|in use|elevat|appimage/.test(text)) return UPDATE_ERRORS.INSTALL;
  return UPDATE_ERRORS.UNKNOWN;
}

export class UpdateError extends Error {
  constructor(kind, cause) {
    super(MESSAGES[kind] || MESSAGES[UPDATE_ERRORS.UNKNOWN]);
    this.name = "UpdateError";
    this.kind = kind;
    this.cause = cause;
  }
}

export class UpdateService {
  /**
   * deps: { tauri: () => window.__TAURI__ | undefined, flush: () => Promise<{ok,failures}> }
   */
  constructor(deps = {}) {
    this._tauri = deps.tauri ?? (() => globalThis.window?.__TAURI__);
    this._flush = deps.flush ?? (() => flushAll({ timeoutMs: 8000 }));
    this._busy = false;
    this._pending = null; // the Update resource from the last successful check
    this._startupChecked = false;
  }

  get busy() { return this._busy; }

  /** { configured, canSelfInstall, reason, version } — never throws. */
  async status() {
    const invoke = this._tauri()?.core?.invoke;
    if (!invoke) return { configured: false, canSelfInstall: false, reason: "Updates are available in the desktop app only.", version: null };
    try {
      return await invoke("updater_status");
    } catch (err) {
      return { configured: false, canSelfInstall: false, reason: "Couldn't determine update support.", version: null };
    }
  }

  /**
   * Asks the release server whether a newer, compatible version exists.
   * Returns { state: "unavailable" } | { state: "up-to-date" } |
   *         { state: "available", version, notes, date, canSelfInstall, reason } |
   *         { state: "error", kind, message }.   Never throws.
   */
  async check() {
    if (this._busy) return { state: "error", kind: UPDATE_ERRORS.UNKNOWN, message: "An update is already in progress." };
    const st = await this.status();
    if (!st.configured) return { state: "unavailable", reason: st.reason };
    const updater = this._tauri()?.updater;
    if (!updater?.check) return { state: "unavailable", reason: "The updater isn't available in this build." };
    try {
      const update = await updater.check({ timeout: 15000 });
      this._pending = update || null;
      if (!update) return { state: "up-to-date", version: st.version };
      return {
        state: "available",
        version: update.version,
        currentVersion: update.currentVersion ?? st.version,
        notes: typeof update.body === "string" ? update.body.slice(0, 1500) : "",
        date: update.date ?? null,
        canSelfInstall: !!st.canSelfInstall,
        reason: st.reason ?? null,
      };
    } catch (err) {
      const kind = classifyUpdateError(err);
      return { state: "error", kind, message: MESSAGES[kind] };
    }
  }

  /**
   * Download -> (signature verified by the plugin) -> flush saves -> install -> restart.
   * onProgress({ phase: "downloading"|"verifying"|"installing"|"restarting", received, total })
   * signal: AbortSignal. Resolves { cancelled: true } or { installed: true }; throws UpdateError.
   */
  async downloadAndInstall({ onProgress = () => {}, signal } = {}) {
    if (this._busy) throw new UpdateError(UPDATE_ERRORS.UNKNOWN);
    this._busy = true; // claimed synchronously, BEFORE any await, so concurrent calls can't both pass
    try {
      const update = this._pending;
      if (!update) throw new UpdateError(UPDATE_ERRORS.UNKNOWN, new Error("no checked update"));
      const st = await this.status();
      if (!st.canSelfInstall) throw new UpdateError(UPDATE_ERRORS.INSTALL, new Error(st.reason || "this installation can't update itself"));
      let received = 0, total = 0;
      try {
        await update.download((e) => {
          if (e.event === "Started") { total = e.data?.contentLength ?? 0; received = 0; }
          else if (e.event === "Progress") received += e.data?.chunkLength ?? 0;
          onProgress({ phase: e.event === "Finished" ? "verifying" : "downloading", received, total });
        }, { timeout: 120000 });
      } catch (err) {
        throw new UpdateError(classifyUpdateError(err), err);
      }
      if (signal?.aborted) {
        try { await update.close?.(); } catch { /* resource already gone */ }
        this._pending = null;
        return { cancelled: true };
      }

      // Never replace the app while the teacher has unsaved work.
      const saved = await this._flush();
      if (saved && saved.ok === false) throw new UpdateError(UPDATE_ERRORS.SAVE, new Error("flush failed"));

      onProgress({ phase: "installing", received, total });
      try {
        await update.install();
      } catch (err) {
        const kind = classifyUpdateError(err);
        throw new UpdateError(kind === UPDATE_ERRORS.INTEGRITY ? kind : UPDATE_ERRORS.INSTALL, err);
      }
      onProgress({ phase: "restarting", received, total });
      this._pending = null;
      try { await this._tauri()?.core?.invoke("restart_app"); } catch { /* Windows installers quit the app themselves */ }
      return { installed: true };
    } finally {
      this._busy = false;
    }
  }

  /**
   * One quiet check per launch. Returns the version string only when the user
   * should be told (new version, and not while presenting); never throws and
   * never surfaces offline/not-found errors (silent on failure by design).
   */
  async startupCheck({ isPresenting = () => false } = {}) {
    if (this._startupChecked) return null;
    this._startupChecked = true;
    const r = await this.check();
    if (r.state === "available" && !isPresenting()) return r.version;
    return null;
  }
}

export const updateService = new UpdateService();
