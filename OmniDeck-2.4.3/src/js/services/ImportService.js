// ImportService — transactional PowerPoint / PDF / backup imports.
//
// An import creates several real resources (a managed copy of the file,
// converted page images, one media record per page) BEFORE the lesson that
// uses them is saved. If anything fails midway, those resources must not
// be left behind, and the lesson must not be left half-built. So every
// import runs inside an ImportTransaction that remembers exactly which
// media THIS import created:
//
//   validate input -> convert -> render/read every page -> validate each
//   asset -> register media -> build pages in memory -> attach + persist
//   the lesson ONCE -> COMMIT
//   any failure -> ROLLBACK: remove only the media this import created
//                  (never pre-existing user media), via the reference-safe
//                  MediaService.removeMedia
//
// Nothing is attached to the lesson until the final persist, so a failure
// before that leaves the lesson byte-for-byte as it was.

import { mediaService as defaultMediaService, MediaInUseError } from "./MediaService.js";
import { lessonService as defaultLessonService, blankPage } from "./LessonService.js";
import { uid } from "../utils/dom.js";

export class ImportError extends Error {
  /**
   * `stage`: "validate" | "pick" | "convert" | "render" | "register" |
   * "create" | "persist". `rollback` reports what cleanup did.
   */
  constructor(message, { stage, cause, rollback = null } = {}) {
    super(message);
    this.name = "ImportError";
    this.stage = stage;
    this.cause = cause;
    this.rollback = rollback;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function looksLikePng(bytes) {
  return !!bytes && bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Tracks the media created by ONE import so rollback is precise. */
export class ImportTransaction {
  constructor({ mediaService = defaultMediaService } = {}) {
    this.mediaService = mediaService;
    this._created = []; // insertion order
    this.state = "open"; // "open" | "committed" | "rolled-back"
  }

  /** Called by MediaService.pickFiles for each NEWLY created record. */
  track(id) {
    if (!this._created.includes(id)) this._created.push(id);
  }

  has(id) { return this._created.includes(id); }
  get createdIds() { return [...this._created]; }

  async importBytes(kind, bytes, name, mime) {
    const record = await this.mediaService.importBytes(kind, bytes, name, mime);
    this.track(record.id);
    return record;
  }

  commit() {
    this.state = "committed";
    this._created = [];
  }

  /**
   * Removes every media item this import created, newest first. Only ids
   * recorded here are ever touched. Returns { removed, kept, failed }.
   */
  async rollback() {
    const outcome = { removed: [], kept: [], failed: [] };
    if (this.state !== "open") return outcome;
    for (const id of [...this._created].reverse()) {
      try {
        const r = await this.mediaService.removeMedia(id);
        if (r?.removed === false) outcome.failed.push({ id, error: new Error(r.reason || "not removed") });
        else outcome.removed.push(id);
      } catch (err) {
        if (err instanceof MediaInUseError) outcome.kept.push(id);
        else outcome.failed.push({ id, error: err });
      }
    }
    this.state = "rolled-back";
    this._created = [];
    return outcome;
  }
}


/** Reads width/height from a PNG's IHDR chunk; null if the bytes are too short/odd. */
export function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const isIhdr = bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
  if (!isIhdr) return null;
  const rd = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  const width = rd(16);
  const height = rd(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * One imported PowerPoint slide / PDF page -> one real, fully editable OmniDeck
 * slide. It is a canvas ("freeform") slide whose background IS the rendered
 * picture, so there is no "Image" title or caption bar around it, and the
 * teacher keeps everything OmniDeck offers on any slide: add text/image boxes,
 * change or replace the background, reorder, duplicate, delete, present.
 */
function buildSlidePage(makePage, record, pageName, bytes) {
  const page = makePage("freeform");
  page.title = pageName;
  page.fileName = record.name;
  page.boxes = [];
  page.background = { type: "image", mediaId: record.id, fit: "contain" };
  const size = pngSize(bytes);
  if (size) page.sourceAspect = Math.round((size.width / size.height) * 1000) / 1000;
  return page;
}

const KIND_LABEL = { presentation: "PowerPoint", pdf: "PDF" };

async function fail(tx, err, stage) {
  const rollback = await tx.rollback();
  if (err instanceof ImportError) {
    err.rollback = rollback;
    throw err;
  }
  throw new ImportError(err?.message || String(err), { stage, cause: err, rollback });
}

async function ensureConverted(mediaService, tx, item, kind) {
  if (item.slideFiles?.length && !item.conversionError) return item;
  // A record reused from an earlier import that never converted: retry now.
  // (A freshly created record already had its one conversion attempt.)
  if (!tx.has(item.id) && (kind === "presentation" || kind === "pdf")) {
    return kind === "presentation" ? mediaService.convertPresentation(item.id) : mediaService.convertPdfPages(item.id);
  }
  return item;
}

/**
 * PowerPoint/PDF -> one lesson page per slide/page, added to an existing
 * lesson in a single persisted step. A PDF that can't be split into images
 * (poppler missing) still imports as one embedded-PDF page — that is a
 * working import, not a failure — while a PowerPoint that can't be
 * converted fails and rolls back (there is nothing displayable to add).
 *
 * Returns { cancelled: true } if the teacher dismissed the file picker.
 */
export async function importSlidesAsPages(lessonId, kind, deps = {}) {
  const mediaService = deps.mediaService ?? defaultMediaService;
  const lessonService = deps.lessonService ?? defaultLessonService;
  const makePage = deps.blankPage ?? blankPage;

  if (kind !== "presentation" && kind !== "pdf") {
    throw new ImportError(`Can't import unsupported kind "${kind}".`, { stage: "validate" });
  }
  const label = KIND_LABEL[kind];
  const tx = new ImportTransaction({ mediaService });

  try {
    if (deps.dependencies) {
      try {
        await deps.dependencies.assertReady(kind);
      } catch (err) {
        throw new ImportError(err?.message || `The ${label} import tools aren't ready.`, { stage: "validate", cause: err });
      }
    }

    let picked;
    try {
      picked = await mediaService.pickFiles(kind, { transaction: tx });
    } catch (err) {
      throw new ImportError(err?.message || `Couldn't import the ${label} file.`, { stage: "pick", cause: err });
    }
    if (!picked.length) return { cancelled: true, pages: [], warnings: [] };

    const pages = [];
    const warnings = [];
    let slideCount = 0;

    for (const original of picked) {
      let item;
      try {
        item = await ensureConverted(mediaService, tx, original, kind);
      } catch (err) {
        throw new ImportError(err?.message || `${label} conversion failed.`, { stage: "convert", cause: err });
      }

      if (item.conversionError || !item.slideFiles?.length) {
        if (kind === "pdf") {
          const page = makePage("pdf");
          page.mediaId = item.id;
          page.fileName = item.name;
          pages.push(page);
          warnings.push(`"${item.name}" couldn't be split into page images (${item.conversionError || "no pages produced"}), so it was added as one embedded PDF page.`);
          continue;
        }
        throw new ImportError(item.conversionError || `The ${label} file couldn't be converted into slides.`, { stage: "convert" });
      }

      const total = item.slideFiles.length;
      for (let i = 0; i < total; i++) {
        let bytes;
        try {
          bytes = await mediaService.readSlideBytes(item, item.slideFiles[i]);
        } catch (err) {
          throw new ImportError(`Couldn't read ${kind === "pdf" ? "page" : "slide"} ${i + 1} of "${item.name}": ${err?.message || err}`, { stage: "render", cause: err });
        }
        if (!looksLikePng(bytes)) {
          throw new ImportError(`${kind === "pdf" ? "Page" : "Slide"} ${i + 1} of "${item.name}" isn't a valid image, so nothing was imported.`, { stage: "render" });
        }

        const base = kind === "pdf" ? "Page" : "Slide";
        const pageName = total > 1 ? `${base} ${i + 1}` : item.name.replace(/\.(pptx|ppt|pdf)$/i, "");
        let record;
        try {
          record = await tx.importBytes("image", bytes, `${pageName}.png`, "image/png");
        } catch (err) {
          throw new ImportError(`Couldn't register ${base.toLowerCase()} ${i + 1} of "${item.name}": ${err?.message || err}`, { stage: "register", cause: err });
        }
        if (!(await mediaService.verifyAsset(record.id))) {
          throw new ImportError(`${base} ${i + 1} of "${item.name}" wasn't found on disk after importing it.`, { stage: "register" });
        }

        pages.push(buildSlidePage(makePage, record, pageName, bytes));
        slideCount++;
      }
    }

    if (!pages.length) throw new ImportError(`Nothing was imported from the ${label} file.`, { stage: "create" });

    try {
      await lessonService.appendPages(lessonId, pages); // ONE persisted step; undoes itself on failure
    } catch (err) {
      throw new ImportError(`The imported pages couldn't be saved to the lesson: ${err?.message || err}`, { stage: "persist", cause: err });
    }
    tx.commit();
    return { cancelled: false, pages, slideCount, embeddedCount: pages.length - slideCount, warnings };
  } catch (err) {
    return fail(tx, err, "create");
  }
}

/**
 * Import a PowerPoint/PDF as a new lesson. Converted slides/pages become
 * individual OmniDeck pages in source order (one PowerPoint slide = one
 * OmniDeck slide). The lesson and all media are committed transactionally;
 * there is no extra title page and no embedded-presentation navigation.
 */
export async function importFileAsNewLesson(title, kind, deps = {}) {
  const mediaService = deps.mediaService ?? defaultMediaService;
  const lessonService = deps.lessonService ?? defaultLessonService;
  const makePage = deps.blankPage ?? blankPage;

  if (kind !== "presentation" && kind !== "pdf") {
    throw new ImportError(`Can't import unsupported kind "${kind}".`, { stage: "validate" });
  }
  const label = KIND_LABEL[kind];
  const tx = new ImportTransaction({ mediaService });

  try {
    if (deps.dependencies) {
      try {
        await deps.dependencies.assertReady(kind);
      } catch (err) {
        throw new ImportError(err?.message || `The ${label} import tools aren't ready.`, { stage: "validate", cause: err });
      }
    }

    let picked;
    try {
      picked = await mediaService.pickFiles(kind, { transaction: tx });
    } catch (err) {
      throw new ImportError(err?.message || `Couldn't import the ${label} file.`, { stage: "pick", cause: err });
    }
    if (!picked.length) return { cancelled: true, lesson: null };

    const pages = [];
    const warnings = [];
    let slideCount = 0;
    // The New Lesson picker intentionally imports the first selected file,
    // matching its singular button/lesson-title UI.
    const original = picked[0];
    let item;
    try {
      item = await ensureConverted(mediaService, tx, original, kind);
    } catch (err) {
      throw new ImportError(err?.message || `${label} conversion failed.`, { stage: "convert", cause: err });
    }

    if (item.conversionError || !item.slideFiles?.length) {
      if (kind === "presentation") {
        throw new ImportError(item.conversionError || "The PowerPoint file couldn't be converted into slides.", { stage: "convert" });
      }
      // Preserve the existing resilient PDF behavior if page rasterization
      // is unavailable; PowerPoint never falls back to an embedded deck.
      if (!(await mediaService.verifyAsset(item.id))) {
        throw new ImportError(`"${item.name}" wasn't found on disk.`, { stage: "register" });
      }
      const page = makePage("pdf");
      page.mediaId = item.id;
      page.fileName = item.name;
      pages.push(page);
      warnings.push(`"${item.name}" couldn't be split into page images (${item.conversionError || "no pages produced"}), so it was added as one embedded PDF page.`);
    } else {
      const total = item.slideFiles.length;
      for (let i = 0; i < total; i++) {
        let bytes;
        try {
          bytes = await mediaService.readSlideBytes(item, item.slideFiles[i]);
        } catch (err) {
          throw new ImportError(`Couldn't read ${kind === "pdf" ? "page" : "slide"} ${i + 1} of "${item.name}": ${err?.message || err}`, { stage: "render", cause: err });
        }
        if (!looksLikePng(bytes)) {
          throw new ImportError(`${kind === "pdf" ? "Page" : "Slide"} ${i + 1} of "${item.name}" isn't a valid image, so nothing was imported.`, { stage: "render" });
        }
        const base = kind === "pdf" ? "Page" : "Slide";
        const pageName = total > 1 ? `${base} ${i + 1}` : item.name.replace(/\.(pptx|ppt|pdf)$/i, "");
        let record;
        try {
          record = await tx.importBytes("image", bytes, `${pageName}.png`, "image/png");
        } catch (err) {
          throw new ImportError(`Couldn't register ${base.toLowerCase()} ${i + 1} of "${item.name}": ${err?.message || err}`, { stage: "register", cause: err });
        }
        if (!(await mediaService.verifyAsset(record.id))) {
          throw new ImportError(`${base} ${i + 1} of "${item.name}" wasn't found on disk after importing it.`, { stage: "register" });
        }
        pages.push(buildSlidePage(makePage, record, pageName, bytes));
        slideCount++;
      }
    }

    if (!pages.length) throw new ImportError(`Nothing was imported from the ${label} file.`, { stage: "create" });
    const now = new Date().toISOString();
    const lesson = { id: uid("lesson"), title, createdAt: now, updatedAt: now, pages };
    try {
      await lessonService.insertLesson(lesson);
    } catch (err) {
      throw new ImportError(`The lesson couldn't be saved: ${err?.message || err}`, { stage: "persist", cause: err });
    }
    tx.commit();
    return { cancelled: false, lesson, slideCount, embeddedCount: pages.length - slideCount, warnings };
  } catch (err) {
    return fail(tx, err, "create");
  }
}
