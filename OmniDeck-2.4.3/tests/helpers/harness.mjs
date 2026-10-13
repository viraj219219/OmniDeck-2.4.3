// Shared bits for the native/script tests: counted checks, honest skips, and an
// async process runner. Child stdin is always closed (an open stdin pipe makes
// pwsh wait forever), and an in-process HTTP server needs the async runner
// (spawnSync would block the event loop that serves the child's requests).
import { spawn, spawnSync } from "node:child_process";

const REQUIRE_NATIVE = process.env.OMNIDECK_REQUIRE_NATIVE_TESTS === "1";
export const state = { failures: 0, skipped: 0 };

export function check(name, ok, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) { state.failures++; if (detail) console.log("     " + String(detail).split("\n").join("\n     ")); }
  return ok;
}

// A missing OS/tool is an honest SKIP locally, but a hard FAILURE where the
// runner is supposed to provide it (CI sets OMNIDECK_REQUIRE_NATIVE_TESTS=1).
export function skip(name, reason) {
  if (REQUIRE_NATIVE) { console.log(`FAIL ${name} - required but unavailable: ${reason}`); state.failures++; }
  else { console.log(`SKIP ${name} - ${reason}`); state.skipped++; }
}

export function which(cmd) {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function run(cmd, args, { env = {}, cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ status: code, signal, stdout: out, stderr: err, all: out + err }); });
  });
}

export function finish() {
  console.log(`\n${state.failures ? "FAILED" : "passed"}: ${state.failures} failure(s), ${state.skipped} skipped`);
  process.exit(state.failures ? 1 : 0);
}
