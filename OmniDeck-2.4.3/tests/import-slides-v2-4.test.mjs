// v2.4: imported slides are canvas slides with a contain-fit picture background; autoFit never paints unfitted.
import { check } from "./helpers/harness.mjs";
import { pngSize } from "../src/js/services/ImportService.js";
import { fitPresentText } from "../src/js/utils/autoFit.js";

const png = (w, h) => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
};
check("pngSize reads IHDR width/height", JSON.stringify(pngSize(png(1920, 1080))) === JSON.stringify({ width: 1920, height: 1080 }));
check("pngSize tolerates short/odd bytes", pngSize(new Uint8Array(5)) === null && pngSize(null) === null);

// autoFit: with a fake element whose content overflows until the scale is small enough, the FIRST synchronous
// call must already reach the final scale (no rAF needed), proving no unfitted frame is ever painted.
globalThis.requestAnimationFrame = () => 0;
const styles = {};
const el = {
  isConnected: true, clientHeight: 100, clientWidth: 200,
  style: { setProperty: (k, v) => { styles[k] = v; } },
  get scrollHeight() { return 100 + (Number(styles["--present-scale"]) > 0.7 ? 50 : 0); },
};
fitPresentText(el);
check("autoFit reaches its final size synchronously (no full-size flash)", Number(styles["--present-scale"]) <= 0.7 && Number(styles["--present-scale"]) >= 0.5);
const short = { ...el, style: { setProperty: (k, v) => { styles.s = v; } }, scrollHeight: 90 };
fitPresentText(short);
check("short content stays at full size", styles.s === "1");
