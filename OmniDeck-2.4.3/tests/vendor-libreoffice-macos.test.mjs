// Static regression guard for the macOS LibreOffice vendoring path.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const script = readFileSync(join(root, "scripts/vendor-libreoffice-macos.sh"), "utf8");
const common = readFileSync(join(root, "scripts/lib/vendor-common.sh"), "utf8");
const wrapper = readFileSync(join(root, "scripts/vendor-libreoffice.mjs"), "utf8");
const util = readFileSync(join(root, "src-tauri/src/util.rs"), "utf8");

const checks = [
  ["uses official LibreOffice download host", /download\.documentfoundation\.org\/libreoffice\/stable/, common],
  ["supports Apple Silicon and Intel", /aarch64/.test(script) && /x86_64/.test(script), true],
  ["downloads resumably with retries", /curl[^\n]*--retry 3[\s\S]{0,200}-C -/, common],
  ["rejects suspiciously small downloads", /100000000/, script],
  ["no unpinned sidecar-checksum fallback", !/sidecar/.test(script) && !/sidecar/.test(common), true],
  ["refuses an unpinned download unless in discovery mode", /no pinned SHA-256 for this download/.test(common) && /OMNIDECK_PIN_DISCOVERY/.test(common), true],
  ["requires a native runner of the same architecture", /vendor each architecture on its native runner/.test(script), true],
  ["checks Gatekeeper/notarization (spctl)", /spctl --assess/.test(script), true],
  ["checks Mach-O architecture with lipo", /lipo -archs/.test(script), true],
  ["runs a real conversion before swapping", /vo_smoke_convert/.test(script) && /vo_swap/.test(script), true],
  ["validates the official app signature", /codesign --verify --deep --strict/, script],
  ["preserves the complete app bundle", /ditto "\$APP" "\$STAGE\/LibreOffice\.app"/, script],
  ["validates staged soffice", /Contents\/MacOS\/soffice/.test(script) && /--version/.test(script), true],
  ["uses macOS wrapper branch", /process\.platform === "darwin"/, wrapper],
  ["workflow builds per-arch macOS (no universal build)", !/universal-apple-darwin/.test(readFileSync(join(root, ".github/workflows/build.yml"), "utf8").replace(/#.*$/gm, "")), true],
  ["resolves bundled macOS app path", /LibreOffice\.app\/Contents\/MacOS\/soffice/, util],
];
let failures = 0;
for (const [name, test, source] of checks) {
  const ok = typeof test === "boolean" ? test : test.test(source);
  console.log(`${ok ? "OK" : "FAIL"} ${name}`);
  if (!ok) failures++;
}
process.exit(failures ? 1 : 0);
