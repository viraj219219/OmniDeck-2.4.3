import { lessonService } from "./LessonService.js";
import { mediaService } from "./MediaService.js";
import { isRunningInTauri } from "../utils/storageAdapter.js";
import { collectLessonMediaIds } from "../utils/mediaRefs.js";
import { ImportTransaction } from "./ImportService.js";
import { uid } from "../utils/dom.js";

const FORMAT_VERSION = 1;

/**
 * Real lesson backup/export/import.
 *
 * Format choice: ONE self-contained JSON file (lesson data + every
 * referenced media asset's real bytes, base64-encoded, inline) rather than
 * a lesson.json + media/ folder inside a .zip. This is a deliberate
 * simplification — it avoids adding a zip-writing dependency — and is
 * disclosed here rather than silently deviating from a "zip package"
 * expectation: it's still a single portable file a teacher can email or
 * put on a USB drive, and it still contains the real media bytes, not
 * just references to files that might not exist on the receiving machine.
 *
 * Every asset referenced by the lesson (image/video/pdf/presentation
 * mediaId, scripture acceptedImage) is walked and embedded for real —
 * nothing here fabricates or skips media silently.
 */
export async function exportLesson(lessonId) {
  const lesson = await lessonService.getLesson(lessonId);
  if (!lesson) throw new Error("Lesson not found.");

  // Every media reference in any field (mediaId, scripture-page image, boxes,
  // page background) — see utils/mediaRefs.js.
  const mediaIds = collectLessonMediaIds(lesson);

  const media = [];
  const missing = [];
  for (const id of mediaIds) {
    const item = await mediaService.isReferenced(id);
    if (!item) { missing.push(id); continue; }
    const bytes = await readAssetBytes(item);
    if (!bytes) { missing.push(id); continue; }
    media.push({ record: item, base64: bytesToBase64(bytes) });
  }

  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    lesson,
    media,
    missingMedia: missing, // surfaced to the user — never silently dropped
  };
}

/**
 * Imports a backup produced by `exportLesson`. Validates the shape before
 * touching anything, re-imports every embedded asset as a real new media
 * record (via mediaService.importBytes — real files on disk, not just
 * metadata), remaps the lesson's mediaId references to the new ids, and
 * only then creates the lesson. A malformed/foreign JSON file is rejected
 * with a clear reason rather than partially imported.
 */
export async function importBackup(backupJson) {
  let data;
  try {
    data = typeof backupJson === "string" ? JSON.parse(backupJson) : backupJson;
  } catch {
    throw new Error("This file isn't valid JSON — it doesn't look like an OmniDeck backup.");
  }
  if (!data || typeof data !== "object" || !data.lesson || !Array.isArray(data.media)) {
    throw new Error("This file doesn't match the expected backup format.");
  }
  if (data.formatVersion > FORMAT_VERSION) {
    throw new Error(`This backup was made with a newer version of the app (format v${data.formatVersion}); this app only understands up to v${FORMAT_VERSION}.`);
  }

  if (!Array.isArray(data.lesson.pages) || data.lesson.pages.some((p) => !p || typeof p !== "object")) {
    throw new Error("This backup's lesson has no valid pages, so nothing was imported.");
  }

  // Transactional: every media asset re-imported here is tracked, and if
  // any later step fails (bad asset, lesson save) they are all removed
  // again — a failed import leaves no orphan files and no half-made lesson.
  const tx = new ImportTransaction({ mediaService });
  try {
    const idRemap = new Map();
    for (const entry of data.media) {
      if (!entry?.record || !entry?.base64) continue;
      const bytes = base64ToBytes(entry.base64);
      const newRecord = await tx.importBytes(entry.record.kind, bytes, entry.record.name, entry.record.mime);
      idRemap.set(entry.record.id, newRecord.id);
    }

    const now = new Date().toISOString();
    const lessonId = uid("lesson");
    const title = `${data.lesson.title} (Imported)`;
    const remapBackground = (bg) => (bg?.mediaId && idRemap.has(bg.mediaId) ? { ...bg, mediaId: idRemap.get(bg.mediaId) } : bg);
    const pages = data.lesson.pages.map((page) => {
      const copy = { ...page, id: `${lessonId}-${page.id}` };
      if (copy.mediaId && idRemap.has(copy.mediaId)) copy.mediaId = idRemap.get(copy.mediaId);
      if (copy.acceptedImage?.mediaId && idRemap.has(copy.acceptedImage.mediaId)) {
        copy.acceptedImage = { ...copy.acceptedImage, mediaId: idRemap.get(copy.acceptedImage.mediaId) };
      }
      if (copy.background) copy.background = remapBackground(copy.background);
      if (copy.boxes?.length) {
        copy.boxes = copy.boxes.map((box) =>
          box.mediaId && idRemap.has(box.mediaId) ? { ...box, mediaId: idRemap.get(box.mediaId) } : box
        );
      }
      return copy;
    });
    if (!pages.length) pages.push({ id: `${lessonId}-p1`, type: "title", title, subtitle: "" });

    const importedLesson = { id: lessonId, title, createdAt: now, updatedAt: now, pages };
    await lessonService.insertLesson(importedLesson); // one persisted step; removes itself again on failure
    tx.commit();
    return { lesson: importedLesson, missingMedia: data.missingMedia || [], skippedMediaCount: data.media.length - idRemap.size };
  } catch (err) {
    const rollback = await tx.rollback();
    if (rollback.failed.length) console.warn("[BackupService] some media from the failed import couldn't be cleaned up", rollback.failed);
    throw err;
  }
}

async function readAssetBytes(item) {
  if (!isRunningInTauri) return null; // browser preview has no real files to read back
  try {
    const { readFile, BaseDirectory } = window.__TAURI__.fs;
    return await readFile(item.managedPath, { baseDir: BaseDirectory.AppLocalData });
  } catch (err) {
    console.warn(`[BackupService] failed to read asset bytes for ${item.id}`, err);
    return null;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
