// atomicFile — crash-safe JSON persistence, independent of WHICH filesystem
// backs it.
//
// storageAdapter.js supplies an `ops` object for the real backend (Tauri's
// fs plugin, or localStorage in the browser dev preview); tests supply
// fault-injecting fakes. Everything about *how* a save stays safe lives here
// so it is exercised by the same code in production and in tests.
//
// ops interface (all async):
//   readText(name)         -> string | null   (null = file does not exist;
//                                              throws on any real I/O error)
//   writeText(name, text)  -> void            (may leave a partial file if
//                                              the process dies mid-write —
//                                              that is exactly what we defend
//                                              against)
//   rename(from, to)       -> void            (atomically replaces `to`)
//   remove(name)           -> void            (missing file is not an error)
//
// On-disk layout for a data file `X`:
//   X            the primary, always a complete valid document
//   X.tmp        a new version being committed (never the primary)
//   X.bak        the last known-good primary, refreshed before every commit
//   X.bak.tmp    staging area so X.bak itself is never half-written
//   X.corrupt-*  a primary that failed validation, quarantined (never
//                deleted) before it is replaced by a recovered copy
//
// Invariant: at every instant at least one of {X, X.bak} holds a complete
// valid document once any save has succeeded, because the primary is only
// ever replaced by an atomic rename of a fully written + read-back-verified
// temp file, and the backup is only refreshed from a primary that itself
// validated.

export const TMP_SUFFIX = ".tmp";
export const BAK_SUFFIX = ".bak";
const BAK_TMP_SUFFIX = ".bak.tmp";

/**
 * Thrown when a file EXISTS (or provably existed) but its content can't be
 * trusted — as opposed to simply not existing, which is normal first-run
 * behavior. `code`:
 *   "unreadable" — couldn't be opened/read (permission, I/O error)
 *   "corrupt"    — read fine but isn't valid, and no valid backup exists
 */
export class StorageReadError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = "StorageReadError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Thrown when a save could not be completed. The previously saved version
 * is ALWAYS still intact when this is thrown. `stage`:
 *   "invalid-data"  the new data wasn't valid JSON / failed the validator —
 *                   refused before touching disk
 *   "tmp-write"     writing the temp file failed
 *   "verify"        the temp file didn't read back identically
 *   "backup"        refreshing the backup failed (aborts the save)
 *   "commit"        the final atomic rename failed
 */
export class StorageWriteError extends Error {
  constructor(message, { stage, cause } = {}) {
    super(message);
    this.name = "StorageWriteError";
    this.stage = stage;
    this.cause = cause;
  }
}

const recoveryEvents = [];
const recoveryListeners = new Set();

/** Subscribe to "a corrupted file was auto-recovered" notices (for the UI). */
export function onStorageRecovery(listener) {
  recoveryListeners.add(listener);
  return () => recoveryListeners.delete(listener);
}

/** Recovery notices raised so far (used by tests and by late-mounting UI). */
export function getRecoveryEvents() {
  return [...recoveryEvents];
}

function announceRecovery(event) {
  recoveryEvents.push(event);
  console.warn(
    `[storage] RECOVERED ${event.file} from ${event.source}: ${event.reason}.` +
    (event.quarantinedAs ? ` The unreadable original was kept as ${event.quarantinedAs}.` : "")
  );
  for (const fn of recoveryListeners) {
    try { fn(event); } catch (err) { console.warn("[storage] recovery listener threw", err); }
  }
}

function tryParse(text, validate) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: "invalid JSON", cause: err };
  }
  if (validate && !validate(parsed)) return { ok: false, reason: "failed validation (unexpected structure)" };
  return { ok: true, parsed };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bestEffortRemove(ops, name) {
  try { await ops.remove(name); } catch { /* cleanup only — never mask the real error */ }
}

/**
 * Stages `text` in `name` + ".tmp" and proves it landed intact by reading it
 * back. The primary is never touched here.
 */
