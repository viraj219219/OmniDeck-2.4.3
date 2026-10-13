import { uid } from "../utils/dom.js";
import { readJSON, writeJSONStrict, isRunningInTauri, StorageReadError } from "../utils/storageAdapter.js";
import { SerialSaveQueue } from "../utils/SaveQueue.js";
import * as pdfJsService from "./PdfJsService.js";

const FILE = "media-library.json";

export const MEDIA_KINDS = ["image", "video", "presentation", "pdf"];

const KIND_DIR = {
  image: "media/images",
  video: "media/videos",
  presentation: "media/presentations",
  pdf: "media/pdfs",
};
const THUMB_DIR = "media/thumbnails";

const KIND_EXTENSIONS = {
  image: ["png", "jpg", "jpeg", "gif", "webp"],
  video: ["mp4", "mov", "webm", "mkv"],
  presentation: ["pptx", "ppt"],
  pdf: ["pdf"],
};

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  pdf: "application/pdf",
};

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

/**
 * MediaService — the contract every view/component codes against.
 * Abstract only; never instantiated directly at runtime (see the singleton
 * exported at the bottom, which is always a real, storage-backed
 * implementation for the environment we're running in).
 */
/**
 * Thrown when a delete is refused because something still references the
 * media (or because that couldn't be verified — deletion fails CLOSED).
 * `code` is "in-use" or "unverifiable"; `lessons` lists referencing lessons.
 */
export class MediaInUseError extends Error {
  constructor(message, { code = "in-use", lessons = [] } = {}) {
    super(message);
    this.name = "MediaInUseError";
    this.code = code;
    this.lessons = lessons;
  }
}

export class MediaService {
  constructor() {
    this._referenceProvider = null;
  }

  /**
   * Registers the reference checker deletion must pass:
   * `async (mediaId) => ({ referenced: boolean, lessons: [...] })`.
   * LessonService registers itself on load (see LessonService.js). Until a
   * checker is registered, removeMedia REFUSES to delete anything.
   */
  setReferenceProvider(fn) { this._referenceProvider = fn; }

  /**
   * THE reference-safety gate — every physical deletion in every subclass
   * goes through this, so no caller (Media Library, scripture-page image replacement,
   * import rollback, ...) can delete a file a lesson still uses.
   */
  async _assertDeletable(id) {
    if (!this._referenceProvider) {
      throw new MediaInUseError("Can't delete media: reference checking isn't available, so it can't be verified that no lesson uses this file.", { code: "unverifiable" });
    }
    let result;
    try {
      result = await this._referenceProvider(id);
    } catch (err) {
      throw new MediaInUseError(`Can't delete media: checking which lessons use it failed (${err?.message || err}).`, { code: "unverifiable" });
    }
    if (result?.referenced) {
      const titles = (result.lessons || []).map((l) => l.title);
      throw new MediaInUseError(
        titles.length
          ? `This file is still used by ${titles.length} lesson${titles.length === 1 ? "" : "s"} (${titles.slice(0, 3).join(", ")}${titles.length > 3 ? ", …" : ""}) and was not deleted.`
          : "This file is still referenced by the last saved version of a lesson and was not deleted.",
        { code: "in-use", lessons: result.lessons || [] }
      );
    }
  }

  async listMedia(_kind) { throw new Error("MediaService is abstract"); }
  async pickFiles(_kind, _opts) { throw new Error("MediaService is abstract"); }
  async importBytes(_kind, _bytes, _name, _mime) { throw new Error("MediaService is abstract"); }
  /** Deletes a media item's files + record. Throws MediaInUseError if referenced. */
  async removeMedia(_id) { throw new Error("MediaService is abstract"); }
  async isReferenced(_id) { throw new Error("MediaService is abstract"); }
  /** True only if the record exists AND (where files are real) its file is on disk. */
  async verifyAsset(_id) { throw new Error("MediaService is abstract"); }
  async flush() {}
  getAssetUrl(_item) { throw new Error("MediaService is abstract"); }
  async convertPresentation(_id) { throw new Error("MediaService is abstract"); }
  async convertPdfPages(_id) { throw new Error("MediaService is abstract"); }
  async getSlideAssetUrl(_item, _slideFilename) { throw new Error("MediaService is abstract"); }
  async readSlideBytes(_item, _slideFilename) { throw new Error("MediaService is abstract"); }
}

