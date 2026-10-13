// Regression tests for bugs found in the v2.2 audit. Each block names the
// failure it guards against. Plain Node, no DOM library (see helpers/miniDom.mjs).
import { installMiniDom, findNode, hasClass } from "./helpers/miniDom.mjs";
import { makeChecker } from "./helpers/fakeDisk.mjs";

const { check, done } = makeChecker();

// localStorage shim for the browser-preview storage path (same approach as lesson-service.test.mjs)
const store = new Map();
installMiniDom();
globalThis.window.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, v); },
  removeItem: (k) => { store.delete(k); },
};

// ---- 1. Present-Mode keys must not fire while typing in a text field --------------------
{
  const { bindKeys } = await import("../src/js/utils/keyboard.js");
  let handler;
  globalThis.document.addEventListener = (type, fn) => { if (type === "keydown") handler = fn; };
  globalThis.document.removeEventListener = () => {};
  const calls = [];
  bindKeys({ ArrowLeft: () => calls.push("left"), Home: () => calls.push("home"), Escape: () => calls.push("esc") });
  const press = (key, target) => { let prevented = false; handler({ key, target, preventDefault() { prevented = true; } }); return prevented; };
  const input = { tagName: "INPUT" };
  const body = { tagName: "BODY" };

  check("ArrowLeft while typing in an input does NOT change slides", press("ArrowLeft", input) === false && calls.length === 0);
  check("Home while typing in an input does NOT change slides (caret keeps working)", press("Home", input) === false && calls.length === 0);
  check("Escape still exits even from inside an input", press("Escape", input) === true && calls.at(-1) === "esc");
  check("ArrowLeft on the slide itself still navigates", press("ArrowLeft", body) === true && calls.at(-1) === "left");
  check("a contenteditable element counts as typing", press("ArrowLeft", { tagName: "DIV", isContentEditable: true }) === false);
}

// ---- 2. A valid but EMPTY lessons.json must stay empty (not be re-seeded) ---------------
{
  store.set("omnideck:lessons.json", "[]");
  const { lessonService } = await import("../src/js/services/LessonService.js");
  const lessons = await lessonService.listLessons();
  check("an emptied lesson library is not silently re-seeded with the example lessons", lessons.length === 0);
}

// ---- 3. Boxes added to a NON-freeform slide must render in Present Mode -----------------
{
  const { renderPresentStage } = await import("../src/js/components/slideStage.js");
  const box = { id: "b1", type: "text", x: 10, y: 10, w: 30, h: 20, text: "OVERLAY-TEXT", fontSize: 6 };

  const withBox = renderPresentStage({ id: "p1", type: "title", title: "Hello", subtitle: "", boxes: [box] }, { interactive: false });
  const overlay = findNode(withBox, (n) => hasClass(n, "present-freeform--overlay"));
  check("a title slide with an overlay box renders the box layer", !!overlay);
  check("the overlay box's text is in the presented slide", !!overlay && overlay.textContent.includes("OVERLAY-TEXT"));
  check("the slide's own content is still rendered next to the overlay", withBox.textContent.includes("Hello"));

  const scripture = renderPresentStage({ id: "p2", type: "scripture", reference: "John 3:16", verses: [{ number: 16, text: "For God so loved" }], boxes: [box] }, { interactive: false });
  check("scripture slides get their overlay boxes too", scripture.textContent.includes("OVERLAY-TEXT") && scripture.textContent.includes("For God so loved"));
  check("scripture slide content order matches presentation: verses before reference",
    scripture.textContent.indexOf("For God so loved") < scripture.textContent.indexOf("John 3:16"));

  const formattedScripture = renderPresentStage({
    id: "p2-style",
    type: "scripture",
    reference: "John 3:16",
    scriptureAlign: "right",
    scriptureStyle: { fontSize: 1.4 },
    verses: [{ number: 16, text: "For God so loved the world" }],
    boxes: [],
  }, { interactive: false });
  const verseBlock = findNode(formattedScripture, (n) => hasClass(n, "present-scripture"));
  const reference = findNode(formattedScripture, (n) => hasClass(n, "present-ref"));
  check("Scripture alignment is applied to the verse block", verseBlock?.style.textAlign === "right");
  check("Scripture alignment is also applied to the reference", reference?.style.textAlign === "right");
  check("Scripture size override is applied to the shared output renderer", verseBlock?.style.fontSize?.includes("1.4 * clamp(") === true);
  check("Scripture render has the same present-stage inner wrapper", hasClass(formattedScripture, "present-stage__inner"));

  const plain = renderPresentStage({ id: "p3", type: "title", title: "No boxes", subtitle: "", boxes: [] }, { interactive: false });
  check("a slide with no boxes is unchanged (no wrapper, no overlay)", !hasClass(plain, "present-layered") && !findNode(plain, (n) => hasClass(n, "present-freeform")));

  const freeform = renderPresentStage({ id: "p4", type: "freeform", boxes: [box] }, { interactive: false });
  check("freeform slides still render their boxes exactly once", hasClass(freeform, "present-freeform") && !hasClass(freeform, "present-freeform--overlay") && freeform.textContent === "OVERLAY-TEXT");
}

// ---- 4. Present Mode must not block typing in its own text fields (WebKit user-select quirk) ----
{
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/styles/present.css", import.meta.url), "utf8");
  check("present.css re-enables text selection on inputs inside Present Mode",
    /\.present-root input[^{]*\{[^}]*user-select:\s*text/.test(css));
  const opens = (css.match(/\{/g) || []).length, closes = (css.match(/\}/g) || []).length;
  check("present.css braces are balanced", opens === closes);
}

done();
