// check-deps.mjs / run-tauri.mjs: a missing install must be a clear failure
// (never a silent skip), and the LOCAL Tauri CLI must be launched via Node
// without relying on PATH. Uses throwaway fake repos; no network needed.
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { check, finish } from "./helpers/harness.mjs";

const scripts = join(fileURLToPath(new URL(".", import.meta.url)), "..", "scripts");
function fakeRepo({ cli = true, pdfjs = true, cliEntry = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), "omnideck preflight "));   // space in path on purpose
  mkdirSync(join(d, "scripts"));
  for (const f of ["check-deps.mjs", "run-tauri.mjs"]) copyFileSync(join(scripts, f), join(d, "scripts", f));
  writeFileSync(join(d, "package.json"), '{"type":"module"}');
  if (cli || pdfjs) mkdirSync(join(d, "node_modules"));
  if (cli) {
    const c = join(d, "node_modules/@tauri-apps/cli");
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, "package.json"), '{"name":"@tauri-apps/cli","bin":{"tauri":"./tauri.js"}}');
    if (cliEntry) writeFileSync(join(c, "tauri.js"), 'console.log("ARGS:" + process.argv.slice(2).join(" ")); process.exit(7);');
  }
  if (pdfjs) { mkdirSync(join(d, "node_modules/pdfjs-dist"), { recursive: true }); writeFileSync(join(d, "node_modules/pdfjs-dist/package.json"), "{}"); }
  return d;
}
const node = (repo, script, args = [], env = {}) =>
  spawnSync(process.execPath, [join(repo, "scripts", script), ...args], { encoding: "utf8", env: { ...process.env, CI: "", OMNIDECK_REPO_ROOT: "", ...env } });

let r = node(fakeRepo({ cli: false, pdfjs: false }), "check-deps.mjs");
check("no node_modules: check-deps exits 1 and says to run npm ci", r.status === 1 && /npm ci/.test(r.stderr) && /node_modules/.test(r.stderr), r.stderr);
r = node(fakeRepo({ cli: false, pdfjs: true }), "check-deps.mjs");
check("node_modules without @tauri-apps/cli: exits 1", r.status === 1 && /@tauri-apps\/cli is not installed/.test(r.stderr), r.stderr);
r = node(fakeRepo({ cliEntry: false }), "check-deps.mjs");
check("partial CLI install (missing entry point): exits 1", r.status === 1 && /partial install/.test(r.stderr), r.stderr);
r = node(fakeRepo({ pdfjs: false }), "check-deps.mjs");
check("missing pdfjs-dist: exits 1 by default", r.status === 1 && /pdfjs-dist is not installed/.test(r.stderr), r.stderr);
r = node(fakeRepo({ pdfjs: false }), "check-deps.mjs", [], { OMNIDECK_ALLOW_NO_PDFJS: "1" });
check("missing pdfjs-dist: explicit dev opt-out allows it", r.status === 0, r.stderr);
r = node(fakeRepo({ pdfjs: false }), "check-deps.mjs", ["--strict"], { OMNIDECK_ALLOW_NO_PDFJS: "1" });
check("missing pdfjs-dist: opt-out is ignored in --strict (release) mode", r.status === 1, r.stderr);
r = node(fakeRepo(), "check-deps.mjs", ["--strict"]);
check("complete install passes --strict", r.status === 0, r.stderr);

const ok = fakeRepo();
r = node(ok, "run-tauri.mjs", ["dev", "--flag"]);
check("run-tauri launches the local CLI with Node (no PATH needed), forwards args, and propagates its exit code", r.status === 7 && /ARGS:dev --flag/.test(r.stdout), r.stdout + r.stderr);
r = node(fakeRepo({ cli: false, pdfjs: false }), "run-tauri.mjs", ["dev"]);
check("run-tauri with no CLI fails loudly (exit 1) instead of skipping", r.status === 1 && /npm ci/.test(r.stderr), r.stderr);

finish();
