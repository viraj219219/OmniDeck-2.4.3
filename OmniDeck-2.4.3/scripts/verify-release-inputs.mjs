#!/usr/bin/env node
// Release gate: refuses to let `tauri build` package an app that is missing a
// runtime it claims to ship. Run it AFTER vendoring and BEFORE building.
//
//   node scripts/verify-release-inputs.mjs [--platform=linux|windows|macos]
//        [--arch=x86_64|aarch64] [--require-updater]
//
// Checks (each failure is listed; exit 1 if any):
//   * vendored pdf.js files exist and are plausibly sized
//   * the bundled LibreOffice runtime exists in the layout util.rs searches,
//     its provenance file matches scripts/libreoffice-version.txt and the
//     requested platform/arch, and records a 64-hex archive checksum
//   * version metadata agrees across package.json / Cargo.toml / tauri.conf.json
//   * (--require-updater) updater signing inputs are present
//
// This is a static check of the INPUTS. It does not prove an installer works;
// the packaged-artifact checks in CI (scripts/verify-linux-package.sh etc.) do that.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVendored } from "./lib/pdfjs-required.mjs";

const root = process.env.OMNIDECK_REPO_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1];
const platform = arg("platform") || ({ win32: "windows", darwin: "macos" }[process.platform] || "linux");
const arch = arg("arch") || (process.arch === "arm64" ? "aarch64" : "x86_64");
const requireUpdater = process.argv.includes("--require-updater");
const problems = [];
const fail = (m) => problems.push(m);

// ---- pdf.js ----
for (const p of verifyVendored(join(root, "src/js/vendor/pdfjs"))) fail(`pdf.js: ${p} (run: node scripts/vendor-pdfjs.mjs --strict)`);

// ---- LibreOffice ----
const lo = join(root, "src-tauri/resources/libreoffice");
const expectedVersion = readFileSync(join(root, "scripts/libreoffice-version.txt"), "utf8").trim();
const isFile = (p) => existsSync(p) && statSync(p).isFile();
const soffice = {
  windows: () => isFile(join(lo, "program/soffice.exe")),
  macos: () => isFile(join(lo, "LibreOffice.app/Contents/MacOS/soffice")),
  linux: () => {
    const opt = join(lo, "opt");
    if (!existsSync(opt)) return false;
    return readdirSync(opt).some((d) => d.startsWith("libreoffice") && isFile(join(opt, d, "program/soffice")) && isFile(join(opt, d, "program/soffice.bin")));
  },
}[platform];
if (!soffice) fail(`unknown platform "${platform}"`);
else if (!soffice()) fail(`LibreOffice runtime for ${platform} is missing or incomplete in src-tauri/resources/libreoffice (vendor it first: npm run vendor:libreoffice)`);
const prov = join(lo, "OMNIDECK-LIBREOFFICE.txt");
if (!isFile(prov)) fail("LibreOffice provenance file OMNIDECK-LIBREOFFICE.txt is missing (the runtime was not produced by the vendoring scripts)");
else {
  const kv = Object.fromEntries(readFileSync(prov, "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  if (kv.libreoffice_version !== expectedVersion) fail(`LibreOffice version mismatch: bundled ${kv.libreoffice_version}, expected ${expectedVersion} (scripts/libreoffice-version.txt)`);
  const wantPlatform = platform === "windows" ? "windows-x86_64" : `${platform}-${arch}`;
  if (kv.platform !== wantPlatform) fail(`LibreOffice runtime is for ${kv.platform}, this build needs ${wantPlatform}`);
  if (!/^[0-9a-f]{64}$/.test(kv.archive_sha256 || "")) fail("LibreOffice provenance has no valid archive_sha256");
}

// ---- version agreement ----
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
const cargo = (readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
if (new Set([pkg, tauri, cargo]).size !== 1) fail(`version mismatch: package.json=${pkg} tauri.conf.json=${tauri} Cargo.toml=${cargo}`);
const tag = process.env.GITHUB_REF_NAME;
if (process.env.GITHUB_REF_TYPE === "tag" && tag !== `v${pkg}`) fail(`release tag ${tag} does not match the app version v${pkg}`);

// ---- updater inputs ----
if (requireUpdater) {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) fail("TAURI_SIGNING_PRIVATE_KEY is not set: updater artifacts cannot be signed");
  const pub = process.env.TAURI_UPDATER_PUBKEY || "";
  if (pub.length < 40) fail("TAURI_UPDATER_PUBKEY (repository variable) is missing or too short");
}

if (problems.length) {
  console.error(`RELEASE INPUT CHECK FAILED (${platform}-${arch}):\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`Release inputs OK for ${platform}-${arch}: pdf.js vendored, LibreOffice ${expectedVersion} present and matching, versions agree at ${pkg}.`);
