import { h } from "../utils/dom.js";
import { isRunningInTauri } from "../utils/storageAdapter.js";
import { bibleService } from "../services/BibleService.js";
import { pickAndImportBible, listCustomBibleImports, removeCustomBibleImport, AmbiguousLanguageError } from "../services/BibleImportService.js";
import { SUPPORTED_LANGUAGES } from "../services/BibleLanguageDetectionService.js";
import { lessonService } from "../services/LessonService.js";
import { exportLessonFlow, importLessonFlow } from "./lessonTransfer.js";
import { updateService } from "../services/UpdateService.js";
import { presentationService } from "../services/PresentationService.js";
import { dependencyService } from "../services/DependencyService.js";
import { getTheme, setTheme, applyTheme } from "../services/ThemeService.js";
import { toast } from "../components/toast.js";
import { openModal, closeModal } from "../components/modal.js";
import { icon } from "../utils/icons.js";

export const title = "Settings";

export async function render(root, { navigate, setActions }) {
  setActions([]);
  const languages = await bibleService.getLanguages();
  const english = languages.find((l) => l.name === "English");
  let monitors = [];
  try {
    monitors = await presentationService.getMonitors();
  } catch (err) {
    // Display detection failing must not blank the whole Settings screen.
    console.warn("[settings] couldn't list monitors", err);
  }
  const displaySettings = await presentationService.getDisplaySettings();
  const theme = await getTheme();

  const page = h("div", { class: "page" }, [
    h("div", { class: "section-heading" }, [
      h("div", {}, [h("h2", {}, "Settings"), h("p", {}, "Only real, working configuration lives here.")]),
    ]),
  ]);

  page.appendChild(section("Runtime & Storage", [
    row("Runtime", "How this build is currently running.",
      h("span", { class: "badge" + (isRunningInTauri ? " badge--success" : " badge--muted") }, isRunningInTauri ? "Desktop (Tauri)" : "Browser preview")),
    row("Lesson & media storage", isRunningInTauri ? "Local-first, under the app's local data directory — works fully offline." : "Browser preview keeps data in this tab only (localStorage / in-memory) — not persistent.",
      h("span", { class: "badge badge--muted" }, isRunningInTauri ? "Local files" : "Session only")),
  ]));

  page.appendChild(await renderUpdatesSection());
  page.appendChild(await renderImportToolsSection());

  page.appendChild(section("Bible", [
    row("English translation", english?.translationName || "—",
      h("span", { class: "badge badge--success" }, "Available")),
    row("Attribution", english?.attribution || "", null),
    // Only real, imported languages are ever listed here — a language
    // nobody has imported yet simply doesn't appear (see "Import a
    // translation" below to add one, e.g. Telugu).
    ...languages.filter((l) => l.name !== "English").map((l) =>
      row(`${l.name} translation`, l.translationName || "—", h("span", { class: "badge badge--success" }, "Available"))),
  ]));

  page.appendChild(await renderBibleImportSection(navigate));

  page.appendChild(renderAppearanceSection(theme));
  page.appendChild(renderDisplayModeSection(monitors, displaySettings));
  page.appendChild(await renderBackupSection(navigate));

  page.appendChild(section("About", [
    row("Version", await appVersion(), null),
    row("Bible text license", "World English Bible (WEB) — public domain. See src/js/data/LICENSE-BIBLE.md.", null),
    row("PowerPoint rendering", "Production OmniDeck builds bundle the LibreOffice presentation renderer, so PowerPoint import does not require LibreOffice to be installed separately. Development builds may fall back to a system LibreOffice install. Each slide of an imported .pptx becomes its own individual, editable page in the Lesson Editor. If no renderer is available the import is refused with a clear message and nothing is added to your lesson.", null),
  ]));

  root.appendChild(page);
}

/**
 * "Import Tools": live readiness of the external programs PowerPoint/PDF
 * import depends on (LibreOffice, Poppler), e.g.
 *   PowerPoint import — ✓ Ready
 *   PowerPoint import — ⚠ LibreOffice not installed
 * with a Re-check button so a teacher can install a tool and confirm it
 * without restarting the screen.
 */
