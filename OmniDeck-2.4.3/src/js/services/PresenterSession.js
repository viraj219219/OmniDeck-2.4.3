import { createDisplayWatcher, describeLostDisplay } from "./DisplayWatcher.js";

/**
 * PresenterSession — the ONE authoritative state of a running presentation.
 *
 * It owns: the current slide index, the quiz/media state of that slide, which
 * display is the audience output, and the connection status. Everything the
 * operator sees (live preview, next-slide preview, slide list, counters,
 * status) is a read-only projection of getView(); everything the audience
 * window shows is the same page object sent through broadcastSlideState().
 * There is no second source of truth and no separate audience rendering code:
 * the audience window re-renders the same page with the same renderPresentStage.
 *
 * Sync transport = native Tauri events (see PresentationService), NOT
 * localStorage/BroadcastChannel/postMessage, and no polling: every state change
 * pushes immediately. (The only poll is DisplayWatcher's cheap hot-plug check,
 * because Tauri v2 exposes no monitor-change event; it stops with the session.)
 *
 * Pure logic with injected service/timers so every flow — one display, two
 * displays, hot-plug, display switching, exit — is unit-tested with mocked
 * displays (tests/presenter-session.test.mjs). A mock is not a projector:
 * real-hardware behaviour is listed as unverified in docs/PRESENTER_VIEW.md.
 */

export const UPCOMING_COUNT = 8;

export function describeOutput({ dual, lost, forcedSingle, monitorCount, audienceMonitor, problem }) {
  if (dual && audienceMonitor) {
    const size = audienceMonitor.width && audienceMonitor.height ? ` · ${audienceMonitor.width}×${audienceMonitor.height}` : "";
    return { state: "connected", label: `Audience display connected`, detail: `${audienceMonitor.name || `Display ${audienceMonitor.index + 1}`}${size}` };
  }
  if (lost) return { state: "lost", label: "Audience display disconnected", detail: `${describeLostDisplay(problem)}` };
  if (forcedSingle) return { state: "single", label: "Single-display mode", detail: "This screen is the audience output (set in Settings → Display)." };
  if (monitorCount < 2) return { state: "single", label: "One display detected", detail: "This screen is the audience output. Connect a projector and it will be offered automatically." };
  return { state: "single", label: "Audience display not open", detail: "Choose a display to show the presentation on." };
}

