// The ONE definition of "which media ids does a lesson page reference".
// Deletion safety, backup export, and the Media Library's "in use" check
// all use this, so a new reference field only has to be added here. (Before
// this existed, `page.background.mediaId` was missed by the in-use check —
// a background image could be deleted out from under a lesson.)

/** Every media id one page points at, in any field. */
export function collectPageMediaIds(page) {
  const ids = new Set();
  if (!page || typeof page !== "object") return ids;
  if (page.mediaId) ids.add(page.mediaId);
  if (page.acceptedImage?.mediaId) ids.add(page.acceptedImage.mediaId);
  if (page.background?.mediaId) ids.add(page.background.mediaId);
  if (Array.isArray(page.boxes)) {
    for (const box of page.boxes) if (box?.mediaId) ids.add(box.mediaId);
  }
  return ids;
}

export function collectLessonMediaIds(lesson) {
  const ids = new Set();
  for (const page of lesson?.pages || []) for (const id of collectPageMediaIds(page)) ids.add(id);
  return ids;
}

export function collectLessonsMediaIds(lessons) {
  const ids = new Set();
  for (const lesson of lessons || []) for (const id of collectLessonMediaIds(lesson)) ids.add(id);
  return ids;
}

export function pageReferencesMedia(page, mediaId) {
  return collectPageMediaIds(page).has(mediaId);
}

/**
 * Returns a copy of `page` with every media reference rewritten through
 * `idMap` (old id -> new id). The inverse of collectPageMediaIds: a new
 * reference field must be added to BOTH.
 */
export function remapPageMediaIds(page, idMap) {
  const re = (id) => (id && idMap.has(id) ? idMap.get(id) : id);
  const copy = { ...page };
  if (copy.mediaId) copy.mediaId = re(copy.mediaId);
  if (copy.acceptedImage?.mediaId) copy.acceptedImage = { ...copy.acceptedImage, mediaId: re(copy.acceptedImage.mediaId) };
  if (copy.background?.mediaId) copy.background = { ...copy.background, mediaId: re(copy.background.mediaId) };
  if (Array.isArray(copy.boxes)) copy.boxes = copy.boxes.map((b) => (b?.mediaId ? { ...b, mediaId: re(b.mediaId) } : b));
  return copy;
}
