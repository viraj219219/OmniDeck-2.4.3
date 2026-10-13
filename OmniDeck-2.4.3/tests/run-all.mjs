// Lightweight test runner: discovers every tests/*.test.mjs file and runs
// each in its own child process (so one file's globals/mocks — e.g. the
// fetch() shim in bible-service.test.mjs — never leak into another file),
// then aggregates exit codes. Intentionally not a full framework: the
// project's actual tests are small functional smoke tests, and `node
// --test` support for this style of standalone script is unnecessary
// weight here.
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const testsDir = dirname(fileURLToPath(import.meta.url));

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const entries = (await readdir(testsDir)).filter((f) => f.endsWith(".test.mjs")).sort();

if (entries.length === 0) {
  console.log("No test files found (tests/*.test.mjs).");
  process.exit(1);
}

let failures = 0;
for (const entry of entries) {
  console.log(`\n--- ${entry} ---`);
  const code = await run(join(testsDir, entry));
  if (code !== 0) failures++;
}

console.log(`\n${entries.length - failures}/${entries.length} test files passed.`);
process.exit(failures === 0 ? 0 : 1);
