// OmniDeck — Tauri application entry point.
//
// This process intentionally stays thin. All lesson/Bible/media/quiz logic
// lives in the frontend behind service interfaces (see src/js/services).
// The Rust side is only responsible for:
//   - owning the native window(s) — the main presenter window, always, and
//     an optional second "audience" window for churches with 2+ displays
//   - toggling true OS-level fullscreen for Present Mode
//   - reporting connected monitors so the frontend can offer a two-display
//     Present Mode only where a second monitor actually exists
//   - exposing file-system + dialog plugins for local media selection
//   - the app-close handshake (CloseGate below): closing the main window
//     is intercepted so the frontend can flush every pending save first
//   - reporting whether the external import tools (LibreOffice, Poppler)
//     are installed, without running them
//
// When a real backend is introduced, native commands (e.g. for local
// database access) can be added here without touching the frontend UI —
// the frontend only needs to be pointed at RealLessonService, etc.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// NOTE on `#[tauri::command(async)]` below: plain (sync) Tauri commands run on
// the MAIN thread. The conversion/extraction commands wait on LibreOffice or
// Poppler for up to EXTERNAL_TOOL_TIMEOUT (120 s), which would freeze the
// whole UI, and `open_audience_window` creates a window — which Tauri documents
// as deadlocking on Windows when done from a sync command. `(async)` moves
// them onto Tauri's worker pool without changing their signatures.

mod util;
use util::*;

mod docx_reader;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Whether one external tool could be found, and where.
#[derive(Serialize)]
struct ToolStatus {
    found: bool,
    path: Option<String>,
}

fn tool_status(path: Option<PathBuf>) -> ToolStatus {
    ToolStatus {
        found: path.is_some(),
        path: path.map(|p| p.to_string_lossy().to_string()),
    }
}

/// Everything PowerPoint / PDF import (and quiz-from-document import)
/// shells out to.
#[derive(Serialize)]
struct ImportDependencies {
    soffice: ToolStatus,
    pdftoppm: ToolStatus,
    pdftotext: ToolStatus,
}

/// Reports which import tools are available. PowerPoint uses the bundled
/// LibreOffice renderer first and in-app pdf.js for PDF rasterization, so
/// Poppler is not required for the PowerPoint path. Never fails: a missing tool is
/// just `found: false`, so the UI can explain it instead of an import
/// crashing deep inside a conversion.
#[tauri::command]
fn check_import_dependencies() -> ImportDependencies {
    // Bundled runtime first (same resolution order the conversions use), so the
    // UI never reports a system copy while conversions run the bundled one, or vice versa.
    let soffice = resolve_soffice();
    ImportDependencies {
        soffice: tool_status(soffice),
        pdftoppm: tool_status(find_executable("pdftoppm")),
        pdftotext: tool_status(find_executable("pdftotext")),
    }
}

/// Runs a `soffice` invocation, trying PATH first and falling back to
/// `soffice_candidates()`'s common install locations only when `soffice`
/// truly isn't found anywhere — so a real LibreOffice install with a
/// PATH that was never updated still works, instead of forcing every
/// teacher to edit PATH by hand. Stops and returns immediately on any
/// non-NotFound outcome (success, a real failure, or a timeout) — only
/// "this binary doesn't exist here" advances to the next candidate.
/// `build_args` is called fresh per candidate since `Command` isn't
/// cloneable.
fn run_soffice_with_fallback(
    build_args: impl Fn() -> Vec<String>,
    timeout: Duration,
) -> Result<std::process::Output, RunError> {
    let mut last_err = RunError::NotFound;
    for bin in soffice_candidates() {
        let mut cmd = Command::new(&bin);
        cmd.args(build_args());
        match run_with_timeout(cmd, timeout) {
            Ok(out) => return Ok(out),
            Err(RunError::NotFound) => { last_err = RunError::NotFound; continue; }
            Err(other) => return Err(other),
        }
    }
    Err(last_err)
}

/// Enter or exit true OS fullscreen for the main window. Used exclusively
/// by Present Mode — the editor chrome never calls this.
#[tauri::command]
fn set_presentation_fullscreen(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_fullscreen(enabled).map_err(|e| e.to_string())
}

/// One physical monitor, as reported to the frontend so it can offer a
/// "which screen is the audience display" choice, and so it can tell
/// single-display churches from multi-display ones. `index` is this
/// monitor's position in the list returned by `list_monitors` in this same
/// call — the frontend uses that index (not a name, which some OSes/window
/// managers don't report) to refer back to a specific monitor when calling
/// `open_audience_window`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorInfo {
    index: usize,
    name: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    is_primary: bool,
}

