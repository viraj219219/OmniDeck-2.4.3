#!/usr/bin/env node
// Writes src-tauri/tauri.updater.conf.json — the release-only Tauri config override that
// (a) turns on signed updater artifacts and (b) embeds the updater PUBLIC key + endpoint.
// Kept out of tauri.conf.json so dev/PR builds have no half-configured updater.
//
//   TAURI_UPDATER_PUBKEY=<contents of the .pub file>  GITHUB_REPOSITORY=owner/repo \
//     node scripts/write-updater-config.mjs [out.json]
//
// The PRIVATE key is never read or written here; it is only provided to the build via the
// TAURI_SIGNING_PRIVATE_KEY secret. Exit 1 if the public key or repository is missing/invalid.
import { writeFileSync } from "node:fs";

const pubkey = (process.env.TAURI_UPDATER_PUBKEY || "").trim();
const repo = (process.env.GITHUB_REPOSITORY || "").trim();
const out = process.argv[2] || "src-tauri/tauri.updater.conf.json";
const die = (m) => { console.error(`write-updater-config: ${m}`); process.exit(1); };

if (pubkey.length < 40) die("TAURI_UPDATER_PUBKEY is missing or too short. Set the repository VARIABLE to the contents of the .pub file made by `npx tauri signer generate`.");
if (/PRIVATE|untrusted comment: .*secret/i.test(pubkey)) die("TAURI_UPDATER_PUBKEY looks like a PRIVATE key. Refusing to write it into a config that ships to users.");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) die(`GITHUB_REPOSITORY "${repo}" is not owner/repo`);

const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: {
      pubkey,
      endpoints: [`https://github.com/${repo}/releases/latest/download/latest.json`],
      windows: { installMode: "passive" },
    },
  },
};
writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
console.log(`wrote ${out} (endpoint https://github.com/${repo}/releases/latest/download/latest.json)`);