async function renderImportToolsSection() {
  const body = h("div", { class: "card", style: { padding: "4px 20px" } });
  const group = h("div", { class: "settings-group" }, [
    h("h3", { style: { margin: "0 0 8px", fontSize: "var(--fs-sm)", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" } }, "Import Tools"),
    body,
  ]);

  const badge = (r) => h("span", {
    class: "badge " + (r.level === "ok" ? "badge--success" : r.level === "error" ? "badge--danger" : "badge--muted"),
  }, r.level === "ok" ? "✓ Ready" : r.level === "unknown" ? "? Couldn't check" : `⚠ ${r.message}`);

  async function paint() {
    let status;
    try {
      status = await dependencyService.getStatus();
    } catch (err) {
      status = null;
      console.warn("[settings] dependency status failed", err);
    }
    body.replaceChildren();
    const rows = status
      ? [
          ["PowerPoint import", "Needs the bundled LibreOffice renderer (development builds may use system LibreOffice).", status.powerpoint],
          ["PDF import (page images)", "Needs Poppler (pdftoppm). Without it a PDF is still added, as one embedded page.", status.pdf],
          ["Quiz from PDF", "Needs Poppler (pdftotext).", status.pdfText],
          ["Quiz from Word document", "Needs LibreOffice.", status.wordText],
        ]
      : [["Import tools", "The readiness check couldn't run.", { level: "unknown", message: "Couldn't check" }]];
    for (const [label, desc, r] of rows) body.appendChild(row(label, desc, badge(r)));
    const recheck = h("button", { class: "btn btn--sm" }, "Re-check");
    recheck.addEventListener("click", async () => { recheck.disabled = true; await paint(); });
    body.appendChild(row("Missing something?", "Install it (see PPTX-SETUP.md), then Re-check. If the app was open while you installed, restart OmniDeck so it picks up the new PATH.", recheck));
  }
  await paint();
  return group;
}

function section(heading, rows) {
  return h("div", { class: "settings-group" }, [
    h("h3", { style: { margin: "0 0 8px", fontSize: "var(--fs-sm)", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" } }, heading),
    h("div", { class: "card", style: { padding: "4px 20px" } }, rows.filter(Boolean)),
  ]);
}

function row(label, desc, right) {
  return h("div", { class: "settings-row" }, [
    h("div", {}, [h("div", { class: "settings-row__label" }, label), desc ? h("div", { class: "settings-row__desc" }, desc) : null]),
    right,
  ]);
}

function monitorLabel(m) {
  const size = m.width && m.height ? ` — ${m.width}×${m.height}` : "";
  return `${m.name || `Monitor ${m.index + 1}`}${size}${m.isPrimary ? " (Primary)" : ""}`;
}

function renderAppearanceSection(theme) {
  const lightBtn = h("button", { class: "btn btn--sm" + (theme !== "dark" ? " btn--primary" : "") }, "Light");
  const darkBtn = h("button", { class: "btn btn--sm" + (theme === "dark" ? " btn--primary" : "") }, "Dark");

  async function pick(value, btn, otherBtn) {
    btn.disabled = true;
    try {
      const saved = await setTheme(value);
      applyTheme(saved);
      btn.classList.add("btn--primary");
      otherBtn.classList.remove("btn--primary");
    } catch (err) {
      toast(err?.message || "Couldn't save this setting.", "danger");
    } finally {
      btn.disabled = false;
    }
  }
  lightBtn.addEventListener("click", () => pick("light", lightBtn, darkBtn));
  darkBtn.addEventListener("click", () => pick("dark", darkBtn, lightBtn));

  return section("Appearance", [
    row(
      "App theme",
      "Switches the main app's own interface between light and dark. Present Mode always stays its own fixed dark theatre look for the classroom/projector, and the slide canvas you edit on always stays a white \"page\" — neither is affected by this.",
      h("div", { class: "action-row" }, [lightBtn, darkBtn]),
    ),
  ]);
}

function renderDisplayModeSection(monitors, settings) {
  if (!isRunningInTauri) {
    return section("Displays", [
      row("Present Mode", "Multiple displays can only be detected and used in the installed desktop app, not this browser preview.", null),
    ]);
  }

  if (monitors.length < 2) {
    return section("Displays", [
      row("Displays detected", "1 display connected. Present Mode will fill this display — this is the normal setup for most Sunday School rooms.", null),
    ]);
  }

  const modeSelect = h("select", { style: { width: "260px" } }, [
    h("option", { value: "auto", selected: settings.mode !== "single" }, "Automatic — use both displays"),
    h("option", { value: "single", selected: settings.mode === "single" }, "Always use a single display"),
  ]);

  // The primary monitor is always the presenter's own screen and can never
  // be offered as the audience display — selecting it would put the
  // classroom output on the same screen as the controls, or have Present
  // Mode reject the choice outright. Mirrors the primary-resolution rule
  // in computeDisplayPlan (PresentationService.js): if nothing reports
  // isPrimary, monitor 0 is treated as the presenter's screen.
  let primaryIndex = monitors.findIndex((m) => m.isPrimary);
  if (primaryIndex === -1) primaryIndex = 0;
  const audienceCandidates = monitors.filter((m) => m.index !== primaryIndex);
  const monitorSelect = h("select", { style: { width: "260px" } }, [
    h("option", { value: "", selected: settings.audienceMonitorIndex == null }, "Auto-detect"),
    ...audienceCandidates.map((m) => h("option", {
      value: String(m.index),
      selected: settings.audienceMonitorIndex === m.index,
    }, monitorLabel(m))),
  ]);
  const monitorRow = row("Audience display", "Which monitor shows the classroom/projector output. Your own screen (with controls) always shows on the other one — it can't be chosen here.", monitorSelect);
  monitorRow.style.display = settings.mode === "single" ? "none" : "";

  modeSelect.addEventListener("change", () => {
    monitorRow.style.display = modeSelect.value === "single" ? "none" : "";
  });

  const saveBtn = h("button", {
    class: "btn btn--sm",
    onClick: async () => {
      try {
        const audienceMonitorIndex = monitorSelect.value === "" ? null : Number(monitorSelect.value);
        await presentationService.setDisplaySettings({ mode: modeSelect.value, audienceMonitorIndex });
        toast("Display settings saved.", "success");
      } catch (err) {
        toast(err?.message || "Couldn't save this setting.", "danger");
      }
    },
  }, "Save");

  return section("Displays", [
    row("Displays detected", `${monitors.length} displays connected.`, null),
    row("Display mode", "Automatic uses your second display as the classroom/projector output with a presenter view (current slide, controls, and what's next) on your own screen.",
      h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [modeSelect])),
    monitorRow,
    h("div", { class: "settings-row", style: { justifyContent: "flex-end" } }, [saveBtn]),
  ]);
}

/** Shows a modal asking the teacher to pick this translation's language,
 * when detection was genuinely ambiguous. `candidates` (from
 * BibleLanguageDetectionService) are offered first, as one-click buttons;
 * every other supported language is available below via a dropdown, so an
 * unlucky/narrow candidate list never traps the teacher. Resolves to
 * `{ name, code }`, or null if the teacher cancels (which cancels the
 * whole import — nothing is saved without a language). */
function promptForLanguage(candidates) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
      closeModal();
    };

    openModal("Which language is this translation in?", (close) => {
      const wrap = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px", minWidth: "280px" } });
      wrap.appendChild(h("p", { class: "field-hint" }, "We couldn't confidently identify this Bible's language. Please select it below."));

      if (candidates?.length) {
        wrap.appendChild(h("div", { class: "field-hint", style: { fontWeight: "600" } }, "Likely:"));
        const candidateRow = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px" } },
          candidates.map((c) => {
            const btn = h("button", { class: "btn btn--sm" }, c.name);
            btn.addEventListener("click", () => finish({ name: c.name, code: c.code }));
            return btn;
          }));
        wrap.appendChild(candidateRow);
      }

      wrap.appendChild(h("div", { class: "field-hint", style: { fontWeight: "600", marginTop: "4px" } }, "Or choose from all supported languages:"));
      const select = h("select", { style: { width: "100%" } }, [
        h("option", { value: "" }, "Select a language…"),
        ...SUPPORTED_LANGUAGES.map((l) => h("option", { value: l.code }, l.name)),
      ]);
      const confirmBtn = h("button", { class: "btn btn--sm" }, "Use this language");
      confirmBtn.addEventListener("click", () => {
        const lang = SUPPORTED_LANGUAGES.find((l) => l.code === select.value);
        if (lang) finish({ name: lang.name, code: lang.code });
      });
      wrap.appendChild(h("div", { style: { display: "flex", gap: "8px" } }, [select, confirmBtn]));

      const cancelBtn = h("button", { class: "btn btn--sm btn--ghost", style: { alignSelf: "flex-start", marginTop: "4px" } }, "Cancel import");
      cancelBtn.addEventListener("click", () => { close(); finish(null); });
      wrap.appendChild(cancelBtn);

      return wrap;
    });
  });
}

