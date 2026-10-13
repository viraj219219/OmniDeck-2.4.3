// Regression tests for hot-plug safety in two-display Present Mode
// (DisplayWatcher). Pure logic with a fake service + fake clock; the same
// scenarios are exercised against a real two-monitor X display with real
// RandR hot-plug events in tests/e2e/.

import { makeChecker } from "./helpers/fakeDisk.mjs";
const { check, done } = makeChecker();
const realWarn = console.warn;
console.warn = (...a) => { if (String(a[0]).startsWith("[DisplayWatcher]")) return; realWarn(...a); };

const { createDisplayWatcher, describeLostDisplay } = await import("../src/js/services/DisplayWatcher.js");

function harness({ initialMode = "dual" } = {}) {
  const h = {
    clock: 0,
    placement: { open: true, ok: true, problem: null, monitorCount: 2 },
    plan: { mode: "dual", audienceMonitorIndex: 1 },
    calls: [],
    lost: [], restored: [],
    failOpen: false, failPlacement: false, failClose: false,
  };
  const service = {
    checkAudiencePlacement: async () => { h.calls.push("check"); if (h.failPlacement) throw new Error("ipc"); return h.placement; },
    closeAudienceWindow: async () => { h.calls.push("close"); if (h.failClose) throw new Error("close failed"); },
    resolveDisplayPlan: async () => { h.calls.push("plan"); return h.plan; },
    openAudienceWindow: async (i) => { h.calls.push("open:" + i); if (h.failOpen) throw new Error("no such monitor"); },
  };
  h.watcher = createDisplayWatcher({
    service, initialMode,
    onLost: (problem) => h.lost.push(problem),
    onRestored: (plan) => h.restored.push(plan),
    now: () => h.clock,
    graceMs: 2500,
    setTimer: () => 1, clearTimer: () => {},
  });
  h.count = (c) => h.calls.filter((x) => x === c).length;
  h.tick = async (ms = 1500) => { h.clock += ms; await h.watcher.poll(); };
  return h;
}

// ---- healthy dual: nothing happens -------------------------------------------------------------
{
  const h = harness();
  await h.tick(3000); await h.tick(); await h.tick();
  check("dual + audience on its own display: never closed, never reported", h.count("close") === 0 && h.lost.length === 0 && h.watcher.mode === "dual");
}

// ---- grace period right after opening --------------------------------------------------------------
{
  const h = harness();
  h.placement = { open: true, ok: false, problem: "audience-on-presenter-display", monitorCount: 2 };
  await h.tick(1000);
  check("placement isn't judged while the window is still settling (grace)", h.count("check") === 0 && h.lost.length === 0);
  await h.tick(2000);
  check("…but is judged once the grace period has passed", h.count("check") === 1 && h.lost.length === 1);
}

// ---- unplug the second display ------------------------------------------------------------------------
{
  const h = harness();
  await h.tick(3000);
  h.placement = { open: true, ok: false, problem: "second-display-disconnected", monitorCount: 1 };
  await h.tick();
  check("second display unplugged: the audience window is CLOSED", h.count("close") === 1);
  check("…the teacher is told why (reason passed through)", h.lost.length === 1 && h.lost[0] === "second-display-disconnected");
  check("…watcher switches to looking for a display to come back", h.watcher.mode === "lost");
  await h.tick(); await h.tick();
  check("…and it reports the loss only ONCE", h.lost.length === 1 && h.count("close") === 1);
}

// ---- window dragged onto the presenter's display -----------------------------------------------------------
{
  const h = harness();
  await h.tick(3000);
  h.placement = { open: true, ok: false, problem: "audience-on-presenter-display", monitorCount: 2 };
  await h.tick();
  check("audience window dragged onto the presenter's screen: closed immediately", h.count("close") === 1 && h.lost[0] === "audience-on-presenter-display");
}

// ---- transient errors don't cause a false alarm ---------------------------------------------------------------
{
  const h = harness();
  await h.tick(3000);
  h.failPlacement = true;
  await h.tick(); await h.tick();
  check("a failing placement check is retried, NOT treated as 'display lost'", h.count("close") === 0 && h.lost.length === 0 && h.watcher.mode === "dual");
  h.failPlacement = false;
  await h.tick();
  check("…and recovers", h.watcher.mode === "dual");
}

// ---- close failing still ends in a safe state -------------------------------------------------------------------
{
  const h = harness();
  h.failClose = true;
  await h.tick(3000);
  h.placement = { open: true, ok: false, problem: "second-display-disconnected", monitorCount: 1 };
  await h.tick();
  check("even if closing the window errors, Present Mode is marked single-display and the teacher is told", h.watcher.mode === "lost" && h.lost.length === 1);
}