async function stageTmp(ops, name, text) {
  const tmp = name + TMP_SUFFIX;
  try {
    await ops.writeText(tmp, text);
  } catch (err) {
    await bestEffortRemove(ops, tmp);
    throw new StorageWriteError(`Couldn't write ${tmp}: ${err?.message || err}`, { stage: "tmp-write", cause: err });
  }
  let readBack;
  try {
    readBack = await ops.readText(tmp);
  } catch (err) {
    await bestEffortRemove(ops, tmp);
    throw new StorageWriteError(`Couldn't verify ${tmp}: ${err?.message || err}`, { stage: "verify", cause: err });
  }
  if (readBack !== text) {
    await bestEffortRemove(ops, tmp);
    throw new StorageWriteError(`${tmp} did not read back identically after writing — the disk may be full or failing.`, { stage: "verify" });
  }
  return tmp;
}

/**
 * Atomically replaces `name` with the verified temp file. Retries a few
 * times (Windows can briefly refuse to replace a file an antivirus/indexer
 * has open). On failure the verified temp file is deliberately LEFT IN
 * PLACE — it is a complete new version recovery can use — and the primary
 * is untouched.
 */
async function promoteTmp(ops, tmp, name, sleep = defaultSleep) {
  const retries = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await ops.rename(tmp, name);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(30 * attempt);
    }
  }
  throw new StorageWriteError(`Couldn't replace ${name} with the new version: ${lastErr?.message || lastErr}. The previously saved version is intact.`, { stage: "commit", cause: lastErr });
}

/**
 * Crash-safe save of one JSON document. See the file header for the layout.
 * Throws StorageWriteError on failure; on any failure the previously saved
 * primary (and its backup) are left exactly as they were.
 *
 * Order matters:
 *   1. validate the new content (refuse to persist garbage)
 *   2. stage it in X.tmp and read it back      — old primary untouched
 *   3. refresh X.bak from the current primary   — only if that primary is valid
 *   4. atomically rename X.tmp over X
 * A crash at any point leaves either the old primary or the new one intact,
 * plus a valid backup.
 */
export async function atomicWriteText(ops, name, text, { validate, sleep } = {}) {
  const check = tryParse(text, validate);
  if (!check.ok) {
    throw new StorageWriteError(`Refused to save ${name}: the new content is ${check.reason}. The previously saved version was not touched.`, { stage: "invalid-data", cause: check.cause });
  }

  const tmp = await stageTmp(ops, name, text);

  // A corrupt primary must never overwrite the only good backup, so the
  // backup is only refreshed from a primary that itself validates.
  let current;
  try {
    current = await ops.readText(name);
  } catch {
    current = undefined; // unreadable primary: leave the existing backup alone
  }
  if (typeof current === "string" && tryParse(current, validate).ok) {
    const bak = name + BAK_SUFFIX;
    const bakTmp = name + BAK_TMP_SUFFIX;
    try {
      await ops.writeText(bakTmp, current);
      await ops.rename(bakTmp, bak);
    } catch (err) {
      await bestEffortRemove(ops, bakTmp);
      // The old backup (if any) is untouched thanks to the staging file.
      // Abort rather than silently run without the safety net this whole
      // module exists to provide; the staged new version stays in X.tmp.
      throw new StorageWriteError(`Couldn't refresh the backup ${bak}: ${err?.message || err}. Nothing was changed.`, { stage: "backup", cause: err });
    }
  }

  await promoteTmp(ops, tmp, name, sleep);
}

async function readCandidate(ops, name, validate) {
  let text;
  try {
    text = await ops.readText(name);
  } catch (err) {
    throw new StorageReadError(`${name} exists but could not be read from disk.`, { code: "unreadable", cause: err });
  }
  if (text === null) return { state: "missing" };
  const check = tryParse(text, validate);
  return check.ok ? { state: "valid", text, parsed: check.parsed } : { state: "invalid", reason: check.reason, cause: check.cause };
}