async function renderBibleImportSection(navigate) {
  const customImports = await listCustomBibleImports();

  const importBtn = h("button", { class: "btn btn--sm" }, [icon("upload"), "Import Bible Translation (JSON/XML)"]);
  importBtn.addEventListener("click", async () => {
    importBtn.disabled = true;
    const originalChildren = [...importBtn.childNodes]; // keeps the icon, not just the text
    importBtn.replaceChildren("Importing…");
    try {
      const result = await pickAndImportBible({ resolveLanguage: promptForLanguage });
      if (result) {
        toast(`Imported ${result.language} — ${result.translationName} (${result.verseCount} verses).`, "success");
        navigate("settings");
        return; // page is being re-rendered fresh; don't touch this button further
      }
    } catch (err) {
      // AmbiguousLanguageError shouldn't normally surface here — promptForLanguage
      // handles it above — but if it does (e.g. resolveLanguage rejected),
      // its own message is already the right plain-language text to show.
      const message = err instanceof AmbiguousLanguageError ? err.message : (err?.message || "Couldn't import this file.");
      toast(message, "danger");
    } finally {
      importBtn.disabled = false;
      importBtn.replaceChildren(...originalChildren);
    }
  });

  const importRow = row(
    "Import a translation",
    "Bring your own Bible text as a JSON or XML file — for a language with no bundled translation, or an alternate translation in any language. OmniDeck detects the language automatically where possible and only asks you to confirm when it genuinely can't tell. See src/js/services/BibleImportService.js for the exact expected file format. This app can't verify licensing on your behalf — only import text you have the right to use.",
    importBtn,
  );

  const importedRows = customImports.length
    ? customImports.map((entry) => {
        const removeBtn = h("button", { class: "btn btn--ghost btn--sm" }, [icon("trash"), "Remove"]);
        removeBtn.addEventListener("click", async () => {
          removeBtn.disabled = true;
          try {
            await removeCustomBibleImport(entry.slug);
            toast(`Removed the ${entry.language} translation.`, "success");
            navigate("settings");
          } catch (err) {
            removeBtn.disabled = false;
            toast(err?.message || "Couldn't remove this translation.", "danger");
          }
        });
        return row(entry.language, entry.translationName, removeBtn);
      })
    : [row("Imported translations", "None imported yet.", null)];

  return section("Bible Translations", [importRow, ...importedRows]);
}

