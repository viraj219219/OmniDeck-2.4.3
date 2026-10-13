// Single definition of the pdf.js files a production build must contain.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

// [file, minimum plausible size]. An empty/truncated file is as bad as a missing one.
export const REQUIRED = [["pdf.mjs", 100_000], ["pdf.worker.mjs", 500_000]];

export function verifyVendored(dir) {
  const problems = [];
  for (const [name, minBytes] of REQUIRED) {
    const p = join(dir, name);
    if (!existsSync(p)) problems.push(`${name} is missing`);
    else if (statSync(p).size < minBytes) problems.push(`${name} is too small (${statSync(p).size} bytes < ${minBytes}); truncated copy?`);
  }
  return problems;
}
