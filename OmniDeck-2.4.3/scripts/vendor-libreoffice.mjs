import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const dest = join(root, "src-tauri", "resources", "libreoffice");

function bundledExists() {
  if (process.platform === "win32") {
    // soffice.exe is a GUI-subsystem launcher and may return exit code 1 with
    // no useful console output. Probe the console wrapper used by the vendor
    // validation instead, so a complete bundle is reused on subsequent runs.
    const exe = join(dest, "program", "soffice.com");
    if (!existsSync(exe)) return false;
    // Do not trust a stale/partial file left by an interrupted previous build.
    const probe = spawnSync(exe, ["--version"], { encoding: "utf8", windowsHide: true });
    return probe.status === 0;
  }
  if (process.platform === "linux") return existsSync(join(dest, "opt")) &&
    !!spawnSync("find", [join(dest, "opt"), "-type", "f", "-name", "soffice"], { encoding: "utf8" }).stdout.trim();
  if (process.platform === "darwin") {
    const exe = join(dest, "LibreOffice.app", "Contents", "MacOS", "soffice");
    if (!existsSync(exe)) return false;
    const probe = spawnSync(exe, ["--version"], { encoding: "utf8" });
    return probe.status === 0;
  }
  return false;
}

if (bundledExists()) {
  console.log("[OmniDeck] Bundled LibreOffice renderer already present.");
  process.exit(0);
}

if (process.platform === "win32") {
  console.log("[OmniDeck] LibreOffice renderer is missing. Downloading the self-contained development copy...");
  const r = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    join(root, "scripts", "vendor-libreoffice-windows.ps1"),
    "-Destination", "src-tauri/resources/libreoffice"
  ], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

if (process.platform === "darwin") {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  console.log(`[OmniDeck] LibreOffice renderer is missing. Downloading the self-contained macOS ${arch} development copy...`);
  const r = spawnSync("bash", [
    join(root, "scripts", "vendor-libreoffice-macos.sh"), arch,
    "src-tauri/resources/libreoffice"
  ], { stdio: "inherit", env: { ...process.env, LIBREOFFICE_VERSION: process.env.LIBREOFFICE_VERSION || "26.8.0" } });
  process.exit(r.status ?? 1);
}

if (process.platform === "linux") {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  console.log(`[OmniDeck] LibreOffice renderer is missing. Downloading the self-contained ${arch} development copy...`);
  const r = spawnSync("bash", [
    join(root, "scripts", "vendor-libreoffice-linux.sh"), arch,
    "src-tauri/resources/libreoffice"
  ], { stdio: "inherit", env: { ...process.env, LIBREOFFICE_VERSION: process.env.LIBREOFFICE_VERSION || "26.8.0" } });
  process.exit(r.status ?? 1);
}

console.log("[OmniDeck] Automatic local vendoring is implemented for Windows, Linux, and macOS.");
