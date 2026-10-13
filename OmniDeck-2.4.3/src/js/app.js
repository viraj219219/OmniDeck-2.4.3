import { qs, qsa, clear, h } from "./utils/dom.js";
import { setState } from "./state/store.js";
import { icon } from "./utils/icons.js";
import { getTheme, applyTheme } from "./services/ThemeService.js";
import * as homeView from "./views/home.js";
import * as libraryView from "./views/lessonLibrary.js";
import * as editorView from "./views/lessonEditor.js";
import * as bibleView from "./views/bible.js";
import * as mediaView from "./views/media.js";
import * as settingsView from "./views/settings.js";
import * as presentView from "./views/presentMode.js";
import { toast } from "./components/toast.js";
import { presentationService } from "./services/PresentationService.js";
import { isRunningInTauri, onStorageRecovery } from "./utils/storageAdapter.js";
import { registerFlusher, flushAll, hasPendingChanges, installCloseHandler } from "./services/ShutdownService.js";
import { updateService } from "./services/UpdateService.js";
// Loading LessonService registers the media-deletion reference guard; make
// that explicit here so it can never depend on which view happens to load first.
import "./services/LessonService.js";

const routes = {
  home: homeView,
  library: libraryView,
  editor: editorView,
  bible: bibleView,
  media: mediaView,
  settings: settingsView,
};

const shell = qs("#app-shell");
const viewRoot = qs("#view-root");
const presentRoot = qs("#present-root");
const titleEl = qs("#titlebar-title");
const actionsEl = qs("#titlebar-actions");

let currentExit = null; // present-mode teardown, if active
let renderToken = 0; // guards against stale async renders when navigating quickly
let beforeNavigateHook = null; // set by the current view; awaited before we leave it

/**
 * Lets the currently-mounted view register a "flush before you leave me"
 * callback — used by the lesson editor to force any pending debounced
 * autosave to complete before navigating to Present Mode, another lesson,
 * or any other screen, so an in-progress edit is never silently lost.
 * Only one hook is ever active (the current view); registering a new one
 * (or navigating away, which clears it) replaces/removes the previous one.
 */
export function setBeforeNavigate(fn) {
  beforeNavigateHook = fn;
}

function setTitle(text) {
  titleEl.textContent = text;
}

function setActions(nodes) {
  clear(actionsEl);
  for (const n of nodes) actionsEl.appendChild(n);
}

function highlightNav(route) {
  qsa(".nav-rail__item").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.route === route);
  });
}

export async function navigate(route, params = {}) {
  if (beforeNavigateHook) {
    const hook = beforeNavigateHook;
    beforeNavigateHook = null;
    try {
      await hook();
    } catch (err) {
      console.warn("[app] beforeNavigate flush failed", err);
    }
  }

  if (route === "present") {
    // Present Mode must show the latest SAVED lesson. Every way of getting
    // here (editor button, any future entry point) flushes pending edits
    // first; if they can't be saved we stay put unless the caller already
    // got the teacher's explicit OK to show unsaved changes.
    if (!params.allowUnsaved) {
      const flushed = await flushAll();
      if (!flushed.ok) {
        console.warn("[app] blocked Present Mode: pending changes couldn't be saved", flushed.failures);
        toast("Can't start Present Mode: your latest changes couldn't be saved. Fix the save problem (see the Retry button in the editor) and try again.", "danger");
        return;
      }
    }
    setState({ route, routeParams: params, presenting: true });
    shell.style.display = "none";
    presentRoot.classList.remove("present-root--hidden");
    presentRoot.setAttribute("aria-hidden", "false");
    try {
      currentExit = await presentView.render(presentRoot, {
        params,
        onExit: (opts) => exitPresent(params, opts),
      });
    } catch (err) {
      // The shell is already hidden at this point: if Present Mode can't
      // start, put the teacher back in the editor instead of leaving them
      // on a blank full-screen overlay with no controls.
      console.warn("[app] Present Mode failed to start", err);
      currentExit = null;
      try { await presentationService.closeAudienceWindow(); } catch { /* best effort */ }
      try { await presentationService.exitFullscreen(); } catch { /* best effort */ }
      toast(`Couldn't start Present Mode: ${err?.message || err}`, "danger");
      exitPresent(params);
    }
    return;
  }

  const view = routes[route] || routes.home;
  setState({ route, routeParams: params, presenting: false });
  highlightNav(route);

  const token = ++renderToken;
  clear(viewRoot);
  viewRoot.setAttribute("tabindex", "-1");
  viewRoot.focus({ preventScroll: true });
  setTitle(view.title || "");
  setActions([]);

  try {
    await view.render(viewRoot, { params, navigate, setTitle, setActions });
  } catch (err) {
    // A view that throws (e.g. the lesson library can't be read) must show
    // WHY, not leave a blank screen and an unhandled rejection.
    console.warn(`[app] the "${route}" view failed to render`, err);
    if (token !== renderToken) return;
    clear(viewRoot);
    viewRoot.appendChild(h("div", { class: "page" }, [
      h("div", { class: "empty-state" }, [
        h("h3", {}, "Something went wrong loading this screen"),
        h("p", {}, err?.message || String(err)),
        h("p", {}, "Your data has not been deleted. Try another section, or reopen OmniDeck."),
      ]),
    ]));
    toast(err?.message || "Couldn't load this screen.", "danger");
    return;
  }
  if (token !== renderToken) return; // a newer navigation started while awaiting
}