export function createPresenterSession({
  lesson,
  service,
  notify = () => {},
  isTauri = true,
  createWatcher = createDisplayWatcher,
  startIndex = 0,
  watcherOptions = {},        // tests inject a manual clock/timer
  labelFor = (page) => page?.title || page?.type || "Slide", // presentMode passes slideStage.pageLabel
  previewSize = null,
} = {}) {
  if (!lesson?.pages?.length) throw new Error("PresenterSession needs a lesson with at least one page");
  const pages = lesson.pages;
  const listeners = new Set();

  let index = Math.min(Math.max(0, startIndex | 0), pages.length - 1);
  let quiz = { quizSelection: null, quizTextAnswer: "", quizTextSubmitted: false };
  let media = null;               // { playing, currentTime } of the CURRENT slide's video, or null
  let plan = { mode: "single", monitors: [] };
  let dual = false;
  let lost = false;
  let lostProblem = null;
  let audienceMonitorIndex = null;
  let lastBroadcast = null;
  let watcher = null;
  let unbindReady = () => {};
  let exiting = false;
  let started = false;
  let fullscreen = false;

  const emitChange = () => { const v = getView(); for (const fn of listeners) { try { fn(v); } catch (e) { console.warn("[PresenterSession] listener failed", e); } } };

  const designSize = previewSize && typeof previewSize === "object"
    ? previewSize
    : { width: 860, height: 483.75, slideWidth: 858 };

  function buildState() {
    return { page: pages[index], index, total: pages.length, lessonTitle: lesson.title, previewSize: designSize, ...quiz, media };
  }

  function broadcast(state) {
    if (!isTauri) return;
    Promise.resolve(service.broadcastSlideState(state)).catch((err) => console.warn("[PresenterSession] couldn't send the slide to the audience display", err));
  }

  /** Publishes the current state: always remembered (a window opened later gets THIS), sent immediately when an audience window is up. */
  function publish() {
    lastBroadcast = buildState();
    if (dual) broadcast(lastBroadcast);
    emitChange();
  }

  function getView() {
    const monitors = (plan.monitors || []).map((m, i) => ({ ...m, index: m.index ?? i }));
    const primaryIndex = plan.primaryIndex ?? Math.max(0, monitors.findIndex((m) => m.isPrimary));
    const audienceMonitor = dual && audienceMonitorIndex != null ? monitors[audienceMonitorIndex] : null;
    const upcoming = [];
    for (let i = index + 1; i < pages.length && upcoming.length < UPCOMING_COUNT; i++) upcoming.push({ index: i, page: pages[i], label: labelFor(pages[i]) });
    return {
      lessonTitle: lesson.title,
      index, total: pages.length,
      counter: `${index + 1} / ${pages.length}`,
      current: pages[index],
      next: index < pages.length - 1 ? { index: index + 1, page: pages[index + 1], label: labelFor(pages[index + 1]) } : null,
      upcoming,
      slides: pages.map((page, i) => ({ index: i, page, label: labelFor(page), isCurrent: i === index, isPast: i < index })),
      canPrev: index > 0,
      canNext: index < pages.length - 1,
      quiz: { ...quiz },
      media,
      dual,
      output: describeOutput({ dual, lost, forcedSingle: plan.forcedSingle === true, monitorCount: monitors.length, audienceMonitor, problem: lostProblem }),
      // Displays the operator may choose as the audience output: never the presenter's own screen.
      audienceChoices: monitors.filter((m) => m.index !== primaryIndex),
      audienceMonitorIndex,
      canChooseDisplay: monitors.length >= 2 && plan.forcedSingle !== true,
      fullscreen,
    };
  }

  async function refreshPlan() {
    const settings = isTauri ? await service.getDisplaySettings().catch(() => null) : null;
    const p = await service.resolveDisplayPlan();
    plan = { ...p, forcedSingle: settings?.mode === "single" };
    return plan;
  }

  async function start() {
    if (started) return;
    started = true;
    try { await refreshPlan(); }
    catch (err) { console.warn("[PresenterSession] couldn't read the display list; using a single screen", err); plan = { mode: "single", monitors: [] }; }
    dual = plan.mode === "dual";
    audienceMonitorIndex = dual ? plan.audienceMonitorIndex : null;

    try { await service.enterFullscreen(); fullscreen = true; }
    catch (err) { console.warn("[PresenterSession] couldn't enter fullscreen; presenting in a window", err); notify("Couldn't switch to full screen — presenting in a window instead.", "danger"); }

    // Subscribed BEFORE any audience window opens so the ready signal can never be missed.
    try { unbindReady = await service.onAudienceReady(() => { if (lastBroadcast) broadcast(lastBroadcast); }); }
    catch (err) { console.warn("[PresenterSession] couldn't subscribe to the audience-ready signal", err); }

    if (dual) {
      try { await service.openAudienceWindow(audienceMonitorIndex); }
      catch (err) {
        dual = false; audienceMonitorIndex = null;
        notify(err?.message || "Couldn't open the audience display — showing a single screen instead.", "danger");
      }
    }

    watcher = createWatcher({
      ...watcherOptions,
      service,
      initialMode: dual ? "dual" : "single",
      onLost: (problem) => { dual = false; lost = true; lostProblem = problem; audienceMonitorIndex = null; notify(describeLostDisplay(problem), "danger", 14000); emitChange(); },
      onRestored: (restoredPlan) => {
        // Flip state and push the CURRENT slide synchronously: the reopened audience window must
        // never wait on a monitor refresh to show something. Details are refreshed afterwards.
        dual = true; lost = false; lostProblem = null;
        plan = { ...plan, ...restoredPlan, forcedSingle: false };
        audienceMonitorIndex = restoredPlan?.audienceMonitorIndex ?? null;
        notify("Second display detected — audience display restored.", "success", 7000);
        publish(); // the reopened window also announces itself (audience:ready) and gets the same state
        refreshPlan().then(() => { if (dual && plan.mode === "dual") audienceMonitorIndex = plan.audienceMonitorIndex; emitChange(); }).catch(() => {});
      },
    });
    if (isTauri) watcher.start();
    publish();
  }

  // ---- navigation: the only place `index` changes -------------------------
  function goTo(target) {
    if (!Number.isInteger(target) || target < 0 || target >= pages.length || target === index) return false;
    index = target;
    quiz = { quizSelection: null, quizTextAnswer: "", quizTextSubmitted: false };
    media = null;
    publish();
    return true;
  }
  const next = () => goTo(index + 1);
  const prev = () => goTo(index - 1);

  function setQuiz(patch) { quiz = { ...quiz, ...patch }; publish(); }
  /** Typing in a fill-in-the-blank answer: remembered, but neither redrawn (focus!) nor shown to the audience until submitted. */
  function setQuizDraft(text) { quiz = { ...quiz, quizTextAnswer: String(text ?? "") }; }

  /** Controller's video state, relayed so the audience copy plays/pauses/seeks with it. */
  function setMediaState(state) {
    media = state ? { playing: !!state.playing, currentTime: Number(state.currentTime) || 0, at: Date.now() } : null;
    if (dual) Promise.resolve(service.broadcastMediaState?.({ index, media })).catch((e) => console.warn("[PresenterSession] media relay failed", e));
  }

  /** Operator picks a different external display. Never the presenter's own screen. */
  async function chooseAudienceDisplay(monitorIndex) {
    const v = getView();
    if (!v.canChooseDisplay) throw new Error("Choosing a display needs two or more displays and Display Mode set to Automatic.");
    if (!v.audienceChoices.some((m) => m.index === monitorIndex)) throw new Error("That display is the presenter's own screen. Choose the projector/external display.");
    const settings = (await service.getDisplaySettings().catch(() => null)) || { mode: "auto" };
    await service.setDisplaySettings({ ...settings, mode: settings.mode === "single" ? "auto" : (settings.mode || "auto"), audienceMonitorIndex: monitorIndex });
    await service.openAudienceWindow(monitorIndex);          // moves the existing window or opens one
    dual = true; lost = false; lostProblem = null; audienceMonitorIndex = monitorIndex;
    await refreshPlan().catch(() => {});
    publish();
  }

  /** Re-reads the displays (after the operator changed resolution / plugged something in). */
  async function refreshDisplays() {
    try { await refreshPlan(); if (dual && plan.mode === "dual") audienceMonitorIndex = plan.audienceMonitorIndex; emitChange(); }
    catch (err) { console.warn("[PresenterSession] display refresh failed", err); }
  }

  async function exit() {
    if (exiting) return false;
    exiting = true;
    watcher?.stop();
    unbindReady();
    if (isTauri) {
      // Blank first: even if closing the window fails, the room never keeps a stale slide.
      await Promise.resolve(service.broadcastSlideState({ page: null })).catch(() => {});
      await Promise.resolve(service.closeAudienceWindow()).catch(() => {});
    }
    try { await service.exitFullscreen(); } catch (err) { console.warn("[PresenterSession] couldn't leave fullscreen", err); }
    dual = false; audienceMonitorIndex = null; fullscreen = false;
    return true;
  }

  return {
    start, goTo, next, prev, setQuiz, setQuizDraft, setMediaState, chooseAudienceDisplay, refreshDisplays, exit,
    getView, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get lastBroadcast() { return lastBroadcast; },
    get exiting() { return exiting; },
  };
}
