import { isRunningInTauri, readJSON, writeJSON } from "../utils/storageAdapter.js";

const DISPLAY_CONFIG_FILE = "display-config.json";

/**
 * Pure, dependency-free decision logic for two-display Present Mode,
 * factored out of resolveDisplayPlan() specifically so it can be exercised
 * by automated tests with synthetic monitor lists — no real Tauri runtime,
 * no storage — for the 1/2/3-monitor and forced-single scenarios.
 *
 * Given the full list of currently connected monitors and the persisted
 * display settings, decides whether this session should run single- or
 * dual-display, and — if dual — which monitor is the audience display.
 *
 * Hardening rules enforced here, all defensive against a stale settings
 * file, a monitor unplugged/replugged since the setting was saved, or a
 * platform that doesn't reliably flag a primary monitor:
 *   - Fewer than 2 monitors → always single, regardless of settings.
 *   - settings.mode === "single" → always single (explicit override),
 *     even with 2+ monitors connected.
 *   - The presenter's own screen is treated as the primary monitor; the
 *     audience monitor may NEVER be the primary monitor, even if a
 *     settings file explicitly names it (hand-edited, or written before
 *     this rule existed). If no monitor reports isPrimary (some window
 *     managers don't), monitor 0 is treated as primary so there's still a
 *     well-defined "not the presenter's screen" set to pick from.
 *   - A saved audienceMonitorIndex that is out of range, negative,
 *     non-integer, or points at the resolved primary monitor is treated
 *     as unset and re-resolved automatically instead of being trusted.
 *   - Auto-selection picks the first non-primary monitor in list order.
 */
export function computeDisplayPlan(monitors, settings) {
  const list = Array.isArray(monitors) ? monitors : [];
  if (list.length < 2) {
    return { mode: "single", monitors: list };
  }
  if (settings?.mode === "single") {
    return { mode: "single", monitors: list };
  }

  let primaryIndex = list.findIndex((m) => m && m.isPrimary);
  if (primaryIndex === -1) primaryIndex = 0;

  const requested = settings?.audienceMonitorIndex;
  const isValidChoice =
    Number.isInteger(requested) &&
    requested >= 0 &&
    requested < list.length &&
    requested !== primaryIndex;

  const audienceMonitorIndex = isValidChoice
    ? requested
    : list.findIndex((_, i) => i !== primaryIndex); // guaranteed to exist: list.length >= 2

  return { mode: "dual", audienceMonitorIndex, primaryIndex, monitors: list };
}

/**
 * PresentationService — owns everything about how Present Mode reaches the
 * screen(s): true OS fullscreen for the presenter's own window (every
 * church, every time), and — only for churches with 2+ displays — a second
 * chrome-less "audience" window fullscreened on a chosen monitor, plus
 * broadcasting the current slide state to it. Single-display churches are
 * completely unaffected: resolveDisplayPlan() returns { mode: "single" }
 * for them and nothing about the audience window is ever touched.
 */
export class PresentationService {
  async enterFullscreen() { throw new Error("Not implemented"); }
  async exitFullscreen() { throw new Error("Not implemented"); }
  async getMonitors() { throw new Error("Not implemented"); }
  async getDisplaySettings() { throw new Error("Not implemented"); }
  async setDisplaySettings(_settings) { throw new Error("Not implemented"); }
  async resolveDisplayPlan() { throw new Error("Not implemented"); }
  async openAudienceWindow(_monitorIndex) { throw new Error("Not implemented"); }
  async closeAudienceWindow() { throw new Error("Not implemented"); }
  async checkAudiencePlacement() { throw new Error("Not implemented"); }
  async broadcastSlideState(_state) { throw new Error("Not implemented"); }
  async onAudienceReady(_callback) { throw new Error("Not implemented"); }
  async broadcastMediaState(_state) { throw new Error("Not implemented"); }
}

export class TauriPresentationService extends PresentationService {
  async enterFullscreen() {
    if (!isRunningInTauri) {
      // Browser dev-preview fallback so Present Mode is still testable
      // without the native shell running.
      await document.documentElement.requestFullscreen?.().catch(() => {});
      return;
    }
    const { invoke } = window.__TAURI__.core;
    await invoke("set_presentation_fullscreen", { enabled: true });
  }

  async exitFullscreen() {
    if (!isRunningInTauri) {
      if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
      return;
    }
    const { invoke } = window.__TAURI__.core;
    await invoke("set_presentation_fullscreen", { enabled: false });
  }

