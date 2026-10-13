// Runs `node --check` against every .js file under src/, so a syntax error
// anywhere in the frontend (not just app.js) fails `npm run check`.
import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

async function collectJsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectJsFiles(full)));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = await collectJsFiles(root);
let failures = 0;
for (const file of files) {
  try {
    await execFileAsync(process.execPath, ["--check", file]);
    console.log(`OK    ${file}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${file}`);
    console.error(err.stderr || err.message);
  }
}

console.log(`\n${files.length - failures}/${files.length} files OK.`);
process.exit(failures === 0 ? 0 : 1);
