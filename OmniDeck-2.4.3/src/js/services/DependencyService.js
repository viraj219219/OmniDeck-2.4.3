import { isRunningInTauri } from "../utils/storageAdapter.js";
import * as pdfJsService from "./PdfJsService.js";

/**
 * DependencyService — is the machine ready for PowerPoint / PDF import?
 *
 * As of v2.3, most of what this used to gate on is gone:
 *  - PDF page splitting and PDF text extraction run entirely on the
 *    bundled pdf.js library inside the webview — no external tool at all.
 *  - "Quiz from Word document" reads modern .docx files with a pure-Rust
 *    zip/XML reader (see docx_reader.rs) — no external tool at all.
 *  - PowerPoint import is the one case that still needs a real rendering
 *    engine for visual fidelity, so it needs LibreOffice's `soffice` —
 *    but that's looked up bundled-inside-the-app FIRST (see
 *    `bundled_soffice_path` in util.rs) and only falls back to a system
 *    install if no bundled copy shipped with this build.
 *
 * This module turns the raw Rust `check_import_dependencies` result (which
 * only knows about `soffice`/`pdftoppm`/`pdftotext` — it can't see into the
 * webview to check pdf.js) plus the frontend's own pdf.js availability
 * check into plain-language capability rows for Settings — "Ready" /
 * "Not available", never raw binary names.
 */
export class DependencyError extends Error {
  constructor(message, { missing = [] } = {}) {
    super(message);
    this.name = "DependencyError";
    this.missing = missing;
  }
}

const READY = { ready: true, level: "ok", message: "Ready", missing: [] };

function has(raw, tool) {
  return !!raw?.[tool]?.found;
}

/**
 * Pure: raw tool detection + pdf.js availability -> user-facing readiness
 * rows. Exported so it's unit-tested with synthetic input. `raw` is
 * `{ soffice, pdftoppm, pdftotext }` each `{ found, path }`, or
 * null/undefined when detection itself couldn't run (status "unknown" —
 * never a false "Ready"). `pdfJsAvailable` is a plain boolean.
 */
export function summarizeDependencies(raw, pdfJsAvailable = false) {
  if (!raw) {
    const unknown = { ready: null, level: "unknown", message: "Couldn't check", missing: [] };
    return { powerpoint: unknown, pdf: unknown, pdfText: unknown, wordText: unknown };
  }

  // PowerPoint fidelity still needs a real rendering engine. Once pdf.js
  // is vendored, the LibreOffice-produced PDF is rasterized by pdf.js
  // (not pdftoppm), so soffice is the only thing this checks for that
  // case; without the vendored pdf.js this build still needs pdftoppm too
  // (see MediaService.convertPresentation's fallback path).
  const pptMissing = pdfJsAvailable
    ? (has(raw, "soffice") ? [] : ["soffice"])
    : ["soffice", "pdftoppm"].filter((t) => !has(raw, t));
  const powerpoint = pptMissing.length === 0
    ? READY
    : {
        ready: false,
        level: "error",
        message: "PowerPoint rendering isn't available on this install (missing the bundled/installed presentation renderer).",
        missing: pptMissing,
      };

  const pdf = pdfJsAvailable || has(raw, "pdftoppm")
    ? READY
    : {
        ready: false,
        level: "warning",
        message: "PDFs will be added as one embedded page instead of page-by-page slides.",
        missing: ["pdftoppm"],
      };

  const pdfText = pdfJsAvailable || has(raw, "pdftotext")
    ? READY
    : { ready: false, level: "warning", message: "Can't make quizzes from PDFs on this install.", missing: ["pdftotext"] };

  // Modern .docx text extraction is pure Rust now and always ready; only
  // the legacy .doc fallback still needs soffice, which isn't worth
  // surfacing as a capability gap for the common case.
  const wordText = READY;

  return { powerpoint, pdf, pdfText, wordText };
}

export class DependencyService {
  async getRaw() { throw new Error("Not implemented"); }
  async getStatus() {
    const [raw, pdfJsAvailable] = await Promise.all([this.getRaw(), pdfJsService.isAvailable()]);
    return summarizeDependencies(raw, pdfJsAvailable);
  }

  /**
   * Pre-flight for an import button. Throws DependencyError (a clear,
   * user-facing message) when the import CANNOT work. PDF never throws —
   * without pdf.js or Poppler it still imports as one embedded page, so
   * the app returns the status for the caller to mention instead. If
   * detection itself fails the import is allowed to proceed (its own
   * error handling still applies) rather than being blocked by a broken
   * check.
   */
  async assertReady(kind) {
    const status = await this.getStatus();
    if (kind === "presentation" && status.powerpoint.ready === false) {
      throw new DependencyError(
        "PowerPoint import isn't available on this install — no presentation renderer was found, " +
          "bundled or installed. Production OmniDeck builds bundle the renderer; if this development build is missing its bundled copy, install LibreOffice only for development/testing and restart OmniDeck.",
        { missing: status.powerpoint.missing }
      );
    }
    return status;
  }
}

class TauriDependencyService extends DependencyService {
  async getRaw() {
    try {
      const { invoke } = window.__TAURI__.core;
      return await invoke("check_import_dependencies");
    } catch (err) {
      console.warn("[DependencyService] dependency check failed", err);
      return null;
    }
  }
}

class BrowserPreviewDependencyService extends DependencyService {
  async getRaw() { return null; }
  async getStatus() {
    const msg = "Requires the desktop app — not available in browser preview";
    const row = { ready: false, level: "warning", message: msg, missing: [] };
    return { powerpoint: row, pdf: row, pdfText: row, wordText: row };
  }
  async assertReady(kind) {
    if (kind === "presentation") throw new DependencyError("PowerPoint import requires the desktop app — it isn't available in browser preview.");
    return this.getStatus();
  }
}

export const dependencyService = isRunningInTauri ? new TauriDependencyService() : new BrowserPreviewDependencyService();
export { TauriDependencyService, BrowserPreviewDependencyService };
