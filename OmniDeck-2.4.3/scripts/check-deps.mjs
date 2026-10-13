#!/usr/bin/env node
// Preflight: fail fast, with an actionable message, when `npm ci` has not been run.
//
// ROOT CAUSE of "'tauri' is not recognized as an internal or external command":
// the npm scripts call the local @tauri-apps/cli binary, which npm only exposes on
// PATH from node_modules/.bin. With no node_modules (fresh unzip / copied folder /
// failed install) there is no binary, so the shell reports "not recognized". The
// same missing install is why vendor-pdfjs reported "node_modules/pdfjs-dist not found".
//
//   node scripts/check-deps.mjs            check what `npm run dev` needs
//   node scripts/check-deps.mjs --strict   also require pdfjs-dist (release builds)
//
// Exit codes: 0 ok, 1 missing/incomplete dependencies.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.OMNIDECK_REPO_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict") || process.env.CI === "true" || process.env.OMNIDECK_REQUIRE_PDFJS === "1";
const allowNoPdfjs = process.env.OMNIDECK_ALLOW_NO_PDFJS === "1" && !strict;
const nm = join(root, "node_modules");
const problems = [];

if (!existsSync(nm)) {
  problems.push("node_modules/ does not exist: dependencies have not been installed.");
} else {
  const cliPkg = join(nm, "@tauri-apps", "cli", "package.json");
  if (!existsSync(cliPkg)) problems.push("@tauri-apps/cli is not installed (needed for `tauri dev` / `tauri build`).");
  else {
    const bin = JSON.parse(readFileSync(cliPkg, "utf8")).bin;
    const rel = typeof bin === "string" ? bin : bin && bin.tauri;
    if (!rel || !existsSync(join(nm, "@tauri-apps", "cli", rel))) problems.push("@tauri-apps/cli is installed but its `tauri` entry point is missing (partial install).");
  }
  if (!existsSync(join(nm, "pdfjs-dist", "package.json")) && !allowNoPdfjs) {
    problems.push("pdfjs-dist is not installed (PDF/PowerPoint import needs it" + (strict ? "; release builds require it" : "; set OMNIDECK_ALLOW_NO_PDFJS=1 to run dev without it") + ").");
  }
}

if (problems.length) {
  console.error("[OmniDeck] Dependency check FAILED:\n  - " + problems.join("\n  - "));
  console.error(`\nFix: open a terminal in\n  ${root}\nand run:\n  npm ci\n(needs network access once; if it fails, check Node >= 18 with \`node -v\` and your proxy/firewall).\nThen re-run your command. A global Tauri CLI is NOT required.`);
  process.exit(1);
}
console.log("[OmniDeck] Dependency check OK (local Tauri CLI" + (allowNoPdfjs ? "" : " and pdfjs-dist") + " installed).");
