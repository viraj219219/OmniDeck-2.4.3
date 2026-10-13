// Shared plumbing for the real-runtime E2E scripts (see run-linux-e2e.sh). Nothing in the app is mocked
// except ONE thing that can't be automated: the native GTK file-picker
// (dialog.open) is replaced by a function returning a prepared path.
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeChecker } from "../helpers/fakeDisk.mjs";

export const { check, done } = makeChecker();
export const DATA_HOME = process.env.E2E_DATA_HOME;
export const BIN = process.env.E2E_BIN;
export const OUT = process.env.E2E_OUT;
export const DATA = join(DATA_HOME, "org.omnideck.app");
export const FIX = join(process.cwd(), "src-tauri", "test-fixtures");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8", env: process.env }).trim(); } catch (e) { return ""; } };
// pgrep -x matches the exact process name; `pgrep -f` would also match the shell running pgrep itself.
export const isRunning = () => sh("pgrep -x omnideck") !== "";

// ---- WebDriver plumbing --------------------------------------------------------------
const PORT = 4444;
let driver = null;
export async function startDriver() {
  driver = spawn(`${process.env.HOME}/.cargo/bin/tauri-driver`, ["--port", String(PORT)], { env: { ...process.env, XDG_DATA_HOME: DATA_HOME }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/status`); if (r.ok) return; } catch {} await sleep(200); }
  throw new Error("tauri-driver did not start");
}
export const stopDriver = () => { try { driver?.kill(); } catch {} };
export async function wd(method, path, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok || j.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(j.value).slice(0, 400)}`);
  return j.value;
}
let sid = null;
export async function newSession() {
  const v = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: BIN } } } });
  sid = v.sessionId;
  await wd("POST", `/session/${sid}/timeouts`, { script: 180000 });
  for (let i = 0; i < 60; i++) {
    const ok = await page(`return !!document.querySelector("#app-shell") && !!window.__TAURI__`).catch(() => false);
    if (ok) { await sleep(4000); return; }   // let start-up finish (lessons load, close-handler listener registers)
    await sleep(500);
  }
  throw new Error("app shell never appeared");
}
// Runs an async function body inside the real webview; returns its JSON value or throws its error.
export async function page(body, args = []) {
  const script = `const done = arguments[arguments.length - 1];
    const M = (p) => import(new URL(p, document.baseURI).href);
    (async () => { ${body} })().then((v) => done({ ok: true, v }), (e) => done({ ok: false, e: String((e && e.stack) || e), name: e && e.name, stage: e && e.stage, code: e && e.code, message: e && e.message }));`;
  const r = await wd("POST", `/session/${sid}/execute/async`, { script, args });
  if (!r.ok) { const err = new Error(r.message || r.e); err.name = r.name; err.stage = r.stage; err.code = r.code; throw err; }
  return r.v;
}
export async function screenshot(name) { sh(`import -window root ${OUT}/${name}.png`); }
export const dirList = (d) => (existsSync(d) ? readdirSync(d).sort() : []);
export const readJson = (f) => JSON.parse(readFileSync(join(DATA, f), "utf8"));
export const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

