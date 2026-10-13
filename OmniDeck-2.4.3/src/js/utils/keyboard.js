/**
 * Attaches a keydown handler for the given map of `{ key: handler }` and
 * returns a detach function. Keys are matched by `event.key`.
 * Used by Present Mode for Arrow Right / Arrow Left / Home / End / Escape.
 *
 * While the teacher is typing in a text field (e.g. a fill-in-the-blank quiz
 * answer), every key except Escape is left alone: arrow keys/Home/End must
 * move the caret, not change slides (and must not be preventDefault-ed).
 */
export function isEditableTarget(target) {
  if (!target || typeof target !== "object") return false;
  const tag = String(target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return target.isContentEditable === true || target.getAttribute?.("contenteditable") === "true";
}

export function bindKeys(map) {
  const handler = (event) => {
    const fn = map[event.key];
    if (!fn) return;
    if (event.key !== "Escape" && isEditableTarget(event.target)) return;
    event.preventDefault();
    fn(event);
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}