/**
 * Real, Tauri-backed media storage.
 *
 * On import, a user-picked file is COPIED (bytes, not just the path) into
 * `AppLocalData/media/<kind>/<id>.<ext>` so the library survives even if the
 * user moves, renames, or deletes the original file. Metadata (id, original
 * filename, managed path, mime, size, created date, optional thumbnail) is
 * persisted alongside via storageAdapter.
 *
 * See src-tauri/capabilities/default.json for the filesystem permissions
 * this requires, and src-tauri/tauri.conf.json's `app.security.assetProtocol`
 * for how `getAssetUrl()` is allowed to actually serve these files to
 * <img>/<video> elements in the webview.
 */
export class TauriMediaService extends MediaService {
  constructor() {
    super();
    this._cache = null;
    this._loadPromise = null;
    this._dirsEnsured = new Set();
    // One serialized, coalescing pipeline for media-library.json — every
    // library mutation (import, convert, delete) persists through it.
    this._queue = new SerialSaveQueue(() => this._writeSnapshot(), { name: "media-library" });
  }

  async _fs() {
    return window.__TAURI__.fs;
  }
  async _dialog() {
    return window.__TAURI__.dialog;
  }
  async _path() {
    return window.__TAURI__.path;
  }
  async _core() {
    return window.__TAURI__.core;
  }

  async _load() {
    if (this._cache) return this._cache;
    if (!this._loadPromise) this._loadPromise = this._loadOnce();
    try {
      return await this._loadPromise;
    } finally {
      if (!this._cache) this._loadPromise = null;
    }
  }

  async _loadOnce() {
    let stored;
    try {
      stored = await readJSON(FILE, null, { validate: Array.isArray });
    } catch (err) {
      // Same read-safety contract as LessonService: a real teacher's media
      // index that exists but can't be trusted (and has no valid backup)
      // must surface as an error, never as a silent empty library.
      const reason = err instanceof StorageReadError && err.code === "corrupt"
        ? "your media library file is corrupted"
        : "your media library file could not be read";
      throw new Error(`Couldn't load your media library — ${reason}. Nothing has been deleted. (${err.message})`);
    }
    this._cache = stored || [];
    return this._cache;
  }

  async _writeSnapshot() {
    await writeJSONStrict(FILE, this._cache, { validate: Array.isArray });
  }

  async _persist() {
    try {
      await this._queue.request();
    } catch (err) {
      throw new Error(`Failed to save the media library to disk. ${err?.message || err}`.trim(), { cause: err });
    }
  }

  async flush() {
    if (!this._cache) return;
    await this._queue.flush();
  }

  async _ensureDir(relDir) {
    if (this._dirsEnsured.has(relDir)) return;
    const { BaseDirectory, exists, mkdir } = await this._fs();
    const dir = BaseDirectory.AppLocalData;
    if (!(await exists(relDir, { baseDir: dir }))) {
      await mkdir(relDir, { baseDir: dir, recursive: true });
    }
    this._dirsEnsured.add(relDir);
  }

  async listMedia(kind) {
    const items = await this._load();
    return kind ? items.filter((m) => m.kind === kind) : items;
  }

  async isReferenced(id) {
    // Cross-checked by the caller against actual lesson pages (LessonService
    // owns lesson data); this just exposes the media item for that check.
    const items = await this._load();
    return items.find((m) => m.id === id) || null;
  }

  /** Directory (relative to AppLocalData) that holds a media item's converted page/slide PNGs. */
  _slidesDirFor(kind, id) {
    return `${KIND_DIR[kind] || "media/misc"}/${id}-slides`;
  }

  async _removePath(rel, { recursive = false } = {}) {
    const { BaseDirectory, remove, exists } = await this._fs();
    const opts = { baseDir: BaseDirectory.AppLocalData };
    if (await exists(rel, opts)) await remove(rel, recursive ? { ...opts, recursive: true } : opts);
  }