  /**
   * Real connected monitors, via Tauri's window/monitor API. Two-display
   * Present Mode is desktop-only by nature (a browser tab can't move
   * windows onto a second physical screen), so the browser dev-preview
   * always reports a single monitor — which correctly keeps it on the
   * single-display path.
   */
  async getMonitors() {
    if (!isRunningInTauri) return [{ index: 0, name: "Preview", isPrimary: true }];
    const { invoke } = window.__TAURI__.core;
    return invoke("list_monitors");
  }

  async getDisplaySettings() {
    const fallback = { mode: "auto", audienceMonitorIndex: null };
    try {
      return (await readJSON(DISPLAY_CONFIG_FILE, null)) || fallback;
    } catch (err) {
      // Display settings are a convenience, not the teacher's content —
      // an unreadable/corrupt config file just falls back to "auto" rather
      // than blocking Present Mode. Logged, not silently pretended-fine.
      console.warn("[PresentationService] display settings could not be read, using defaults", err);
      return fallback;
    }
  }

  async setDisplaySettings(settings) {
    const ok = await writeJSON(DISPLAY_CONFIG_FILE, settings);
    if (!ok) throw new Error("Couldn't save display settings.");
  }

  /**
   * Decides, for this specific Present Mode session, whether to use one
   * display or two, and (if two) which monitor is the audience display.
   *   - Fewer than 2 monitors connected → always single, regardless of
   *     settings — there's nowhere to put a second window.
   *   - Settings forced to "single" → single, even with 2+ monitors
   *     connected (the teacher's explicit override).
   *   - Otherwise → dual. The audience monitor is whichever the teacher
   *     picked in Settings, or, if they left it on Auto (or their pick is
   *     no longer valid — see computeDisplayPlan), the first non-primary
   *     monitor. The primary monitor — the presenter's own screen — can
   *     never be selected as the audience monitor.
   */
  async resolveDisplayPlan() {
    const monitors = await this.getMonitors();
    if (!isRunningInTauri || monitors.length < 2) {
      return { mode: "single", monitors };
    }
    const settings = await this.getDisplaySettings();
    return computeDisplayPlan(monitors, settings);
  }

  /**
   * Opens the audience window. The backend (see open_audience_window in
   * main.rs) independently refuses to place it on the presenter's own
   * monitor even if `monitorIndex` claims otherwise — this call can
   * therefore reject with an error (e.g. a stale index from a monitor
   * that's since been unplugged, or one that resolves to the presenter's
   * screen), which callers must handle rather than assume dual mode
   * always succeeds once resolveDisplayPlan has said "dual".
   */
  async openAudienceWindow(monitorIndex) {
    const { invoke } = window.__TAURI__.core;
    await invoke("open_audience_window", { monitorIndex });
  }

  async closeAudienceWindow() {
    if (!isRunningInTauri) return;
    const { invoke } = window.__TAURI__.core;
    await invoke("close_audience_window");
  }

  /**
   * Where the audience window is right now: { open, ok, problem, monitorCount }.
   * `ok` is only true when it is on a display of its own (never the
   * presenter's). Used by DisplayWatcher to survive hot-plugged monitors.
   */
  async checkAudiencePlacement() {
    if (!isRunningInTauri) return { open: false, ok: false, problem: "no-audience-window", monitorCount: 1 };
    const { invoke } = window.__TAURI__.core;
    return invoke("audience_placement_status");
  }

  async broadcastSlideState(state) {
    if (!isRunningInTauri) return;
    const { emit } = window.__TAURI__.event;
    await emit("presenter:slide-state", state);
  }

  /** Relays the presenter's video play/pause/seek so the audience copy follows (and is the only one with sound). */
  async broadcastMediaState(state) {
    if (!isRunningInTauri) return;
    const { emit } = window.__TAURI__.event;
    await emit("presenter:media-state", state);
  }

  /**
   * Audience-ready handshake. The audience window is a separate OS window
   * with its own (async) module load — there's no guarantee it has
   * finished registering its "presenter:slide-state" listener by the time
   * the presenter draws and broadcasts the first slide, so that first
   * broadcast can arrive before anyone is listening for it and be lost
   * with nothing to retry it.
   *
   * To close that gap, audience.js emits "audience:ready" itself, right
   * after it registers its slide-state listener (see audience.js). The
   * presenter subscribes here — before opening the audience window, so it
   * can never miss the ready signal either — and re-broadcasts whatever
   * the current slide state is when it arrives. That guarantees the
   * audience display always ends up showing the current slide once it's
   * actually able to render it, regardless of load timing, and it's safe
   * to fire more than once (e.g. if the audience window is ever reloaded).
   */
  async onAudienceReady(callback) {
    if (!isRunningInTauri) return () => {};
    const { listen } = window.__TAURI__.event;
    return listen("audience:ready", callback);
  }
}

// Singleton.
export const presentationService = new TauriPresentationService();
