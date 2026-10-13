// Focused regression test for storageAdapter.js's read-failure distinction:
// "file missing" (normal) must never be conflated with "file exists but
// unreadable/corrupt" (a real error) — see readJSON's doc comment for why.
// Runs in plain Node, so it shims a minimal `window.localStorage` (the
// non-Tauri code path) rather than the real Tauri fs plugin.

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`PASS — ${name}`);
  else { failures++; console.error(`FAIL — ${name}`); }
}

const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); },
  },
};

const { readJSON, writeJSON, StorageReadError } = await import("../src/js/utils/storageAdapter.js");

// A: file does not exist -> returns fallback, no throw
const missing = await readJSON("does-not-exist.json", "FALLBACK");
check("missing file returns fallback (not an error)", missing === "FALLBACK");

// D: file exists and is valid JSON -> returns parsed data
await writeJSON("good.json", { hello: "world" });
const good = await readJSON("good.json", null);
check("valid file returns its real parsed content", good && good.hello === "world");

// C: file exists but contains invalid JSON -> throws StorageReadError("corrupt"),
// and must NOT resolve to the fallback (that would look like "no data").
store.set("omnideck:corrupt.json", "{ not valid json");
let corruptError = null;
try {
  await readJSON("corrupt.json", "SHOULD_NOT_SEE_THIS");
} catch (err) {
  corruptError = err;
}
check("corrupt JSON throws instead of silently returning fallback", corruptError instanceof StorageReadError);
check("corrupt JSON is tagged with code 'corrupt'", corruptError?.code === "corrupt");

// B: the storage layer itself is unreadable -> throws StorageReadError("unreadable"),
// again never silently resolving to fallback.
const originalGetItem = window.localStorage.getItem;
window.localStorage.getItem = () => { throw new Error("simulated I/O failure"); };
let unreadableError = null;
try {
  await readJSON("anything.json", "SHOULD_NOT_SEE_THIS");
} catch (err) {
  unreadableError = err;
}
check("unreadable storage throws instead of silently returning fallback", unreadableError instanceof StorageReadError);
check("unreadable storage is tagged with code 'unreadable'", unreadableError?.code === "unreadable");
window.localStorage.getItem = originalGetItem;

// Sanity: a real teacher's saved lessons.json equivalent — once written,
// a later corrupt read must never come back looking like an empty list.
await writeJSON("lessons.json", [{ id: "lesson_1", title: "Real Lesson" }]);
store.set("omnideck:lessons.json", "{corrupt");
let lessonsError = null;
try {
  await readJSON("lessons.json", []);
} catch (err) {
  lessonsError = err;
}
check("a corrupted lessons file never resolves to an empty array", lessonsError instanceof StorageReadError);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
