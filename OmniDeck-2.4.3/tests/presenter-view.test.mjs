// Presenter View contracts that need no browser: keyboard guard, audience isolation, preview
// inertness, wiring. (Rendering itself needs a webview: that is verified manually, see docs.)
import { readFileSync } from "node:fs";
import { makeChecker } from "./helpers/fakeDisk.mjs";
const { check, done } = makeChecker();
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---- keyboard: never hijack typing ----
const handlers = [];
globalThis.document = { addEventListener: (t, h) => handlers.push(h), removeEventListener: () => {} };
const { bindKeys } = await import("../src/js/utils/keyboard.js");
const hits = [];
bindKeys({ ArrowRight: () => hits.push("next"), ArrowLeft: () => hits.push("prev"), Home: () => hits.push("home"), PageDown: () => hits.push("next"), Escape: () => hits.push("esc") });
const fire = (key, target) => { let prevented = false; handlers.at(-1)({ key, target, preventDefault: () => { prevented = true; } }); return prevented; };
const el = (tagName, extra = {}) => ({ tagName, getAttribute: () => null, ...extra });
check("arrow keys navigate when focus is on the slide", fire("ArrowRight", el("DIV")) === true && hits.at(-1) === "next");
check("PageDown navigates", fire("PageDown", el("DIV")) && hits.at(-1) === "next");
hits.length = 0;
for (const t of [el("INPUT"), el("TEXTAREA"), el("SELECT"), el("DIV", { isContentEditable: true })]) {
  check(`typing in <${t.tagName.toLowerCase()}${t.isContentEditable ? " contenteditable" : ""}> is NOT hijacked (arrows/Home left alone, not preventDefault-ed)`, fire("ArrowRight", t) === false && fire("Home", t) === false);
}
check("no slide change happened while typing", hits.length === 0);
check("Escape still exits from inside a text field", fire("Escape", el("INPUT")) === true && hits.at(-1) === "esc");

// ---- previews are inert: media muted/paused/no controls ----
const { neutralizeMedia } = await import("../src/js/components/presenterThumb.js");
const vid = { muted: false, controls: true, autoplay: true, paused: false, removeAttribute() {}, pause() { this.paused = true; } };
const root = { querySelectorAll: (sel) => (/video/.test(sel) ? [vid] : []), setAttribute(k) { this.attr = k; } };
neutralizeMedia(root);
check("preview video is muted, paused, control-less, non-autoplay", vid.muted && !vid.controls && !vid.autoplay && vid.paused);
check("preview subtree is inert (not focusable/clickable)", root.attr === "inert");

// ---- audience window shows presentation only ----
const aud = code(read("src/js/audience.js")), html = read("src/audience.html");
check("audience.js imports no controller code (session, thumbs, watcher, toast, keyboard, editor)", !/PresenterSession|presenterThumb|DisplayWatcher|toast|keyboard|lessonEditor|PresentationService/.test(aud));
check("audience page has no buttons/inputs/selects/nav", !/<(button|input|select|nav|textarea)\b/i.test(html));
check("audience renders a uniformly scaled preview-sized slide, non-interactive", /renderScaledPresentSlide\(state\.page,\s*\{\s*interactive:\s*false/.test(aud) && /state\.previewSize/.test(aud));
check("audience hides video controls (it only follows the presenter)", /video\.controls = false/.test(aud) && /video\.muted = false/.test(aud));
check("audience goes blank when told the show ended ({page:null})", /!state\.page\)\s*\{[^}]*drawWaiting\(\)/.test(aud));
check("audience ignores late media relays for a slide that is no longer showing", /payload\.index !== currentIndex\) return/.test(aud));

// ---- controller wiring ----
const pm = code(read("src/js/views/presentMode.js"));
check("controller is a thin view over the shared PresenterSession", /createPresenterSession\(/.test(pm) && /session\.goTo\(/.test(pm) && /session\.next\(\)/.test(pm));
check("controller has: live preview, next preview, slide list, counters, status, display chooser, exit", ["presenter__live", "presenter__next", "presenter__list", "presenter__counter", "presenter__status", "presenter__choose", "End show"].every((c) => pm.includes(c)));
check("direct slide selection and current-slide highlight are wired", /session\.goTo\(s\.index\)/.test(pm) && /is-current/.test(pm) && /aria-current/.test(pm));
check("presenter copy of a video is muted when an audience window exists (no double audio)", /if \(view\.dual\) v\.muted = true/.test(pm));
check("typing in a quiz answer does not redraw (focus) or reach the audience until submitted", /onQuizTextChange: \(val\) => session\.setQuizDraft\(val\)/.test(pm));
check("single-display layout keeps the original full-bleed stage + control bar", /Single-display layout: unchanged/.test(read("src/js/views/presentMode.js")));
check("no localStorage/BroadcastChannel/postMessage anywhere in the present path", ["src/js/views/presentMode.js", "src/js/audience.js", "src/js/services/PresenterSession.js", "src/js/services/PresentationService.js", "src/js/components/presenterThumb.js"].every((f) => !/localStorage|BroadcastChannel|postMessage/.test(code(read(f)))));
check("sync uses native Tauri events", /emit\("presenter:slide-state"/.test(read("src/js/services/PresentationService.js")) && /emit\("presenter:media-state"/.test(read("src/js/services/PresentationService.js")));

// ---- native side: permissions / guard ----
const rs = read("src-tauri/src/main.rs"), cap = JSON.parse(read("src-tauri/capabilities/default.json"));
check("audience window is in the default capability (it needs event + media read access)", cap.windows.includes("audience") && cap.permissions.includes("core:default"));
check("native guard: audience can never be opened on the presenter's own monitor", /Can't open the audience display on the presenter's own monitor/.test(rs));
check("native audience window has no decorations and is fullscreened after positioning", /\.decorations\(false\)/.test(rs) && rs.indexOf("set_position") < rs.indexOf("set_fullscreen(true)"));
done();
