import { h } from "./dom.js";

/**
 * Builds a "Book Chapter:Verse(s)" reference label from a book name,
 * chapter number, and a set/array of verse numbers — e.g.
 * formatReference("John", 3, [16, 17, 18]) -> "John 3:16-18". A single
 * verse number collapses to "John 3:16"; a non-contiguous selection lists
 * verses comma-separated ("John 3:16,18"). Shared by scripturePicker.js
 * (the original selection's reference) and lessonEditor.js (re-deriving a
 * sub-reference for each paginated chunk of a longer passage).
 */
export function formatReference(bookName, chapter, verseNumbers) {
  const nums = [...verseNumbers].sort((a, b) => a - b);
  if (!nums.length) return `${bookName} ${chapter}`;
  const isRange = nums.length > 1 && nums[nums.length - 1] - nums[0] === nums.length - 1;
  const versesLabel = isRange ? `${nums[0]}-${nums[nums.length - 1]}` : nums.join(",");
  return `${bookName} ${chapter}:${versesLabel}`;
}

// A rough, deliberately conservative budget for how much scripture text
// comfortably fits on one Present Mode slide before it starts getting cut
// off / auto-shrunk illegibly small by the clamp()'d font sizing in
// present.css. Not an exact typographic measurement (that would need real
// layout/measurement at the actual presentation font) — a practical
// threshold tuned to keep slides readable from the back of a room.
export const DEFAULT_MAX_CHARS_PER_SLIDE = 420;

/**
 * Splits a passage's verses into one or more slide-sized chunks, never
 * splitting a single verse across two slides (only breaks BETWEEN
 * verses). A passage that already fits comes back as a single chunk — the
 * common case — so callers can always create "however many pages
 * chunks.length says" without a special case for "didn't need to split".
 */
export function paginateVerses(verses, maxChars = DEFAULT_MAX_CHARS_PER_SLIDE) {
  const list = verses || [];
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const v of list) {
    // +12 is a rough allowance for the "Verse N" label rendered alongside
    // each verse's text (see renderVerseList) — not exact, just enough to
    // avoid under-budgeting a chunk by ignoring the labels entirely.
    const vLen = (v.text || "").length + 12;
    if (current.length && currentLen + vLen > maxChars) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(v);
    currentLen += vLen;
  }
  if (current.length) chunks.push(current);
  return chunks.length ? chunks : [list];
}

/**
 * Renders a passage's verses with an explicit "Verse N" label before each
 * one — used by both the Lesson Editor canvas and Present Mode (see
 * slideStage.js), styled differently by the class names each caller
 * passes in, but with the same underlying structure so what a teacher
 * sees while building a slide matches what the room sees.
 */
export function renderVerseList(verses, { wrapClass, rowClass, numberClass, textClass } = {}) {
  if (!verses?.length) {
    return h("div", { class: wrapClass }, "Use \u201c+ Add Scripture\u201d to choose a passage.");
  }
  return h("div", { class: wrapClass }, verses.map((v) =>
    h("div", { class: rowClass }, [
      h("span", { class: numberClass }, `Verse ${v.number}`),
      h("span", { class: textClass }, v.text),
    ])
  ));
}
