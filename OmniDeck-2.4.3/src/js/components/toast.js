import { h } from "../utils/dom.js";

/**
 * Fire-and-forget toast notification. Kept intentionally simple — no
 * queueing library, this is a desktop utility app, not a design system demo.
 */
export function toast(message, variant = "default", timeoutMs = 3200) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const classes = ["toast"];
  if (variant === "success") classes.push("toast--success");
  if (variant === "danger") classes.push("toast--danger");
  const node = h("div", { class: classes.join(" ") }, message);
  root.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, timeoutMs);
}
