// MediaLifecycle — transaction-safe operations that swap or drop a lesson's
// media reference AND (only when it is safe) delete the media it used to use.
//
// The rule these enforce: a lesson must never be left pointing at a file that
// no longer exists. So the order is always
//
//   create new media -> verify it exists -> point the lesson at it (memory)
//   -> persist the lesson -> confirm it was persisted -> ONLY THEN consider
//   deleting the old media, and only if nothing else references it.
//
// If anything before the delete fails, nothing is deleted and the in-memory
// lesson is put back exactly as it was. The physical delete itself goes
// through MediaService.removeMedia, whose own reference check is the last
// line of defense (an old image also used by another lesson is kept).

import { MediaInUseError } from "./MediaService.js";

export class ReplaceMediaError extends Error {
  /** `stage`: "import" | "validate" | "persist" | "verify-persist". */
  constructor(message, { stage, cause, newMediaId = null } = {}) {
    super(message);
    this.name = "ReplaceMediaError";
    this.stage = stage;
    this.cause = cause;
    this.newMediaId = newMediaId; // kept on disk after a failed save so a retry can reuse it
  }
}

async function tryDeleteOld(mediaService, oldId) {
  try {
    const result = await mediaService.removeMedia(oldId);
    return { status: result?.removed === false ? "not-found" : "removed" };
  } catch (err) {
    if (err instanceof MediaInUseError) return { status: "kept-referenced", error: err };
    return { status: "delete-failed", error: err };
  }
}

/**
 * Accepts a generated illustration: swaps `page.acceptedImage` to a newly
 * imported asset. Returns { record, oldMedia: { status, error? } } where
 * oldMedia.status is "none" | "removed" | "not-found" | "kept-referenced" |
 * "delete-failed". Throws ReplaceMediaError (with the page restored and
 * the old media untouched) if any step before the delete fails.
 *
 * @param persist       async () => void — must THROW if the lesson save fails
 * @param verifyPersisted optional (mediaId) => boolean — confirms the saved
 *                      lesson really references the new media
 * @param reuseRecord   a record from an earlier attempt whose save failed
 */
export async function replaceAcceptedImage({ page, bytes, mime, name, generatedAt, persist, verifyPersisted, mediaService, reuseRecord = null }) {
  const previous = page.acceptedImage ?? null;

  let record = null;
  if (reuseRecord) {
    try { if (await mediaService.verifyAsset(reuseRecord.id)) record = reuseRecord; } catch { /* import fresh below */ }
  }
  if (!record) {
    try {
      record = await mediaService.importBytes("image", bytes, name, mime);
    } catch (err) {
      throw new ReplaceMediaError(err?.message || "Couldn't save the generated image.", { stage: "import", cause: err });
    }
  }

  let exists = false;
  try { exists = await mediaService.verifyAsset(record.id); } catch { exists = false; }
  if (!exists) {
    throw new ReplaceMediaError("The new image wasn't found on disk after saving it, so the lesson was left unchanged.", { stage: "validate", newMediaId: record.id });
  }

  page.acceptedImage = { mediaId: record.id, reference: page.reference, generatedAt };
  try {
    await persist();
  } catch (err) {
    page.acceptedImage = previous; // lesson goes back to the old, still-valid image
    throw new ReplaceMediaError(err?.message || "Couldn't save the lesson.", { stage: "persist", cause: err, newMediaId: record.id });
  }
  if (verifyPersisted && !verifyPersisted(record.id)) {
    page.acceptedImage = previous;
    throw new ReplaceMediaError("The lesson save didn't include the new image, so the old image was kept.", { stage: "verify-persist", newMediaId: record.id });
  }

  const oldId = previous?.mediaId;
  if (!oldId || oldId === record.id) return { record, oldMedia: { status: "none" } };
  return { record, oldMedia: await tryDeleteOld(mediaService, oldId) };
}

/**
 * Removes the accepted illustration: clears the reference, persists, and
 * only if that save succeeded considers deleting the file. If the save
 * fails the reference is restored and nothing is deleted.
 */
export async function clearAcceptedImage({ page, persist, mediaService }) {
  const previous = page.acceptedImage ?? null;
  if (!previous?.mediaId) return { oldMedia: { status: "none" } };
  page.acceptedImage = null;
  try {
    await persist();
  } catch (err) {
    page.acceptedImage = previous;
    throw err;
  }
  return { oldMedia: await tryDeleteOld(mediaService, previous.mediaId) };
}
