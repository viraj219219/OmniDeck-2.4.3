import { lessonService as defaultLessonService, PAGE_TYPES } from "./LessonService.js";
import { mediaService as defaultMediaService, MEDIA_KINDS } from "./MediaService.js";
import { ImportTransaction } from "./ImportService.js";
import { importBackup } from "./BackupService.js";
import { collectLessonMediaIds, remapPageMediaIds } from "../utils/mediaRefs.js";
import { createZip, openZip, ZipFormatError } from "../utils/zip.js";
import { uid } from "../utils/dom.js";

/**
 * Portable native OmniDeck lesson package  (.omnilesson)
 * -----------------------------------------------------
 * A ZIP archive (STORE/DEFLATE, UTF-8 names) containing exactly:
 *
 *   manifest.json            versioned manifest (see below)
 *   assets/<assetId>[.ext]   one file per referenced media asset
 *
 * manifest.json:
 *   {
 *     "format": "omnideck-lesson-package",
 *     "formatVersion": 1,            // readers reject versions they don't know
 *     "app": { "name": "OmniDeck", "version": "2.4.3" },
 *     "exportedAt": "<ISO-8601>",
 *     "lesson": { "title": "...", "pages": [ ... ] },   // slide order = array order
 *     "assets": [ { "id", "kind", "name", "mime", "size", "sha256", "path" } ]
 *   }
 * Pages reference media by "assetId" (the id the media had on the exporting
 * machine) in the same fields the app already uses (mediaId, acceptedImage,
 * background, boxes[]). No absolute paths are stored anywhere; on import every
 * asset is re-created as a NEW media record on the receiving machine and the
 * references are remapped, so it works on a clean install on any OS.
 *
 * Extraction safety: the archive is never unpacked to disk by name. Asset bytes
 * are read in memory and handed to mediaService.importBytes, which chooses its
 * own managed file name. Entry names are additionally validated (no traversal,
 * absolute, drive-letter, backslash or duplicate names), sizes/counts are
 * capped and every asset is verified against its manifest size and SHA-256.
 */
