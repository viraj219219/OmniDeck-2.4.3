// PdfJsService — PDF page rasterization and text extraction using pdf.js,
// running entirely inside the Tauri webview (canvas rendering). This is
// what removes the Poppler (`pdftoppm`/`pdftotext`) system dependency for
// PDF import: pdf.js is a pure JS/WASM library, so once it's vendored into
// the app there is nothing for the teacher to install, on any OS — it works
// identically on Windows/Linux/macOS because it's just JS running in the
// same webview OmniDeck already ships.
//
// STATUS (v2.3): this module is complete and is the primary PDF path, but
// it needs the actual pdf.js library files present at
// `src/js/vendor/pdfjs/pdf.mjs` + `pdf.worker.mjs` to activate — this repo
// has no network access at build time to fetch pdfjs-dist itself, so the
// fetch has to happen where the existing CI does (see
// .github/workflows/build.yml, which now runs `npm install pdfjs-dist` and
// copies its `build/pdf.mjs` + `build/pdf.worker.mjs` into that vendor path
// before `tauri build`). Until those two files exist, `isAvailable()`
// returns false and MediaService's existing pdftoppm/pdftotext path is used
// exactly as before — so nothing regresses in the meantime.

const VENDOR_ENTRY = "../vendor/pdfjs/pdf.mjs";
const VENDOR_WORKER = "../vendor/pdfjs/pdf.worker.mjs";

let pdfjsLibPromise = null;

/** Lazily imports the vendored pdf.js module. Never throws — callers check isAvailable() first. */
async function loadPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(/* @vite-ignore */ VENDOR_ENTRY)
      .then((mod) => {
        const lib = mod.default ?? mod;
        lib.GlobalWorkerOptions.workerSrc = new URL(VENDOR_WORKER, import.meta.url).href;
        return lib;
      })
      .catch((err) => {
        pdfjsLibPromise = null; // allow a retry later (e.g. after the vendor files are added)
        throw err;
      });
  }
  return pdfjsLibPromise;
}

/** Whether the vendored pdf.js library is present and importable. */
export async function isAvailable() {
  try {
    await loadPdfJs();
    return true;
  } catch {
    return false;
  }
}

const RENDER_SCALE = 150 / 72; // matches the previous pdftoppm "-r 150" (150 DPI; PDF units are 72/inch)

/**
 * Same wall-clock ceiling as the Rust side's `EXTERNAL_TOOL_TIMEOUT`
 * (src-tauri/src/util.rs) — kept equal on purpose, not because the two
 * mechanisms share code, but so a teacher sees a failure within the same
 * ~2 minutes regardless of which conversion path (LibreOffice/Poppler
 * subprocess, or this in-webview pdf.js path) happens to be active.
 *
 * PPTX-import crash root cause (this constant + renderWithTimeout below):
 * every subprocess this app shells out to (`soffice`, `pdftoppm`,
 * `pdftotext`) is wrapped in `run_with_timeout` in Rust — a hard
 * wall-clock ceiling that guarantees a `Result` comes back. This pdf.js
 * path does the equivalent work (turning a converted PDF into slide
 * PNGs) but, before this fix, had NO such ceiling: `renderPdfPagesToPngs`
 * was a plain `await` chain with nothing bounding how long pdf.js's
 * worker/rendering could run. If the worker fails to initialize cleanly
 * under Tauri's custom asset protocol (a real, plausible failure mode —
 * this is the newest, least-exercised path in the app, "complete but
 * unverified end-to-end" per its own STATUS note above) or a render call
 * simply never settles, the calling `await` in MediaService just hangs
 * forever: the "Importing PowerPoint" overlay in lessonEditor.js only
 * ever clears in a `finally` after that `await` resolves/rejects, so it
 * stays up indefinitely — exactly the reported "stuck for several
 * minutes" symptom, with no bound on how many minutes. Left running long
 * enough, a wedged renderer/worker is also a plausible route to the
 * eventual native crash (unreclaimed decode buffers, a worker that never
 * exits) that closes the app outright. Wrapping the whole conversion in
 * `renderWithTimeout` turns an unbounded hang into a clean, reported
 * error within a fixed ceiling — matching the guarantee every other
 * import path already had.
 */
