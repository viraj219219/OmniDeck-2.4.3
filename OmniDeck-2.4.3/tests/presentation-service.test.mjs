// Functional smoke tests for the display-plan decision logic in
// PresentationService.js — the piece that decides single- vs dual-display
// Present Mode and which monitor is the audience display.
//
// resolveDisplayPlan() itself is gated on isRunningInTauri, which is only
// ever true inside the real Tauri webview, so it can't be meaningfully
// exercised here. computeDisplayPlan() is the pure decision logic factored
// out specifically so it can be: no Tauri runtime, no storage, just plain
// synthetic monitor lists and settings objects in, a plan out.
import { computeDisplayPlan } from "../src/js/services/PresentationService.js";

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS — ${name}`);
  else { failures++; console.error(`FAIL — ${name}`); }
}

const AUTO = { mode: "auto", audienceMonitorIndex: null };

function mon(index, isPrimary = false) {
  return { index, name: `Monitor ${index + 1}`, isPrimary, width: 1920, height: 1080 };
}

// --- 1-monitor scenario ---
{
  const plan = computeDisplayPlan([mon(0, true)], AUTO);
  check("1 monitor: always single", plan.mode === "single");
}
{
  // Even an explicit (nonsensical) audience pick can't force dual with
  // only one screen connected — there's nowhere to put a second window.
  const plan = computeDisplayPlan([mon(0, true)], { mode: "auto", audienceMonitorIndex: 0 });
  check("1 monitor: single even with an explicit audience pick", plan.mode === "single");
}
check("0 monitors: doesn't crash, resolves single", computeDisplayPlan([], AUTO).mode === "single");
check("Non-array monitors input: doesn't crash, resolves single", computeDisplayPlan(null, AUTO).mode === "single");

// --- 2-monitor scenarios ---
{
  const monitors = [mon(0, true), mon(1, false)];
  const plan = computeDisplayPlan(monitors, AUTO);
  check("2 monitors, auto: dual mode", plan.mode === "dual");
  check("2 monitors, auto: audience is the non-primary monitor", plan.audienceMonitorIndex === 1);
}
{
  // Explicitly trying to select the primary monitor as audience — this is
  // exactly the case the settings UI now also filters out, but the
  // decision logic itself must refuse to trust it regardless of caller.
  const monitors = [mon(0, true), mon(1, false)];
  const plan = computeDisplayPlan(monitors, { mode: "auto", audienceMonitorIndex: 0 });
  check("2 monitors: primary monitor can never be selected as audience", plan.audienceMonitorIndex !== 0);
  check("2 monitors: falls back to the other monitor instead", plan.audienceMonitorIndex === 1);
}
{
  // No monitor reports isPrimary at all (some window managers don't).
  const monitors = [mon(0, false), mon(1, false)];
  const plan = computeDisplayPlan(monitors, AUTO);
  check("2 monitors, none flagged primary: treats monitor 0 as presenter's screen", plan.audienceMonitorIndex === 1);
}

// --- Forced single mode ---
{
  const monitors = [mon(0, true), mon(1, false)];
  const plan = computeDisplayPlan(monitors, { mode: "single", audienceMonitorIndex: 1 });
  check("Forced single with 2 monitors: stays single", plan.mode === "single");
}
{
  const monitors = [mon(0, true), mon(1, false), mon(2, false)];
  const plan = computeDisplayPlan(monitors, { mode: "single", audienceMonitorIndex: 2 });
  check("Forced single with 3 monitors: stays single", plan.mode === "single");
}

// --- 3-monitor scenarios ---
{
  const monitors = [mon(0, true), mon(1, false), mon(2, false)];
  const plan = computeDisplayPlan(monitors, { mode: "auto", audienceMonitorIndex: 2 });
  check("3 monitors: honors a valid, explicit non-primary pick", plan.mode === "dual" && plan.audienceMonitorIndex === 2);
}
{
  const monitors = [mon(0, true), mon(1, false), mon(2, false)];
  const plan = computeDisplayPlan(monitors, AUTO);
  check("3 monitors, auto: picks the first non-primary monitor", plan.audienceMonitorIndex === 1);
}
{
  // Primary monitor isn't first in the list.
  const monitors = [mon(0, false), mon(1, true), mon(2, false)];
  const plan = computeDisplayPlan(monitors, AUTO);
  check("3 monitors, primary in the middle: skips it for auto-selection", plan.audienceMonitorIndex === 0);
}

// --- Invalid / stale monitor selections ---
{
  const monitors = [mon(0, true), mon(1, false), mon(2, false)];
  const plan = computeDisplayPlan(monitors, { mode: "auto", audienceMonitorIndex: 99 });
  check("Out-of-range saved index: falls back to auto instead of crashing", plan.mode === "dual" && plan.audienceMonitorIndex === 1);
}
{
  const monitors = [mon(0, true), mon(1, false)];
  const plan = computeDisplayPlan(monitors, { mode: "auto", audienceMonitorIndex: -1 });
  check("Negative saved index: falls back to auto", plan.audienceMonitorIndex === 1);
}
{
  const monitors = [mon(0, true), mon(1, false)];
  const plan = computeDisplayPlan(monitors, { mode: "auto", audienceMonitorIndex: 1.5 });
  check("Non-integer saved index: falls back to auto", plan.audienceMonitorIndex === 1);
}
{
  const monitors = [mon(0, true), mon(1, false)];
  const plan = computeDisplayPlan(monitors, { mode: "auto", audienceMonitorIndex: "1" });
  check("Non-numeric (string) saved index: falls back to auto", plan.audienceMonitorIndex === 1);
}
{
  const monitors = [mon(0, true), mon(1, false), mon(2, false)];
  // Settings saved back when there were 4 monitors; only 3 are connected now.
  const plan = computeDisplayPlan(monitors, { mode: "auto", audienceMonitorIndex: 3 });
  check("Stale index from a since-removed monitor: falls back to auto", plan.audienceMonitorIndex === 1);
}
{
  const monitors = [mon(0, true), mon(1, false)];
  const plan = computeDisplayPlan(monitors, {});
  check("Empty settings object: doesn't crash, resolves dual with auto pick", plan.mode === "dual" && plan.audienceMonitorIndex === 1);
}
{
  const monitors = [mon(0, true), mon(1, false)];
  const plan = computeDisplayPlan(monitors, null);
  check("Null settings: doesn't crash, resolves dual with auto pick", plan.mode === "dual" && plan.audienceMonitorIndex === 1);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
