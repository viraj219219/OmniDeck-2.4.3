import { h, mount } from "../utils/dom.js";

let activeBackdrop = null;

/**
 * Render a simple modal dialog. `render(closeFn)` builds the modal body and
 * receives a `close()` callback to dismiss it. Returns the close function.
 */
export function openModal(title, render) {
  closeModal();
  const backdrop = h("div", {
    class: "modal-backdrop",
    onClick: (e) => { if (e.target === backdrop) closeModal(); },
  });
  const body = h("div", {});
  const modal = h("div", { class: "modal" }, [
    h("div", { class: "modal__title" }, title),
    body,
  ]);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  activeBackdrop = backdrop;

  const onKeydown = (e) => {
    if (e.key === "Escape") closeModal();
  };
  document.addEventListener("keydown", onKeydown);
  backdrop._cleanup = () => document.removeEventListener("keydown", onKeydown);

  mount(body, render(closeModal));
  return closeModal;
}

export function closeModal() {
  if (activeBackdrop) {
    activeBackdrop._cleanup?.();
    activeBackdrop.remove();
    activeBackdrop = null;
  }
}
