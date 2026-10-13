// Checklist item: "wide / tall / square viewport" — fitSlideBox() is the one
// function responsible for keeping a 16:9 slide correctly letterboxed (and
// --slide-w correctly set, which the whole preview/presentation parity fix
// depends on) no matter what shape the surrounding window/container is.
// No real browser is available in this test runner, so ResizeObserver is
// undefined here — that's fine, fitSlideBox() calls its sizing logic
// synchronously once regardless, before ever touching ResizeObserver, so a
// plain fake container/slide element is enough to exercise the real math.

import { makeChecker } from "./helpers/fakeDisk.mjs";

globalThis.window = globalThis.window || {};
window.addEventListener ??= () => {};
window.removeEventListener ??= () => {};

const { fitSlideBox } = await import("../src/js/utils/slideScale.js");
const { check, done } = makeChecker();

function fakeEl(clientWidth, clientHeight) {
  const props = {};
  return {
    clientWidth,
    clientHeight,
    style: {
      setProperty(k, v) { props[k] = v; },
      get width() { return props.width; },
      set width(v) { props.width = v; },
      get height() { return props.height; },
      set height(v) { props.height = v; },
    },
    _props: props,
  };
}

function fit(containerW, containerH) {
  const container = fakeEl(containerW, containerH);
  const slide = fakeEl(0, 0);
  fitSlideBox(container, slide);
  const w = parseInt(slide.style.width, 10);
  const h = parseInt(slide.style.height, 10);
  const slideW = parseInt(slide._props["--slide-w"], 10);
  return { w, h, slideW };
}

// Wide viewport (2560x1080, wider than 16:9): height is the binding
// constraint, width must shrink below the container's own width to stay 16:9.
{
  const { w, h, slideW } = fit(2560, 1080);
  check("wide viewport: slide height fills the container height exactly", h === 1080);
  check("wide viewport: slide width is narrower than the container (letterboxed on the sides)", w < 2560 && w > 0);
  check("wide viewport: width/height ratio is 16:9", Math.abs(w / h - 16 / 9) < 0.01);
  check("wide viewport: --slide-w matches the computed width, not the container's raw width", slideW === w && slideW !== 2560);
}

// Tall viewport (900x1600, taller than 16:9): width is the binding
// constraint, height must shrink below the container's own height.
{
  const { w, h, slideW } = fit(900, 1600);
  check("tall viewport: slide width fills the container width exactly", w === 900);
  check("tall viewport: slide height is shorter than the container (letterboxed top/bottom)", h < 1600 && h > 0);
  check("tall viewport: width/height ratio is 16:9", Math.abs(w / h - 16 / 9) < 0.01);
  check("tall viewport: --slide-w matches the container's width (width was the binding constraint)", slideW === 900);
}

// Square viewport (1000x1000): width is the binding constraint (16:9 is
// wider than 1:1), so this should behave like the tall case above.
{
  const { w, h, slideW } = fit(1000, 1000);
  check("square viewport: slide width fills the container width exactly", w === 1000);
  check("square viewport: slide height is shorter than the container (letterboxed top/bottom)", h < 1000 && h > 0);
  check("square viewport: width/height ratio is 16:9", Math.abs(w / h - 16 / 9) < 0.01);
  check("square viewport: --slide-w matches the container's width", slideW === 1000);
}

// A zero-sized container (e.g. mid-layout, before the pane has been given
// real dimensions) must not throw or set nonsense values.
{
  const container = fakeEl(0, 0);
  const slide = fakeEl(0, 0);
  let threw = false;
  try {
    fitSlideBox(container, slide);
  } catch {
    threw = true;
  }
  check("zero-sized container does not throw", !threw);
  check("zero-sized container leaves the slide unsized rather than 0x0 (waits for a real size)", slide.style.width === undefined);
}

done();
