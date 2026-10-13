// In-memory filesystem with fault injection, shared by the persistence /
// media / import / shutdown tests. It is TEST INFRASTRUCTURE ONLY — nothing
// under src/ imports it. It can be viewed two ways:
//   - as the `ops` object atomicFile.js expects (readText/writeText/...), and
//   - as a stand-in for window.__TAURI__ (fs/path/core/dialog/event) so the
//     real storageAdapter / MediaService code paths run unmodified against it,
//     including a Windows-style app-data directory with a space in it.

export class CrashError extends Error {
  constructor(msg = "simulated crash / power loss") { super(msg); this.name = "CrashError"; }
}

export const WIN_BASE = "C:\\Users\\Pat Smith\\AppData\\Local\\org.omnideck.app";

export class FakeDisk {
  constructor() {
    this.files = new Map();   // relative posix path -> string | Uint8Array
    this.dirs = new Set([""]);
    this.faults = [];         // { op, match, times, partial, error }
    this.mutations = 0;       // count of mutating ops (for crash fuzzing)
    this.crashAt = null;      // mutation number at which the "process dies"
    this.dead = false;
    this.activeWrites = new Map(); // path -> concurrent writers (must stay <= 1)
    this.maxConcurrentPerPath = 0;
    this.log = [];
  }

  /** Make matching operations fail. `partial` writes half the data first. */
  failOn(op, match, { times = 1, partial = false, error } = {}) {
    const matcher = typeof match === "string" ? (p) => p === match : match instanceof RegExp ? (p) => match.test(p) : match;
    this.faults.push({ op, match: matcher, times, partial, error: error || new Error(`injected ${op} failure`) });
  }
  clearFaults() { this.faults = []; }

  norm(path) {
    let p = String(path).replace(/\\/g, "/");
    const base = WIN_BASE.replace(/\\/g, "/") + "/";
    if (p.startsWith(base)) p = p.slice(base.length);
    if (p === WIN_BASE.replace(/\\/g, "/")) p = "";
    return p;
  }

  _fault(op, path) {
    const f = this.faults.find((x) => x.op === op && x.times > 0 && x.match(path));
    if (f) f.times -= 1;
    return f || null;
  }

  _mutate(op, path) {
    if (this.dead) throw new CrashError("process already dead");
    this.mutations += 1;
    this.log.push(`${op} ${path}`);
    if (this.crashAt !== null && this.mutations === this.crashAt) return "crash";
    return null;
  }

  // ---- primitives used by both views -------------------------------------
  async readTextRaw(path) {
    const p = this.norm(path);
    const f = this._fault("read", p);
    if (f) throw f.error;
    if (!this.files.has(p)) return null;
    const v = this.files.get(p);
    return typeof v === "string" ? v : new TextDecoder().decode(v);
  }

  async writeRaw(path, data) {
    const p = this.norm(path);
    const crash = this._mutate("write", p);
    const n = (this.activeWrites.get(p) || 0) + 1;
    this.activeWrites.set(p, n);
    this.maxConcurrentPerPath = Math.max(this.maxConcurrentPerPath, n);
    try {
      await Promise.resolve(); // yield so overlapping writers are observable
      const f = this._fault("write", p);
      const isStr = typeof data === "string";
      if (crash === "crash") {
        this.files.set(p, isStr ? data.slice(0, Math.floor(data.length / 2)) : data.slice(0, Math.floor(data.length / 2)));
        this.dead = true;
        throw new CrashError();
      }
      if (f) {
        if (f.partial) this.files.set(p, isStr ? data.slice(0, Math.floor(data.length / 2)) : data.slice(0, Math.floor(data.length / 2)));
        throw f.error;
      }
      this.files.set(p, data);
    } finally {
      this.activeWrites.set(p, this.activeWrites.get(p) - 1);
    }
  }

  async renameRaw(from, to) {
    const a = this.norm(from), b = this.norm(to);
    const crash = this._mutate("rename", `${a} -> ${b}`);
    if (crash === "crash") { this.dead = true; throw new CrashError(); } // rename is atomic: it either happened or not; here: not
    const f = this._fault("rename", a) || this._fault("rename", b);
    if (f) throw f.error;
    if (!this.files.has(a)) throw new Error(`rename: ${a} does not exist`);
    this.files.set(b, this.files.get(a));
    this.files.delete(a);
  }

  async removeRaw(path, { recursive = false } = {}) {
    const p = this.norm(path);
    const crash = this._mutate("remove", p);
    if (crash === "crash") { this.dead = true; throw new CrashError(); }
    const f = this._fault("remove", p);
    if (f) throw f.error;
    if (this.files.delete(p)) return;
    if (recursive) {
      for (const k of [...this.files.keys()]) if (k.startsWith(p + "/")) this.files.delete(k);
      this.dirs.delete(p);
      return;
    }
    throw new Error(`remove: ${p} not found`);
  }

