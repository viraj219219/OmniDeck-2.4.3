#!/usr/bin/env node
// Copies the pdf.js runtime from node_modules/pdfjs-dist (installed by `npm ci`)
// into src/js/vendor/pdfjs/, where PdfJsService.js imports it at runtime and
// where tauri.conf.json's frontendDist ("../src") picks it up for the bundle.
// This only moves files npm already downloaded; it never fetches anything.
//
// Modes
//   (default, development)  Missing pdfjs-dist => warn and exit 0. PdfJsService then
//                           reports "not available" and imports fall back to
//                           Rust/Poppler, so `npm run dev` never needs it.
//   --strict (or OMNIDECK_REQUIRE_PDFJS=1, or CI=true)   RELEASE BUILDS.
//                           Anything missing => clear error and exit 1. A release
//                           without pdf.js would silently re-introduce the Poppler
//                           system dependency for PowerPoint/PDF import, so it must
//                           not be produced.
//   --verify                Only check the already-vendored files (no copying).
//
// Exit codes: 0 ok, 1 strict failure / verification failure.

import { existsSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.OMNIDECK_REPO_ROOT || join(here, "..");
const pkgDir = join(repoRoot, "node_modules", "pdfjs-dist");
const destDir = join(repoRoot, "src", "js", "vendor", "pdfjs");
const args = new Set(process.argv.slice(2));
const strict = args.has("--strict") || args.has("--verify") || process.env.OMNIDECK_REQUIRE_PDFJS === "1" || process.env.CI === "true";

import { REQUIRED, verifyVendored as verifyIn } from "./lib/pdfjs-required.mjs";
const verifyVendored = (dir = destDir) => verifyIn(dir);

function fail(msg) {
  console.error(`[vendor-pdfjs] ERROR: ${msg}`);
  process.exit(1);
}

if (args.has("--verify")) {
  const problems = verifyVendored();
  if (problems.length) fail(`vendored pdf.js is incomplete in ${destDir}: ${problems.join("; ")}`);
  console.log(`[vendor-pdfjs] verified: ${REQUIRED.map(([n]) => n).join(", ")} present in ${destDir}`);
  process.exit(0);
}

if (!existsSync(pkgDir)) {
  const msg = "node_modules/pdfjs-dist not found. Run `npm ci` (needs network) first.";
  if (strict) fail(msg + " Release builds require the vendored pdf.js.");
  console.warn(`[vendor-pdfjs] ${msg} Skipping; PDF import falls back to the Rust/Poppler path.`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
for (const [src, dest] of [["build/pdf.mjs", "pdf.mjs"], ["build/pdf.worker.mjs", "pdf.worker.mjs"]]) {
  const srcPath = join(pkgDir, src);
  if (!existsSync(srcPath)) {
    const msg = `expected file missing: ${src} (pdfjs-dist's layout may have changed — check the installed version)`;
    if (strict) fail(msg);
    console.warn(`[vendor-pdfjs] ${msg}`);
    continue;
  }
  copyFileSync(srcPath, join(destDir, dest));
}

// Standard fonts + cmaps: needed for PDFs that don't embed fonts (CJK, older generators).
// Best effort in development; REQUIRED in strict mode because a release that silently
// mis-renders such PDFs is a regression.
for (const sub of ["standard_fonts", "cmaps"]) {
  const srcPath = join(pkgDir, sub);
  if (existsSync(srcPath)) cpSync(srcPath, join(destDir, sub), { recursive: true });
  else if (strict) fail(`pdfjs-dist/${sub} is missing`);
}

const problems = verifyVendored();
if (problems.length) {
  if (strict) fail(`vendored pdf.js is incomplete: ${problems.join("; ")}`);
  console.warn(`[vendor-pdfjs] vendored pdf.js with problems: ${problems.join("; ")}`);
} else {
  console.log(`[vendor-pdfjs] vendored pdf.js into ${destDir}`);
}