export const PACKAGE_FORMAT = "omnideck-lesson-package";
export const PACKAGE_FORMAT_VERSION = 1;
export const PACKAGE_EXTENSION = "omnilesson";
export const PACKAGE_APP_VERSION = "2.4.3"; // kept equal to package.json by tests/release-config.test.mjs
const MAX_PAGES = 2000;
const MAX_ASSETS = 4000;
const ASSET_PATH_RE = /^assets\/[A-Za-z0-9_-]{1,100}(\.[A-Za-z0-9]{1,10})?$/;
const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export class LessonPackageError extends Error {
  constructor(message, { code = "invalid", details = null } = {}) {
    super(message);
    this.name = "LessonPackageError";
    this.code = code; // invalid | corrupt | unsupported-version | missing-asset | export
    this.details = details;
  }
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeBaseName(name) {
  const base = String(name || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, "").trim();
  return base.slice(0, 200) || "media";
}

function extFromName(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

/** "Title", "Title (2)", "Title (3)" ... never equal to an existing title. */
export function uniqueLessonTitle(base, existingTitles) {
  const taken = new Set([...existingTitles].map((t) => String(t).trim().toLowerCase()));
  const clean = String(base || "").trim() || "Imported Lesson";
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${clean} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${clean} (${uid("dup")})`;
}

async function defaultReadAssetBytes(item) {
  const fs = globalThis.window?.__TAURI__?.fs;
  if (!fs) throw new Error("Reading media files needs the desktop app.");
  return fs.readFile(item.managedPath, { baseDir: fs.BaseDirectory.AppLocalData });
}

/**
 * Builds the package bytes for one lesson. Fails (never silently drops) if any
 * referenced asset is missing or unreadable.
 * deps: { lessonService, mediaService, readAssetBytes(item) }
 */
export async function exportLessonPackage(lessonId, deps = {}) {
  const lessons = deps.lessonService ?? defaultLessonService;
  const media = deps.mediaService ?? defaultMediaService;
  const readBytes = deps.readAssetBytes ?? defaultReadAssetBytes;

  const lesson = await lessons.getLesson(lessonId);
  if (!lesson) throw new LessonPackageError("Lesson not found.", { code: "export" });

  const assets = [];
  const entries = [];
  const missing = [];
  for (const id of collectLessonMediaIds(lesson)) {
    if (!ASSET_ID_RE.test(id)) { missing.push({ id, reason: "unsupported media id" }); continue; }
    const item = await media.isReferenced(id);
    if (!item) { missing.push({ id, reason: "not in the media library" }); continue; }
    let bytes;
    try { bytes = await readBytes(item); } catch (err) { missing.push({ id, name: item.name, reason: err?.message || String(err) }); continue; }
    if (!bytes || !bytes.byteLength) { missing.push({ id, name: item.name, reason: "file is empty or unreadable" }); continue; }
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const name = safeBaseName(item.name);
    const ext = extFromName(item.managedPath) || extFromName(name);
    const path = `assets/${id}${ext ? "." + ext : ""}`;
    assets.push({ id, kind: item.kind, name, mime: item.mime || "application/octet-stream", size: bytes.byteLength, sha256: await sha256Hex(bytes), path });
    entries.push({ name: path, data: bytes, compress: /svg|text|json|xml/i.test(item.mime || "") });
  }
  if (missing.length) {
    const names = missing.slice(0, 5).map((m) => m.name || m.id).join(", ");
    throw new LessonPackageError(
      `${missing.length} media file(s) used by this lesson can't be read (${names}${missing.length > 5 ? ", …" : ""}), so a complete package can't be made. Nothing was exported.`,
      { code: "missing-asset", details: missing });
  }

  const manifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    app: { name: "OmniDeck", version: PACKAGE_APP_VERSION },
    exportedAt: new Date().toISOString(),
    lesson: { title: lesson.title, pages: JSON.parse(JSON.stringify(lesson.pages || [])) },
    assets,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const bytes = await createZip([{ name: "manifest.json", data: manifestBytes, compress: true }, ...entries]);
  return { bytes, assetCount: assets.length, pageCount: manifest.lesson.pages.length, lessonTitle: lesson.title };
}

function validateManifest(m) {
  const bad = (msg, code = "invalid") => { throw new LessonPackageError(msg, { code }); };
  if (!m || typeof m !== "object" || Array.isArray(m)) bad("The package's manifest isn't valid.");
  if (m.format !== PACKAGE_FORMAT) bad("This isn't an OmniDeck lesson package.");
  if (!Number.isInteger(m.formatVersion) || m.formatVersion < 1) bad("The package has no valid format version.");
  if (m.formatVersion > PACKAGE_FORMAT_VERSION) {
    bad(`This package was made by a newer OmniDeck (package format v${m.formatVersion}); this version understands up to v${PACKAGE_FORMAT_VERSION}. Please update OmniDeck and try again.`, "unsupported-version");
  }
  const l = m.lesson;
  if (!l || typeof l !== "object" || typeof l.title !== "string" || !l.title.trim() || l.title.length > 300) bad("The package's lesson has no valid title.");
  if (!Array.isArray(l.pages) || l.pages.length < 1 || l.pages.length > MAX_PAGES) bad("The package's lesson has no valid pages.");
  const known = new Set(PAGE_TYPES.map((t) => t.type));
  const pageIds = new Set();
  for (const p of l.pages) {
    if (!p || typeof p !== "object" || Array.isArray(p)) bad("The package contains a malformed slide.");
    if (typeof p.id !== "string" || !p.id || pageIds.has(p.id)) bad("The package contains a slide with a missing or duplicate id.");
    pageIds.add(p.id);
    if (!known.has(p.type)) bad(`The package contains a slide of an unknown type ("${String(p.type).slice(0, 40)}").`);
  }
  if (!Array.isArray(m.assets) || m.assets.length > MAX_ASSETS) bad("The package's asset list isn't valid.");
  const ids = new Set();
  for (const a of m.assets) {
    if (!a || typeof a !== "object") bad("The package contains a malformed asset entry.");
    if (!ASSET_ID_RE.test(a.id || "") || ids.has(a.id)) bad("The package contains an asset with an invalid or duplicate id.");
    ids.add(a.id);
    if (!MEDIA_KINDS.includes(a.kind)) bad(`The package contains an asset of unsupported kind "${String(a.kind).slice(0, 30)}".`);
    if (typeof a.path !== "string" || !ASSET_PATH_RE.test(a.path) || !a.path.startsWith(`assets/${a.id}`)) bad("The package contains an asset with an unsafe path.");
    if (!Number.isInteger(a.size) || a.size < 1) bad("The package contains an asset with an invalid size.");
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) bad("The package contains an asset without a valid checksum.");
    if (typeof a.name !== "string" || typeof a.mime !== "string") bad("The package contains an asset with missing metadata.");
  }
  return m;
}

/**
 * Imports package bytes as a NEW lesson (never overwrites). Transactional: on
 * any failure every media record this import created is removed again.
 * deps: { lessonService, mediaService }
 */
export async function importLessonPackage(bytes, deps = {}) {
  const lessons = deps.lessonService ?? defaultLessonService;
  const media = deps.mediaService ?? defaultMediaService;
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);

  let zip, manifest;
  try {
    zip = openZip(bytes);
    if (!zip.entries.has("manifest.json")) throw new LessonPackageError("This isn't an OmniDeck lesson package (no manifest).");
    const raw = await zip.read("manifest.json");
    try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch { throw new LessonPackageError("The package's manifest is damaged.", { code: "corrupt" }); }
  } catch (err) {
    if (err instanceof LessonPackageError) throw err;
    if (err instanceof ZipFormatError) throw new LessonPackageError(`This file can't be opened as a lesson package: ${err.message}.`, { code: "corrupt" });
    throw err;
  }
  validateManifest(manifest);

  const byId = new Map(manifest.assets.map((a) => [a.id, a]));
  const lessonObj = manifest.lesson;
  const needed = collectLessonMediaIds(lessonObj);
  const missing = [...needed].filter((id) => !byId.has(id));
  if (missing.length) {
    throw new LessonPackageError(`The package is incomplete: ${missing.length} media file(s) used by its slides aren't included. Nothing was imported.`, { code: "missing-asset", details: missing });
  }

  // Verify EVERY needed asset (present, size, checksum) before creating anything.
  const verified = new Map();
  for (const id of needed) {
    const a = byId.get(id);
    if (!zip.entries.has(a.path)) {
      throw new LessonPackageError(`The package is incomplete: "${a.name}" is listed but its file is missing. Nothing was imported.`, { code: "missing-asset", details: [id] });
    }
    let data;
    try { data = await zip.read(a.path); }
    catch (err) { throw new LessonPackageError(`"${a.name}" in the package is damaged (${err.message}). Nothing was imported.`, { code: "corrupt" }); }
    if (data.byteLength !== a.size || (await sha256Hex(data)) !== a.sha256) {
      throw new LessonPackageError(`"${a.name}" in the package is damaged (checksum mismatch). Nothing was imported.`, { code: "corrupt" });
    }
    verified.set(id, data);
  }

  const tx = new ImportTransaction({ mediaService: media });
  try {
    const idMap = new Map();
    for (const [id, data] of verified) {
      const a = byId.get(id);
      const rec = await tx.importBytes(a.kind, data, safeBaseName(a.name), a.mime);
      idMap.set(id, rec.id);
    }
    const existing = (await lessons.listLessons()).map((l) => l.title);
    const title = uniqueLessonTitle(lessonObj.title, existing);
    const lessonId = uid("lesson");
    const now = new Date().toISOString();
    const pages = lessonObj.pages.map((p) => ({ ...remapPageMediaIds(p, idMap), id: `${lessonId}-${p.id}` }));
    const lesson = { id: lessonId, title, createdAt: now, updatedAt: now, pages };
    await lessons.insertLesson(lesson);
    tx.commit();
    return { lesson, assetCount: idMap.size, renamed: title !== lessonObj.title.trim() };
  } catch (err) {
    const rb = await tx.rollback();
    if (rb.failed.length) console.warn("[LessonPackageService] couldn't clean up some media after a failed import", rb.failed);
    throw err;
  }
}

/** Dispatches on content: native package (ZIP) vs. legacy v1 JSON backup. */
export async function importLessonFileBytes(bytes, deps = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return importLessonPackage(bytes, deps);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new LessonPackageError("This file isn't an OmniDeck lesson package or backup."); }
  const r = await importBackup(text);
  return { lesson: r.lesson, assetCount: 0, renamed: false, legacy: true, missingMedia: r.missingMedia };
}