// ---- re-plug: restored after a debounce ----------------------------------------------------------------------------
{
  const h = harness();
  await h.tick(3000);
  h.placement = { open: true, ok: false, problem: "second-display-disconnected", monitorCount: 1 };
  h.plan = { mode: "single", monitors: [1] };
  await h.tick();
  await h.tick(); await h.tick();
  check("while unplugged: no attempt to reopen", h.count("open:1") === 0);
  h.plan = { mode: "dual", audienceMonitorIndex: 1 };
  await h.tick();
  check("re-plugged: NOT reopened on the first sighting (cable still seating)", h.count("open:1") === 0);
  await h.tick();
  check("re-plugged and stable for two polls: audience window reopened on the new display", h.count("open:1") === 1 && h.restored.length === 1 && h.watcher.mode === "dual");
  h.placement = { open: true, ok: true, problem: null, monitorCount: 2 };
  await h.tick(); await h.tick();
  check("after restoring it is healthy again (grace, then ok)", h.lost.length === 1 && h.watcher.mode === "dual");
}

// ---- flapping display -------------------------------------------------------------------------------------------------
{
  const h = harness();
  await h.tick(3000);
  h.placement = { open: true, ok: false, problem: "second-display-disconnected", monitorCount: 1 };
  await h.tick();
  h.plan = { mode: "dual", audienceMonitorIndex: 1 };
  await h.tick();
  h.plan = { mode: "single", monitors: [1] };
  await h.tick();
  h.plan = { mode: "dual", audienceMonitorIndex: 1 };
  await h.tick();
  check("a flapping display never triggers a reopen (needs two CONSECUTIVE stable polls)", h.count("open:1") === 0);
}

// ---- reopen failing ------------------------------------------------------------------------------------------------------
{
  const h = harness();
  await h.tick(3000);
  h.placement = { open: true, ok: false, problem: "second-display-disconnected", monitorCount: 1 };
  await h.tick();
  h.plan = { mode: "dual", audienceMonitorIndex: 1 };
  h.failOpen = true;
  await h.tick(); await h.tick(); await h.tick(); await h.tick();
  check("a failing reopen keeps retrying quietly and never claims success", h.restored.length === 0 && h.watcher.mode === "lost" && h.count("open:1") >= 2);
  h.failOpen = false;
  await h.tick(); await h.tick();
  check("…and succeeds once the display is usable", h.restored.length === 1 && h.watcher.mode === "dual");
}

// ---- forced single-display never auto-opens -------------------------------------------------------------------------------
{
  const h = harness({ initialMode: "single" });
  h.plan = { mode: "single", monitors: [1, 2] }; // Settings force single even with 2 monitors
  for (let i = 0; i < 6; i++) await h.tick();
  check("forced single-display (plan stays 'single'): the watcher never opens an audience window", h.count("open:1") === 0 && h.restored.length === 0);
}

// ---- projector plugged in after Present Mode started on one screen ---------------------------------------------------------
{
  const h = harness({ initialMode: "single" });
  h.plan = { mode: "single", monitors: [1] };
  await h.tick(); await h.tick();
  h.plan = { mode: "dual", audienceMonitorIndex: 1 };
  await h.tick(); await h.tick();
  check("started on one screen, second display connected later: audience display opens", h.count("open:1") === 1 && h.restored.length === 1 && h.watcher.mode === "dual");
}

// ---- stop() ---------------------------------------------------------------------------------------------------------------------
{
  const h = harness();
  await h.tick(3000);
  const checksBefore = h.count("check");
  h.watcher.stop();
  h.placement = { open: true, ok: false, problem: "second-display-disconnected", monitorCount: 1 };
  await h.tick(); await h.tick();
  check("after stop() (leaving Present Mode) nothing more is polled or closed", h.count("check") === checksBefore && h.lost.length === 0 && h.count("close") === 0);
}

// ---- no overlapping polls ------------------------------------------------------------------------------------------------------------
{
  const h = harness();
  await h.tick(3000);
  let release;
  const gate = new Promise((r) => { release = r; });
  const orig = h.calls.push.bind(h.calls);
  const slow = createDisplayWatcher({
    service: { checkAudiencePlacement: async () => { orig("slow-check"); await gate; return { ok: true }; }, closeAudienceWindow: async () => {}, resolveDisplayPlan: async () => ({}), openAudienceWindow: async () => {} },
    now: () => 10000, graceMs: 0, setTimer: () => 1, clearTimer: () => {},
  });
  const a = slow.poll(); const b = slow.poll(); const c = slow.poll();
  release();
  await Promise.all([a, b, c]);
  check("overlapping polls are dropped (only one placement check in flight)", h.calls.filter((x) => x === "slow-check").length === 1);
}

// ---- wording -------------------------------------------------------------------------------------------------------------------------------
check("teacher-facing messages explain what happened and what will happen next",
  /disconnected/.test(describeLostDisplay("second-display-disconnected")) && /automatically/.test(describeLostDisplay("second-display-disconnected")) &&
  /presenter screen/.test(describeLostDisplay("audience-on-presenter-display")) && describeLostDisplay("whatever").length > 20);

done();