function exitPresent(params, opts) {
  presentRoot.classList.add("present-root--hidden");
  presentRoot.setAttribute("aria-hidden", "true");
  clear(presentRoot);
  shell.style.display = "";
  currentExit = null;
  navigate("editor", { lessonId: params.lessonId, pageId: opts?.pageId });
}

function wireNav() {
  qsa(".nav-rail__item[data-route]").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.route));
  });
}

function paintNavIcons() {
  qsa(".nav-rail__icon[data-icon]").forEach((span) => {
    span.appendChild(icon(span.dataset.icon, "nav-rail__icon-svg icon"));
  });
}

wireNav();
paintNavIcons();
// Apply the teacher's saved theme before the first paint they'd notice —
// getTheme() defaults to "light" (matching the pre-existing look) if
// nothing's been saved yet or the config file can't be read.
getTheme().then(applyTheme);
navigate("home");

// ---- App close / shutdown ---------------------------------------------------
// The real close path is NATIVE: main.rs intercepts the window's
// CloseRequested event, keeps the window open, and emits
// "app:close-requested"; installCloseHandler() flushes every pending save
// (final atomic write) and then tells Rust to exit — or, if saving failed,
// asks the teacher whether to close anyway. `beforeunload` cannot await an
// async filesystem write (and Tauri doesn't fire it on window close), so it
// is only a guard for reload/navigation in the webview and the browser dev
// preview: it kicks off a flush and, if edits are still unsaved, makes the
// webview show its standard "leave without saving?" confirmation.
registerFlusher("view", {
  flush: async () => { if (beforeNavigateHook) await beforeNavigateHook(); },
  isDirty: () => false, // the view's own flusher (e.g. the editor's) reports dirtiness
});

if (isRunningInTauri) {
  installCloseHandler(window.__TAURI__).catch((err) => {
    console.warn("[app] couldn't install the native close handler", err);
  });
}

// A corrupted data file that was automatically restored from its backup:
// tell the teacher (once) rather than recovering silently.
onStorageRecovery((n) => {
  toast(`A damaged data file (${n.file}) was automatically restored from its backup. The damaged copy was kept.`, "danger");
});

window.addEventListener("beforeunload", (event) => {
  if (currentExit) currentExit(); // exit fullscreen / close the audience window
  if (hasPendingChanges()) {
    flushAll().catch(() => {});
    event.preventDefault();
    event.returnValue = "";
  }
});

// One quiet update check per launch (desktop release builds only). Never blocks
// startup, never interrupts a presentation, and stays silent on offline/errors:
// a small toast plus a dot on the Settings item is all the UI an update gets.
if (isRunningInTauri) {
  setTimeout(() => {
    updateService.startupCheck({ isPresenting: () => !!currentExit }).then((version) => {
      if (!version) return;
      toast(`OmniDeck ${version} is available — open Settings → Updates to install it.`, "default", 8000);
      qs('.nav-rail__item[data-route="settings"]')?.classList.add("has-update");
    }).catch(() => {});
  }, 4000);
}
