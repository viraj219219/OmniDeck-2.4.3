// Shared UI flows for native OmniDeck lesson packages (.omnilesson).
// Used by the Lesson Library (Import Lesson / per-lesson Export) and by
// Settings > Backup & Transfer, so there is exactly ONE implementation.
// PowerPoint/PDF import is a different feature and lives in the New Lesson dialog.
import { exportLessonPackage, importLessonFileBytes, PACKAGE_EXTENSION, LessonPackageError } from "../services/LessonPackageService.js";
import { isRunningInTauri } from "../utils/storageAdapter.js";
import { toast } from "../components/toast.js";

export function sanitizeFileName(name) {
  return (name || "lesson").replace(/[^a-z0-9\- ]/gi, "").trim().replace(/\s+/g, "-").toLowerCase() || "lesson";
}

/** Exports one lesson as a portable package; returns true if a file was written. */
export async function exportLessonFlow(lesson) {
  try {
    const result = await exportLessonPackage(lesson.id);
    const fileName = `${sanitizeFileName(lesson.title)}.${PACKAGE_EXTENSION}`;
    const saved = await saveBytes(fileName, result.bytes);
    if (!saved) return false; // cancelled — not an error
    toast(`Exported "${lesson.title}" (${result.pageCount} slide${result.pageCount === 1 ? "" : "s"}, ${result.assetCount} media file${result.assetCount === 1 ? "" : "s"}).`, "success");
    return true;
  } catch (err) {
    toast(err?.message || "Export failed.", "danger");
    return false;
  }
}

/** Lets the user pick a package and imports it as a NEW lesson. */
export async function importLessonFlow(navigate) {
  try {
    const bytes = await pickBytes();
    if (!bytes) return null; // cancelled
    const result = await importLessonFileBytes(bytes);
    const extra = result.renamed ? ` A lesson with that name already exists, so it was added as "${result.lesson.title}".` : "";
    const missing = result.missingMedia?.length ? ` ${result.missingMedia.length} media file(s) were missing from this older backup.` : "";
    toast(`Imported "${result.lesson.title}".${extra}${missing}`, missing ? "danger" : "success");
    if (navigate) navigate("editor", { lessonId: result.lesson.id });
    return result;
  } catch (err) {
    toast(err instanceof LessonPackageError || err?.message ? err.message : "Import failed.", "danger");
    return null;
  }
}

async function saveBytes(suggestedName, bytes) {
  if (isRunningInTauri) {
    const { save } = window.__TAURI__.dialog;
    const { writeFile, stat } = window.__TAURI__.fs;
    const path = await save({ defaultPath: suggestedName, filters: [{ name: "OmniDeck Lesson", extensions: [PACKAGE_EXTENSION] }] });
    if (!path) return false;
    await writeFile(path, bytes);
    // Read back the size so a truncated write (disk full) is reported, not announced as success.
    const info = await stat(path);
    if (info?.size !== bytes.byteLength) throw new Error("The lesson file wasn't written completely (the disk may be full). Please try again or choose another location.");
    return true;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url; a.download = suggestedName; a.click();
  URL.revokeObjectURL(url);
  return true;
}

async function pickBytes() {
  if (isRunningInTauri) {
    const { open } = window.__TAURI__.dialog;
    const { readFile } = window.__TAURI__.fs;
    const path = await open({ multiple: false, filters: [{ name: "OmniDeck Lesson", extensions: [PACKAGE_EXTENSION, "json"] }] });
    if (!path) return null;
    return readFile(Array.isArray(path) ? path[0] : path);
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `.${PACKAGE_EXTENSION},.json`;
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? new Uint8Array(await file.arrayBuffer()) : null);
    };
    input.click();
  });
}
