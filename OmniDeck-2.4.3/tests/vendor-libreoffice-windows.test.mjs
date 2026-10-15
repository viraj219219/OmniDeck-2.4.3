// Windows LibreOffice vendoring: static guards + BEHAVIOURAL tests.
//
// What runs for real here: the PowerShell parser, and the script's own helper
// functions (resumable download against a local Range server, native-exit-code
// capture, runtime-file validation, version validation, smoke conversion with a
// real LibreOffice when one is installed). What CANNOT run on a non-Windows
// machine and therefore needs the windows-latest CI job: Authenticode
// validation, msiexec administrative extraction and the official download.
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { check, skip, which, run, finish } from "./helpers/harness.mjs";
import { startRangeServer } from "./helpers/rangeServer.mjs";
import { checkPowerShellStructure } from "./helpers/ps-structure.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const scriptPath = join(root, "scripts/vendor-libreoffice-windows.ps1");
const script = readFileSync(scriptPath, "utf8");
const vendorEntry = readFileSync(join(root, "scripts/vendor-libreoffice.mjs"), "utf8");

// ---- static guards -------------------------------------------------------
const staticChecks = [
  ["uses official TDF download host", /https:\/\/download\.documentfoundation\.org\/libreoffice\/stable\//],
  ["pins LibreOffice 26.8.0", /"26\.8\.0"\s*=\s*"[0-9A-F]{64}"/],
  ["keeps the pinned 26.8.0 SHA-256 unchanged", /4AA6C6E1895F4055104EFFCB556BD3362D20C6AD707C149543304F395EF9DB95/i],
  ["loads System.Net.Http explicitly for Windows PowerShell 5.1", /Add-Type -AssemblyName System\.Net\.Http/],
  ["streams the body (ResponseHeadersRead)", /ResponseHeadersRead/],
  ["follows redirects", /AllowAutoRedirect\s*=\s*\$true/],
  ["disables transparent decompression so Range offsets stay byte-exact", /AutomaticDecompression\s*=\s*\[System\.Net\.DecompressionMethods\]::None/],
  ["resumes with an HTTP Range request", /RangeHeaderValue/],
  ["handles 206, 416 and servers that ignore Range", (s) => /-eq 206/.test(s) && /-eq 416/.test(s) && /ignored the Range request/.test(s)],
  ["does not retry permanent 4xx errors", /\$permanent\s*=\s*\$true/],
  ["retries transient failures (MaxRetries default 4)", /\[int\]\$MaxRetries\s*=\s*4/],
  ["keeps the partial file for the next run (no delete on failure)", /resumable partial|survives failures/],
  ["checks for incomplete downloads", /Incomplete download/],
  ["verifies SHA-256 and retries once from scratch on mismatch", (s) => /Get-FileHash[\s\S]*SHA256/.test(s) && /mismatch twice/.test(s)],
  ["checks Authenticode", /Get-AuthenticodeSignature/],
  ["extracts with msiexec administrative mode", /msiexec\.exe[\s\S]*'\/a'/],
  ["requires soffice.exe, soffice.com and soffice.bin", (s) => /program\\soffice\.exe/.test(s) && /program\\soffice\.com/.test(s) && /program\\soffice\.bin/.test(s)],
  ["validates with soffice.com --version (the console wrapper)", /Assert-LibreOfficeVersion -Soffice \(Join-Path \$destStage "program\\soffice\.com"\)/],
  ["runs a real conversion smoke test before replacing the bundle", /Invoke-SmokeConversion -Soffice \(Join-Path \$destStage/],
  ["stages beside the destination and rolls back", (s) => /libreoffice-staging-/.test(s) && /libreoffice-backup-/.test(s) && /Previous bundle restored/.test(s)],
  ["native exit code is captured by the child helper and not the parent Process object", (s) => /`\$nativeCode = `\$LASTEXITCODE/.test(s) && /native-exit-code\.txt/.test(s) && !/\$p\.ExitCode/.test(s)],
  ["exits non-zero on any failure", (s) => /\$script:ExitCode\s*=\s*1/.test(s) && /exit \$script:ExitCode/.test(s)],
  ["does not use fragile Invoke-WebRequest", (s) => !/Invoke-WebRequest/.test(s)],
  ["launches the encoded PowerShell helper instead of cmd batch wrapper", (s) => /-EncodedCommand/.test(s) && /powershell\.exe/.test(s) && !/run-native\.cmd/.test(s)],
  ["rejects a helper that fails to write its exit code", (s) => /Native process wrapper did not write an exit code/.test(s)],
  ["reuses Windows bundle by probing soffice.com, not GUI soffice.exe", () => /const exe = join\(dest, "program", "soffice\.com"\)/.test(vendorEntry)],
  ["starts with a UTF-8 BOM (Windows PowerShell 5.1 reads it as UTF-8)", () => readFileSync(scriptPath)[0] === 0xEF],
];
for (const [name, test] of staticChecks) check(name, typeof test === "function" ? test(script) : test.test(script));

// ---- structural check that does NOT need PowerShell -------------------------
for (const f of ["vendor-libreoffice-windows.ps1", "verify-windows-package.ps1"]) {
  const probs = checkPowerShellStructure(readFileSync(join(root, "scripts", f), "utf8"));
  check(`${f}: balanced braces, no orphaned catch/finally`, probs.length === 0, probs.join("\n"));
}
check("structure checker detects an orphaned finally (self-test)", checkPowerShellStructure("function f {\n try {\n  a\n } catch {\n  b\n }\n c\n finally {\n  d\n }\n}\n").length > 0);
check("structure checker accepts a valid try/catch/finally (self-test)", checkPowerShellStructure("function f {\n try { a } catch { b }\n finally { c }\n}\n").length === 0);

// ---- behavioural tests (need PowerShell 7) --------------------------------
const pwsh = which("pwsh") || (existsSync("/tmp/pwsh/pwsh") ? "/tmp/pwsh/pwsh" : null);
if (!pwsh) {
  skip("PowerShell behavioural tests", "pwsh is not installed");
} else {
  const ps = (code, opts) => run(pwsh, ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; . '${scriptPath}' -LoadFunctionsOnly; ${code}`], opts);
  const q = (p) => p.replace(/'/g, "''");
  const tmp = mkdtempSync(join(tmpdir(), "omnideck-win-test-"));

  const parse = await run(pwsh, ["-NoProfile", "-Command",
    `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}',[ref]$t,[ref]$e); $e.Count`]);
  check("PowerShell parser: 0 syntax errors", parse.stdout.trim() === "0", parse.all);

  // exit-code contract at script level: unsupported version => exit 1, no stack of side effects
  const unsupported = await run(pwsh, ["-NoProfile", "-NonInteractive", "-File", scriptPath, "-Version", "9.9.9", "-Destination", join(tmp, "never")]);
  check("unsupported version exits with code 1", unsupported.status === 1, `exit=${unsupported.status}\n${unsupported.all}`);
  check("unsupported version creates nothing", !existsSync(join(tmp, "never")));

  // resumable download
  const body = randomBytes(3 * 1024 * 1024);
  {
    const srv = await startRangeServer(body, { dropAfter: 1024 * 1024 });
    const out = join(tmp, "resume.bin");
    const r = await ps(`[void](Invoke-ResumableDownload -Uri '${srv.url}' -OutputPath '${q(out)}' -Retries 3 -MinimumBytes 1000 -DelayCapSeconds 1)`);
    const ranged = srv.state.requests.filter((x) => x.range === "bytes=1048576-").length;
    check("download survives a mid-stream disconnect", r.status === 0 && existsSync(out) && Buffer.compare(readFileSync(out), body) === 0, r.all);
    check("the retry RESUMES (Range: bytes=1048576-) instead of restarting", ranged === 1, JSON.stringify(srv.state.requests));
    await srv.close();
  }
  {
    const srv = await startRangeServer(body, { ignoreRange: true, dropAfter: 1024 * 1024 });
    const out = join(tmp, "norange.bin");
    const r = await ps(`[void](Invoke-ResumableDownload -Uri '${srv.url}' -OutputPath '${q(out)}' -Retries 3 -MinimumBytes 1000 -DelayCapSeconds 1)`);
    check("a server that ignores Range still yields an intact file (restart, no corruption)", r.status === 0 && Buffer.compare(readFileSync(out), body) === 0, r.all);
    await srv.close();
  }
  {
    const srv = await startRangeServer(body, { status: 404 });
    const out = join(tmp, "missing.bin");
    const r = await ps(`[void](Invoke-ResumableDownload -Uri '${srv.url}' -OutputPath '${q(out)}' -Retries 4 -MinimumBytes 1000 -DelayCapSeconds 1)`);
    check("HTTP 404 fails (non-zero) ...", r.status !== 0, r.all);
    check("... after ONE request: permanent client errors are not retried", srv.state.requests.length === 1, `requests=${srv.state.requests.length}`);
    await srv.close();
  }
  {
    const srv = await startRangeServer(body);
    const out = join(tmp, "complete.bin");
    writeFileSync(out, body); // a previous run already finished the transfer
    const r = await ps(`[void](Invoke-ResumableDownload -Uri '${srv.url}' -OutputPath '${q(out)}' -Retries 2 -MinimumBytes 1000 -DelayCapSeconds 1)`);
    check("a complete partial (HTTP 416) is accepted without re-downloading", r.status === 0 && statSync(out).size === body.length && srv.state.requests.length === 1, r.all);
    await srv.close();
  }
  {
    const srv = await startRangeServer(Buffer.from("tiny"));
    const out = join(tmp, "tiny.bin");
    const r = await ps(`[void](Invoke-ResumableDownload -Uri '${srv.url}' -OutputPath '${q(out)}' -Retries 3 -MinimumBytes 1000000 -DelayCapSeconds 1)`);
    check("an HTML-error-page-sized download is rejected and deleted", r.status !== 0 && !existsSync(out) && srv.state.requests.length === 1, r.all);
    await srv.close();
  }

  // Invoke-NativeCapture deliberately launches powershell.exe and uses Windows
  // process semantics. Keep this behavioural assertion on a Windows runner;
  // Linux still exercises parsing, static guards, and the platform-neutral
  // resumable-download helpers above.
  if (process.platform === "win32" && which("cmd.exe") && which("ping.exe")) {
    const cmd = q(which("cmd.exe"));
    const ping = q(which("ping.exe"));
    const r = await ps(`$global:LASTEXITCODE = 5; $ok = Invoke-NativeCapture -FilePath '${cmd}' -Arguments @('/c','exit','0'); $global:LASTEXITCODE = 0; $bad = Invoke-NativeCapture -FilePath '${cmd}' -Arguments @('/c','exit','1'); $slow = Invoke-NativeCapture -FilePath '${ping}' -Arguments @('-n','30','127.0.0.1') -TimeoutSeconds 1; "$($ok.ExitCode)|$($bad.ExitCode)|$($slow.TimedOut)"`);
    check("Invoke-NativeCapture: real exit codes (stale $LASTEXITCODE ignored) and timeout kill", r.stdout.trim() === "0|1|True", r.all);
  }

  // runtime-file validation
  {
    const rt = join(tmp, "rt");
    mkdirSync(join(rt, "program"), { recursive: true });
    mkdirSync(join(rt, "share"), { recursive: true });
    for (const f of ["soffice.exe", "soffice.bin"]) writeFileSync(join(rt, "program", f), "x");
    const r = await ps(`Assert-RuntimeFiles -Root '${q(rt)}'`);
    check("Assert-RuntimeFiles rejects a runtime without soffice.com", r.status !== 0 && /soffice\.com is missing/.test(r.all), r.all);
  }

  // version + smoke conversion with a REAL LibreOffice, if this machine has one
  const realSoffice = process.platform === "win32" ? (process.env.OMNIDECK_TEST_SOFFICE || which("soffice")) : null;
  const fixture = join(root, "src-tauri/test-fixtures/three-slides.pptx");
  if (process.platform === "win32" && !realSoffice) {
    skip("PowerShell version/smoke helpers against a real LibreOffice", "no soffice on this Windows machine");
  } else if (process.platform === "win32" && realSoffice) {
    const v = (await run(realSoffice, ["--version"])).stdout.trim();
    const mm = /LibreOffice (\d+)\.(\d+)/.exec(v);
    const ok = await ps(`Assert-LibreOfficeVersion -Soffice '${q(realSoffice)}' -Expected '${mm[1]}.${mm[2]}.0'`);
    check(`Assert-LibreOfficeVersion accepts the matching version (${v})`, ok.status === 0, ok.all);
    const bad = await ps(`Assert-LibreOfficeVersion -Soffice '${q(realSoffice)}' -Expected '99.9.0'`);
    check("Assert-LibreOfficeVersion rejects a mismatching version", bad.status !== 0 && /was expected/.test(bad.all), bad.all);
    const smoke = await ps(`Invoke-SmokeConversion -Soffice '${q(realSoffice)}' -Fixture '${q(fixture)}' -ExpectedPages 3`, { timeoutMs: 300000 });
    check("smoke conversion: 3-slide PPTX -> PDF with 3 pages (one per slide)", smoke.status === 0 && /Smoke conversion OK/.test(smoke.all), smoke.all);
    const wrong = await ps(`Invoke-SmokeConversion -Soffice '${q(realSoffice)}' -Fixture '${q(fixture)}' -ExpectedPages 5`, { timeoutMs: 300000 });
    check("smoke conversion fails when the page count is wrong", wrong.status !== 0 && /expected 5/.test(wrong.all), wrong.all);
  }
}
finish();