/**
 * Reads a JSON document, self-healing from the backup when the primary is
 * missing-but-backed-up or corrupt.
 *
 *   primary valid                         -> its data
 *   primary + backup + tmp all absent     -> `fallback` (genuine first run)
 *   primary unreadable (I/O error)        -> throws StorageReadError("unreadable")
 *   primary corrupt/missing, backup valid -> restores the backup as the
 *       primary (quarantining the bad file as X.corrupt-<time>), logs a
 *       clear recovery notice, returns the recovered data
 *   nothing valid to recover from         -> throws StorageReadError("corrupt")
 *       — NEVER `fallback`, so a damaged library can't masquerade as an
 *       empty one and be overwritten with seed data.
 */
export async function readWithRecovery(ops, name, fallback, { validate, sleep, now = Date.now } = {}) {
  const primary = await readCandidate(ops, name, validate);
  if (primary.state === "valid") return primary.parsed;

  // Look for something to recover from: backup first (last known-good),
  // then a fully written but uncommitted temp file.
  const sources = [];
  for (const suffix of [BAK_SUFFIX, TMP_SUFFIX]) {
    const file = name + suffix;
    sources.push({ file, suffix, result: await readCandidate(ops, file, validate) });
  }

  const usable = sources.find((s) => s.result.state === "valid");
  const anythingExisted = primary.state !== "missing" || sources.some((s) => s.result.state !== "missing");

  if (!usable) {
    if (!anythingExisted) return fallback; // A: genuine first run
    const detail = [
      primary.state === "invalid" ? `${name} is corrupted (${primary.reason})` : `${name} is missing`,
      ...sources.filter((s) => s.result.state === "invalid").map((s) => `${s.file} is also corrupted (${s.result.reason})`),
    ].join("; ");
    const hasBackupFile = sources.some((s) => s.suffix === BAK_SUFFIX && s.result.state !== "missing");
    throw new StorageReadError(
      `${name} exists but its content is corrupted (invalid JSON) and ${hasBackupFile ? "its backup is unusable too" : "there is no valid backup to recover from"}. ${detail}. Nothing was overwritten or reset.`,
      { code: "corrupt", cause: primary.cause }
    );
  }

  // Quarantine a bad primary (never delete evidence), then restore.
  let quarantinedAs = null;
  if (primary.state === "invalid") {
    const target = `${name}.corrupt-${now()}`;
    try {
      await ops.rename(name, target);
      quarantinedAs = target;
    } catch (err) {
      console.warn(`[storage] couldn't quarantine corrupted ${name} (it will be replaced by the recovered copy)`, err);
    }
  }

  try {
    if (usable.suffix === TMP_SUFFIX) {
      await ops.rename(usable.file, name); // already a complete file — just promote it
    } else {
      const staged = await stageTmp(ops, name, usable.result.text);
      await promoteTmp(ops, staged, name, sleep); // backup stays untouched as a source
    }
  } catch (err) {
    // Couldn't write the healed primary back (read-only disk?). The data is
    // still good in memory, and the next successful save will replace the
    // bad primary — don't fail the load over it.
    console.warn(`[storage] recovered ${name} from ${usable.file} in memory but couldn't restore it on disk yet`, err);
  }

  announceRecovery({
    file: name,
    source: usable.file,
    reason: primary.state === "invalid" ? `the main file was corrupted (${primary.reason})` : "the main file was missing",
    quarantinedAs,
    at: new Date(now()).toISOString(),
  });
  return usable.result.parsed;
}

/** Removes a data file together with every sibling this module creates. */
export async function removeAllVersions(ops, name) {
  const failures = [];
  for (const file of [name, name + BAK_SUFFIX, name + TMP_SUFFIX, name + BAK_TMP_SUFFIX]) {
    try { await ops.remove(file); } catch (err) { failures.push({ file, err }); }
  }
  return failures;
}
