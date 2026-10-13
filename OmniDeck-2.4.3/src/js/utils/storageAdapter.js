import {
  StorageReadError,
  StorageWriteError,
  atomicWriteText,
  readWithRecovery,
  removeAllVersions,
  onStorageRecovery,
  getRecoveryEvents,
} from "./atomicFile.js";

const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Re-exported so every existing `import { StorageReadError } from
// storageAdapter.js` keeps working; the classes live in atomicFile.js so the
// pure crash-safety logic has no dependency on this module.
export { StorageReadError, StorageWriteError, onStorageRecovery, getRecoveryEvents };

// ---------------------------------------------------------------------------
// Backends. Both expose the same tiny `ops` interface (see atomicFile.js) so
// the atomic-write / recovery logic is identical in the desktop app and in
// the browser dev preview.
// ---------------------------------------------------------------------------

function tauriOps() {
  // Vanilla-JS (no bundler) Tauri v2 apps can't resolve bare npm specifiers
  // like "@tauri-apps/plugin-fs" at runtime. With `withGlobalTauri` enabled
  // (see tauri.conf.json) the plugin's bindings are injected instead as
  // window.__TAURI__.fs — see https://v2.tauri.app/reference/javascript/api/
  const { BaseDirectory, exists, mkdir, readTextFile, writeTextFile, rename, remove } = window.__TAURI__.fs;
  const baseDir = BaseDirectory.AppLocalData;
  let dirEnsured = false;
  return {
    async readText(name) {
      // exists() failing is a real error (unreadable), not "missing".
      if (!(await exists(name, { baseDir }))) return null;
      return readTextFile(name, { baseDir });
    },
    async writeText(name, text) {
      if (!dirEnsured) {
        if (!(await exists("", { baseDir }))) await mkdir("", { baseDir, recursive: true });
        dirEnsured = true;
      }
      await writeTextFile(name, text, { baseDir });
    },
    // Relative names + baseDir: the plugin resolves them with the platform's
    // own path rules, so this is correct on Windows (backslashes, drive
    // letters, spaces in the user profile) without any string handling here.
    async rename(from, to) {
      await rename(from, to, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
    },
    async remove(name) {
      if (await exists(name, { baseDir })) await remove(name, { baseDir });
    },
  };
}

function localStorageOps() {
  const key = (name) => `omnideck:${name}`;
  const ls = () => window.localStorage;
  return {
    async readText(name) {
      return ls().getItem(key(name)); // null === missing
    },
    async writeText(name, text) {
      ls().setItem(key(name), text);
    },
    async rename(from, to) {
      const value = ls().getItem(key(from));
      if (value === null) throw new Error(`${from} does not exist`);
      ls().setItem(key(to), value);
      // A rename must not leave a usable copy behind under the old name (a
      // stale .tmp would later look like a recoverable version). Real
      // browsers have removeItem; a minimal shim without it is blanked
      // instead, which reads back as "invalid", never as valid data.
      if (typeof ls().removeItem === "function") ls().removeItem(key(from));
      else ls().setItem(key(from), "");
    },
    async remove(name) {
      ls().removeItem?.(key(name));
    },
  };
}

function ops() {
  return hasTauri ? tauriOps() : localStorageOps();
}

// ---------------------------------------------------------------------------
// Per-file mutex. The invariant "at most one persistence operation per data
// file may be active at a time" is enforced HERE, at the lowest layer, so no
// caller — however it is written — can interleave two writes (or a write and
// a recovery) on the same file. Higher layers (SaveQueue) add coalescing on
// top; this is the safety net underneath.
// ---------------------------------------------------------------------------

const fileLocks = new Map(); // fileName -> tail promise of the chain

function withFileLock(fileName, task) {
  const prev = fileLocks.get(fileName) || Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => {});
  fileLocks.set(fileName, tail);
  tail.then(() => { if (fileLocks.get(fileName) === tail) fileLocks.delete(fileName); });
  return run;
}

/**
 * Reads a persisted JSON file, distinguishing:
 *   A. Nothing exists (no file, no backup) -> returns `fallback` (first run)
 *   B. File exists, can't be read          -> throws StorageReadError("unreadable")
 *   C. File corrupt AND no valid backup    -> throws StorageReadError("corrupt")
 *   D. File valid                          -> returns the parsed data
 *   E. File corrupt/missing but a valid backup exists -> the backup is
 *      validated, restored as the main file, a recovery notice is logged
 *      (see onStorageRecovery), and the recovered data is returned.
 * Only A resolves to `fallback`. B and C are real failures and are never
 * collapsed into "no data" — that is indistinguishable from an empty state
 * and is exactly how a teacher's library could be reseeded/overwritten.
 *
 * `validate(parsed) => boolean` (optional) lets a caller reject
 * syntactically valid JSON of the wrong shape (e.g. lessons.json must be an
 * array) so it triggers recovery instead of being trusted.
 */
export async function readJSON(fileName, fallback, { validate } = {}) {
  return withFileLock(fileName, () => readWithRecovery(ops(), fileName, fallback, { validate }));
}

/**
 * Crash-safe save. Throws StorageWriteError on failure — the previously
 * saved version is always left intact. Use this where the reason matters.
 */
export async function writeJSONStrict(fileName, data, { validate } = {}) {
  const text = JSON.stringify(data, null, 2);
  if (text === undefined) throw new StorageWriteError(`Refused to save ${fileName}: the data can't be represented as JSON.`, { stage: "invalid-data" });
  return withFileLock(fileName, () => atomicWriteText(ops(), fileName, text, { validate }));
}

/** Boolean-returning wrapper kept for callers that only need pass/fail. */
export async function writeJSON(fileName, data, options) {
  try {
    await writeJSONStrict(fileName, data, options);
    return true;
  } catch (err) {
    console.warn(`[storage] failed to write ${fileName}`, err);
    return false;
  }
}

/** Deletes a data file and every .tmp/.bak sibling (used when the user
 * explicitly removes something that owns its own data file). */
export async function deleteJSON(fileName) {
  return withFileLock(fileName, () => removeAllVersions(ops(), fileName));
}

export const isRunningInTauri = hasTauri;
