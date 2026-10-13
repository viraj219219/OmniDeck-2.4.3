// Regression tests: import-capability readiness is detected without
// crashing and reported in plain, jargon-free language — never the raw
// tool names (LibreOffice / Poppler / soffice / pdftoppm) that v2.2 used
// to surface directly to teachers.
//
// v2.3: PDF splitting/text and DOCX-quiz text no longer depend on any
// external tool once pdf.js is vendored (see PdfJsService.js); this file
// exercises both that branch and the pre-vendoring fallback branch (which
// still behaves like v2.2's Poppler-based path) so neither regresses.

import { FakeDisk, installFakeTauri, makeChecker } from "./helpers/fakeDisk.mjs";
const { check, done } = makeChecker();
const realWarn = console.warn;
console.warn = (...a) => { if (String(a[0]).includes("[DependencyService]")) return; realWarn(...a); };

const disk = new FakeDisk();
const found = (p) => ({ found: true, path: p });
const missing = { found: false, path: null };
let raw = null;
let throwInvoke = false;
installFakeTauri(disk, { commands: { check_import_dependencies: async () => { if (throwInvoke) throw new Error("command unavailable"); return raw; } } });

const { dependencyService, summarizeDependencies, DependencyError, BrowserPreviewDependencyService } = await import("../src/js/services/DependencyService.js");

// In this test environment the vendored pdf.js files at
// src/js/vendor/pdfjs/ don't exist, so PdfJsService.isAvailable() is false
// and every summarizeDependencies() call below implicitly exercises the
// "no pdf.js" branch — i.e. the same Poppler-dependent behaviour v2.2 had.
// The `summarizeDependencies(raw, true)` calls further down cover the
// pdf.js-available branch directly as a pure-function test, since this
// harness has no way to make the dynamic import of the vendor path
// succeed without the actual files present.

// all present (Windows-style paths, spaces — detection results are opaque strings)
raw = { soffice: found("C:\\Program Files\\LibreOffice\\program\\soffice.exe"), pdftoppm: found("C:\\poppler\\Library\\bin\\pdftoppm.exe"), pdftotext: found("C:\\poppler\\Library\\bin\\pdftotext.exe") };
let s = await dependencyService.getStatus();
check("everything installed: PowerPoint import ✓ Ready", s.powerpoint.ready === true && s.powerpoint.level === "ok" && s.powerpoint.message === "Ready");
check("everything installed: PDF import ✓ Ready", s.pdf.ready === true && s.pdf.message === "Ready");
check("everything installed: Word-quiz text is always Ready (pure-Rust .docx reader)", s.wordText.ready === true);
check("everything installed: assertReady passes", (await dependencyService.assertReady("presentation")).powerpoint.ready === true);

// LibreOffice (soffice) missing, no pdf.js vendored -> PowerPoint import unavailable
raw = { soffice: missing, pdftoppm: found("/usr/bin/pdftoppm"), pdftotext: found("/usr/bin/pdftotext") };
s = await dependencyService.getStatus();
check("soffice missing: PowerPoint reported not ready, no raw tool name in the message", s.powerpoint.ready === false && s.powerpoint.level === "error" && !/soffice|LibreOffice/i.test(s.powerpoint.message));
check("soffice missing: PDF import is still Ready (pdftoppm present)", s.pdf.ready === true);
check("soffice missing: Word-quiz text is unaffected (doesn't touch soffice for .docx)", s.wordText.ready === true);
let err = null;
try { await dependencyService.assertReady("presentation"); } catch (e) { err = e; }
check("soffice missing: assertReady throws a clear, jargon-free DependencyError", err instanceof DependencyError && !/soffice/i.test(err.message) && err.missing.includes("soffice"));

// pdftoppm missing, no pdf.js vendored -> PDF falls back to embedded-page warning
raw = { soffice: found("/usr/bin/soffice"), pdftoppm: missing, pdftotext: missing };
s = await dependencyService.getStatus();
check("pdftoppm missing (no pdf.js): PowerPoint import unavailable too (both needed on this fallback path)", s.powerpoint.ready === false);
check("pdftoppm missing (no pdf.js): PDF import warns (embedded fallback) but is not an error", s.pdf.ready === false && s.pdf.level === "warning" && /embedded/.test(s.pdf.message));
check("pdftoppm missing (no pdf.js): PDF pre-flight does NOT throw (a PDF still imports embedded)", (await dependencyService.assertReady("pdf")).pdf.ready === false);
check("pdftotext missing (no pdf.js): PDF-quiz import flagged, jargon-free", s.pdfText.ready === false && !/pdftotext/i.test(s.pdfText.message));

// detection itself failing must never claim Ready
throwInvoke = true;
s = await dependencyService.getStatus();
check("detection failure is 'unknown', never a false Ready", s.powerpoint.ready === null && s.powerpoint.level === "unknown" && s.pdf.ready === null);
check("detection failure does not block an import (its own error handling still applies)", (await dependencyService.assertReady("presentation")).powerpoint.ready === null);
throwInvoke = false;

// pure function: null raw -> unknown for every row
const u = summarizeDependencies(undefined);
check("summarize(null) -> unknown for every row", [u.powerpoint, u.pdf, u.pdfText, u.wordText].every((r) => r.level === "unknown"));

// pure function: pdf.js available branch (exercised directly, since this
// harness can't make the dynamic vendor import succeed end-to-end)
const withPdfJsNoSoffice = summarizeDependencies({ soffice: missing, pdftoppm: missing, pdftotext: missing }, true);
check("pdf.js available: PDF import is Ready even with Poppler entirely absent", withPdfJsNoSoffice.pdf.ready === true);
check("pdf.js available: PDF-quiz text is Ready even with Poppler entirely absent", withPdfJsNoSoffice.pdfText.ready === true);
check("pdf.js available: PowerPoint import still needs soffice (fidelity requires a real renderer)", withPdfJsNoSoffice.powerpoint.ready === false && withPdfJsNoSoffice.powerpoint.missing.includes("soffice") && !withPdfJsNoSoffice.powerpoint.missing.includes("pdftoppm"));
const withPdfJsAndSoffice = summarizeDependencies({ soffice: found("/opt/omnideck/resources/libreoffice/program/soffice"), pdftoppm: missing, pdftotext: missing }, true);
check("pdf.js + bundled soffice: PowerPoint import is Ready without Poppler at all", withPdfJsAndSoffice.powerpoint.ready === true);

// browser preview
const bp = new BrowserPreviewDependencyService();
err = null;
try { await bp.assertReady("presentation"); } catch (e) { err = e; }
check("browser preview: PowerPoint import says it needs the desktop app", err instanceof DependencyError && /desktop app/.test(err.message));
check("browser preview: status rows are honest (not Ready)", (await bp.getStatus()).powerpoint.ready === false);

done();