const RENDER_TIMEOUT_MS = 120_000;

/**
 * A single PDF page's rendered pixel dimensions are attacker/corruption
 * controlled (they come straight from the PDF's own `/MediaBox`, which
 * LibreOffice faithfully carries over from whatever the source PPTX
 * declared). Before allocating a canvas, reject anything wildly outside
 * what a real slide could ever need — a legitimate 16:9 slide at 150 DPI
 * is roughly 2000x1125px (~2.3 megapixels); this allows a very generous
 * margin above that (a full US Letter/A0 poster at high DPI, e.g.) while
 * refusing a malformed or adversarial page whose declared size would
 * otherwise make `canvas.width = ...` try to allocate a bitmap large
 * enough to exhaust the webview renderer's memory — the other concrete,
 * fixable mechanism (alongside the missing timeout above) behind an
 * import silently consuming memory until the whole app is killed for it.
 */
const MAX_CANVAS_DIMENSION_PX = 20_000; // per side
const MAX_CANVAS_PIXELS = 60_000_000; // ~60 megapixels total

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function renderPagesInternal(doc, onProgress) {
  const pages = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);

    if (width <= 0 || height <= 0 || width > MAX_CANVAS_DIMENSION_PX || height > MAX_CANVAS_DIMENSION_PX || width * height > MAX_CANVAS_PIXELS) {
      page.cleanup();
      throw new Error(
        `Slide ${pageNum} has an unusually large or invalid page size (${width}x${height}px at 150 DPI) and was refused ` +
          "rather than risk running out of memory. This usually means the source file is corrupted or was built with an " +
          "unusual custom slide size."
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`Page ${pageNum} produced no image`))), "image/png")
    );
    pages.push(new Uint8Array(await blob.arrayBuffer()));
    onProgress?.(pageNum, doc.numPages);

    page.cleanup();
    canvas.width = 0;
    canvas.height = 0; // release the backing bitmap promptly for large PDFs
  }
  return pages;
}

/**
 * Renders every page of `bytes` (a PDF file's raw bytes) to a PNG. Returns
 * an array of `Uint8Array`, one per page, in page order — mirroring what
 * the Rust `convert_pdf_to_slides` command used to hand back as filenames,
 * except these are ready-to-import bytes directly, with no temp files and
 * no subprocess.
 *
 * Bounded by RENDER_TIMEOUT_MS end-to-end and by MAX_CANVAS_*_PX per page
 * (see both above) — a hang or an oversized page produces a clear
 * rejection instead of an indefinite stall or an out-of-memory crash.
 */
export async function renderPdfPagesToPngs(bytes, { onProgress } = {}) {
  const pdfjsLib = await loadPdfJs();
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  try {
    return await withTimeout(
      renderPagesInternal(doc, onProgress),
      RENDER_TIMEOUT_MS,
      `Rendering this PowerPoint/PDF's slides took too long (over ${RENDER_TIMEOUT_MS / 1000}s) and was stopped. ` +
        "The file may be too large or complex, or the in-app renderer may be stuck. Try again, or restart OmniDeck if this keeps happening."
    );
  } finally {
    await doc.destroy();
  }
}

/** Extracts all text from `bytes` (a PDF's raw bytes), page breaks as blank lines. */
export async function extractPdfText(bytes) {
  const pdfjsLib = await loadPdfJs();
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  try {
    const pageTexts = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => item.str).join(" ").trim());
      page.cleanup();
    }
    const text = pageTexts.filter(Boolean).join("\n\n").trim();
    if (!text) {
      throw new Error(
        "This PDF has no extractable text (it may be a scanned image with no text layer). " +
          "Text extraction only works on PDFs that contain real text, not scanned pictures of pages."
      );
    }
    return text;
  } finally {
    await doc.destroy();
  }
}
