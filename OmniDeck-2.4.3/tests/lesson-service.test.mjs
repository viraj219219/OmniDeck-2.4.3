// Focused regression test: a freshly-installed app's seeded example
// lessons must be immediately presentable — their Scripture pages must
// carry real verses (from the bundled WEB dataset), not just a reference
// string with an empty verses array. Runs in plain Node, so it shims
// fetch() (for BibleService's dataset load) and window.localStorage (for
// storageAdapter's non-Tauri path), same approach as the other test files.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = url instanceof URL ? url : new URL(url);
  if (u.protocol === "file:") {
    const buf = await readFile(fileURLToPath(u));
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString("utf8")) };
  }
  return realFetch(url);
};

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); },
  },
};

const { lessonService } = await import("../src/js/services/LessonService.js");

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS — ${name}`);
  else { failures++; console.error(`FAIL — ${name}`); }
}

const lessons = await lessonService.listLessons();
check("fresh install seeds example lessons", lessons.length === 4);

const scripturePages = lessons.flatMap((l) => l.pages.filter((p) => p.type === "scripture"));
check("every seeded lesson has a Scripture page", scripturePages.length === 4);
check(
  "every seeded Scripture page has real, non-empty verses (not just a reference string)",
  scripturePages.every((p) => Array.isArray(p.verses) && p.verses.length > 0)
);

const davidGoliath = scripturePages.find((p) => p.reference?.startsWith("1 Samuel 17"));
check(
  "David & Goliath scripture page has the real WEB text, not fabricated text",
  davidGoliath?.verses.some((v) => v.text.includes("You come to me with a sword"))
);

// The actual bug report: presentation validation must now pass for every
// seeded lesson out of the box, with no "no Scripture selected" failure.
for (const lesson of lessons) {
  const problems = await lessonService.validateForPresentation(lesson.id);
  const scriptureProblems = problems.filter((p) => p.message.includes("no Scripture selected"));
  check(`"${lesson.title}" has no "no Scripture selected" validation failure`, scriptureProblems.length === 0);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
