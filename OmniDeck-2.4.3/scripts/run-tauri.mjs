#!/usr/bin/env node
// Runs the LOCALLY installed Tauri CLI (node_modules/@tauri-apps/cli) with Node
// directly, so it works from Windows PowerShell/CMD, Linux and macOS shells
// without depending on PATH, .cmd shims, or a global `tauri`.
//   node scripts/run-tauri.mjs dev | build | <any tauri subcommand> [args...]
// Never silently skips: a missing CLI is an error with install instructions.
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.OMNIDECK_REPO_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "node_modules", "@tauri-apps", "cli");

export function resolveTauriEntry() {
  const pkgJson = join(pkgDir, "package.json");
  if (!existsSync(pkgJson)) return null;
  const bin = JSON.parse(readFileSync(pkgJson, "utf8")).bin;
  const rel = typeof bin === "string" ? bin : bin && bin.tauri;
  const entry = rel && join(pkgDir, rel);
  return entry && existsSync(entry) ? entry : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const entry = resolveTauriEntry();
  if (!entry) {
    console.error("[OmniDeck] The local Tauri CLI (@tauri-apps/cli) is not installed.\n" +
      `Run \`npm ci\` in ${root} (needs network once), then retry. A global Tauri CLI is not required.`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
  child.on("error", (e) => { console.error(`[OmniDeck] Could not start the Tauri CLI: ${e.message}`); process.exit(1); });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
