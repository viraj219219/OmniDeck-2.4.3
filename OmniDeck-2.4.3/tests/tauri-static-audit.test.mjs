// Static audit of the Tauri surface — the checks a JS-only test run can't do
// (no runtime here validates window.__TAURI__ calls). It cross-references:
//   frontend invoke("…") calls  <->  Rust #[tauri::command] + generate_handler!
//   frontend plugin calls       <->  capabilities/default.json permissions
//   frontend events             <->  events Rust emits
//   capability windows          <->  windows that exist
// and guards the persistence/deletion "safety layer" boundaries so a future
// change can't quietly bypass them. It does NOT replace `cargo check`/`cargo
// test` (run those too) or a real-hardware run.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker } from "./helpers/fakeDisk.mjs";

const { check, done } = makeChecker();
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
function walk(dir, out = []) {
  for (const f of readdirSync(join(root, dir))) {
    const rel = join(dir, f);
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(js|html)$/.test(f)) out.push(rel);
  }
  return out;
}
const jsFiles = walk("src").filter((f) => !f.includes("/data/"));
// Comments are stripped so prose that merely MENTIONS localStorage or
// beforeunload can't trip (or mask) the code-level checks below.
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const src = Object.fromEntries(jsFiles.map((f) => [f, stripComments(read(f))]));
const rust = read("src-tauri/src/main.rs");
const caps = JSON.parse(read("src-tauri/capabilities/default.json"));
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));

