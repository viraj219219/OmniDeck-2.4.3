// Release configuration & gate tests. These are STATIC/behavioural checks of config and scripts.
// They do not prove that an installer works on Windows/macOS (only the native CI jobs do).
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { check, skip, which, run, state } from "./helpers/harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));
const strip = (s) => s.replace(/^\s*#.*$/gm, "");
const tmp = (t) => mkdtempSync(join(tmpdir(), `omnideck-${t}-`));

// ---------- 1. versions ----------
const pkgV = json("package.json").version;
const lock = json("package-lock.json");
const cargoV = read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)[1];
const cargoLockV = read("src-tauri/Cargo.lock").match(/name = "omnideck"\nversion = "([^"]+)"/)[1];
const tauriV = json("src-tauri/tauri.conf.json").version;
const svcV = read("src/js/services/LessonPackageService.js").match(/PACKAGE_APP_VERSION = "([^"]+)"/)[1];
check(`all app versions agree (${pkgV})`, [lock.version, lock.packages[""].version, cargoV, cargoLockV, tauriV, svcV].every((v) => v === pkgV));
check("version is the intended 2.4.3 (OmniDeck 2.4.3)", pkgV === "2.4.3");

// ---------- 2. LibreOffice version: single source of truth ----------
const loV = read("scripts/libreoffice-version.txt").trim();
check("libreoffice-version.txt is a plain x.y.z", /^\d+\.\d+\.\d+$/.test(loV));
const sh = (f) => read(f).match(/LIBREOFFICE_VERSION:-([0-9.]+)/)?.[1];
check("linux/macOS scripts default to the pinned version", sh("scripts/vendor-libreoffice-linux.sh") === loV && sh("scripts/vendor-libreoffice-macos.sh") === loV);
check("npm wrapper defaults to the pinned version", [...read("scripts/vendor-libreoffice.mjs").matchAll(/\|\| "([0-9.]+)"/g)].every((m) => m[1] === loV));
check("Windows script default + pin entry use the pinned version", new RegExp(`\\[string\\]\\$Version = "${loV.replace(/\./g, "\\.")}"`).test(read("scripts/vendor-libreoffice-windows.ps1")) && read("scripts/vendor-libreoffice-windows.ps1").includes(`"${loV}" = "`));
const wf = read("../.github/workflows/build.yml");
check("workflow reads the version from the file (no literal LibreOffice version in the workflow)", /libreoffice-version\.txt/.test(wf) && !/24\.8\.4/.test(wf) && !/LIBREOFFICE_VERSION:\s*"/.test(wf));

// ---------- 3. lockfile integrity (offline stand-in for `npm ci`) ----------
{
  const pk = lock.packages, rootDeps = { ...pk[""].dependencies, ...pk[""].devDependencies };
  const pj = json("package.json"), want = { ...pj.dependencies, ...pj.devDependencies };
  check("lockfile root dependencies equal package.json (npm ci precondition)", JSON.stringify(rootDeps) === JSON.stringify(want));
  check("pdfjs-dist is locked with version, resolved URL and integrity", !!pk["node_modules/pdfjs-dist"]?.integrity && /pdfjs-dist-\d/.test(pk["node_modules/pdfjs-dist"].resolved));
  const missing = [];
  for (const [name, e] of Object.entries(pk)) {
    if (!name) continue;
    if (!e.integrity || !e.resolved) missing.push(`${name}: no integrity/resolved`);
    for (const dep of Object.keys({ ...e.dependencies })) if (!pk[`node_modules/${dep}`] && !pk[`${name}/node_modules/${dep}`]) missing.push(`${name} -> ${dep}`);
  }
  check("every locked package has integrity and every hard dependency is locked", missing.length === 0 && (console.log(missing.join("\n")), true));
  check("updater plugin is NOT an npm dependency (uses the injected window.__TAURI__ global)", !("@tauri-apps/plugin-updater" in want));
}

// ---------- 4. workflow structure ----------
{
  const ids = [...wf.matchAll(/^\s+id: ([a-z0-9_-]+)$/gm)].map((m) => m[1]);
  check("five native build targets", ["linux-x86_64", "linux-aarch64", "windows-x86_64", "macos-x86_64", "macos-aarch64"].every((i) => ids.includes(i)));
  check("tag builds serialize tauri-action updater JSON uploads while PR builds stay parallel", wf.includes("max-parallel: ${{ startsWith(github.ref, 'refs/tags/v') && 1 || 5 }}"));
  check("macOS is per-architecture on verified runners (no universal build)", /macos-15-intel/.test(wf) && /runs-on|platform: macos-15\b/.test(wf) && !/universal-apple-darwin/.test(strip(wf)));
  const i = (s) => wf.indexOf(s);
  check("pdf.js is vendored in strict mode before the build", /vendor-pdfjs\.mjs --strict/.test(wf) && i("vendor-pdfjs.mjs --strict") < i("Build installers"));
  check("every platform vendors LibreOffice before the build", ["vendor-libreoffice-linux.sh", "vendor-libreoffice-windows.ps1", "vendor-libreoffice-macos.sh"].every((s) => i(s) > 0 && i(s) < i("Build installers (PR")));
  check("input gate runs before building and Linux deps are generated before it", i("verify-release-inputs.mjs") > i("linux-runtime-depends.sh") && i("verify-release-inputs.mjs") < i("Build installers (PR"));
  check("built-package verification exists for all three OS families", ["verify-linux-package.sh", "verify-windows-package.ps1", "verify-macos-package.sh"].every((s) => i(s) > i("Build, sign and attach")));
  check("cargo test and cargo check run", /cargo test --manifest-path/.test(wf) && /cargo check --manifest-path/.test(wf));
  check("Rust cache points to the nested Tauri workspace", wf.includes("workspaces: OmniDeck-2.4.3/src-tauri"));
  check("unsigned macOS CI build preserves vendor code signatures with --no-sign", wf.includes("run: npx tauri build --no-sign"));
  check("unsigned macOS tag build does not re-sign nested vendor apps", wf.includes("secrets.APPLE_CERTIFICATE == '' && '--no-sign'"));
  const macVerifier = read("scripts/verify-macos-package.sh");
  check("macOS package conversion timeout is portable (no GNU timeout dependency)", /python3 -/.test(macVerifier) && !/\btimeout 300\b/.test(macVerifier));
  check("macOS bundle signature failures print codesign diagnostics", /codesign --verify --deep --strict --verbose=2 "\$LO"/.test(macVerifier));
  check("skips are failures in the frontend job", /OMNIDECK_REQUIRE_NATIVE_TESTS: "1"/.test(wf));
  check("tag builds require updater signing inputs", /--require-updater/.test(wf) && /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/.test(wf) && /write-updater-config\.mjs/.test(wf));
  check("release is a DRAFT and its updater manifest is validated before publishing", /releaseDraft: true/.test(wf) && /verify-release-assets\.mjs/.test(wf) && /release-integrity/.test(wf));
  check("no secret or private key is echoed to logs", !/echo.*\$\{\{ *secrets\./.test(wf));
}

// ---------- 5. tauri / capability configuration ----------
{
  const t = json("src-tauri/tauri.conf.json"), s = JSON.stringify(t);
  check("macOS minimum is 11.0 (LibreOffice 26.x requirement; was 10.15)", t.bundle.macOS.minimumSystemVersion === "11.0");
  check("deb/rpm no longer 'recommend' a system LibreOffice/Poppler", !t.bundle.linux && !/libreoffice-impress|poppler-utils/.test(s));
  check("LibreOffice resources are bundled with directory structure preserved", Array.isArray(t.bundle.resources) && t.bundle.resources.includes("resources/libreoffice/"));
  const mac = json("src-tauri/tauri.macos.conf.json");
  check("macOS avoids resource glob-copying the signed LibreOffice app", Array.isArray(mac.bundle.resources) && mac.bundle.resources.length === 0 && mac.bundle.macOS.files["Frameworks/LibreOffice.app"] === "resources/libreoffice/LibreOffice.app");
  check("both macOS architectures use the signature-preserving config", wf.includes('tauri_args: "--config src-tauri/tauri.macos.conf.json --target x86_64-apple-darwin"') && wf.includes('tauri_args: "--config src-tauri/tauri.macos.conf.json --target aarch64-apple-darwin"'));

  check("base config has no updater key and no updater artifacts (release-only override)", !t.plugins?.updater && !t.bundle.createUpdaterArtifacts);
  const caps = readdirSync(join(root, "src-tauri/capabilities")).map((f) => json(`src-tauri/capabilities/${f}`));
  const up = caps.find((c) => c.identifier === "updater");
  check("updater permission is granted to the MAIN window only", !!up && up.windows.length === 1 && up.windows[0] === "main" && up.permissions.includes("updater:default"));
  check("default capability does NOT grant updater to the audience window", !JSON.stringify(caps.find((c) => c.identifier === "default")).includes("updater"));
  const cargo = read("src-tauri/Cargo.toml");
  check("updater crate is a dependency", /tauri-plugin-updater = "2"/.test(cargo));
  const files = ["src-tauri/tauri.conf.json", "../.github/workflows/build.yml", "scripts/write-updater-config.mjs", "src-tauri/src/main.rs"];
  check("no private signing key material is committed", files.every((f) => !/-----BEGIN [A-Z ]*PRIVATE KEY-----|untrusted comment: minisign encrypted secret key|RWRTY0I/.test(read(f))));
}

// ---------- 6. Rust source wiring (static; Rust itself is compiled only in CI) ----------
{
  const u = read("src-tauri/src/util.rs"), m = read("src-tauri/src/main.rs");
  check("bundled LibreOffice is resolved from Tauri's resource_dir first", /roots\.push\(r\.join\("resources"\)\.join\("libreoffice"\)\)/.test(u) && /set_resource_dir\(dir\)/.test(m) && /resource_dir\(\)/.test(m));
  check("installed .deb/.rpm layout (/usr/lib/<product>) is a searched fallback", /\.join\("lib"\)\.join\(name\)/.test(u));
  check("dependency check reports the BUNDLED soffice first (resolve_soffice)", /let soffice = resolve_soffice\(\);/.test(m) && /bundled_soffice_path\(\)\s*\n\s*\.or_else/.test(u));
  check("updater is registered only when configured", /if updater_config_ready\(app\.config\(\)\.plugins\.0\.get\("updater"\)\)/.test(m));
  check("restart goes through the CloseGate", /fn restart_app\(app: AppHandle, gate: State<CloseGate>\)/.test(m) && /gate\.approve\(\);\s*\n\s*app\.restart\(\)/.test(m));
  check("updater commands are exposed", /updater_status,\s*\n\s*restart_app/.test(m));
  const bal = (s) => s.split("{").length - s.split("}").length;
  check("Rust sources have balanced braces (cheap sanity; cargo is the real check)", bal(u) === 0 && bal(m) === 0);
}

// ---------- 7. verify-release-inputs ----------
{
  const mkRepo = ({ pdf = true, lo = true, provVersion = loV, plat = "linux-x86_64", sha = "a".repeat(64) } = {}) => {
    const r = tmp("repo");
    for (const f of ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "scripts/libreoffice-version.txt"]) { mkdirSync(dirname(join(r, f)), { recursive: true }); copyFileSync(join(root, f), join(r, f)); }
    if (pdf) { const d = join(r, "src/js/vendor/pdfjs"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "pdf.mjs"), Buffer.alloc(150_000, 1)); writeFileSync(join(d, "pdf.worker.mjs"), Buffer.alloc(600_000, 1)); }
    const l = join(r, "src-tauri/resources/libreoffice"); mkdirSync(l, { recursive: true });
    if (lo) { const p = join(l, "opt/libreoffice26.8/program"); mkdirSync(p, { recursive: true }); writeFileSync(join(p, "soffice"), "x"); writeFileSync(join(p, "soffice.bin"), "x"); }
    writeFileSync(join(l, "OMNIDECK-LIBREOFFICE.txt"), `libreoffice_version=${provVersion}\nplatform=${plat}\narchive_sha256=${sha}\n`);
    return r;
  };
  const gate = (r, extra = [], env = {}) => run("node", [join(root, "scripts/verify-release-inputs.mjs"), "--platform=linux", "--arch=x86_64", ...extra], { env: { OMNIDECK_REPO_ROOT: r, ...env } });
  let r = await gate(mkRepo()); check("gate passes with everything present", r.status === 0, r.all);
  r = await gate(mkRepo({ pdf: false })); check("gate FAILS when pdf.js is not vendored", r.status === 1 && /pdf\.mjs is missing/.test(r.all));
  r = await gate(mkRepo({ lo: false })); check("gate FAILS when only the README placeholder exists (no LibreOffice)", r.status === 1 && /LibreOffice runtime for linux is missing/.test(r.all));
  r = await gate(mkRepo({ provVersion: "24.8.4" })); check("gate FAILS on a LibreOffice version mismatch", r.status === 1 && /version mismatch/.test(r.all));
  r = await gate(mkRepo({ plat: "linux-aarch64" })); check("gate FAILS when the runtime is for the wrong architecture", r.status === 1 && /needs linux-x86_64/.test(r.all));
  r = await gate(mkRepo({ sha: "nope" })); check("gate FAILS without a recorded archive checksum", r.status === 1 && /archive_sha256/.test(r.all));
  r = await gate(mkRepo(), ["--require-updater"], { TAURI_SIGNING_PRIVATE_KEY: "", TAURI_UPDATER_PUBKEY: "" }); check("--require-updater FAILS without signing inputs", r.status === 1 && /TAURI_SIGNING_PRIVATE_KEY/.test(r.all) && /TAURI_UPDATER_PUBKEY/.test(r.all));
  r = await gate(mkRepo(), ["--require-updater"], { TAURI_SIGNING_PRIVATE_KEY: "x", TAURI_UPDATER_PUBKEY: "K".repeat(60) }); check("--require-updater passes with inputs", r.status === 0, r.all);
  r = await gate(mkRepo(), [], { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v9.9.9" }); check("a tag that doesn't match the app version is rejected", r.status === 1 && /does not match/.test(r.all));
  r = await gate(mkRepo(), [], { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${pkgV}` }); check("a matching tag is accepted", r.status === 0, r.all);
}

// ---------- 8. strict pdf.js vendoring ----------
{
  const r = tmp("pdfjs"); const env = { OMNIDECK_REPO_ROOT: r, CI: "" };
  let x = await run("node", [join(root, "scripts/vendor-pdfjs.mjs")], { env }); check("dev mode: missing pdfjs-dist only warns (exit 0)", x.status === 0 && /Skipping/.test(x.all));
  x = await run("node", [join(root, "scripts/vendor-pdfjs.mjs"), "--strict"], { env }); check("--strict: missing pdfjs-dist is an ERROR (exit 1)", x.status === 1 && /Release builds require/.test(x.all));
  x = await run("node", [join(root, "scripts/vendor-pdfjs.mjs")], { env: { ...env, CI: "true" } }); check("CI=true implies strict", x.status === 1);
  x = await run("node", [join(root, "scripts/vendor-pdfjs.mjs"), "--verify"], { env }); check("--verify fails when files are absent", x.status === 1 && /incomplete/.test(x.all));
  const pd = join(r, "node_modules/pdfjs-dist"); mkdirSync(join(pd, "build"), { recursive: true });
  writeFileSync(join(pd, "build/pdf.mjs"), Buffer.alloc(150_000, 1)); writeFileSync(join(pd, "build/pdf.worker.mjs"), Buffer.alloc(10, 1));
  x = await run("node", [join(root, "scripts/vendor-pdfjs.mjs"), "--strict"], { env }); check("--strict rejects a truncated worker file", x.status === 1);
  writeFileSync(join(pd, "build/pdf.worker.mjs"), Buffer.alloc(600_000, 1)); mkdirSync(join(pd, "standard_fonts")); mkdirSync(join(pd, "cmaps"));
  x = await run("node", [join(root, "scripts/vendor-pdfjs.mjs"), "--strict"], { env }); check("--strict succeeds with a complete package", x.status === 0, x.all);
  check("npm build script is strict and gated", /check-deps\.mjs --strict && node scripts\/vendor-pdfjs\.mjs --strict && node scripts\/vendor-libreoffice\.mjs && node scripts\/verify-release-inputs\.mjs && node scripts\/run-tauri\.mjs build/.test(json("package.json").scripts.build));
  check("npm dev script runs the dependency preflight before vendoring and the local Tauri CLI", /^node scripts\/check-deps\.mjs && .*vendor-pdfjs\.mjs && .*vendor-libreoffice\.mjs && node scripts\/run-tauri\.mjs dev$/.test(json("package.json").scripts.dev));
  check("no npm script depends on a bare `tauri` on PATH", !Object.values(json("package.json").scripts).some((c) => /(^|&&\s*)tauri\b/.test(c)));
  check("@tauri-apps/cli is a declared devDependency and present in the lockfile", !!json("package.json").devDependencies["@tauri-apps/cli"] && !!json("package-lock.json").packages["node_modules/@tauri-apps/cli"]);
}

// ---------- 9. updater config + release asset validation ----------
{
  const out = join(tmp("upd"), "c.json");
  const w = (env) => run("node", [join(root, "scripts/write-updater-config.mjs"), out], { env });
  let r = await w({ TAURI_UPDATER_PUBKEY: "", GITHUB_REPOSITORY: "o/r" }); check("updater config refuses a missing public key", r.status === 1);
  r = await w({ TAURI_UPDATER_PUBKEY: "-----BEGIN PRIVATE KEY----- " + "A".repeat(60), GITHUB_REPOSITORY: "o/r" }); check("updater config refuses key material that looks private", r.status === 1 && /PRIVATE/.test(r.all));
  r = await w({ TAURI_UPDATER_PUBKEY: "K".repeat(60), GITHUB_REPOSITORY: "not a repo" }); check("updater config refuses a bad repository name", r.status === 1);
  r = await w({ TAURI_UPDATER_PUBKEY: "K".repeat(60), GITHUB_REPOSITORY: "acme/omnideck" });
  const c = r.status === 0 ? JSON.parse(readFileSync(out, "utf8")) : {};
  check("updater config embeds the https GitHub Releases endpoint, key and signed artifacts", c.plugins?.updater?.endpoints?.[0] === "https://github.com/acme/omnideck/releases/latest/download/latest.json" && c.plugins.updater.pubkey.length === 60 && c.bundle.createUpdaterArtifacts === true);

  const d = tmp("rel"); const sig = "S".repeat(80);
  const plat = (k, f) => [k, { signature: sig, url: `https://github.com/acme/omnideck/releases/download/v${pkgV}/${f}` }];
  const files = { "linux-x86_64": "a.AppImage", "linux-aarch64": "b.AppImage", "windows-x86_64": "c-setup.exe", "darwin-x86_64": "d.app.tar.gz", "darwin-aarch64": "e.app.tar.gz" };
  const good = { version: pkgV, platforms: Object.fromEntries(Object.entries(files).map(([k, f]) => plat(k, f))) };
  const assets = Object.values(files).flatMap((f) => [f, `${f}.sig`]).join("\n");
  const vr = async (latest, a = assets, map = undefined) => {
    writeFileSync(join(d, "l.json"), JSON.stringify(latest));
    writeFileSync(join(d, "a.txt"), a);
    const args = [join(root, "scripts/verify-release-assets.mjs"), "--latest", join(d, "l.json"), "--assets", join(d, "a.txt"), "--version", pkgV];
    if (map !== undefined) { writeFileSync(join(d, "assets-map.tsv"), map); args.push("--asset-map", join(d, "assets-map.tsv")); }
    return run("node", args);
  };
  r = await vr(good); check("a complete, signed manifest passes", r.status === 0, r.all);
  const apiGood = structuredClone(good);
  const apiMap = Object.entries(files).map(([key, file], i) => {
    const id = String(7001 + i);
    apiGood.platforms[key].url = `https://api.github.com/repos/acme/omnideck/releases/assets/${id}`;
    return `${id}\t${file}`;
  }).join("\n");
  r = await vr(apiGood, assets, apiMap); check("Tauri GitHub API asset IDs resolve to attached filenames", r.status === 0, r.all);
  r = await vr(apiGood, assets, ""); check("API asset URL without an ID mapping fails closed", r.status === 1 && /missing from --asset-map/.test(r.all), r.all);
  const drop = structuredClone(good); delete drop.platforms["darwin-aarch64"]; r = await vr(drop); check("manifest missing a platform fails", r.status === 1 && /darwin-aarch64/.test(r.all));
  const nosig = structuredClone(good); nosig.platforms["linux-x86_64"].signature = ""; r = await vr(nosig); check("manifest entry without a signature fails", r.status === 1 && /signature/.test(r.all));
  r = await vr(good, assets.split("\n").filter((l) => l !== "c-setup.exe").join("\n")); check("manifest pointing at an asset that isn't attached fails", r.status === 1 && /not attached/.test(r.all));
  r = await vr({ ...good, version: "0.0.1" }); check("manifest with the wrong version fails", r.status === 1 && /version/.test(r.all));
  const http = structuredClone(good); http.platforms["linux-x86_64"].url = http.platforms["linux-x86_64"].url.replace("https", "http"); r = await vr(http); check("non-https update URL fails", r.status === 1 && /https/.test(r.all));
}

// ---------- 10. linux-runtime-depends ----------
if (process.platform === "linux" && which("dpkg") && which("ldd") && which("file") && which("python3")) {
  const b = tmp("bundle"); mkdirSync(join(b, "program"), { recursive: true }); copyFileSync("/bin/true", join(b, "program/soffice.bin")); chmodSync(join(b, "program/soffice.bin"), 0o755);
  const out = join(tmp("o"), "linux.json");
  let r = await run("bash", [join(root, "scripts/linux-runtime-depends.sh"), b, out]);
  const cfg = r.status === 0 ? JSON.parse(readFileSync(out, "utf8")) : null;
  check("depends script derives deb packages and rpm sonames from the real binaries", !!cfg && cfg.bundle.linux.deb.depends.includes("libc6") && cfg.bundle.linux.rpm.depends.some((s) => /^libc\.so\.6\(\)\(64bit\)$/.test(s)), r.all);
  if (which("gcc")) {
    const g = tmp("gcc"); mkdirSync(join(g, "program"), { recursive: true });
    writeFileSync(join(g, "f.c"), "int fakefn(void){return 1;}\n"); writeFileSync(join(g, "m.c"), "int fakefn(void); int main(){return fakefn();}\n");
    const built = await run("sh", ["-c", `cd ${g} && gcc -shared -fPIC -o libomnifake.so f.c && gcc -o program/soffice.bin m.c -L. -lomnifake && rm libomnifake.so`]);
    r = await run("bash", [join(root, "scripts/linux-runtime-depends.sh"), g, join(tmp("o"), "x.json")]);
    check("depends script FAILS (exit 2) when a needed library cannot be resolved", built.status === 0 && r.status === 2 && /libomnifake\.so/.test(r.all), r.all);
  } else skip("depends negative test", "gcc missing");
} else skip("linux-runtime-depends tests", "needs Linux with dpkg, ldd, file, python3");

// ---------- 11. verify-linux-package (static mode) against fixture .debs ----------
if (process.platform === "linux" && which("dpkg-deb")) {
  const mkDeb = ({ depends = "libc6, libx11-6", withBin = true, extraDepends = "" } = {}) => {
    const w = tmp("deb"); const pkg = join(w, "pkg"); const lo = join(pkg, "usr/lib/OmniDeck/resources/libreoffice/opt/libreoffice26.8/program");
    mkdirSync(lo, { recursive: true }); mkdirSync(join(pkg, "DEBIAN"), { recursive: true });
    writeFileSync(join(lo, "soffice"), "#!/bin/sh\n"); chmodSync(join(lo, "soffice"), 0o755);
    if (withBin) { writeFileSync(join(lo, "soffice.bin"), "x"); chmodSync(join(lo, "soffice.bin"), 0o755); }
    writeFileSync(join(pkg, "DEBIAN/control"), `Package: omnideck\nVersion: ${pkgV}\nArchitecture: all\nMaintainer: t <t@example.com>\nDescription: t\n${depends || extraDepends ? `Depends: ${[depends, extraDepends].filter(Boolean).join(", ")}\n` : ""}`);
    const bundle = join(w, "bundle"); mkdirSync(join(bundle, "deb"), { recursive: true });
    return { bundle, built: run("dpkg-deb", ["--build", pkg, join(bundle, "deb/omnideck.deb")]) };
  };
  const ver = async (o) => { const d = mkDeb(o); await d.built; return run("bash", [join(root, "scripts/verify-linux-package.sh"), d.bundle, "--no-install"]); };
  let r = await ver({});
  check("package verifier accepts the deb layout (bin present, exec bit, Depends declared)", /ok:   deb contains soffice\.bin/.test(r.all) && /ok:   soffice\.bin keeps its executable bit/.test(r.all) && /ok:   deb declares Depends/.test(r.all) && /ok:   deb does not depend on a system LibreOffice/.test(r.all), r.all);
  check("package verifier still FAILS overall when rpm/AppImage are missing", r.status === 1 && /no \.rpm found/.test(r.all) && /no \.AppImage found/.test(r.all));
  r = await ver({ withBin: false }); check("package verifier FAILS a deb without soffice.bin", /does not contain the bundled soffice\.bin/.test(r.all));
  r = await ver({ depends: "" }); check("package verifier FAILS a deb with no Depends", /has no Depends/.test(r.all));
  r = await ver({ extraDepends: "libreoffice-impress" }); check("package verifier FAILS a deb that depends on a system LibreOffice", /depends on a SYSTEM LibreOffice/.test(r.all));
} else skip("verify-linux-package tests", "needs dpkg-deb");

console.log(`\n${state.failures} failure(s), ${state.skipped} skipped`);
process.exit(state.failures ? 1 : 0);
