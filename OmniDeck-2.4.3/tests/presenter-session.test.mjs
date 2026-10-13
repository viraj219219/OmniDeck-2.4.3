// PresenterSession with MOCKED displays. Everything here is simulated: monitors, the audience
// window, hot-plug and resolution changes are a mock. Passing proves the control flow
// (single authoritative state, immediate pushes, hot-plug recovery, display choice, exit).
// It does NOT prove behaviour on a physical projector - see docs/PRESENTER_VIEW.md.
import { makeChecker } from "./helpers/fakeDisk.mjs";
import { createPresenterSession, describeOutput } from "../src/js/services/PresenterSession.js";
import { computeDisplayPlan } from "../src/js/services/PresentationService.js";
import { createDisplayWatcher } from "../src/js/services/DisplayWatcher.js";
const { check, done } = makeChecker();
console.warn = () => {};

const mon = (i, o = {}) => ({ index: i, name: i === 0 ? "Laptop" : `Projector ${i}`, x: i * 1920, y: 0, width: 1920, height: 1080, isPrimary: i === 0, ...o });
class MockDisplays {
  constructor(n = 1) { this.monitors = Array.from({ length: n }, (_, i) => mon(i)); this.settings = { mode: "auto", audienceMonitorIndex: null }; this.audience = null; this.sent = []; this.media = []; this.log = []; this.fullscreen = false; this.failOpen = false; this.readyCb = null; }
  async getMonitors() { return this.monitors; }
  async getDisplaySettings() { return { ...this.settings }; }
  async setDisplaySettings(s) { this.settings = { ...s }; this.log.push("settings"); }
  async resolveDisplayPlan() { return computeDisplayPlan(this.monitors, this.settings); }
  async enterFullscreen() { this.fullscreen = true; }
  async exitFullscreen() { this.fullscreen = false; this.log.push("exitFullscreen"); }
  async openAudienceWindow(i) { if (this.failOpen) throw new Error("no such monitor"); if (!this.monitors[i] || this.monitors[i].isPrimary) throw new Error("Can't open the audience display on the presenter's own monitor."); this.audience = i; this.log.push(`open:${i}`); }
  async closeAudienceWindow() { this.audience = null; this.log.push("close"); }
  async checkAudiencePlacement() { if (this.audience == null) return { open: false, ok: true }; if (this.monitors.length < 2 || !this.monitors[this.audience]) return { open: true, ok: false, problem: "second-display-disconnected" }; return { open: true, ok: true }; }
  async broadcastSlideState(s) { this.sent.push(s); }
  async broadcastMediaState(s) { this.media.push(s); }
  async onAudienceReady(cb) { this.readyCb = cb; return () => { this.readyCb = null; }; }
}
const lesson = { id: "l1", title: "Test Lesson", pages: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, type: i === 4 ? "quiz" : "title", title: `Slide ${i + 1}` })) };
const clock = () => { let t = 0; const timers = []; return { now: () => t, advance: (ms) => { t += ms; }, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} }; };
const mk = (n, extra = {}) => { const svc = new MockDisplays(n); const c = clock(); const notes = []; const session = createPresenterSession({ lesson, service: svc, notify: (m, v) => notes.push({ m, v }), watcherOptions: { now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer }, ...extra }); return { svc, c, notes, session }; };
const poll = async (session, c, times = 1) => { for (let i = 0; i < times; i++) { c.advance(3000); await session._watcher?.poll(); } };

// Real watcher handle so tests can poll deterministically.
const watchers = [];
const createWatcher = (opts) => { const w = createDisplayWatcher(opts); watchers.push(w); return w; };
const mk2 = (n) => { const r = mk(n, { createWatcher }); return { ...r, poll: async (times = 1) => { for (let i = 0; i < times; i++) { r.c.advance(3000); await watchers.at(-1).poll(); } } }; };

// 1. ONE display
{ const { svc, session, notes } = mk2(1); await session.start();
  const v = session.getView();
  check("one display: single mode, no audience window opened", v.dual === false && svc.audience === null && v.output.state === "single" && /One display/.test(v.output.label));
  check("one display: this screen is fullscreen", svc.fullscreen === true);
  check("one display: nothing is broadcast to a non-existent audience", svc.sent.length === 0);
  check("one display: no display chooser offered", v.canChooseDisplay === false && v.audienceChoices.length === 0);
  session.next(); check("one display: navigation still works", session.getView().index === 1);
  check("one display: latest state remembered for a projector plugged in later", session.lastBroadcast.index === 1);
  await session.exit(); check("one display: exit leaves fullscreen", svc.fullscreen === false); }