/// Lists every currently-connected monitor. A Sunday School room with one
/// display (the common case) reports exactly one entry; the frontend treats
/// that as "single-display church" and never offers two-display Present
/// Mode. This never creates or moves any window — read-only.
#[tauri::command]
fn list_monitors(window: WebviewWindow) -> Result<Vec<MonitorInfo>, String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let primary = window.primary_monitor().map_err(|e| e.to_string())?;
    let primary_pos = primary.as_ref().map(|m| m.position());

    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, m)| MonitorInfo {
            index,
            name: m.name().cloned(),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            is_primary: Some(m.position()) == primary_pos,
        })
        .collect())
}

/// Where the audience window is RIGHT NOW, judged by physical position (see
/// `classify_audience_placement`). Present Mode polls this so that a display
/// being unplugged mid-service can never leave a fullscreen audience window
/// covering the presenter's controls: window managers typically drag an
/// orphaned window onto whatever display remains.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudiencePlacement {
    open: bool,
    ok: bool,
    problem: Option<String>,
    monitor_count: usize,
}

#[tauri::command]
fn audience_placement_status(app: AppHandle) -> Result<AudiencePlacement, String> {
    let main = app.get_webview_window("main").ok_or("Main window not found")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    let positions: Vec<(i32, i32)> = monitors.iter().map(|m| (m.position().x, m.position().y)).collect();
    let presenter = main
        .current_monitor()
        .map_err(|e| e.to_string())?
        .map(|m| (m.position().x, m.position().y));
    let audience_window = app.get_webview_window("audience");
    let audience = audience_window
        .as_ref()
        .and_then(|w| w.current_monitor().ok().flatten())
        .map(|m| (m.position().x, m.position().y));
    let verdict = classify_audience_placement(audience_window.is_some(), &positions, presenter, audience);
    Ok(AudiencePlacement {
        open: verdict.open,
        ok: verdict.ok,
        problem: verdict.problem.map(|p| p.to_string()),
        monitor_count: positions.len(),
    })
}

/// Opens (or, if it's already open from a previous Present session in this
/// run, re-positions) a second, chrome-less window on the chosen monitor
/// and puts it into true OS fullscreen there — this is the classroom/
/// projector "audience display" for two-display churches. The main window
/// is never touched by this command; it keeps running the normal presenter
/// screen. Position is set *before* requesting fullscreen, which is what
/// makes the OS fullscreen onto the correct monitor rather than whichever
/// one the window last happened to be on.
#[tauri::command(async)]
fn open_audience_window(app: AppHandle, monitor_index: usize) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("Main window not found")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .get(monitor_index)
        .ok_or_else(|| format!("No monitor at index {monitor_index}"))?;

    // Hardening: never let the audience window land on the same physical
    // monitor as the presenter's own window, no matter what the frontend
    // passed in — a stale settings file, a monitor unplugged/replugged
    // (and index reused) between the frontend's list_monitors() call and
    // this one, or any future bug upstream. The frontend already keeps the
    // presenter's monitor out of the choice it offers, but the backend
    // must not trust that; this is the last line of defense before a
    // window actually gets created.
    //
    // Compared by physical position rather than by index: the presenter
    // window's *current* monitor (wherever it actually is right now) is
    // the true "presenter screen", which is not necessarily the OS's
    // notion of "the primary monitor" if the window happens to be sitting
    // on a different display when Present Mode starts. Position is a
    // stable way to identify "is this the same screen" even if monitor
    // indices have shifted since the frontend last asked.
    if let Some(presenter_monitor) = main.current_monitor().map_err(|e| e.to_string())? {
        if presenter_monitor.position() == monitor.position() {
            return Err(
                "Can't open the audience display on the presenter's own monitor.".to_string(),
            );
        }
    }

    let position = monitor.position();
    let size = monitor.size();

    let audience = if let Some(existing) = app.get_webview_window("audience") {
        existing
    } else {
        WebviewWindowBuilder::new(&app, "audience", WebviewUrl::App("audience.html".into()))
            .title("OmniDeck — Audience Display")
            .decorations(false)
            .skip_taskbar(true)
            .visible(true)
            .build()
            .map_err(|e| e.to_string())?
    };

    audience
        .set_position(tauri::PhysicalPosition::new(position.x, position.y))
        .map_err(|e| e.to_string())?;
    audience
        .set_size(tauri::PhysicalSize::new(size.width, size.height))
        .map_err(|e| e.to_string())?;
    audience.set_fullscreen(true).map_err(|e| e.to_string())?;
    audience.show().map_err(|e| e.to_string())?;

    Ok(())
}