async function appVersion() {
  try {
    const v = await window.__TAURI__?.app?.getVersion?.();
    if (v) return v;
  } catch { /* fall through to the packaged default */ }
  return "2.2.0";
}

async function renderBackupSection(navigate) {
  let lessons = [];
  let loadError = null;
  try {
    lessons = await lessonService.listLessons();
  } catch (err) {
    // A lesson library that can't be read must not blank the whole Settings
    // screen (Bible import, displays, AI keys, ...) — only disable export.
    loadError = err;
    console.warn("[settings] couldn't load lessons for export", err);
  }

  const exportBtn = h("button", { class: "btn btn--sm" }, [icon("download"), "Export a Lesson"]);
  exportBtn.addEventListener("click", () => {
    if (loadError) { toast(loadError.message || "Couldn't load your lessons.", "danger"); return; }
    if (!lessons.length) { toast("No lessons to export yet.", "danger"); return; }
    openModal("Export Lesson", (close) => {
      const box = h("div", {}, lessons.map((lesson) =>
        h("button", {
          class: "list-row",
          style: { width: "100%", cursor: "pointer" },
          onClick: async () => { if (await exportLessonFlow(lesson)) close(); },
        }, h("div", { class: "list-row__title" }, lesson.title))
      ));
      return box;
    });
  });

  const importBtn = h("button", { class: "btn btn--sm" }, [icon("upload"), "Import Lesson"]);
  importBtn.addEventListener("click", () => importLessonFlow(navigate));

  return section("Backup & Transfer", [
    row("Export", "Creates one portable .omnilesson file with the lesson and every media file it uses, to open on any computer running OmniDeck. (Also available on each lesson in the Library.)", exportBtn),
    row("Import", "Adds a lesson from an exported .omnilesson file (or an older .json backup) as a new library entry — never overwrites existing lessons.", importBtn),
  ]);
}