// 2. Second display connected, chosen automatically
{ const { svc, session } = mk2(2); await session.start();
  const v = session.getView();
  check("two displays: audience opens on the external display, never the presenter's", svc.audience === 1 && v.dual && v.audienceMonitorIndex === 1);
  check("status names the connected display and its resolution", v.output.state === "connected" && /Projector 1/.test(v.output.detail) && /1920×1080/.test(v.output.detail));
  check("first slide is sent to the audience immediately", svc.sent.length === 1 && svc.sent[0].index === 0 && svc.sent[0].page.id === "p0");
  svc.sent.length = 0; svc.readyCb(); check("audience:ready handshake re-sends the CURRENT slide", svc.sent.length === 1 && svc.sent[0].page.id === "p0");
  check("view exposes live current, next, upcoming list and counters", v.current.id === "p0" && v.next.index === 1 && v.upcoming.length === 5 && v.counter === "1 / 6" && v.canPrev === false && v.canNext === true);
  check("slide list marks exactly one current slide", v.slides.filter((s) => s.isCurrent).length === 1 && v.slides[0].isCurrent);

  // 3. controls: next / prev / direct selection
  svc.sent.length = 0;
  session.next(); check("next: audience updated immediately", svc.sent.at(-1).page.id === "p1" && svc.sent.at(-1).index === 1);
  session.goTo(4); check("direct selection (thumbnail click): audience jumps to that slide", svc.sent.at(-1).page.id === "p4" && session.getView().index === 4);
  session.prev(); check("previous: audience follows", svc.sent.at(-1).page.id === "p3");
  const n = svc.sent.length;
  check("selecting the current slide is a no-op (no duplicate push)", session.goTo(3) === false && svc.sent.length === n);
  check("out-of-range / non-integer selection is rejected", [session.goTo(-1), session.goTo(99), session.goTo(1.5), session.goTo("2"), session.goTo(NaN)].every((r) => r === false) && session.getView().index === 3);
  session.goTo(5); check("last slide: canNext false, no next preview", session.getView().canNext === false && session.getView().next === null);
  session.goTo(4); session.setQuiz({ quizSelection: 2 }); check("quiz state is part of the broadcast", svc.sent.at(-1).quizSelection === 2);
  session.goTo(0); check("changing slides resets quiz state", svc.sent.at(-1).quizSelection === null);

  // 9. audience payload contains only presentation content
  const keys = Object.keys(svc.sent.at(-1)).sort().join();
  check("audience payload has no controller data (no slide list, upcoming, status, choices)", keys === "index,lessonTitle,media,page,previewSize,quizSelection,quizTextAnswer,quizTextSubmitted,total" && !("slides" in svc.sent.at(-1)) && !("output" in svc.sent.at(-1)));

  // media relay
  session.setMediaState({ playing: true, currentTime: 12.5 });
  check("video play state is relayed to the audience", svc.media.at(-1).media.playing === true && svc.media.at(-1).media.currentTime === 12.5);
  session.goTo(1); check("changing slides clears the relayed media state", session.getView().media === null);

  // 4. resolution change
  svc.monitors[1] = mon(1, { width: 1280, height: 720 }); await session.refreshDisplays();
  check("resolution change is reflected in the status", /1280×720/.test(session.getView().output.detail));
  await session.exit(); }

// 5. disconnect + reconnect the projector
{ const { svc, session, notes, poll } = mk2(2); await session.start(); session.goTo(2);
  svc.monitors.pop(); // unplug
  await poll();
  let v = session.getView();
  check("unplug: audience window is closed, presenter keeps working on one screen", svc.audience === null && v.dual === false && v.output.state === "lost");
  check("unplug: the operator is told, with an actionable explanation", notes.some((n) => n.v === "danger" && /disconnected/i.test(n.m)) && /reconnected|come back/i.test(v.output.detail));
  svc.sent.length = 0; session.next(); check("while disconnected nothing is sent to a missing window, state is still tracked", svc.sent.length === 0 && session.lastBroadcast.index === 3);
  svc.monitors.push(mon(1)); // replug
  await poll(1); check("reconnect needs two stable polls (cable-seating debounce)", svc.audience === null);
  await poll(1);
  v = session.getView();
  check("reconnect: audience reopened on the external display", svc.audience === 1 && v.dual && v.output.state === "connected");
  check("reconnect: audience immediately shows the CURRENT slide, not a stale one", svc.sent.at(-1)?.page.id === "p3");
  check("reconnect: operator is told", notes.some((n) => n.v === "success" && /restored/i.test(n.m)));
  await session.exit(); }