/// Closes the audience window, if one is open. Safe to call even if it
/// isn't (e.g. exiting Present Mode after single-display was actually
/// used) — simply does nothing in that case.
#[tauri::command]
fn close_audience_window(app: AppHandle) -> Result<(), String> {
    if let Some(audience) = app.get_webview_window("audience") {
        audience.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Real PowerPoint rendering, in two documented external steps, neither of
/// which is bundled with the app (both are common, separately-installed
/// system tools — see src/js/data/PPTX-SETUP.md for exact install commands
/// per OS):
///
///   1. `soffice --headless --convert-to pdf` (LibreOffice) turns the
///      .pptx into a real PDF — this is the actual rendering step; nothing
///      here fabricates slide content.
///   2. `pdftoppm -png` (poppler-utils) rasterizes each PDF page to a real
///      PNG, one file per slide, so the frontend can show/advance through
///      real slide images in the editor and Present Mode exactly like an
///      image page.
///
/// Only these two specific binaries, with a fixed argument shape, are ever
/// invoked — this command never runs an arbitrary caller-supplied command
/// line, so it doesn't need (and deliberately doesn't request) the
/// frontend-facing shell plugin's broader capability surface.
///
/// Returns the actual sorted list of slide PNG filenames produced (not just
/// a count) — poppler's `pdftoppm` zero-pads page numbers based on the
/// total page count (slide-1.png for <10 pages, slide-01.png for 10-99,
/// etc.), so the frontend must not guess the naming pattern; it gets the
/// real filenames back and stores them as-is. Every failure mode (binary
/// missing, conversion producing no PDF, PDF producing no pages) returns a
/// specific, user-facing error string — never a silent empty list or a
/// fabricated slide count.
#[tauri::command(async)]
fn convert_pptx_to_slides(pptx_path: String, work_dir: String) -> Result<Vec<String>, String> {
    let pptx = Path::new(&pptx_path);
    if !pptx.exists() {
        return Err(format!("Source file not found: {}", pptx_path));
    }
    ensure_presentation_file(pptx)?;
    std::fs::create_dir_all(&work_dir).map_err(|e| format!("Could not create working directory: {e}"))?;

    // A dedicated, throwaway LibreOffice user profile for THIS conversion
    // only. Without this, every "soffice --headless" call shares the one
    // real LibreOffice profile on the machine — if that profile is already
    // locked by another running soffice process (including a leftover
    // Quickstarter icon, or a previous conversion that didn't fully exit),
    // this call can hang until it hits EXTERNAL_TOOL_TIMEOUT, or silently
    // reuse a half-initialized profile that renders slides with missing
    // fonts/images/backgrounds instead of failing outright. `--norestore`
    // additionally suppresses the "Document Recovery" dialog LibreOffice
    // can otherwise show (and block headless execution on) after an
    // earlier crash. The profile directory is scoped to this call's own
    // work_dir, so it's cleaned up along with everything else there.
    let profile_dir = Path::new(&work_dir).join("lo-profile");
    let profile_url = path_to_file_url(&profile_dir);

    let soffice_result = run_soffice_with_fallback(
        || vec![
            "--headless".to_string(),
            "--norestore".to_string(),
            format!("-env:UserInstallation={profile_url}"),
            "--convert-to".to_string(),
            "pdf".to_string(),
            "--outdir".to_string(),
            work_dir.clone(),
            pptx_path.clone(),
        ],
        EXTERNAL_TOOL_TIMEOUT,
    );
    // The throwaway profile is only needed while soffice runs; it can be
    // tens of MB, and leaving one behind per presentation quietly ate disk.
    let _ = std::fs::remove_dir_all(&profile_dir);
    let soffice_output = match soffice_result {
        Ok(out) => out,
        Err(RunError::NotFound) => {
            return Err(
                "LibreOffice (the \"soffice\" command) isn't installed or isn't on the system PATH. \
                 PowerPoint files can't be converted without it. See src/js/data/PPTX-SETUP.md for \
                 install instructions.".to_string()
            );
        }
        Err(RunError::TimedOut) => {
            return Err(format!(
                "LibreOffice took too long (over {}s) to convert this PowerPoint file and was stopped. \
                 The file may be too large, corrupted, or LibreOffice may be stuck (e.g. a leftover lock \
                 file from a previous crash). Try again, or restart LibreOffice-related processes if this \
                 keeps happening.",
                EXTERNAL_TOOL_TIMEOUT.as_secs()
            ));
        }
        Err(RunError::Launch(e)) => return Err(format!("Failed to launch LibreOffice: {e}")),
    };
    if !soffice_output.status.success() {
        return Err(format!(
            "LibreOffice failed to convert this PowerPoint file to PDF: {}",
            String::from_utf8_lossy(&soffice_output.stderr)
        ));
    }

    let stem = pptx.file_stem().and_then(|s| s.to_str()).unwrap_or("slides");
    let pdf_path = Path::new(&work_dir).join(format!("{stem}.pdf"));
    if !pdf_path.exists() {
        return Err("LibreOffice reported success but produced no PDF file.".to_string());
    }

    render_pdf_to_pngs(&pdf_path, &work_dir)
}

/// Same LibreOffice step as `convert_pptx_to_slides` (`soffice --headless
/// --convert-to pdf`), but stops there and hands the PDF's path back
/// instead of rasterizing it with `pdftoppm`. This is what lets the
/// frontend rasterize with pdf.js instead (see `PdfJsService.js` /
/// `MediaService._convertPdfWithPdfJs`) — so a PowerPoint import only
/// needs the bundled/installed LibreOffice runtime, not Poppler too.
/// `convert_pptx_to_slides` above is kept as-is as the fallback for a
/// build where the pdf.js vendor files aren't present.
#[tauri::command(async)]
fn convert_pptx_to_pdf(pptx_path: String, work_dir: String) -> Result<String, String> {
    let pptx = Path::new(&pptx_path);
    if !pptx.exists() {
        return Err(format!("Source file not found: {}", pptx_path));
    }
    ensure_presentation_file(pptx)?;
    std::fs::create_dir_all(&work_dir).map_err(|e| format!("Could not create working directory: {e}"))?;

    let profile_dir = Path::new(&work_dir).join("lo-profile");
    let profile_url = path_to_file_url(&profile_dir);

    let soffice_result = run_soffice_with_fallback(
        || vec![
            "--headless".to_string(),
            "--norestore".to_string(),
            format!("-env:UserInstallation={profile_url}"),
            "--convert-to".to_string(),
            "pdf".to_string(),
            "--outdir".to_string(),
            work_dir.clone(),
            pptx_path.clone(),
        ],
        EXTERNAL_TOOL_TIMEOUT,
    );
    let _ = std::fs::remove_dir_all(&profile_dir);
    let soffice_output = match soffice_result {
        Ok(out) => out,
        Err(RunError::NotFound) => {
            return Err(
                "LibreOffice (the \"soffice\" command) isn't installed or bundled, so this \
                 PowerPoint file can't be converted. See the OmniDeck release notes for how the \
                 bundled runtime is supposed to be packaged — this machine has neither it nor a \
                 system install.".to_string()
            );
        }
        Err(RunError::TimedOut) => {
            return Err(format!(
                "LibreOffice took too long (over {}s) to convert this PowerPoint file and was stopped. \
                 The file may be too large, corrupted, or LibreOffice may be stuck.",
                EXTERNAL_TOOL_TIMEOUT.as_secs()
            ));
        }
        Err(RunError::Launch(e)) => return Err(format!("Failed to launch LibreOffice: {e}")),
    };
    if !soffice_output.status.success() {
        return Err(format!(
            "LibreOffice failed to convert this PowerPoint file to PDF: {}",
            String::from_utf8_lossy(&soffice_output.stderr)
        ));
    }

    let stem = pptx.file_stem().and_then(|s| s.to_str()).unwrap_or("slides");
    let pdf_path = Path::new(&work_dir).join(format!("{stem}.pdf"));
    if !pdf_path.exists() {
        return Err("LibreOffice reported success but produced no PDF file.".to_string());
    }
    Ok(pdf_path.to_string_lossy().into_owned())
}

/// Renders every page of a PDF to a numbered PNG in `work_dir` via
/// poppler's `pdftoppm`, returning the real, page-order-sorted filenames.
/// Shared by `convert_pptx_to_slides` (rendering the PDF LibreOffice just
/// produced from a PowerPoint) and `convert_pdf_to_slides` below
/// (rendering a PDF the teacher picked directly — no LibreOffice step
/// needed at all, since the source is already a PDF). Kept as one
/// function so both commands report failures and sort pages identically,
/// rather than two copies quietly drifting apart over time.
fn render_pdf_to_pngs(pdf_path: &Path, work_dir: &str) -> Result<Vec<String>, String> {
    // A retry (or a re-import into the same folder) must not mix in page
    // images left over from an earlier, possibly longer, run.
    clear_stale_pages(work_dir);

    // Paths are passed as real OS strings (`.arg(Path)`), not through
    // `to_str().unwrap_or_default()`, which silently turned a non-UTF-8
    // Windows path into an empty argument. The output prefix is joined with
    // the platform's own separator.
    let mut poppler_cmd = Command::new(resolve_tool("pdftoppm"));
    poppler_cmd
        .arg("-png")
        .arg("-r")
        .arg("150")
        .arg(pdf_path)
        .arg(Path::new(work_dir).join("slide"));

    let poppler_output = match run_with_timeout(poppler_cmd, EXTERNAL_TOOL_TIMEOUT) {
        Ok(out) => out,
        Err(RunError::NotFound) => {
            return Err(
                "poppler-utils (the \"pdftoppm\" command) isn't installed or isn't on the system PATH. \
                 Individual page images can't be rendered without it. See src/js/data/PPTX-SETUP.md \
                 for install instructions."
                    .to_string(),
            );
        }
        Err(RunError::TimedOut) => {
            return Err(format!(
                "Rendering page images took too long (over {}s) and was stopped. The PDF may be \
                 unusually large or complex.",
                EXTERNAL_TOOL_TIMEOUT.as_secs()
            ));
        }
        Err(RunError::Launch(e)) => return Err(format!("Failed to launch pdftoppm: {e}")),
    };
    if !poppler_output.status.success() {
        return Err(format!(
            "pdftoppm failed to render page images: {}",
            String::from_utf8_lossy(&poppler_output.stderr)
        ));
    }

    let mut filenames: Vec<String> = std::fs::read_dir(work_dir)
        .map_err(|e| format!("Could not read rendered page directory: {e}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("slide") && name.ends_with(".png") {
                Some(name)
            } else {
                None
            }
        })
        .collect();

    if filenames.is_empty() {
        return Err("Conversion completed but produced no page images.".to_string());
    }

    // Sort by the embedded page number rather than lexicographically, so
    // "slide-2.png" correctly sorts before "slide-10.png" regardless of
    // poppler's zero-padding width for this particular page count.
    filenames.sort_by_key(|name| page_number(name));

    Ok(filenames)
}

/// Renders a teacher-picked PDF directly to one PNG per page, exactly like
/// a PowerPoint's slides — added so PDF handouts get the same "each page
/// becomes its own editable/reorderable page in the lesson" experience
/// PowerPoint import already had, instead of the PDF only ever being
/// embedded whole via the webview's own PDF viewer (see mediaRenderer.js —
/// that embed is kept as the fallback when this conversion isn't
/// possible, e.g. poppler missing, exactly like PowerPoint's fallback).
/// No LibreOffice step needed here — the source is already a PDF, so this
/// skips straight to `render_pdf_to_pngs`.
#[tauri::command(async)]
fn convert_pdf_to_slides(pdf_path: String, work_dir: String) -> Result<Vec<String>, String> {
    let pdf = Path::new(&pdf_path);
    if !pdf.exists() {
        return Err(format!("Source file not found: {}", pdf_path));
    }
    std::fs::create_dir_all(&work_dir).map_err(|e| format!("Could not create working directory: {e}"))?;
    render_pdf_to_pngs(pdf, &work_dir)
}

/// Real PDF text extraction via `pdftotext` (poppler-utils) — the same
/// system tool already required for PowerPoint slide rendering (see
/// `convert_pptx_to_slides` above and PPTX-SETUP.md). `-layout` preserves
/// reading order/columns better than the default for typical lesson
/// handouts. Only this one fixed binary + argument shape is ever invoked;
/// the caller-supplied path is passed as a single argument, never
/// interpolated into a shell string.
///
/// Returns the real extracted text, or a specific error string distinguishing
/// "tool missing" from "this PDF has no extractable text" (e.g. a scanned
/// image-only PDF) — the frontend must not treat those the same way.
#[tauri::command(async)]
fn extract_pdf_text(pdf_path: String) -> Result<String, String> {
    let pdf = Path::new(&pdf_path);
    if !pdf.exists() {
        return Err(format!("Source file not found: {}", pdf_path));
    }

    let mut pdftotext_cmd = Command::new(resolve_tool("pdftotext"));
    pdftotext_cmd.args(["-layout", &pdf_path, "-"]);

    let output = match run_with_timeout(pdftotext_cmd, EXTERNAL_TOOL_TIMEOUT) {
        Ok(out) => out,
        Err(RunError::NotFound) => {
            return Err(
                "poppler-utils (the \"pdftotext\" command) isn't installed or isn't on the system \
                 PATH. PDF text can't be extracted without it. See src/js/data/PPTX-SETUP.md for \
                 install instructions (same package as PowerPoint import)."
                    .to_string(),
            );
        }
        Err(RunError::TimedOut) => {
            return Err(format!(
                "Text extraction took too long (over {}s) and was stopped. This PDF may be unusually \
                 large or complex.",
                EXTERNAL_TOOL_TIMEOUT.as_secs()
            ));
        }
        Err(RunError::Launch(e)) => return Err(format!("Failed to launch pdftotext: {e}")),
    };

    if !output.status.success() {
        return Err(format!(
            "pdftotext could not read this PDF: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err(
            "This PDF has no extractable text (it may be a scanned image with no text layer). \
             Text extraction only works on PDFs that contain real text, not scanned pictures of pages."
                .to_string(),
        );
    }
    Ok(text)
}

/// Word document (.docx/.doc) text extraction.
///
/// `.docx` is an OOXML zip — its text lives in `word/document.xml` — so it
/// is read directly with `docx_reader` (hand-written zip + DEFLATE + XML
/// scan, no new crate, no external process). This is the path essentially
/// every modern "Quiz from Word document" file will take, and it needs
/// nothing installed on the machine.
///
/// `.doc` (the legacy pre-2007 OLE/binary format) is a different, far more
/// complex format that isn't parsed here; it still falls back to LibreOffice
/// (`soffice --headless --convert-to txt:Text`), so that path is kept but is
/// no longer required for the common case.
#[tauri::command(async)]
fn extract_docx_text(doc_path: String) -> Result<String, String> {
    let doc = Path::new(&doc_path);
    if !doc.exists() {
        return Err(format!("Source file not found: {}", doc_path));
    }

    let is_modern_docx = doc
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("docx"))
        .unwrap_or(false);

    if is_modern_docx {
        match std::fs::read(doc) {
            Ok(bytes) => match docx_reader::extract_docx_text(&bytes) {
                Ok(text) if !text.trim().is_empty() => return Ok(text),
                Ok(_) => {
                    return Err(
                        "This document has no extractable text — it may be empty, or contain only \
                         images with no text content."
                            .to_string(),
                    )
                }
                Err(docx_reader::DocxError::NotAZip) => {
                    // Fall through to the .doc/LibreOffice path below — some
                    // tools mislabel a legacy .doc with a .docx extension.
                }
                Err(e) => return Err(e.to_string()),
            },
            Err(e) => return Err(format!("Could not read the file: {e}")),
        }
    }

    extract_doc_text_via_libreoffice(doc, &doc_path)
}

/// Legacy `.doc` fallback — and safety net for a `.docx`-named file that
/// turned out not to actually be a zip. Unchanged from the previous
/// implementation: shells out to LibreOffice, since parsing the binary OLE
/// `.doc` format from scratch is out of scope.
fn extract_doc_text_via_libreoffice(doc: &Path, doc_path: &str) -> Result<String, String> {
    let work_dir = std::env::temp_dir().join(format!("omnideck-docx-{}", uuid_like()));
    std::fs::create_dir_all(&work_dir).map_err(|e| format!("Could not create a temporary working folder: {e}"))?;

    let result = (|| -> Result<String, String> {
        let profile_dir = work_dir.join("lo-profile");
        let profile_url = path_to_file_url(&profile_dir);
        let work_dir_str = work_dir.to_str().unwrap_or_default().to_string();

        let output = match run_soffice_with_fallback(
            || vec![
                "--headless".to_string(),
                "--norestore".to_string(),
                format!("-env:UserInstallation={profile_url}"),
                "--convert-to".to_string(),
                "txt:Text".to_string(),
                "--outdir".to_string(),
                work_dir_str.clone(),
                doc_path.to_string(),
            ],
            EXTERNAL_TOOL_TIMEOUT,
        ) {
            Ok(out) => out,
            Err(RunError::NotFound) => {
                return Err(
                    "This is an older .doc file, which needs LibreOffice (the \"soffice\" command) \
                     to read — it isn't installed or isn't on the system PATH. Modern .docx files \
                     don't need this. See src/js/data/PPTX-SETUP.md for install instructions."
                        .to_string(),
                );
            }
            Err(RunError::TimedOut) => {
                return Err(format!(
                    "LibreOffice took too long (over {}s) to read this document and was stopped. \
                     The file may be too large, corrupted, or LibreOffice may be stuck (e.g. a \
                     leftover lock file from a previous crash).",
                    EXTERNAL_TOOL_TIMEOUT.as_secs()
                ));
            }
            Err(RunError::Launch(e)) => return Err(format!("Failed to launch LibreOffice: {e}")),
        };
        if !output.status.success() {
            return Err(format!(
                "LibreOffice could not read this document: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }

        let stem = doc.file_stem().and_then(|s| s.to_str()).unwrap_or("document");
        let txt_path = work_dir.join(format!("{stem}.txt"));
        if !txt_path.exists() {
            return Err("LibreOffice reported success but produced no text file. This document format may not be supported.".to_string());
        }

        let text = std::fs::read_to_string(&txt_path)
            .map_err(|e| format!("Converted the document but could not read the result: {e}"))?
            .trim()
            .to_string();

        if text.is_empty() {
            return Err(
                "This document has no extractable text — it may be empty, or contain only images \
                 with no text content."
                    .to_string(),
            );
        }
        Ok(text)
    })();

    // Always clean up the temp working folder, whether extraction succeeded
    // or failed, so a failed/cancelled import never leaves stray files.
    let _ = std::fs::remove_dir_all(&work_dir);
    result
}

/// What the frontend needs to decide whether to offer in-app updates.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterStatus {
    /// A signing public key + HTTPS endpoint were compiled into this build.
    configured: bool,
    /// This installation type can replace itself (false for .deb/.rpm).
    can_self_install: bool,
    reason: Option<String>,
    version: String,
}

#[tauri::command]
fn updater_status(app: AppHandle) -> UpdaterStatus {
    let configured = updater_config_ready(app.config().plugins.0.get("updater"));
    let (can_self_install, reason) = updater_can_self_install(TargetOs::current(), std::env::var_os("APPIMAGE").is_some());
    UpdaterStatus {
        configured,
        can_self_install: configured && can_self_install,
        reason: if configured { reason.map(|r| r.to_string()) } else { Some("Automatic updates aren't enabled in this build.".to_string()) },
        version: app.package_info().version.to_string(),
    }
}

/// Restarts into the freshly installed version. Goes through the CloseGate so
/// the frontend has ALREADY flushed pending saves (UpdateService does that
/// before calling this); the gate is approved here only so the restart isn't
/// intercepted a second time by the close handshake.
#[tauri::command]
fn restart_app(app: AppHandle, gate: State<CloseGate>) {
    gate.approve();
    app.restart();
}

/// Starts (or ignores, if already started) the close handshake.
fn begin_close(app: &AppHandle) {
    if let CloseDecision::Notify { generation } = app.state::<CloseGate>().on_close_requested() {
        if app.emit("app:close-requested", ()).is_err() {
            // Couldn't even notify the webview: don't strand the window.
            app.state::<CloseGate>().approve();
            app.exit(0);
            return;
        }
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(CLOSE_ACK_TIMEOUT);
            if handle.state::<CloseGate>().watchdog_should_close(generation) {
                handle.exit(0);
            }
        });
    }
}

/// The webview received "app:close-requested" and is now saving.
#[tauri::command]
fn close_ack(gate: State<CloseGate>) {
    gate.ack();
}

/// Everything was saved (or the teacher chose to discard): exit for real.
#[tauri::command]
fn confirm_close(app: AppHandle, gate: State<CloseGate>) {
    gate.approve();
    app.exit(0);
}

/// The teacher chose to keep editing after a failed final save: the window
/// stays open and the next close attempt starts the handshake afresh.
#[tauri::command]
fn cancel_close(gate: State<CloseGate>) {
    gate.cancel();
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(CloseGate::default())
        .invoke_handler(tauri::generate_handler![
            set_presentation_fullscreen,
            list_monitors,
            open_audience_window,
            audience_placement_status,
            close_audience_window,
            convert_pptx_to_slides,
            convert_pptx_to_pdf,
            convert_pdf_to_slides,
            extract_pdf_text,
            extract_docx_text,
            check_import_dependencies,
            updater_status,
            restart_app,
            close_ack,
            confirm_close,
            cancel_close
        ])
        .on_window_event(|window, event| {
            // Only the main window guards unsaved work; closing the audience
            // window (or the app tearing it down) must not be intercepted.
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<CloseGate>().is_approved() {
                    return; // the handshake finished: let it close
                }
                api.prevent_close();
                begin_close(app);
            }
        })
        .setup(|app| {
            // Self-update is registered ONLY when this build carries a signing public
            // key and an https endpoint (release builds). Dev/PR builds have neither,
            // so there is no half-configured updater that could be misused.
            if updater_config_ready(app.config().plugins.0.get("updater")) {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            // Record where Tauri placed the bundled resources (deb/rpm: /usr/lib/<product>/)
            // so the bundled LibreOffice is found in installed packages, not just dev layouts.
            if let Ok(dir) = app.path().resource_dir() {
                set_resource_dir(dir);
            }
            let window = app.get_webview_window("main").expect("main window must exist");
            window.set_title("OmniDeck").ok();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OmniDeck");

    app.run(|app_handle, event| {
        // Quit paths that skip the window's CloseRequested (macOS Cmd-Q, the
        // last window being destroyed) go through the same save handshake.
        // `code: Some(_)` is an explicit app.exit(..) — i.e. our own
        // confirm_close / watchdog — and must not be intercepted again.
        if let RunEvent::ExitRequested { code: None, api, .. } = &event {
            if !app_handle.state::<CloseGate>().is_approved() && app_handle.get_webview_window("main").is_some() {
                api.prevent_exit();
                begin_close(app_handle);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omnideck-test-{tag}-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ---- file URLs (Windows paths with drive letters and spaces) ----------

    // ---- executable detection --------------------------------------------

    #[test]
    fn dependency_check_never_panics() {
        let deps = check_import_dependencies();
        assert_eq!(deps.soffice.found, deps.soffice.path.is_some());
    }

    // ---- page images ------------------------------------------------------

    #[test]
    fn conversion_of_missing_source_is_a_clear_error() {
        let err = convert_pdf_to_slides("/definitely/not/here.pdf".to_string(), "/tmp/omnideck-none".to_string()).unwrap_err();
        assert!(err.contains("Source file not found"));
    }

    // ---- REAL external tools (skipped when LibreOffice/Poppler aren't installed) ----
    //
    // These run the actual `soffice` and `pdftoppm` binaries against real
    // fixtures. The work directory deliberately contains a SPACE (like a
    // Windows profile "C:\\Users\\Pat Smith\\...") to prove the profile-URL
    // encoding works with the real LibreOffice, not just as a string test.

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("test-fixtures").join(name)
    }

    fn assert_valid_pngs(dir: &Path, names: &[String]) {
        for name in names {
            let bytes = std::fs::read(dir.join(name)).unwrap_or_else(|e| panic!("{name} unreadable: {e}"));
            assert!(bytes.len() > 500, "{name} is suspiciously small ({} bytes)", bytes.len());
            assert_eq!(&bytes[..8], &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "{name} is not a PNG");
        }
    }

    #[test]
    fn real_libreoffice_and_poppler_convert_a_pptx_to_numbered_pngs() {
        let deps = check_import_dependencies();
        if !deps.soffice.found || !deps.pdftoppm.found {
            eprintln!("SKIPPED real_libreoffice_and_poppler_convert_a_pptx_to_numbered_pngs: LibreOffice/Poppler not installed");
            return;
        }
        let base = temp_dir("real pptx");
        let dir = base.join("Pat Smith").join("deck-slides");
        std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
        let pptx = dir.parent().unwrap().join("deck.pptx");
        std::fs::copy(fixture("three-slides.pptx"), &pptx).unwrap();

        let names = convert_pptx_to_slides(pptx.to_string_lossy().to_string(), dir.to_string_lossy().to_string()).expect("real conversion failed");
        assert_eq!(names, vec!["slide-1.png", "slide-2.png", "slide-3.png"]);
        assert_valid_pngs(&dir, &names);
        assert!(!dir.join("lo-profile").exists(), "the throwaway LibreOffice profile must be cleaned up");

        // A retry into the same folder must not mix in stale pages.
        std::fs::write(dir.join("slide-9.png"), b"stale page from an earlier, longer run").unwrap();
        let again = convert_pptx_to_slides(pptx.to_string_lossy().to_string(), dir.to_string_lossy().to_string()).expect("retry failed");
        assert_eq!(again.len(), 3, "stale slide-9.png must be cleared, got {again:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn real_poppler_renders_a_pdf_to_numbered_pngs() {
        if !check_import_dependencies().pdftoppm.found {
            eprintln!("SKIPPED real_poppler_renders_a_pdf_to_numbered_pngs: Poppler not installed");
            return;
        }
        let base = temp_dir("real pdf");
        let dir = base.join("Pat Smith").join("handout-pages");
        let names = convert_pdf_to_slides(fixture("two-pages.pdf").to_string_lossy().to_string(), dir.to_string_lossy().to_string()).expect("real PDF render failed");
        assert_eq!(names, vec!["slide-1.png", "slide-2.png"]);
        assert_valid_pngs(&dir, &names);

        let text = extract_pdf_text(fixture("two-pages.pdf").to_string_lossy().to_string()).expect("pdftotext failed");
        assert!(text.contains("Handout page 1") && text.contains("Handout page 2"), "got: {text}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_corrupt_pptx_is_a_clear_error_not_a_crash_or_fake_slides() {
        if !check_import_dependencies().soffice.found {
            eprintln!("SKIPPED a_corrupt_pptx_is_a_clear_error_not_a_crash_or_fake_slides: LibreOffice not installed");
            return;
        }
        let base = temp_dir("bad pptx");
        let pptx = base.join("broken.pptx");
        std::fs::write(&pptx, b"this is not a zip file, let alone a presentation").unwrap();
        let out = convert_pptx_to_slides(pptx.to_string_lossy().to_string(), base.join("broken-slides").to_string_lossy().to_string());
        let err = out.expect_err("a corrupt deck must not yield slides");
        assert!(err.contains("isn't a valid PowerPoint"), "unclear error: {err}");
        assert!(!base.join("broken-slides").exists() || std::fs::read_dir(base.join("broken-slides")).unwrap().count() == 0, "no slide files may be produced");
        let _ = std::fs::remove_dir_all(&base);
    }

    // ---- close handshake --------------------------------------------------
}
