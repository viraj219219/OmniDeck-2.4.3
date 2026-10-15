#!/usr/bin/env node
// Integrity gate for a draft release BEFORE it is published:
//   node scripts/verify-release-assets.mjs --latest latest.json --assets assets.txt --version 2.4.3
// assets.txt = one release asset file name per line.
// Fails unless latest.json covers every officially supported platform, every entry has a
// non-empty signature and an https URL that points at an asset really attached to the release,
// and the version matches the app version. A release that fails this must not be published,
// because the updater would serve users a broken or unverifiable update.
import { readFileSync } from "node:fs";

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const latest = JSON.parse(readFileSync(arg("latest"), "utf8"));
const assets = new Set(readFileSync(arg("assets"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
const assetMapPath = arg("asset-map");
const assetIds = new Map();
if (assetMapPath) {
  for (const line of readFileSync(assetMapPath, "utf8").split(/\r?\n/)) {
    const [rawId, ...parts] = line.split("\\t");
    const id = rawId?.trim();
    const name = parts.join("\\t").trim();
    if (/^\\d+$/.test(id || "") && name) assetIds.set(id, name);
  }
}
const version = arg("version");
export const REQUIRED_PLATFORMS = ["linux-x86_64", "linux-aarch64", "windows-x86_64", "darwin-x86_64", "darwin-aarch64"];

const problems = [];
if (latest.version?.replace(/^v/, "") !== version) problems.push(`latest.json version "${latest.version}" != app version ${version}`);
for (const key of REQUIRED_PLATFORMS) {
  // tauri-action may emit "<platform>-<bundle>" keys (e.g. linux-x86_64-appimage) next to the plain one
  const entry = latest.platforms?.[key];
  if (!entry) { problems.push(`latest.json has no entry for ${key}`); continue; }
  if (!entry.signature || entry.signature.length < 40) problems.push(`${key}: missing/short signature`);
  let url; try { url = new URL(entry.url); } catch { problems.push(`${key}: invalid url`); continue; }
  if (url.protocol !== "https:") problems.push(`${key}: url is not https`);
  const assetApi = url.pathname.match(/^\\/repos\\/[^/]+\\/[^/]+\\/releases\\/assets\\/(\\d+)\\/?$/);
  let file;
  if (assetApi) {
    if (url.hostname !== "api.github.com") { problems.push(`${key}: release asset API URL is not api.github.com`); continue; }
    file = assetIds.get(assetApi[1]);
    if (!file) { problems.push(`${key}: release asset ID "${assetApi[1]}" is not attached or missing from --asset-map`); continue; }
  } else {
    file = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
  }
  if (!assets.has(file)) problems.push(`${key}: url points at "${file}" which is not attached to the release`);
  if (!assets.has(`${file}.sig`)) problems.push(`${key}: "${file}.sig" is not attached to the release`);
}
if (problems.length) { console.error("RELEASE ASSET CHECK FAILED:\n  - " + problems.join("\n  - ")); process.exit(1); }
console.log(`latest.json OK: ${REQUIRED_PLATFORMS.length} platforms, signed, URLs match attached assets, version ${version}.`);