// 6. exit
{ const { svc, session } = mk2(2); await session.start(); session.goTo(3);
  await session.exit();
  check("exit: audience is blanked THEN closed (never a stale slide)", svc.sent.at(-1).page === null && svc.log.includes("close") && svc.audience === null);
  check("exit: fullscreen released and ready-listener removed", svc.fullscreen === false && svc.readyCb === null);
  const before = svc.sent.length; session.next(); check("after exit nothing more is broadcast", svc.sent.length === before);
  check("exit is idempotent", (await session.exit()) === false && svc.log.filter((l) => l === "close").length === 1); }

// failures degrade gracefully
{ const svc = new MockDisplays(2); svc.failOpen = true; const notes = []; const session = createPresenterSession({ lesson, service: svc, notify: (m, v) => notes.push({ m, v }), createWatcher });
  await session.start(); check("audience window failing to open falls back to one screen with a message", session.getView().dual === false && notes.some((n) => n.v === "danger")); await session.exit(); }
{ const svc = new MockDisplays(2); svc.resolveDisplayPlan = async () => { throw new Error("monitor list unavailable"); };
  const session = createPresenterSession({ lesson, service: svc, createWatcher }); await session.start();
  check("unreadable display list falls back to a single screen", session.getView().dual === false); await session.exit(); }
{ const svc = new MockDisplays(2); svc.enterFullscreen = async () => { throw new Error("refused"); }; const notes = [];
  const session = createPresenterSession({ lesson, service: svc, notify: (m, v) => notes.push(m), createWatcher }); await session.start();
  check("refused fullscreen still presents (in a window) and says so", session.getView().dual && notes.some((m) => /full screen/i.test(m))); await session.exit(); }
{ const svc = new MockDisplays(1); const session = createPresenterSession({ lesson, service: svc, isTauri: false, createWatcher });
  await session.start(); session.next(); check("browser preview (no Tauri): works, never touches the audience service", svc.sent.length === 0 && session.getView().index === 1); await session.exit(); }

// display selection
{ const { svc, session } = mk2(3); await session.start();
  check("three displays: chooser lists only non-presenter displays", session.getView().audienceChoices.map((m) => m.index).join() === "1,2" && session.getView().canChooseDisplay);
  await session.chooseAudienceDisplay(2);
  check("choosing display 2 moves the audience there and persists the choice", svc.audience === 2 && svc.settings.audienceMonitorIndex === 2 && session.getView().audienceMonitorIndex === 2);
  let e = null; try { await session.chooseAudienceDisplay(0); } catch (x) { e = x; }
  check("the presenter's own screen can never be chosen", !!e && /own screen/.test(e.message) && svc.audience === 2);
  e = null; try { await session.chooseAudienceDisplay(7); } catch (x) { e = x; }
  check("a non-existent display is rejected", !!e);
  check("the new choice is sent the current slide", svc.sent.at(-1).page.id === "p0");
  await session.exit(); }
{ const { svc, session } = mk2(2); svc.settings.mode = "single"; await session.start();
  check("forced single-display mode: no audience, status says why, no chooser", session.getView().dual === false && /Single-display mode/.test(session.getView().output.label) && session.getView().canChooseDisplay === false); await session.exit(); }

// describeOutput wording + misc
check("describeOutput: lost state carries the reason", /disconnected/i.test(describeOutput({ dual: false, lost: true, monitorCount: 1, problem: "second-display-disconnected" }).detail));
{ let e = null; try { createPresenterSession({ lesson: { pages: [] }, service: new MockDisplays(1) }); } catch (x) { e = x; } check("a lesson with no slides can't start a session", !!e); }
check("session code has no localStorage/BroadcastChannel/postMessage sync", !/localStorage|BroadcastChannel|postMessage/.test((await import("node:fs")).readFileSync(new URL("../src/js/services/PresenterSession.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
done();
