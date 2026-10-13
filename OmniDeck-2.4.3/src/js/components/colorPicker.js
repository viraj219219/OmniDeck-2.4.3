import { h } from "../utils/dom.js";
import { openModal } from "./modal.js";

// ---- color math (HSV <-> RGB <-> hex) ----

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360 / 60;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const v = max;
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, v];
}

function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
}

function hexToRgb(hex) {
  const m = String(hex || "").trim().replace(/^#/, "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

const SWATCHES = [
  "#14181D", "#2A2F36", "#F6F4EE", "#FFFFFF", "#000000",
  "#C96A5B", "#E0A95C", "#D9C25A", "#6FCF97", "#4C8DFF",
  "#7C6FCF", "#B15FA8", "#3A6EA5", "#8C4A2E", "#2E6B4A",
];

/**
 * Opens a custom color picker modal — a saturation/value square + hue
 * slider + hex input + swatches, plus a real eyedropper (the browser's
 * EyeDropper API, feature-detected) when available. Built from scratch
 * rather than relying on `<input type="color">`: that control's own UI
 * varies wildly by OS/webview (some skip the eyedropper entirely, some
 * only offer a flat swatch grid on mobile), so teachers on different
 * machines were getting a different, sometimes much more limited, color
 * picker experience.
 *
 * `initialHex`: the starting color. `onLiveChange(hex)`: called on every
 * drag/slide/keystroke, for an immediate preview without committing yet.
 * `onCommit(hex)`: called once, when "Use this color" is pressed.
 * Pressing Cancel calls `onLiveChange(initialHex)` once to restore the
 * pre-picker preview, then closes without committing. Dismissing via the
 * backdrop or Escape closes without restoring — acceptable for how this
 * is used (a background/text-color preview the teacher can just reopen
 * and fix), so it's not worth the extra plumbing modal.js would need to
 * hook those two dismiss paths.
 */
export function openColorPicker({ initialHex, onLiveChange, onCommit }) {
  let [h0, s0, v0] = rgbToHsv(...(hexToRgb(initialHex) || [20, 24, 29]));

  openModal("Choose Color", (close) => {
    const SIZE = 220;
    const svCanvas = h("canvas", { width: SIZE, height: SIZE, class: "colorpicker__sv" });
    const svCtx = svCanvas.getContext("2d");
    const svCursor = h("div", { class: "colorpicker__sv-cursor" });
    const svWrap = h("div", { class: "colorpicker__sv-wrap" }, [svCanvas, svCursor]);

    const hueSlider = h("input", { type: "range", min: "0", max: "360", value: String(Math.round(h0)), class: "colorpicker__hue" });
    const swatch = h("div", { class: "colorpicker__preview" });
    const hexInput = h("input", { type: "text", class: "colorpicker__hex", value: initialHex || "#14181D", maxlength: "7" });
    const eyedropBtn = ("EyeDropper" in window)
      ? h("button", { class: "btn btn--sm", type: "button", title: "Pick a color from anywhere on screen" }, "🖉 Eyedropper")
      : null;

    function currentHex() {
      return rgbToHex(...hsvToRgb(h0, s0, v0));
    }

    function drawSV() {
      const [r, g, b] = hsvToRgb(h0, 1, 1);
      svCtx.fillStyle = `rgb(${r},${g},${b})`;
      svCtx.fillRect(0, 0, SIZE, SIZE);
      const white = svCtx.createLinearGradient(0, 0, SIZE, 0);
      white.addColorStop(0, "rgba(255,255,255,1)");
      white.addColorStop(1, "rgba(255,255,255,0)");
      svCtx.fillStyle = white;
      svCtx.fillRect(0, 0, SIZE, SIZE);
      const black = svCtx.createLinearGradient(0, 0, 0, SIZE);
      black.addColorStop(0, "rgba(0,0,0,0)");
      black.addColorStop(1, "rgba(0,0,0,1)");
      svCtx.fillStyle = black;
      svCtx.fillRect(0, 0, SIZE, SIZE);
    }

    function positionCursor() {
      svCursor.style.left = `${s0 * SIZE}px`;
      svCursor.style.top = `${(1 - v0) * SIZE}px`;
      svCursor.style.background = currentHex();
    }

    function syncFromHsv({ redrawSv = false, moveHue = false } = {}) {
      if (redrawSv) drawSV();
      positionCursor();
      if (moveHue) hueSlider.value = String(Math.round(h0));
      const hex = currentHex();
      swatch.style.background = hex;
      hexInput.value = hex;
      onLiveChange?.(hex);
    }

    function pickFromEvent(e) {
      const rect = svCanvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(SIZE, e.clientX - rect.left));
      const y = Math.max(0, Math.min(SIZE, e.clientY - rect.top));
      s0 = x / SIZE;
      v0 = 1 - y / SIZE;
      syncFromHsv();
    }

    let dragging = false;
    svCanvas.addEventListener("pointerdown", (e) => { dragging = true; svCanvas.setPointerCapture(e.pointerId); pickFromEvent(e); });
    svCanvas.addEventListener("pointermove", (e) => { if (dragging) pickFromEvent(e); });
    svCanvas.addEventListener("pointerup", () => { dragging = false; });

    hueSlider.addEventListener("input", () => {
      h0 = Number(hueSlider.value);
      syncFromHsv({ redrawSv: true });
    });

    hexInput.addEventListener("change", () => {
      const rgb = hexToRgb(hexInput.value);
      if (!rgb) { hexInput.value = currentHex(); return; }
      [h0, s0, v0] = rgbToHsv(...rgb);
      syncFromHsv({ redrawSv: true, moveHue: true });
    });

    if (eyedropBtn) {
      eyedropBtn.addEventListener("click", async () => {
        try {
          const result = await new window.EyeDropper().open();
          const rgb = hexToRgb(result.sRGBHex);
          if (rgb) { [h0, s0, v0] = rgbToHsv(...rgb); syncFromHsv({ redrawSv: true, moveHue: true }); }
        } catch (err) {
          // User pressed Escape to cancel the eyedropper — not an error.
        }
      });
    }

    const swatchRow = h("div", { class: "colorpicker__swatches" },
      SWATCHES.map((hex) => h("button", {
        class: "colorpicker__swatch-btn", type: "button", title: hex,
        style: { background: hex },
        onClick: () => {
          const rgb = hexToRgb(hex);
          [h0, s0, v0] = rgbToHsv(...rgb);
          syncFromHsv({ redrawSv: true, moveHue: true });
        },
      }))
    );

    const actions = h("div", { class: "action-row", style: { marginTop: "14px", justifyContent: "flex-end" } }, [
      h("button", {
        class: "btn btn--sm btn--ghost", type: "button",
        onClick: () => { onLiveChange?.(initialHex); close(); },
      }, "Cancel"),
      h("button", {
        class: "btn btn--sm btn--primary", type: "button",
        onClick: () => { onCommit?.(currentHex()); close(); },
      }, "Use this color"),
    ]);

    drawSV();
    positionCursor();
    swatch.style.background = currentHex();

    return h("div", { class: "colorpicker" }, [
      svWrap,
      hueSlider,
      h("div", { class: "colorpicker__row" }, [
        swatch,
        hexInput,
        eyedropBtn,
      ].filter(Boolean)),
      swatchRow,
      actions,
    ]);
  });
}
