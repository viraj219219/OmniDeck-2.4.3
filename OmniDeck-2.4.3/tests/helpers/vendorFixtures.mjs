// Builds a FAKE "official TDF .deb tarball" for exercising the Linux vendoring
// script's logic (download, checksum, extraction filtering, ELF/ldd/version/
// smoke validation, staging + rollback). soffice.bin is a copy of a real ELF
// (/bin/true); the soffice launcher is a shell stub whose behaviour each test
// chooses, and which hands real conversions to the system LibreOffice. So this
// proves the script's control flow against a real conversion engine - it does
// NOT prove anything about the official LibreOffice download.
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

export function launcher({ version = "LibreOffice 26.8.0.3 fixture", versionExit = 0, convert = "real", realSoffice }) {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version}"; exit ${versionExit}; fi
${convert === "real" ? `exec "${realSoffice}" "$@"` : convert === "empty" ? "exit 0" : "exit 4"}
`;
}

export function buildLinuxTarball({ arch = "x86-64", version = "26.8.0", sofficeScript, sofficeBinIsElf = true, withSofficeBin = true, sofficeBinPath = "/bin/true" }) {
  const work = mkdtempSync(join(tmpdir(), "omnideck-fixture-"));
  const top = `LibreOffice_${version}.3_Linux_${arch}_deb`;
  const debs = join(work, top, "DEBS");
  mkdirSync(debs, { recursive: true });
  const mk = (name, files) => {
    const root = join(work, "pkg-" + name);
    for (const [rel, content, mode] of files) {
      const p = join(root, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      if (content === "ELF") copyFileSync(sofficeBinPath, p); else writeFileSync(p, content);
      chmodSync(p, mode ?? 0o644);
    }
    mkdirSync(join(root, "DEBIAN"), { recursive: true });
    writeFileSync(join(root, "DEBIAN", "control"),
      `Package: ${name}\nVersion: ${version}.3-1\nArchitecture: all\nMaintainer: test <t@example.invalid>\nDescription: fixture ${name}\n`);
    const r = spawnSync("dpkg-deb", ["--build", "--root-owner-group", root, join(debs, `${name}_${version}.3-1_all.deb`)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("dpkg-deb --build failed: " + r.stderr);
  };
  const core = [["opt/libreoffice26.8/program/soffice", sofficeScript, 0o644]];
  if (withSofficeBin) core.push(["opt/libreoffice26.8/program/soffice.bin", sofficeBinIsElf ? "ELF" : "#!/bin/sh\nexit 0\n", 0o644]);
  mk("libreoffice26.8", core);
  mk("libobasis26.8-impress", [["opt/libreoffice26.8/share/impress-marker.txt", "impress\n"]]);
  mk("libreoffice26.8-debian-menus", [["usr/share/applications/libreoffice.desktop", "[Desktop Entry]\n"]]);
  mk("libobasis26.8-l10n-de", [["opt/libreoffice26.8/share/l10n-de-marker.txt", "de\n"]]);
  mk("libobasis26.8-gnome-integration", [["opt/libreoffice26.8/share/gnome-marker.txt", "gnome\n"]]);
  const tarball = join(work, "archive.tar.gz");
  const t = spawnSync("tar", ["-czf", tarball, "-C", work, top], { encoding: "utf8" });
  if (t.status !== 0) throw new Error("tar failed: " + t.stderr);
  const body = readFileSync(tarball);
  return { body, sha: sha256(body), name: `LibreOffice_${version}_Linux_${arch}_deb.tar.gz`, work };
}