  /** Best-effort removal of everything on disk that belongs to `record`. Never throws. */
  async _removeFilesQuietly(record) {
    const targets = [
      [record.managedPath, false],
      [record.thumbnailPath, false],
      [record.slidesDir, true],
      [this._slidesDirFor(record.kind, record.id), true],
    ];
    for (const [rel, recursive] of targets) {
      if (!rel) continue;
      try { await this._removePath(rel, { recursive }); } catch (err) {
        console.warn(`[MediaService] couldn't clean up ${rel}`, err);
      }
    }
  }

  /**
   * Undoes records created by a failed call: their files and their entries
   * in the library. Used so a failed import never leaves orphan files or
   * ghost records behind. Never throws.
   */
  async _discardRecords(records) {
    if (!records.length) return;
    const items = await this._load();
    for (const record of records) {
      await this._removeFilesQuietly(record);
      const idx = items.indexOf(record);
      if (idx !== -1) items.splice(idx, 1);
    }
    try { await this._persist(); } catch (err) {
      console.warn("[MediaService] couldn't persist the library after discarding records", err);
    }
  }

  /**
   * Checks that every converted page/slide file the converter reported is
   * really on disk and non-empty. A converter claiming success while
   * leaving missing/empty images is a failure, not a partial success.
   */
  async _verifySlideFiles(slidesRelDir, files) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("Conversion reported success but produced no page images.");
    }
    const { BaseDirectory, exists, stat } = await this._fs();
    const opts = { baseDir: BaseDirectory.AppLocalData };
    for (const file of files) {
      const rel = `${slidesRelDir}/${file}`;
      if (!(await exists(rel, opts))) throw new Error(`Conversion reported ${file} but that image is missing on disk.`);
      const info = await stat(rel, opts);
      if (!info || !(info.size > 0)) throw new Error(`Conversion produced an empty image (${file}).`);
    }
  }

  /**
   * Opens the native file picker filtered to the given media kind, then for
   * every selected file: copies its bytes into managed app storage, records
   * real metadata, and (for images) generates a real thumbnail. Duplicate
   * imports of the same file (by path+size) reuse the existing library
   * entry instead of copying again — see `_findDuplicate`.
   *
   * All-or-nothing for the copy phase: if any selected file fails to copy,
   * or the library can't be saved, every file/record this call already
   * created is removed again and the error is thrown.
   *
   * `transaction` (optional, see ImportService.js): newly created records —
   * and ONLY those, never reused pre-existing ones — are registered with it
   * so a later failure in the caller's import can roll them back precisely.
   */
  async pickFiles(kind, { transaction } = {}) {
    const extensions = KIND_EXTENSIONS[kind] || ["*"];
    const { open } = await this._dialog();
    const selection = await open({ multiple: true, filters: [{ name: kind, extensions }] });
    if (!selection) return [];
    const paths = Array.isArray(selection) ? selection : [selection];

    const { BaseDirectory, copyFile, stat, readFile, writeFile } = await this._fs();
    const items = await this._load();
    const added = [];
    const reused = [];

    try {
      for (const absPath of paths) {
        const originalName = absPath.split(/[\\/]/).pop();
        const ext = extOf(originalName) || (KIND_EXTENSIONS[kind] || [])[0] || "bin";

        let sourceStat;
        try {
          sourceStat = await stat(absPath);
        } catch (err) {
          throw new Error(`Could not read "${originalName}": ${err?.message || err}`);
        }

        const dup = await this._findDuplicate(items, absPath, sourceStat.size, kind);
        if (dup) { reused.push(dup); continue; }

        const id = uid("media");
        const relDir = KIND_DIR[kind] || "media/misc";
        const managedPath = `${relDir}/${id}.${ext}`;

        await this._ensureDir(relDir);
        const record = {
          id,
          kind,
          name: originalName,
          managedPath,
          sourcePathAtImport: absPath,
          sourceSize: sourceStat.size,
          mime: MIME_BY_EXT[ext] || "application/octet-stream",
          size: sourceStat.size,
          thumbnailPath: null,
          addedAt: new Date().toISOString(),
          source: "local",
        };
        // Tracked BEFORE the copy so a half-copied file is cleaned up too.
        added.push(record);
        try {
          await copyFile(absPath, managedPath, { toPathBaseDir: BaseDirectory.AppLocalData });
        } catch (err) {
          throw new Error(`Failed to copy "${originalName}" into app storage: ${err?.message || err}`);
        }

        if (kind === "image") {
          try {
            record.thumbnailPath = await this._makeImageThumbnail(id, absPath, managedPath, readFile, writeFile, BaseDirectory);
          } catch (err) {
            console.warn("[MediaService] thumbnail generation failed (non-fatal)", err);
          }
        }
        items.push(record);
      }
      if (added.length) await this._persist();
    } catch (err) {
      await this._discardRecords(added);
      throw err;
    }

    for (const record of added) transaction?.track(record.id);

    // PowerPoint files aren't viewable as-is — convert them to real slide
    // images right away, as part of import, so the teacher sees either
    // real slides or a clear reason why not, rather than a filename badge.
    // PDFs get the same treatment: split into real per-page PNGs so each
    // page becomes its own editable/reorderable lesson page, rather than
    // only ever being embedded whole via the webview's own PDF viewer.
    // A conversion failure is recorded on the item (`conversionError`), not
    // thrown — the caller decides whether that fails the whole import (see
    // ImportService.js).
    for (const record of added) {
      if (record.kind === "presentation") {
        try {
          await this.convertPresentation(record.id);
        } catch (err) {
          console.warn(`[MediaService] presentation conversion failed for ${record.id}`, err);
        }
      } else if (record.kind === "pdf") {
        try {
          await this.convertPdfPages(record.id);
        } catch (err) {
          console.warn(`[MediaService] PDF page rendering failed for ${record.id}`, err);
        }
      }
    }

    return [...added, ...reused];
  }

  /**
   * Shared by convertPresentation / convertPdfPages: runs one Tauri
   * conversion command, verifies every reported page image exists, and
   * records either the real ordered `slideFiles` or a specific
   * `conversionError` — never a fake slide count. A failed or partly
   * written conversion has its half-made output folder removed.
   */
  async _convertWithCommand(id, { kind, command, args, fallbackMessage }) {
    const items = await this._load();
    const record = items.find((m) => m.id === id);
    if (!record) throw new Error(`No media item ${id}`);

    const { invoke } = await this._core();
    const { appLocalDataDir, join } = await this._path();
    const base = await appLocalDataDir();
    const abs = await join(base, record.managedPath);
    const slidesRelDir = this._slidesDirFor(kind, id);
    const absSlidesDir = await join(base, slidesRelDir);

    try {
      const slideFiles = await invoke(command, args(abs, absSlidesDir));
      await this._verifySlideFiles(slidesRelDir, slideFiles);
      record.slidesDir = slidesRelDir;
      record.slideFiles = slideFiles;
      record.conversionError = null;
    } catch (err) {
      record.slidesDir = null;
      record.slideFiles = [];
      record.conversionError = typeof err === "string" ? err : (err?.message || fallbackMessage);
      try { await this._removePath(slidesRelDir, { recursive: true }); } catch (cleanupErr) {
        console.warn(`[MediaService] couldn't remove partial output ${slidesRelDir}`, cleanupErr);
      }
    }
    await this._persist();
    return record;
  }

  /**
   * Converts an already-imported .pptx/.ppt media item into real slide
   * PNGs via the `convert_pptx_to_slides` Tauri command (LibreOffice -> PDF -> in-app pdf.js; see src/js/data/PPTX-SETUP.md).
   */
  async convertPresentation(id) {
    if (await pdfJsService.isAvailable()) {
      return this._convertPresentationWithPdfJs(id);
    }
    // Vendored pdf.js not present — full LibreOffice+pdftoppm pipeline,
    // same as before.
    return this._convertWithCommand(id, {
      kind: "presentation",
      command: "convert_pptx_to_slides",
      args: (pptxPath, workDir) => ({ pptxPath, workDir }),
      fallbackMessage: "PowerPoint conversion failed.",
    });
  }

  /**
   * PowerPoint path once pdf.js is vendored: LibreOffice still does the
   * one thing nothing else can (render OOXML slides with full visual
   * fidelity — gradients, tables, charts, fonts, grouping, etc. — into a
   * PDF), via `convert_pptx_to_pdf`, but rasterizing THAT PDF into
   * per-slide PNGs is done with pdf.js exactly like `_convertPdfWithPdfJs`
   * rather than `pdftoppm`. Net effect: PowerPoint import needs the
   * bundled/installed LibreOffice runtime and nothing else — Poppler is
   * never invoked on this path.
   */
  async _convertPresentationWithPdfJs(id) {
    const items = await this._load();
    const record = items.find((m) => m.id === id);
    if (!record) throw new Error(`No media item ${id}`);

    const { invoke } = await this._core();
    const { BaseDirectory, writeFile, readFile } = await this._fs();
    const { appLocalDataDir, join } = await this._path();
    const base = await appLocalDataDir();
    const abs = await join(base, record.managedPath);
    const slidesRelDir = this._slidesDirFor("presentation", id);
    const absSlidesDir = await join(base, slidesRelDir);

    try {
      const pdfPath = await invoke("convert_pptx_to_pdf", { pptxPath: abs, workDir: absSlidesDir });
      const pdfBytes = await readFile(pdfPath);
      const pages = await pdfJsService.renderPdfPagesToPngs(pdfBytes);
      if (!pages.length) throw new Error("Conversion completed but produced no slide images.");

      await this._ensureDir(slidesRelDir);
      const digits = String(pages.length).length;
      const slideFiles = pages.map((_, i) => `slide-${String(i + 1).padStart(digits, "0")}.png`);
      for (let i = 0; i < pages.length; i++) {
        await writeFile(`${slidesRelDir}/${slideFiles[i]}`, pages[i], { baseDir: BaseDirectory.AppLocalData });
      }

      await this._verifySlideFiles(slidesRelDir, slideFiles);
      record.slidesDir = slidesRelDir;
      record.slideFiles = slideFiles;
      record.conversionError = null;
    } catch (err) {
      record.slidesDir = null;
      record.slideFiles = [];
      record.conversionError = typeof err === "string" ? err : (err?.message || "PowerPoint conversion failed.");
      try { await this._removePath(slidesRelDir, { recursive: true }); } catch (cleanupErr) {
        console.warn(`[MediaService] couldn't remove partial output ${slidesRelDir}`, cleanupErr);
      }
    }
    await this._persist();
    return record;
  }

  /**
   * Converts an already-imported PDF media item into real per-page PNGs
   * via `convert_pdf_to_slides` (poppler `pdftoppm` directly). Mirrors
   * convertPresentation exactly, including which record fields it sets
   * (`slidesDir` / `slideFiles` / `conversionError`). A PDF that hasn't
   * converted (or a machine without poppler) still displays via the
   * webview's own embedded PDF viewer.
   */
  async convertPdfPages(id) {
    if (await pdfJsService.isAvailable()) {
      return this._convertPdfWithPdfJs(id);
    }
    // Vendored pdf.js not present in this build — same Rust/pdftoppm path
    // as before, so nothing regresses until the CI vendoring step lands.
    return this._convertWithCommand(id, {
      kind: "pdf",
      command: "convert_pdf_to_slides",
      args: (pdfPath, workDir) => ({ pdfPath, workDir }),
      fallbackMessage: "PDF page rendering failed.",
    });
  }

  /**
   * Primary PDF page-splitting path: renders every page to a PNG with
   * pdf.js directly in the webview (see PdfJsService.js) and writes each
   * PNG into this record's slides directory — no subprocess, no Poppler,
   * identical on every OS. Mirrors `_convertWithCommand`'s contract
   * exactly (same `slidesDir` / `slideFiles` / `conversionError` fields,
   * same verify-then-persist behaviour, same cleanup of a half-written
   * output directory on failure) so callers can't tell which path ran.
   */
  async _convertPdfWithPdfJs(id) {
    const items = await this._load();
    const record = items.find((m) => m.id === id);
    if (!record) throw new Error(`No media item ${id}`);

    const { BaseDirectory, writeFile } = await this._fs();
    const { appLocalDataDir, join } = await this._path();
    const base = await appLocalDataDir();
    const abs = await join(base, record.managedPath);
    const slidesRelDir = this._slidesDirFor("pdf", id);

    try {
      const { readFile } = await this._fs();
      const bytes = await readFile(abs);
      const pages = await pdfJsService.renderPdfPagesToPngs(bytes);
      if (!pages.length) throw new Error("Conversion completed but produced no page images.");

      await this._ensureDir(slidesRelDir);
      const digits = String(pages.length).length;
      const slideFiles = pages.map((_, i) => `slide-${String(i + 1).padStart(digits, "0")}.png`);
      for (let i = 0; i < pages.length; i++) {
        await writeFile(`${slidesRelDir}/${slideFiles[i]}`, pages[i], { baseDir: BaseDirectory.AppLocalData });
      }

      await this._verifySlideFiles(slidesRelDir, slideFiles);
      record.slidesDir = slidesRelDir;
      record.slideFiles = slideFiles;
      record.conversionError = null;
    } catch (err) {
      record.slidesDir = null;
      record.slideFiles = [];
      record.conversionError = typeof err === "string" ? err : (err?.message || "PDF page rendering failed.");
      try { await this._removePath(slidesRelDir, { recursive: true }); } catch (cleanupErr) {
        console.warn(`[MediaService] couldn't remove partial output ${slidesRelDir}`, cleanupErr);
      }
    }
    await this._persist();
    return record;
  }

  /** Resolves an `asset://` URL for one already-converted slide PNG. */
  async getSlideAssetUrl(item, slideFilename) {
    if (!item?.slidesDir || !slideFilename) return null;
    const { convertFileSrc } = await this._core();
    const { appLocalDataDir, join } = await this._path();
    const abs = await join(await appLocalDataDir(), item.slidesDir, slideFilename);
    return convertFileSrc(abs);
  }

  /**
   * Reads the real raw bytes of one already-converted slide PNG — used
   * when importing a PowerPoint so each of its slides can become its own
   * individual, independently-editable "image" media asset (see
   * lessonEditor.js's PowerPoint import flow), rather than one deck kept
   * as a single multi-slide page. Real file bytes via Tauri's fs plugin,
   * never a placeholder.
   */
  async readSlideBytes(item, slideFilename) {
    if (!item?.slidesDir || !slideFilename) throw new Error("No slide image to read.");
    const { readFile } = await this._fs();
    const { appLocalDataDir, join } = await this._path();
    const abs = await join(await appLocalDataDir(), item.slidesDir, slideFilename);
    return readFile(abs);
  }

  /**
   * Imports raw bytes (not a file on disk) as a real managed media asset —
   * used for AI-generated images and for each page of a converted
   * PowerPoint/PDF. Writes the file for real, verifies it landed at the
   * right size, records real metadata, and (for images) makes a real
   * thumbnail. If anything after the file write fails (including saving the
   * library), the file and record are removed again — no orphans.
   */
  async importBytes(kind, bytes, name, mime) {
    if (!bytes || !(bytes.byteLength > 0)) {
      throw new Error(`Refusing to import an empty ${kind} — there was nothing to save.`);
    }
    const ext = extOf(name) || (KIND_EXTENSIONS[kind] || [])[0] || "bin";
    const id = uid("media");
    const relDir = KIND_DIR[kind] || "media/misc";
    const managedPath = `${relDir}/${id}.${ext}`;
    const { BaseDirectory, writeFile, stat } = await this._fs();

    const record = {
      id, kind, name: name || `generated.${ext}`, managedPath,
      sourcePathAtImport: null, sourceSize: bytes.byteLength,
      mime: mime || MIME_BY_EXT[ext] || "application/octet-stream",
      size: bytes.byteLength, thumbnailPath: null,
      addedAt: new Date().toISOString(), source: "generated",
    };

    try {
      await this._ensureDir(relDir);
      try {
        await writeFile(managedPath, bytes, { baseDir: BaseDirectory.AppLocalData });
      } catch (err) {
        throw new Error(`Failed to save generated ${kind} to app storage: ${err?.message || err}`);
      }
      const written = await stat(managedPath, { baseDir: BaseDirectory.AppLocalData });
      if (written?.size !== bytes.byteLength) {
        throw new Error(`Saved ${kind} is ${written?.size ?? 0} bytes on disk but ${bytes.byteLength} were expected.`);
      }

      if (kind === "image") {
        try {
          const { readFile } = await this._fs();
          record.thumbnailPath = await this._makeImageThumbnail(id, null, managedPath, readFile, writeFile, BaseDirectory);
        } catch (err) {
          console.warn("[MediaService] thumbnail generation failed (non-fatal)", err);
        }
      }

      const items = await this._load();
      items.push(record);
      try {
        await this._persist();
      } catch (err) {
        const idx = items.indexOf(record);
        if (idx !== -1) items.splice(idx, 1);
        throw err;
      }
    } catch (err) {
      await this._removeFilesQuietly(record);
      throw err;
    }
    return record;
  }

  async _findDuplicate(items, absPath, size, kind) {
    // File hashing would need reading the whole file into memory; as a
    // practical, honest middle ground we de-duplicate on the combination of
    // original source path + size + kind, which correctly catches the
    // common case (re-importing the same file) without hashing every byte
    // on every import. A true content hash could be layered on top later
    // for files moved/renamed between imports.
    return items.find((m) => m.kind === kind && m.sourcePathAtImport === absPath && m.sourceSize === size) || null;
  }

  async _makeImageThumbnail(id, absPath, managedPath, readFile, writeFile, BaseDirectory) {
    await this._ensureDir(THUMB_DIR);
    const { convertFileSrc } = await this._core();
    const { appLocalDataDir, join } = await this._path();
    const absManaged = await join(await appLocalDataDir(), managedPath);
    const url = convertFileSrc(absManaged);

    const bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode image for thumbnail"));
      img.src = url;
    });
    const maxDim = 240;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const thumbPath = `${THUMB_DIR}/${id}.jpg`;
    await writeFile(thumbPath, bytes, { baseDir: BaseDirectory.AppLocalData });
    return thumbPath;
  }

  /** Resolves an `asset://` URL an <img>/<video>/<iframe> can load directly. */
  async getAssetUrl(item) {
    if (!item) return null;
    const { convertFileSrc } = await this._core();
    const { appLocalDataDir, join } = await this._path();
    const relPath = item.thumbnailUse ? item.thumbnailPath || item.managedPath : item.managedPath;
    const abs = await join(await appLocalDataDir(), relPath);
    return convertFileSrc(abs);
  }

  /**
   * Physically deletes a media item — ONLY if nothing references it (see
   * MediaService._assertDeletable; throws MediaInUseError otherwise).
   *
   * Order is chosen so a failure can never strand a lesson:
   *   1. reference check (fails closed)
   *   2. delete the main file — if THAT fails the record is KEPT (and the
   *      error thrown) so the item stays visible and can be retried
   *   3. best-effort delete thumbnail + converted-page folders
   *   4. drop the record and persist the library
   * Idempotent: retrying after a step-4 failure just persists again.
   */
  async removeMedia(id) {
    const items = await this._load();
    const item = items.find((m) => m.id === id);
    if (!item) return { removed: false, reason: "not-found" };

    await this._assertDeletable(id);

    if (item.managedPath) {
      try {
        await this._removePath(item.managedPath);
      } catch (err) {
        throw new Error(`Couldn't delete "${item.name}" from disk (${err?.message || err}). It was kept in your library — try again.`, { cause: err });
      }
    }
    for (const [rel, recursive] of [[item.thumbnailPath, false], [item.slidesDir, true], [this._slidesDirFor(item.kind, item.id), true]]) {
      if (!rel) continue;
      try { await this._removePath(rel, { recursive }); } catch (err) {
        console.warn(`[MediaService] failed to delete ${rel} for ${id}`, err);
      }
    }

    const idx = items.indexOf(item);
    if (idx !== -1) items.splice(idx, 1);
    try {
      await this._persist();
    } catch (err) {
      // The files are gone; put the record back so the library and disk
      // agree, and let the caller retry.
      if (!items.includes(item)) items.push(item);
      throw err;
    }
    return { removed: true };
  }

  async verifyAsset(id) {
    const items = await this._load();
    const item = items.find((m) => m.id === id);
    if (!item) return false;
    if (!item.managedPath) return true;
    const { BaseDirectory, exists } = await this._fs();
    return exists(item.managedPath, { baseDir: BaseDirectory.AppLocalData });
  }
}

