// Feature flags for in-progress work that's safe to ship alongside stable
// code but not yet ready to be the default experience. Flip a flag to
// `false` to hide the feature from the UI without deleting the code
// behind it — existing lessons that already used it keep rendering fine
// either way (the flag only ever gates whether NEW use of the feature is
// offered, never whether already-saved content is displayed).

/**
 * Freeform drag/resize/insert text & image box canvas editor (see
 * /areas/omnideck-canvas-editor.md project notes — this is step 2 of that
 * plan: the box-based renderer, behind this flag, with drag/resize/insert
 * built directly on top of it).
 *
 * Every existing page type (title, scripture, image, video, pdf,
 * presentation, quiz, discussion, conclusion) is untouched by this work —
 * "freeform" is an additive new page type, not a replacement for any of
 * them, so this flag being on or off never changes how those render.
 */
export const FREEFORM_CANVAS_ENABLED = true;
