// A tiny DOM stand-in — TEST INFRASTRUCTURE ONLY (nothing under src/ imports
// it). Just enough of `document` for utils/dom.js's h()/clear() and the pure
// render functions (e.g. slideStage.renderPresentStage) to build a tree that a
// test can walk, without adding a DOM library as a dependency.

class MiniNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = {};
    // Minimal CSSStyleDeclaration subset used by rendering/layout helpers.
    // setProperty/getPropertyValue are needed for CSS custom properties such
    // as --slide-w and --present-scale in source-level DOM tests.
    this.style = Object.create(null);
    this.style.setProperty = (name, value) => { this.style[name] = String(value); };
    this.style.getPropertyValue = (name) => this.style[name] ?? "";
    this.className = "";
    this.listeners = {};
    this.parentNode = null;
  }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; return child; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  get classList() {
    const self = this;
    return { contains: (c) => self.className.split(/\s+/).includes(c) };
  }
  get textContent() { return this.children.map((c) => (c instanceof MiniText ? c.data : c.textContent)).join(""); }
}
class MiniText { constructor(data) { this.data = data; this.parentNode = null; } }

export function installMiniDom() {
  globalThis.window = globalThis.window || {};
  globalThis.document = {
    createElement: (tag) => new MiniNode(tag),
    createTextNode: (text) => new MiniText(text),
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.requestAnimationFrame = () => 0; // layout-dependent sizing is not under test
}

/** Depth-first search for the first element matching `pred`. */
export function findNode(node, pred) {
  if (!node || node instanceof MiniText) return null;
  if (pred(node)) return node;
  for (const c of node.children) { const hit = findNode(c, pred); if (hit) return hit; }
  return null;
}
export const hasClass = (n, c) => n.className.split(/\s+/).includes(c);
