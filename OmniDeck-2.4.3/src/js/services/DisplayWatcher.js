// DisplayWatcher — keeps two-display Present Mode safe while monitors are
// hot-plugged.
//
// The problem it solves: Present Mode plans its displays ONCE, at the start.
// If the projector/second monitor is unplugged (or its cable is knocked out)
// mid-service, the OS/window manager drags the orphaned, fullscreen audience
// window onto whichever display is left — the presenter's own screen —
// covering the controls. And when the display comes back nothing re-opened it.
//
// While Present Mode is running this polls:
//   DUAL   the audience window must be on its own display. If it isn't
//          (second display gone / window dragged onto the presenter's screen /
//          off-screen) -> close the audience window at once, keep presenting
//          on one screen, tell the teacher (onLost).
//   LOST   (or started single) watch for a second display appearing. Once a
//          dual plan is stable for two consecutive polls, open the audience
//          window on it again (onRestored). A teacher who FORCED single-display
//          in Settings never gets this: resolveDisplayPlan() keeps returning
//          "single" for them.
//
// Pure logic with injected service/timer so it is fully unit-testable; the
// real service calls are Tauri commands (see PresentationService).

export function createDisplayWatcher({
  service,
  initialMode = "dual",       // "dual" | "single"
  onLost = () => {},
  onRestored = () => {},
  intervalMs = 1500,
  graceMs = 2500,             // ignore placement right after (re)opening: the window is still settling
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id),
} = {}) {
  let mode = initialMode;
  let openedAt = now();
  let stableDualPolls = 0;
  let timer = null;
  let busy = false;
  let stopped = false;

  async function poll() {
    if (stopped || busy) return;
    busy = true;
    try {
      if (mode === "dual") {
        if (now() - openedAt < graceMs) return;
        let status;
        try {
          status = await service.checkAudiencePlacement();
        } catch (err) {
          console.warn("[DisplayWatcher] placement check failed; will retry", err);
          return;
        }
        if (status?.ok) return;
        // Definitively wrong: get the audience window off the presenter's
        // screen FIRST, explain afterwards.
        try { await service.closeAudienceWindow(); } catch (err) { console.warn("[DisplayWatcher] closing the audience window failed", err); }
        mode = "lost";
        stableDualPolls = 0;
        onLost(status?.problem || "unknown", status);
      } else {
        let plan;
        try {
          plan = await service.resolveDisplayPlan();
        } catch (err) {
          console.warn("[DisplayWatcher] display plan failed; will retry", err);
          return;
        }
        if (plan?.mode !== "dual") { stableDualPolls = 0; return; }
        stableDualPolls++;
        if (stableDualPolls < 2) return;   // debounce: a cable being seated flaps
        try {
          await service.openAudienceWindow(plan.audienceMonitorIndex);
        } catch (err) {
          console.warn("[DisplayWatcher] couldn't restore the audience display yet", err);
          stableDualPolls = 0;
          return;
        }
        mode = "dual";
        openedAt = now();
        onRestored(plan);
      }
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      openedAt = now();
      timer = setTimer(() => { poll(); }, intervalMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    poll,
    get mode() { return mode; },
  };
}

/** Teacher-facing wording for each reason the audience display was dropped. */
export function describeLostDisplay(problem) {
  switch (problem) {
    case "second-display-disconnected":
      return "The second display was disconnected. The audience window was closed so it can't cover your presenter screen — you're presenting on one screen. It will come back automatically when the display is reconnected.";
    case "audience-on-presenter-display":
      return "The audience window ended up on your presenter screen, so it was closed to keep your controls visible. It will reopen on the second display when that's available.";
    default:
      return "The audience display is no longer available, so it was closed. It will reopen automatically when a second display is available.";
  }
}