/**
 * Browser dev-preview fallback (no Tauri runtime present). There is no real
 * filesystem to copy into here, so this keeps picked files as in-memory
 * Blobs + object URLs for the current session only — this is a genuine,
 * working implementation for UI iteration in a plain browser tab, but it is
 * NOT persistent across a reload (object URLs and Blobs live in page
 * memory). That limitation is real and disclosed, not hidden: the media
 * library view should be tested against `TauriMediaService` (i.e. running
 * inside the actual app via `npm run dev`) for anything persistence-related.
 */
export class BrowserPreviewMediaService extends MediaService {
  constructor() {
    super();
    this._items = [];
    this._blobUrls = new Map(); // id -> object URL
  }

  async listMedia(kind) {
    return kind ? this._items.filter((m) => m.kind === kind) : this._items;
  }

  async isReferenced(id) {
    return this._items.find((m) => m.id === id) || null;
  }

  async pickFiles(kind) {
    const extensions = KIND_EXTENSIONS[kind] || ["*"];
    const files = await new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = extensions.map((e) => `.${e}`).join(",");
      input.onchange = () => resolve(Array.from(input.files || []));
      input.click();
    });

    const added = [];
    for (const file of files) {
      const id = uid("media");
      const url = URL.createObjectURL(file);
      this._blobUrls.set(id, url);
      const record = {
        id, kind, name: file.name, managedPath: null, mime: file.type || MIME_BY_EXT[extOf(file.name)] || "application/octet-stream",
        size: file.size, thumbnailPath: null, addedAt: new Date().toISOString(), source: "browser-preview-session-only",
      };
      this._items.push(record);
      added.push(record);
    }
    return added;
  }

  async importBytes(kind, bytes, name, mime) {
    const id = uid("media");
    const blob = new Blob([bytes], { type: mime || MIME_BY_EXT[extOf(name)] || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    this._blobUrls.set(id, url);
    const record = {
      id, kind, name: name || "generated", managedPath: null, mime: blob.type,
      size: bytes.byteLength, thumbnailPath: null, addedAt: new Date().toISOString(), source: "generated-session-only",
    };
    this._items.push(record);
    return record;
  }

  async getAssetUrl(item) {
    return item ? this._blobUrls.get(item.id) || null : null;
  }

  async convertPresentation(id) {
    // No Tauri backend here to shell out to LibreOffice/poppler — this is
    // a real, disclosed limitation of the browser dev-preview, not a fake
    // success. Run inside the actual app (`npm run dev`) to convert PPTX.
    const item = this._items.find((m) => m.id === id);
    if (item) item.conversionError = "PowerPoint rendering requires the desktop app — not available in browser preview.";
    return item;
  }

  async convertPdfPages(id) {
    // Same real, disclosed limitation as convertPresentation above — no
    // Tauri filesystem/poppler to render page images with here. The PDF
    // still displays fine via the browser's own native <iframe> PDF
    // viewer (see mediaRenderer.js), just not split into per-page slides.
    const item = this._items.find((m) => m.id === id);
    if (item) item.conversionError = "Splitting a PDF into per-page slides requires the desktop app — not available in browser preview.";
    return item;
  }

  async getSlideAssetUrl() {
    return null;
  }

  async readSlideBytes() {
    // Real, disclosed limitation — same as convertPresentation above: no
    // Tauri filesystem to read converted slide images from in the browser
    // dev-preview.
    throw new Error("Reading PowerPoint slide images requires the desktop app — not available in browser preview.");
  }

  async removeMedia(id) {
    if (!this._items.some((m) => m.id === id)) return { removed: false, reason: "not-found" };
    await this._assertDeletable(id);
    const url = this._blobUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    this._blobUrls.delete(id);
    this._items = this._items.filter((m) => m.id !== id);
    return { removed: true };
  }

  async verifyAsset(id) {
    return this._items.some((m) => m.id === id);
  }
}

// Singleton used throughout the app — always a real, storage-backed
// implementation for whichever environment is currently running.
export const mediaService = isRunningInTauri ? new TauriMediaService() : new BrowserPreviewMediaService();