// ---- Updates ------------------------------------------------------------------
// One compact card: current version, a "Check for updates" button, and — only when
// something is available — the new version with Download & install / Cancel.
async function renderUpdatesSection() {
  const st = await updateService.status();
  const status = h("div", { class: "settings-row__desc" }, "");
  const action = h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } });
  const progress = h("progress", { max: "100", value: "0", style: { width: "180px", display: "none" } });
  let controller = null;

  const setStatus = (text, danger = false) => { status.textContent = text; status.style.color = danger ? "var(--color-danger)" : ""; };
  const clearAction = () => { while (action.firstChild) action.removeChild(action.firstChild); };

  const checkBtn = h("button", { class: "btn btn--sm" }, [icon("check"), "Check for updates"]);
  async function runCheck() {
    checkBtn.disabled = true; setStatus("Checking…");
    const r = await updateService.check();
    checkBtn.disabled = false;
    clearAction(); action.appendChild(checkBtn);
    if (r.state === "unavailable") setStatus(r.reason || "Automatic updates aren't enabled in this build.");
    else if (r.state === "up-to-date") setStatus(`You're up to date (version ${r.version ?? st.version}).`);
    else if (r.state === "error") setStatus(r.message, true);
    else if (r.state === "available") showAvailable(r);
  }
  function showAvailable(r) {
    setStatus(`Version ${r.version} is available (you have ${r.currentVersion ?? st.version}).${r.notes ? "\n\n" + r.notes : ""}`);
    status.style.whiteSpace = "pre-wrap";
    clearAction();
    if (!r.canSelfInstall) { // .deb/.rpm: announce, but don't pretend we can install
      action.appendChild(h("span", { class: "settings-row__desc" }, r.reason || "Download the new version from the release page."));
      return;
    }
    const go = h("button", { class: "btn btn--primary btn--sm" }, [icon("download"), "Download & install"]);
    const cancel = h("button", { class: "btn btn--sm" }, "Cancel");
    cancel.style.display = "none";
    go.addEventListener("click", async () => {
      controller = new AbortController();
      go.disabled = true; cancel.style.display = ""; progress.style.display = "";
      try {
        const result = await updateService.downloadAndInstall({
          signal: controller.signal,
          onProgress: ({ phase, received, total }) => {
            if (phase === "downloading") { setStatus(`Downloading… ${total ? Math.round((received / total) * 100) + "%" : ""}`); progress.value = total ? (received / total) * 100 : 0; }
            else if (phase === "verifying") setStatus("Verifying the download's signature…");
            else if (phase === "installing") setStatus("Saving your work and installing…");
            else if (phase === "restarting") setStatus("Restarting OmniDeck…");
          },
        });
        if (result.cancelled) setStatus("Update cancelled. Nothing was installed.");
      } catch (err) {
        setStatus(err?.message || "The update failed.", true);
      } finally {
        progress.style.display = "none"; cancel.style.display = "none"; go.disabled = false;
      }
    });
    cancel.addEventListener("click", () => { controller?.abort(); setStatus("Cancelling… the download will be discarded and nothing installed."); });
    action.append(go, cancel, progress);
  }
  checkBtn.addEventListener("click", runCheck);
  action.appendChild(checkBtn);
  if (!st.configured) checkBtn.disabled = true;
  setStatus(st.configured ? `Version ${st.version ?? ""}. Updates come from the official GitHub Releases and are signature-verified before installing.` : (st.reason || "Automatic updates aren't enabled in this build."));
  return section("Updates", [row("OmniDeck updates", null, h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-end" } }, [action])), h("div", { style: { padding: "0 0 12px" } }, [status])]);
}