  /** View as atomicFile's `ops`. */
  ops() {
    return {
      readText: (n) => this.readTextRaw(n),
      writeText: (n, t) => this.writeRaw(n, t),
      rename: (a, b) => this.renameRaw(a, b),
      remove: async (n) => { if (this.files.has(this.norm(n))) await this.removeRaw(n); },
    };
  }

  // ---- convenience for assertions ----------------------------------------
  text(path) { const v = this.files.get(path); return v === undefined ? undefined : typeof v === "string" ? v : new TextDecoder().decode(v); }
  json(path) { return JSON.parse(this.text(path)); }
  has(path) { return this.files.has(path); }
  list(prefix = "") { return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

/**
 * Installs window.__TAURI__ / __TAURI_INTERNALS__ backed by `disk`. Must run
 * BEFORE importing storageAdapter (it decides Tauri-vs-browser at load).
 * `commands` maps invoke() names to handlers for Rust commands.
 */
export function installFakeTauri(disk, { commands = {} } = {}) {
  const baseDir = { AppLocalData: "AppLocalData" };
  const fs = {
    BaseDirectory: baseDir,
    async exists(path) {
      const f = disk._fault("exists", disk.norm(path));
      if (f) throw f.error;
      const p = disk.norm(path);
      return p === "" ? disk.dirs.has("") : disk.files.has(p) || disk.dirs.has(p) || [...disk.files.keys()].some((k) => k.startsWith(p + "/"));
    },
    async mkdir(path) { disk.dirs.add(disk.norm(path)); },
    async readTextFile(path) {
      const p = disk.norm(path);
      const f = disk._fault("read", p);
      if (f) throw f.error;
      if (!disk.files.has(p)) throw new Error(`No such file: ${p}`);
      const v = disk.files.get(p);
      return typeof v === "string" ? v : new TextDecoder().decode(v);
    },
    async writeTextFile(path, data) { await disk.writeRaw(path, data); },
    async readFile(path) {
      const p = disk.norm(path);
      const f = disk._fault("read", p);
      if (f) throw f.error;
      if (!disk.files.has(p)) throw new Error(`No such file: ${p}`);
      const v = disk.files.get(p);
      return typeof v === "string" ? new TextEncoder().encode(v) : v;
    },
    async writeFile(path, data) { await disk.writeRaw(path, data); },
    async rename(from, to) { await disk.renameRaw(from, to); },
    async remove(path, opts) { await disk.removeRaw(path, opts); },
    async copyFile(src, dst) {
      const a = disk.norm(src);
      const b = disk.norm(dst);
      const f = disk._fault("copy", a) || disk._fault("copy", b);
      if (f) throw f.error;
      if (!disk.files.has(a)) throw new Error(`copy: ${a} not found`);
      await disk.writeRaw(b, disk.files.get(a));
    },
    async stat(path) {
      const p = disk.norm(path);
      if (!disk.files.has(p)) throw new Error(`No such file: ${p}`);
      const v = disk.files.get(p);
      return { size: typeof v === "string" ? v.length : v.length };
    },
  };
  const path = {
    appLocalDataDir: async () => WIN_BASE,
    join: async (...parts) => parts.join("\\"),
  };
  const core = {
    convertFileSrc: (p) => `asset://localhost/${encodeURIComponent(p)}`,
    invoke: async (name, args) => {
      if (!commands[name]) throw new Error(`no fake handler for command ${name}`);
      return commands[name](args, disk);
    },
  };
  const dialog = { open: async () => null, save: async () => null, ask: async () => true };
  const listeners = new Map();
  const event = {
    listen: async (name, cb) => { (listeners.get(name) || listeners.set(name, []).get(name)).push(cb); return () => {}; },
    emit: async (name, payload) => { for (const cb of listeners.get(name) || []) await cb({ payload }); },
  };
  globalThis.window = globalThis.window || {};
  globalThis.window.__TAURI_INTERNALS__ = {};
  globalThis.window.__TAURI__ = { fs, path, core, dialog, event };
  return { fs, path, core, dialog, event, listeners };
}

let checkFailures = 0;
export function makeChecker() {
  return {
    check(name, condition) {
      if (condition) console.log(`PASS — ${name}`);
      else { checkFailures++; console.error(`FAIL — ${name}`); }
    },
    done() {
      console.log(checkFailures === 0 ? "\nALL PASS" : `\n${checkFailures} FAILURE(S)`);
      process.exit(checkFailures === 0 ? 0 : 1);
    },
  };
}
