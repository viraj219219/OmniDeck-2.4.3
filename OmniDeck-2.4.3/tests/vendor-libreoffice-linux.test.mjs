// Behavioural test of scripts/vendor-libreoffice-linux.sh against a LOCAL fixture
// server (OMNIDECK_LO_BASE_URL) and a fake "official" .deb tarball whose launcher
// delegates real conversions to the system LibreOffice. This proves the script's
// control flow: pin policy, download, extraction filtering, ELF/ldd/version/smoke
// validation, staging and rollback. It does NOT prove anything about the real
// official LibreOffice download (that is verified only on the CI runner).
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, skip, which, run, state } from "./helpers/harness.mjs";
import { startRangeServer } from "./helpers/rangeServer.mjs";
import { buildLinuxTarball, launcher, sha256 } from "./helpers/vendorFixtures.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const script = join(root, "scripts/vendor-libreoffice-linux.sh");
const src = readFileSync(script, "utf8");
const common = readFileSync(join(root, "scripts/lib/vendor-common.sh"), "utf8");

// ---- static guards (cheap, always run) ----
check("uses the official TDF download host", /download\.documentfoundation\.org\/libreoffice\/stable/.test(common));
check("maps x86_64 dir to the x86-64 archive filename", /x86_64\)\s+FILE_ARCH="x86-64"/.test(src));
check("maps aarch64 archive naming", /aarch64\) FILE_ARCH="aarch64"/.test(src));
check("extracts with dpkg-deb -x (never installs)", /dpkg-deb -x/.test(src) && !/dpkg -i|apt(-get)? install/.test(src.replace(/#.*$/gm, "")));
check("no unpinned sidecar-checksum fallback exists", !/\.sha256/.test(common.replace(/#.*$/gm, "")) && !/sidecar/.test(src));
check("OMNIDECK_LO_BASE_URL override is refused on GitHub Actions", /must not be set in GitHub Actions/.test(common));
check("pin discovery is refused on GitHub Actions", /OMNIDECK_PIN_DISCOVERY[\s\S]{0,120}GITHUB_ACTIONS/.test(common));

const sys = which("soffice");
if (process.platform !== "linux" || !which("dpkg-deb") || !which("curl") || !sys) {
  skip("Linux vendor behavioural tests", "needs Linux + dpkg-deb + curl + a system soffice");
} else {
  const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const fileArch = hostArch === "x86_64" ? "x86-64" : "aarch64";
  const mkDest = () => mkdtempSync(join(tmpdir(), "omnideck-dest-"));
  const baseEnv = (srv, tb, extra = {}) => ({
    OMNIDECK_LO_BASE_URL: srv.base, OMNIDECK_TEST_PINNED_SHA256: tb.sha, OMNIDECK_MIN_ARCHIVE_BYTES: "1000",
    OMNIDECK_VENDOR_CACHE: mkdtempSync(join(tmpdir(), "omnideck-cache-")), GITHUB_ACTIONS: "", ...extra });
  const serve = (tb) => startRangeServer({ [`/26.8.0/deb/${hostArch}/${tb.name}`]: tb.body });
  const exec = (dest, env) => run("bash", [script, hostArch, dest], { env, timeoutMs: 300000 });
  const mk = (o = {}) => buildLinuxTarball({ arch: fileArch, sofficeScript: launcher({ realSoffice: sys, ...(o.l || {}) }), ...(o.t || {}) });
  const noLeftovers = (d) => !readdirSync(join(d, "..")).some((n) => n.startsWith("libreoffice-staging-"));

  // 1. no pin => refuse (the policy), nothing produced
  { const tb = mk(), srv = await serve(tb), dest = join(mkDest(), "lo");
    const r = await exec(dest, { ...baseEnv(srv, tb), OMNIDECK_TEST_PINNED_SHA256: "" });
    check("unpinned download is refused (non-zero exit)", r.status !== 0 && /no pinned SHA-256/.test(r.all), r.all);
    check("unpinned download produces no bundle", !existsSync(dest));
    await srv.close(); }

  // 2. pin discovery prints the hash, exits 3, produces no bundle
  { const tb = mk(), srv = await serve(tb), dest = join(mkDest(), "lo");
    const r = await exec(dest, { ...baseEnv(srv, tb), OMNIDECK_TEST_PINNED_SHA256: "", OMNIDECK_PIN_DISCOVERY: "1" });
    check("pin discovery exits 3 and prints the computed hash", r.status === 3 && r.all.includes(tb.sha), `exit=${r.status}\n${r.all}`);
    check("pin discovery never creates a bundle", !existsSync(dest));
    await srv.close(); }

  // 3. wrong pin => fail twice, no bundle
  { const tb = mk(), srv = await serve(tb), dest = join(mkDest(), "lo");
    const r = await exec(dest, { ...baseEnv(srv, tb), OMNIDECK_TEST_PINNED_SHA256: "0".repeat(64) });
    check("wrong pin is rejected", r.status !== 0 && /SHA-256 mismatch twice/.test(r.all), r.all);
    check("wrong pin produces no bundle", !existsSync(dest));
    await srv.close(); }

  // 4. happy path: real conversion through the staged runtime
  { const tb = mk(), srv = await serve(tb), dest = join(mkDest(), "lo");
    const r = await exec(dest, baseEnv(srv, tb));
    check("pinned happy path exits 0", r.status === 0, r.all);
    check("real smoke conversion ran (3 pages)", /Smoke conversion OK: three-slides\.pptx -> PDF with 3 pages/.test(r.all), r.all);
    check("launcher + soffice.bin staged under opt/", existsSync(join(dest, "opt/libreoffice26.8/program/soffice.bin")));
    check("language packs / menus / integration are skipped", !existsSync(join(dest, "opt/libreoffice26.8/share/l10n-de-marker.txt")) && !existsSync(join(dest, "usr")) && !existsSync(join(dest, "opt/libreoffice26.8/share/gnome-marker.txt")));
    check("impress package is kept", existsSync(join(dest, "opt/libreoffice26.8/share/impress-marker.txt")));
    check("provenance file records the pinned archive hash", readFileSync(join(dest, "OMNIDECK-LIBREOFFICE.txt"), "utf8").includes(`archive_sha256=${tb.sha}`));
    check("no staging/backup directories left behind", noLeftovers(dest) && !readdirSync(join(dest, "..")).some((n) => n.startsWith("libreoffice-backup-")));
    // 4b. an earlier good bundle survives a later failing run
    const tb2 = mk({ l: { versionExit: 1 } }), srv2 = await serve(tb2);
    const r2 = await exec(dest, baseEnv(srv2, tb2));
    check("failing --version exits non-zero", r2.status !== 0 && /soffice --version failed/.test(r2.all), r2.all);
    check("previous good bundle is untouched by a failed run", existsSync(join(dest, "opt/libreoffice26.8/program/soffice.bin")));
    await srv.close(); await srv2.close(); }

  // 5. validation failures: each must fail closed and create nothing
  const failing = [
    ["wrong version string", { l: { version: "LibreOffice 7.1.0.0 fixture" } }, /expected/],
    ["conversion that exits 0 but writes no PDF", { l: { convert: "empty" } }, /smoke conversion failed/],
    ["conversion that fails", { l: { convert: "fail" } }, /smoke conversion failed/],
    ["missing soffice.bin", { t: { withSofficeBin: false } }, /no soffice\.bin/],
    ["soffice.bin that is not an ELF of the right architecture", { t: { sofficeBinIsElf: false } }, /not an ELF binary/],
  ];
  for (const [name, o, re] of failing) {
    const tb = mk(o), srv = await serve(tb), dest = join(mkDest(), "lo");
    const r = await exec(dest, baseEnv(srv, tb));
    check(`rejects ${name}`, r.status !== 0 && re.test(r.all), `exit=${r.status}\n${r.all.slice(-600)}`);
    check(`rejects ${name}: no bundle created`, !existsSync(dest));
    await srv.close();
  }

  // 6. target arch must equal host arch (validation executes the runtime)
  { const other = hostArch === "x86_64" ? "aarch64" : "x86_64";
    const r = await run("bash", [script, other, join(mkDest(), "lo")], { env: { OMNIDECK_VENDOR_CACHE: mkdtempSync(join(tmpdir(), "c-")) } });
    check("cross-architecture vendoring is refused", r.status !== 0 && /native runner/.test(r.all), r.all); }

  // 7. ldd must genuinely fail when a required shared library is missing
  if (which("gcc")) {
    const { mkdtempSync: mt } = await import("node:fs"); const { spawnSync } = await import("node:child_process");
    const d = mt(join(tmpdir(), "omnideck-elf-"));
    writeFileSync(join(d, "f.c"), "int fakefn(void){return 1;}\n"); writeFileSync(join(d, "m.c"), "int fakefn(void); int main(){return fakefn();}\n");
    const ok = spawnSync("sh", ["-c", `cd ${d} && gcc -shared -fPIC -o libomnifake.so f.c && gcc -o m m.c -L. -lomnifake && rm libomnifake.so`]).status === 0;
    const tb = mk({ t: { sofficeBinPath: join(d, "m") } }), srv = await serve(tb), dest = join(mkDest(), "lo");
    const r = ok ? await exec(dest, baseEnv(srv, tb)) : { status: 0, all: "" };
    check("missing shared library makes vendoring fail", ok && r.status !== 0 && /libomnifake\.so/.test(r.all) && /system libraries that are not installed/.test(r.all), r.all.slice(-500));
    check("missing shared library: no bundle created", !existsSync(dest));
    await srv.close();
  } else skip("missing-library ldd test", "gcc not available");
}
console.log(`\n${state.failures} failure(s), ${state.skipped} skipped`);
process.exit(state.failures ? 1 : 0);
