import { readJSON, writeJSON } from "../utils/storageAdapter.js";

const CONFIG_FILE = "theme-config.json";

/**
 * Controls ONLY the main app chrome's light/dark theme (Settings →
 * Appearance) — see base.css's `:root[data-theme="dark"]` overrides.
 * Present Mode (present.css) and the editor's slide canvas
 * (.editor-canvas) are both deliberately their own fixed palettes and are
 * never touched by this — a teacher's Sunday School room shouldn't go
 * dark just because they prefer a dark app UI while building the lesson.
 */
export async function getTheme() {
  try {
    const config = await readJSON(CONFIG_FILE, null);
    return config?.theme === "dark" ? "dark" : "light";
  } catch (err) {
    console.warn("[ThemeService] couldn't read the saved theme, defaulting to light", err);
    return "light";
  }
}

export async function setTheme(theme) {
  const value = theme === "dark" ? "dark" : "light";
  const ok = await writeJSON(CONFIG_FILE, { theme: value });
  if (!ok) throw new Error("Couldn't save the theme setting to disk.");
  return value;
}

/** Applies a theme to the document immediately — called once at app
 * startup (with whatever was last saved) and again the instant the
 * teacher flips the Settings toggle, so there's no reload/flash. */
export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
}