// ---- commands ------------------------------------------------------------------------------
const handlerBlock = /generate_handler!\[([\s\S]*?)\]/.exec(rust)[1];
const registered = new Set(handlerBlock.split(",").map((s) => s.trim()).filter(Boolean));
const invoked = new Set();
for (const text of Object.values(src)) for (const m of text.matchAll(/invoke\(\s*["']([a-z_]+)["']/g)) invoked.add(m[1]);
for (const name of invoked) check(`invoke("${name}") has a registered Rust command`, registered.has(name));
for (const name of registered) check(`registered command ${name} is a real #[tauri::command] fn`, new RegExp(`#\\[tauri::command(?:\\(async\\))?\\]\\s*(?:pub\\s+)?fn ${name}\\b`).test(rust));
for (const name of ["close_ack", "confirm_close", "cancel_close", "check_import_dependencies"]) check(`new command ${name} registered`, registered.has(name));

// ---- fs plugin permissions ---------------------------------------------------------------------
const kebab = (s) => s.replace(/([A-Z])/g, "-$1").toLowerCase();
const fsFns = new Set();
for (const text of Object.values(src)) {
  for (const m of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*(?:await\s+this\._fs\(\)|window\.__TAURI__\.fs)/g)) {
    for (const part of m[1].split(",")) { const n = part.trim().split(":")[0].trim(); if (n && n !== "BaseDirectory") fsFns.add(n); }
  }
}
const permById = new Map(caps.permissions.filter((p) => typeof p === "object").map((p) => [p.identifier, p]));
const plain = new Set(caps.permissions.filter((p) => typeof p === "string"));
for (const fn of fsFns) {
  const id = `fs:allow-${kebab(fn)}`;
  const perm = permById.get(id);
  check(`fs.${fn}() is used -> capability ${id} exists`, !!perm);
  const paths = (perm?.allow || []).map((a) => a.path);
  check(`${id} scope covers the app-data folder itself AND everything under it`, paths.includes("$APPLOCALDATA") && paths.includes("$APPLOCALDATA/**"));
}
check("atomic saves need rename: fs:allow-rename granted", permById.has("fs:allow-rename"));
check("atomic saves need write-text-file: granted", permById.has("fs:allow-write-text-file"));

// ---- dialog plugin ---------------------------------------------------------------------------------
const dialogFns = new Set();
for (const text of Object.values(src)) {
  for (const m of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*(?:await\s+this\._dialog\(\)|window\.__TAURI__\.dialog)/g)) for (const part of m[1].split(",")) dialogFns.add(part.trim());
  if (/tauri\.dialog\?*\.ask|dialog\?\.ask/.test(text)) dialogFns.add("ask");
}
for (const fn of dialogFns) if (fn) check(`dialog.${fn}() is used -> dialog:allow-${fn} granted`, plain.has(`dialog:allow-${fn}`) || plain.has("dialog:default"));
check("dialog:allow-save (backup export) and dialog:allow-ask (unsaved-changes prompt) explicitly granted", plain.has("dialog:allow-save") && plain.has("dialog:allow-ask"));

// ---- events ---------------------------------------------------------------------------------------------
check("core:default (event listen/emit) granted", plain.has("core:default"));
const emittedByRust = new Set([...rust.matchAll(/emit\(\s*"([^"]+)"/g)].map((m) => m[1]));
const listenedInJs = new Set();
for (const text of Object.values(src)) for (const m of text.matchAll(/listen\(\s*["']([^"']+)["']/g)) listenedInJs.add(m[1]);
check("the JS close handler listens for exactly the event Rust emits (app:close-requested)", emittedByRust.has("app:close-requested") && listenedInJs.has("app:close-requested"));

// ---- windows -------------------------------------------------------------------------------------------------
const confWindows = (conf.app?.windows || []).map((w) => w.label || "main");
const rustWindows = [...rust.matchAll(/WebviewWindowBuilder::new\([^,]+,\s*"([^"]+)"/g)].map((m) => m[1]);
for (const w of caps.windows) check(`capability window "${w}" exists (tauri.conf or created in Rust)`, confWindows.includes(w) || rustWindows.includes(w));
check("withGlobalTauri enabled (vanilla JS uses window.__TAURI__)", conf.app?.withGlobalTauri === true);
check("close interception only guards the main window", /window\.label\(\)\s*!=\s*"main"/.test(rust));

// ---- safety-layer boundaries (FINAL AUDIT as a regression guard) -----------------------------------------------
const filesMatching = (re) => jsFiles.filter((f) => re.test(src[f]));
const rel = (list) => list.map((f) => relative("src/js", f)).sort().join(", ");

check("no BroadcastChannel anywhere", filesMatching(/BroadcastChannel/).length === 0);
check("localStorage is used ONLY by the storage adapter's browser-preview backend", rel(filesMatching(/\b(?:localStorage|sessionStorage)\s*[.\[]|\.(?:localStorage|sessionStorage)\b/)) === "utils/storageAdapter.js");
check("writeTextFile( appears only in the atomic storage layer", rel(filesMatching(/writeTextFile\(/)) === "utils/storageAdapter.js");
check("user-picked-path binary export (writeFile on a dialog path) lives only in the size-verified lesson exporter", /await writeFile\(path, bytes\);[\s\S]{0,200}stat\(path\)[\s\S]{0,200}wasn't written completely/.test(src["src/js/views/lessonTransfer.js"]) && !filesMatching(/\bwriteFile\(path\b/).some((f) => !/views\/lessonTransfer\.js$/.test(f)));
check("JSON persistence (writeJSON/writeJSONStrict) is only called by services", filesMatching(/writeJSON(Strict)?\(/).every((f) => /services\/|utils\/storageAdapter/.test(f)));
check("physical delete (remove/unlink) happens only in storage adapter + MediaService", rel(filesMatching(/\bunlink\(|await remove\(|\bremove\(\s*[a-zA-Z.]+\s*,\s*\{\s*baseDir/)) === "services/MediaService.js, utils/storageAdapter.js");
check("no unlink anywhere", filesMatching(/\bunlink\(/).length === 0);
const removeMediaCallers = jsFiles.filter((f) => /\.removeMedia\(/.test(src[f]));
check("removeMedia is only called from the reference-safe paths (MediaLifecycle, ImportService rollback, Media Library view)", rel(removeMediaCallers) === "services/ImportService.js, services/MediaLifecycle.js, views/media.js");
check("the Media Library has no 'Remove Anyway' override any more", !/Remove Anyway/.test(src["src/js/views/media.js"]));
check("beforeunload is only a webview guard in app.js (real close uses the native handshake)", rel(filesMatching(/beforeunload/)) === "app.js");
check("MediaService.removeMedia checks references before deleting", /async removeMedia\(id\)[\s\S]*?await this\._assertDeletable\(id\)/.test(src["src/js/services/MediaService.js"]));

// ---- UI stacking guard: toasts must render ABOVE Present Mode -------------------------------------------------------
const cssZ = (file, selector) => { const m = new RegExp(selector.replace(/[.]/g, "\\.") + "\\s*\\{[^}]*?z-index:\\s*(\\d+)", "s").exec(read(file)); return m ? Number(m[1]) : null; };
const toastZ = cssZ("src/styles/components.css", ".toast-root");
const presentZ = cssZ("src/styles/present.css", ".present-root");
check("toasts stack above Present Mode (otherwise every message shown while presenting is invisible)", toastZ !== null && presentZ !== null && toastZ > presentZ);

done();
