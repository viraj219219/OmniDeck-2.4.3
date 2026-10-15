//! Platform-independent, std-only helpers for the OmniDeck backend.
//!
//! Everything here is deliberately free of Tauri types so it can be compiled
//! and tested on its own — including cross-compiled for Windows and run under
//! Wine (see `portable-tests/`), and type-checked for macOS. It covers:
//!   - launching external tools with a hard timeout (and no flashing console
//!     window on Windows),
//!   - finding those tools (PATH + PATHEXT + the well-known locations a
//!     Dock/Explorer-launched app does not have on its PATH),
//!   - LibreOffice profile `file://` URLs,
//!   - page-image bookkeeping, presentation-file sanity checks,
//!   - the app-close handshake state machine (`CloseGate`).
#![allow(dead_code)]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Outcome of `run_with_timeout`, kept distinct from a plain `String` error
/// so every call site can still compose its own tool-specific,
/// teacher-facing message (matching the existing per-binary error text)
/// while sharing one hardened process-running implementation.
#[derive(Debug)]
pub enum RunError {
    /// The binary itself isn't installed / isn't on PATH.
    NotFound,
    /// The process exceeded its allotted wall-clock time and was killed.
    TimedOut,
    /// Any other failure to launch or wait on the process.
    Launch(String),
}

/// On Windows the app is a GUI-subsystem program, so every console tool it
/// launches (soffice, pdftoppm, pdftotext) would otherwise pop up — and
/// flash — its own black console window during every conversion, right on
/// the teacher's screen. CREATE_NO_WINDOW suppresses that. No-op elsewhere.
pub fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Runs an external command with a bounded wall-clock timeout, guaranteeing
/// the caller always gets a result — never an indefinite hang.
///
/// `Command::output()` (used previously) blocks forever if the child
/// process never exits. LibreOffice's `soffice --headless` in particular
/// is known to hang indefinitely in real deployments (e.g. a stale lock
/// file left by a crashed prior instance, or certain malformed input
/// files), which would otherwise leave a teacher's import spinning with no
/// error, ever, until they force-quit the whole app. `pdftoppm`/
/// `pdftotext` are far less prone to this but get the same protection for
/// consistency, since a bad/adversarial PDF is exactly the kind of input a
/// classroom import might see.
///
/// Implementation notes:
/// - stdout/stderr are drained on background threads concurrently with the
///   timeout poll, so a large *legitimate* output (e.g. `pdftotext` on a
///   long document) can never fill the OS pipe buffer and make a healthy
///   process look hung.
/// - The timeout is enforced by polling `try_wait()` from the same thread
///   that owns the `Child` and calls `.kill()` directly — there is no
///   separate "killer" thread acting on a bare PID after the fact, which
///   would risk killing an unrelated process if the original PID were
///   reaped and reused by the OS in the intervening time. Owning the
///   `Child` for the whole call makes that race impossible.
/// - On timeout, `child.wait()` is still called after `kill()` to reap the
///   process so it never lingers as a zombie.
/// - On timeout, the ENTIRE process tree is torn down (see
///   `kill_process_tree`), not just the PID `Command::spawn()` handed
///   back. This matters specifically for `soffice`: on Windows,
///   `soffice.exe` is a thin launcher that starts a separate
///   `soffice.bin` worker process and exits/detaches from it almost
///   immediately, so `child.kill()` on the launcher's PID alone can be a
///   no-op against the process actually doing (and hanging on) the
///   conversion work. Left alone, a timed-out import leaves that real
///   worker running in the background — invisible to the teacher, still
///   holding the throwaway profile lock and consuming memory — and every
///   retried/subsequent import compounds this, which is a real path to
///   the whole app eventually being killed by the OS for memory
///   exhaustion long after any single import's 120s timeout should have
///   made that impossible.
pub fn run_with_timeout(mut command: Command, timeout: Duration) -> Result<std::process::Output, RunError> {
    hide_console_window(&mut command);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(RunError::NotFound),
        Err(e) => return Err(RunError::Launch(format!("Failed to launch process: {e}"))),
    };

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = stdout_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = stderr_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    kill_process_tree(&mut child);
                    let _ = child.wait();
                    return Err(RunError::TimedOut);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(RunError::Launch(format!("Failed while waiting for process: {e}"))),
        }
    };

    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    Ok(std::process::Output { status, stdout, stderr })
}

/// Kills `child` AND every process it spawned, best-effort. Plain
/// `Child::kill()` only signals the one PID `spawn()` returned — on
/// Windows that is not enough for `soffice`, whose launcher process can
/// start a separate `soffice.bin` worker and return before the real work
/// (and any hang) even begins. `taskkill /T` walks the whole process
/// tree rooted at that PID and terminates it in one shot; `/F` forces it
/// (soffice ignores a polite close request while headless-hung). This is
/// invoked via `std::process::Command` — no extra crate/dependency — and
/// is purely best-effort: if `taskkill` itself isn't available or fails,
/// `child.kill()` still runs as the fallback it always was, so this can
/// only improve on the previous behaviour, never regress it.
/// No-op-but-harmless on non-Windows: `child.kill()` alone already tears
/// down the direct child there, and neither `soffice` nor `pdftoppm` on
/// Linux/macOS are known to double-fork the way the Windows build does.
fn kill_process_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_console_window(&mut taskkill);
        // Best-effort: run and wait briefly, but never let a broken/missing
        // taskkill stop us from also calling the normal kill() below.
        let _ = taskkill.output();
    }
    let _ = child.kill();
}

/// Every external conversion in this file uses the same ceiling. Generous
/// enough for a large real lesson PPTX/PDF on modest classroom hardware,
/// short enough that a genuinely hung LibreOffice/poppler process still
/// surfaces a clear error well within a teacher's patience during class
/// prep (never during class itself — imports happen ahead of time).
pub const EXTERNAL_TOOL_TIMEOUT: Duration = Duration::from_secs(120);

/// Common install locations for LibreOffice's `soffice` binary, tried only
/// after the plain `soffice` command (i.e. whatever's on PATH) comes back
/// NotFound. Covers the most frequent real-world gap — LibreOffice's own
/// Windows installer does not always add itself to PATH, and some Linux
/// package layouts don't symlink `soffice` into `/usr/bin` — without
/// hardcoding a platform-specific path when the plain command already
/// resolves normally. A candidate that doesn't exist on this machine just
/// fails NotFound like any other missing binary, so this list is harmless
/// to probe on any OS.
/// Where a LibreOffice runtime bundled INSIDE the OmniDeck install would
/// live, if `tauri.conf.json`'s `bundle.resources` ships one (see
/// `scripts/vendor-libreoffice-linux.sh` / the v2.3 CI changes for how
/// that resource gets populated — this function only knows how to find it
/// once it's there). Resolved relative to the running executable rather
/// than hardcoded to an absolute install path, since Tauri places bundled
/// resources next to the binary the same way on every platform this app
/// ships for.
///
/// The Linux layout is NOT a flat `program/soffice` — LibreOffice's own
/// .deb packaging splits the runtime across version-numbered sibling
/// directories (`opt/libreofficeX.Y/`, `opt/basisX.Y/`, `opt/ureX.Y/`)
/// cross-linked by symlinks, so the version number can't be hardcoded
/// here; this scans `resources/libreoffice/opt/` for the one entry whose
/// name starts with "libreoffice" instead. Windows/macOS resource layouts
/// (once vendored — see PPTX-SETUP.md for status) are expected to be
/// flatter, since their installers don't split things up the same way.
///
/// Returns None (never panics) if the exe path can't be determined or no
/// bundled copy is present — callers fall through to the system PATH /
/// well-known-install-folder candidates below exactly as before.
pub fn bundled_soffice_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let roots = bundled_runtime_roots(exe_dir, RESOURCE_DIR.get().map(|p| p.as_path()), TargetOs::current());
    find_bundled_soffice(&roots, TargetOs::current())
}

/// Tauri's own resolved resource directory (`app.path().resource_dir()`),
/// recorded once at startup. This is the AUTHORITATIVE place bundled resources
/// live in every package type: next to the exe on Windows, `Contents/Resources`
/// in a macOS .app, and `/usr/lib/<productName>/` for an installed Linux
/// .deb/.rpm (where the executable is in `/usr/bin`, NOT beside the resources).
/// The exe-relative guesses below only remain as fallbacks for dev layouts.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

/// Every directory that may be the root of the bundled LibreOffice runtime
/// ("resources/libreoffice/**" in tauri.conf.json maps to
/// `<resource_dir>/resources/libreoffice`), most authoritative first.
pub fn bundled_runtime_roots(exe_dir: &Path, resource_dir: Option<&Path>, os: TargetOs) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(r) = resource_dir {
        roots.push(r.join("resources").join("libreoffice"));
        roots.push(r.join("libreoffice"));
    }
    roots.push(exe_dir.join("resources").join("libreoffice"));
    roots.push(exe_dir.join("..").join("resources").join("libreoffice")); // dev layout
    match os {
        TargetOs::Linux => {
            // Installed .deb/.rpm/AppImage: binary in <prefix>/bin, resources in <prefix>/lib/<productName>/.
            for name in ["OmniDeck", "omnideck"] {
                roots.push(exe_dir.join("..").join("lib").join(name).join("resources").join("libreoffice"));
            }
        }
        TargetOs::MacOs => {
            roots.push(exe_dir.join("..").join("Resources").join("resources").join("libreoffice"));
            roots.push(exe_dir.join("..").join("Resources").join("libreoffice"));
        }
        TargetOs::Windows => {}
    }
    roots
}

/// Finds a launchable `soffice` inside the first root that has one.
///
/// Linux: LibreOffice's .deb layout is split across version-numbered siblings
/// (`opt/libreofficeX.Y/`), so scan `opt/` (sorted, newest name last wins is
/// irrelevant: the vendoring script stages exactly one) rather than hardcoding.
/// macOS: the official app bundle is kept intact (frameworks are required).
/// Windows: `program/soffice.exe`.
pub fn find_bundled_soffice(roots: &[PathBuf], os: TargetOs) -> Option<PathBuf> {
    for root in roots {
        match os {
            TargetOs::Linux => {
                let Ok(entries) = std::fs::read_dir(root.join("opt")) else { continue };
                let mut dirs: Vec<PathBuf> = entries
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with("libreoffice"))
                    .map(|e| e.path())
                    .collect();
                dirs.sort();
                for d in dirs {
                    let candidate = d.join("program").join("soffice");
                    if is_launchable_file(&candidate) {
                        return Some(candidate);
                    }
                }
            }
            TargetOs::MacOs => {
                let candidate = root.join("LibreOffice.app").join("Contents").join("MacOS").join("soffice");
                if is_launchable_file(&candidate) {
                    return Some(candidate);
                }
            }
            TargetOs::Windows => {
                let candidate = root.join("program").join("soffice.exe");
                if is_launchable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// The soffice that will actually be used and reported: the BUNDLED runtime
/// first, then PATH, then well-known install locations.
pub fn resolve_soffice() -> Option<PathBuf> {
    bundled_soffice_path()
        .or_else(|| find_executable("soffice"))
        .or_else(|| {
            soffice_candidates()
                .into_iter()
                .filter(|c| Path::new(c).is_absolute())
                .map(PathBuf::from)
                .find(|c| is_launchable_file(c))
        })
}

pub fn soffice_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(bundled) = bundled_soffice_path() {
        candidates.push(bundled.to_string_lossy().into_owned());
    }
    candidates.push("soffice".to_string());
    if cfg!(target_os = "windows") {
        candidates.push(r"C:\Program Files\LibreOffice\program\soffice.exe".to_string());
        candidates.push(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe".to_string());
    } else if cfg!(target_os = "macos") {
        candidates.push("/Applications/LibreOffice.app/Contents/MacOS/soffice".to_string());
    } else {
        candidates.push("/usr/bin/soffice".to_string());
        candidates.push("/usr/lib/libreoffice/program/soffice".to_string());
        candidates.push("/opt/libreoffice/program/soffice".to_string());
        candidates.push("/snap/bin/libreoffice.soffice".to_string());
    }
    candidates
}


/// Refuses files that aren't really presentations BEFORE LibreOffice sees
/// them. Found by running the real `soffice` against a garbage "broken.pptx":
/// LibreOffice happily opens unrecognised content as plain text and renders
/// it to "slides", which would silently turn a corrupted or renamed file
/// into fake slides. A genuine .pptx/.odp is a ZIP archive (PK\x03\x04) and a
/// legacy .ppt is an OLE2 container (D0 CF 11 E0 A1 B1 1A E1).
pub fn ensure_presentation_file(path: &Path) -> Result<(), String> {
    let mut head = [0u8; 8];
    let read = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|e| format!("Couldn't read the presentation file: {e}"))?;
    let is_zip = read >= 4 && head[..4] == [0x50, 0x4b, 0x03, 0x04];
    let is_ole = read >= 8 && head == [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if is_zip || is_ole {
        Ok(())
    } else {
        Err("This file isn't a valid PowerPoint presentation (it isn't a real .pptx/.ppt — it may be corrupted, \
             incomplete, or another file type that was renamed). Nothing was imported.".to_string())
    }
}

/// Percent-encodes a filesystem path into a `file://` URL suitable for
/// LibreOffice's `-env:UserInstallation=`. Two Windows-specific problems
/// the previous `format!("file://{path}")` had:
///   - `C:\Users\...` became `file://C:/Users/...` (two slashes: "C:" is
///     parsed as a host name) — a drive-letter path needs THREE slashes;
///   - a space in the user's profile folder ("C:\Users\Pat Smith\...")
///     was left raw, which is not a valid URL and makes LibreOffice reject
///     the profile location and fall back to (or hang on) the shared one.
/// A `\\?\` extended-length prefix (from canonicalize) is stripped first.
pub fn path_to_file_url(path: &Path) -> String {
    let mut raw = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = raw.strip_prefix("//?/") {
        raw = rest.to_string();
    }
    let mut encoded = String::with_capacity(raw.len() + 8);
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => encoded.push(b as char),
            other => encoded.push_str(&format!("%{:02X}", other)),
        }
    }
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

/// Is `path` a regular file that could be launched? (On Unix this also
/// requires an execute bit; Windows has no such bit — the extension list
/// from PATHEXT decides instead.)
pub fn is_launchable_file(path: &Path) -> bool {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Looks for `name` in `dirs`, trying each of `exts` (Windows PATHEXT-style,
/// e.g. ".exe") appended to it — plus `name` as given. Pure and
/// deterministic so it can be unit-tested with a temp directory; the real
/// PATH/PATHEXT are read by `find_executable`.
pub fn find_in_dirs(name: &str, dirs: &[PathBuf], exts: &[String]) -> Option<PathBuf> {
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let mut names = vec![name.to_string()];
        for ext in exts {
            names.push(format!("{name}{ext}"));
        }
        for candidate in names {
            let full = dir.join(&candidate);
            if is_launchable_file(&full) {
                return Some(full);
            }
        }
    }
    None
}

/// Operating systems whose tool-lookup rules differ. An explicit parameter
/// (rather than `cfg!` inside the functions) so the macOS/Windows rules can
/// be exercised by tests running on any OS.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TargetOs {
    Windows,
    MacOs,
    Linux,
}

impl TargetOs {
    pub fn current() -> TargetOs {
        if cfg!(target_os = "windows") {
            TargetOs::Windows
        } else if cfg!(target_os = "macos") {
            TargetOs::MacOs
        } else {
            TargetOs::Linux
        }
    }
}

/// Executable-extension list (Windows PATHEXT semantics); empty elsewhere.
pub fn executable_extensions(os: TargetOs, pathext: Option<&str>) -> Vec<String> {
    if os != TargetOs::Windows {
        return Vec::new();
    }
    pathext
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_string())
        .collect()
}

/// Finds an executable on the real PATH (plus the well-known locations in
/// `tool_search_dirs`) without running it. On Windows this honours PATHEXT
/// (so `soffice` matches `soffice.exe`, `pdftoppm` matches `pdftoppm.exe`).
/// Detection deliberately doesn't execute the tool: `soffice` can hang on
/// start-up, and "is it installed" doesn't need it.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    let os = TargetOs::current();
    let exts = executable_extensions(os, std::env::var("PATHEXT").ok().as_deref());
    find_in_dirs(name, &tool_search_dirs(), &exts)
}

/// Well-known install locations that a GUI-launched app does NOT have on its
/// PATH. On macOS a Finder/Dock-launched app inherits only launchd's minimal
/// PATH (/usr/bin:/bin:/usr/sbin:/sbin), so Homebrew's `pdftoppm` in
/// /opt/homebrew/bin (Apple Silicon) or /usr/local/bin (Intel) — exactly
/// where `brew install poppler` puts it — would be reported "not installed"
/// even though it works in Terminal. `root` is "/" in production; tests pass
/// a temp dir standing in for the filesystem root.
pub fn extra_tool_dirs(os: TargetOs, root: &Path) -> Vec<PathBuf> {
    let rel: &[&str] = match os {
        TargetOs::MacOs => &["opt/homebrew/bin", "usr/local/bin", "opt/local/bin"],
        TargetOs::Windows => &[],
        TargetOs::Linux => &["usr/local/bin", "usr/bin", "snap/bin"],
    };
    rel.iter().map(|r| root.join(r)).collect()
}

/// PATH entries first, then the extra locations, without duplicates.
pub fn tool_search_dirs_for(os: TargetOs, path_var: Option<&std::ffi::OsStr>, root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_var.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    for extra in extra_tool_dirs(os, root) {
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    dirs
}

pub fn tool_search_dirs() -> Vec<PathBuf> {
    let path = std::env::var_os("PATH");
    tool_search_dirs_for(TargetOs::current(), path.as_deref(), Path::new("/"))
}

/// The command to actually run for `name`: the resolved absolute path when
/// it is found (so detection and execution always agree — including the
/// extra directories above), otherwise the bare name so a missing tool
/// still produces the normal "isn't installed" error.
pub fn resolve_tool(name: &str) -> PathBuf {
    find_executable(name).unwrap_or_else(|| PathBuf::from(name))
}



/// True only if `plugins.updater` carries a real-looking minisign public key
/// (the Tauri updater public key is a long base64 string) AND at least one
/// endpoint. Dev/PR builds ship without it, and for those the updater plugin
/// is simply not registered — there is no half-configured state in which the
/// app could trust an unverifiable update.
pub fn updater_config_ready(updater_cfg: Option<&serde_json::Value>) -> bool {
    let Some(cfg) = updater_cfg else { return false };
    let key_ok = cfg.get("pubkey").and_then(|v| v.as_str()).map(|k| k.trim().len() >= 40).unwrap_or(false);
    let endpoints_ok = cfg.get("endpoints").and_then(|v| v.as_array()).map(|a| a.iter().any(|e| e.as_str().map(|s| s.starts_with("https://")).unwrap_or(false))).unwrap_or(false);
    key_ok && endpoints_ok
}

/// Whether this installation can replace itself. The Tauri updater supports
/// Windows (NSIS/MSI), macOS (.app) and Linux AppImage ONLY; a .deb/.rpm is
/// managed by the system package manager, so there the UI can announce a new
/// version but must send the user to the release page instead of installing.
pub fn updater_can_self_install(os: TargetOs, running_as_appimage: bool) -> (bool, Option<&'static str>) {
    match os {
        TargetOs::Linux if !running_as_appimage => (
            false,
            Some("This copy of OmniDeck was installed from a .deb/.rpm package, which can't update itself. Download the new package from the release page, or use the AppImage for in-app updates."),
        ),
        _ => (true, None),
    }
}

/// Result of checking where the audience window actually is right now.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct PlacementVerdict {
    pub open: bool,
    pub ok: bool,
    /// Machine-readable reason when `ok` is false.
    pub problem: Option<&'static str>,
}

/// Decides whether the audience window is safely on its own display.
/// Positions are the top-left corners of monitors/windows' monitors (the
/// same identity the "never on the presenter's monitor" guard in
/// `open_audience_window` uses — index-independent, so it stays correct
/// when a hot-plug re-numbers the monitors).
///
///   no audience window                    -> not open (nothing to protect)
///   fewer than 2 monitors                 -> "second-display-disconnected"
///   window on no known monitor            -> "audience-off-screen"
///   window on the presenter's monitor     -> "audience-on-presenter-display"
///                                            (a window manager typically drags
///                                            an orphaned window onto whatever
///                                            display is left — i.e. right over
///                                            the presenter's controls)
///   otherwise                             -> ok
pub fn classify_audience_placement(
    audience_open: bool,
    monitors: &[(i32, i32)],
    presenter: Option<(i32, i32)>,
    audience: Option<(i32, i32)>,
) -> PlacementVerdict {
    let verdict = |ok: bool, problem: Option<&'static str>| PlacementVerdict { open: audience_open, ok, problem };
    if !audience_open {
        return verdict(false, Some("no-audience-window"));
    }
    if monitors.len() < 2 {
        return verdict(false, Some("second-display-disconnected"));
    }
    let Some(a) = audience else {
        return verdict(false, Some("audience-off-screen"));
    };
    if !monitors.contains(&a) {
        return verdict(false, Some("audience-off-screen"));
    }
    if presenter == Some(a) {
        return verdict(false, Some("audience-on-presenter-display"));
    }
    verdict(true, None)
}

/// Page number embedded in a poppler output name ("slide-07.png" -> 7).
pub fn page_number(name: &str) -> u32 {
    name.trim_start_matches("slide")
        .trim_start_matches('-')
        .trim_end_matches(".png")
        .parse::<u32>()
        .unwrap_or(0)
}

/// Deletes previously rendered `slide*.png` files in `work_dir` (best effort).
pub fn clear_stale_pages(work_dir: &str) {
    if let Ok(entries) = std::fs::read_dir(work_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("slide") && name.ends_with(".png") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}


/// Small dependency-free unique-ish suffix for temp directory names (avoids
/// pulling in a uuid crate just for this). Not cryptographically unique —
/// doesn't need to be, only collision-avoiding for concurrent local calls.
pub fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}-{:x}", nanos, std::process::id())
}

// ---------------------------------------------------------------------------
// App-close handshake
// ---------------------------------------------------------------------------
//
// `beforeunload` can't await an async filesystem write, and the webview
// doesn't even fire it when the window is closed, so the frontend can't be
// trusted to save on its way out. Instead the NATIVE close request is
// intercepted:
//
//   user closes main window
//     -> Rust keeps it open and emits "app:close-requested"      (begin_close)
//     -> JS answers `close_ack` (webview is alive: watchdog disarmed)
//     -> JS flushes every pending save (final atomic write)
//     -> JS calls `confirm_close` (window closes / app exits)
//        or `cancel_close` if the save failed and the teacher chose to keep
//        editing.
//   If the webview never acknowledges (crashed, still loading) a watchdog
//   forces the exit after CLOSE_ACK_TIMEOUT, so the window can never become
//   impossible to close. macOS Cmd-Q, which bypasses window close events,
//   is routed through the same path via RunEvent::ExitRequested.

/// How long Rust waits for the webview to acknowledge a close request
/// before closing anyway. The webview answers immediately when healthy;
/// the (longer) save itself is bounded on the JS side.
pub const CLOSE_ACK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClosePhase {
    Idle,
    /// Event sent; waiting for the webview to acknowledge.
    Requested,
    /// The webview is flushing saves.
    Acked,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloseDecision {
    /// Already approved: let the close go through.
    Allow,
    /// A close is already in progress: keep the window open, do nothing more.
    Ignore,
    /// First request: keep the window open, notify the webview, arm the
    /// watchdog for this generation.
    Notify { generation: u64 },
}

pub struct CloseState {
    phase: ClosePhase,
    generation: u64,
    approved: bool,
}

pub struct CloseGate {
    inner: Mutex<CloseState>,
}

impl Default for CloseGate {
    fn default() -> Self {
        CloseGate { inner: Mutex::new(CloseState { phase: ClosePhase::Idle, generation: 0, approved: false }) }
    }
}

impl CloseGate {
    fn lock(&self) -> std::sync::MutexGuard<'_, CloseState> {
        // A poisoned lock must never make the app un-closable.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_approved(&self) -> bool {
        self.lock().approved
    }

    pub fn on_close_requested(&self) -> CloseDecision {
        let mut s = self.lock();
        if s.approved {
            return CloseDecision::Allow;
        }
        match s.phase {
            ClosePhase::Idle => {
                s.phase = ClosePhase::Requested;
                s.generation += 1;
                CloseDecision::Notify { generation: s.generation }
            }
            ClosePhase::Requested | ClosePhase::Acked => CloseDecision::Ignore,
        }
    }

    /// The webview is alive and handling the close: disarm the watchdog.
    pub fn ack(&self) {
        let mut s = self.lock();
        if s.phase == ClosePhase::Requested {
            s.phase = ClosePhase::Acked;
            s.generation += 1;
        }
    }

    /// The teacher chose to keep editing (or a save failed): back to normal.
    pub fn cancel(&self) {
        let mut s = self.lock();
        s.phase = ClosePhase::Idle;
        s.generation += 1;
    }

    pub fn approve(&self) {
        self.lock().approved = true;
    }

    /// Called by the watchdog thread: true (and approves the close) only if
    /// the webview never acknowledged THIS request.
    pub fn watchdog_should_close(&self, generation: u64) -> bool {
        let mut s = self.lock();
        if s.generation == generation && s.phase == ClosePhase::Requested {
            s.approved = true;
            true
        } else {
            false
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;


    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omnideck-test-{tag}-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn file_url_windows_drive_path_has_three_slashes_and_encoded_spaces() {
        let url = path_to_file_url(Path::new(r"C:\Users\Pat Smith\AppData\Local\org.omnideck.app\media\x-slides\lo-profile"));
        assert_eq!(url, "file:///C:/Users/Pat%20Smith/AppData/Local/org.omnideck.app/media/x-slides/lo-profile");
    }

    #[test]
    fn file_url_unix_path() {
        assert_eq!(path_to_file_url(Path::new("/home/pat/my files/p")), "file:///home/pat/my%20files/p");
    }

    #[test]
    fn file_url_strips_extended_length_prefix_and_encodes_non_ascii() {
        assert_eq!(path_to_file_url(Path::new(r"\\?\C:\Users\Zoë\p")), "file:///C:/Users/Zo%C3%AB/p");
    }

    #[test]
    fn finds_executable_with_pathext_style_extension() {
        let dir = temp_dir("pathext");
        std::fs::write(dir.join("soffice.exe"), b"x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.join("soffice.exe"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let found = find_in_dirs("soffice", &[dir.clone()], &[".exe".to_string()]);
        assert_eq!(found, Some(dir.join("soffice.exe")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_executable_is_none_not_a_panic() {
        let dir = temp_dir("missing");
        assert_eq!(find_in_dirs("pdftoppm", &[dir.clone(), PathBuf::new()], &[".exe".to_string()]), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_file_is_not_reported_as_installed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("noexec");
        std::fs::write(dir.join("pdftotext"), b"x").unwrap();
        std::fs::set_permissions(dir.join("pdftotext"), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(find_in_dirs("pdftotext", &[dir.clone()], &[]), None);
        let _ = std::fs::remove_dir_all(&dir);
    }


    #[test]
    fn pages_sort_numerically_not_lexicographically() {
        let mut names = vec!["slide-10.png", "slide-2.png", "slide-01.png"].into_iter().map(String::from).collect::<Vec<_>>();
        names.sort_by_key(|n| page_number(n));
        assert_eq!(names, vec!["slide-01.png", "slide-2.png", "slide-10.png"]);
    }

    #[test]
    fn stale_pages_are_cleared_but_other_files_kept() {
        let dir = temp_dir("stale");
        std::fs::write(dir.join("slide-1.png"), b"old").unwrap();
        std::fs::write(dir.join("slide-2.png"), b"old").unwrap();
        std::fs::write(dir.join("deck.pdf"), b"keep").unwrap();
        clear_stale_pages(dir.to_str().unwrap());
        assert!(!dir.join("slide-1.png").exists());
        assert!(!dir.join("slide-2.png").exists());
        assert!(dir.join("deck.pdf").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_close_request_notifies_and_second_is_ignored() {
        let gate = CloseGate::default();
        assert_eq!(gate.on_close_requested(), CloseDecision::Notify { generation: 1 });
        assert_eq!(gate.on_close_requested(), CloseDecision::Ignore);
    }

    #[test]
    fn watchdog_closes_only_if_webview_never_acknowledged() {
        let gate = CloseGate::default();
        let CloseDecision::Notify { generation } = gate.on_close_requested() else { panic!() };
        assert!(gate.watchdog_should_close(generation));
        assert!(gate.is_approved());

        let gate = CloseGate::default();
        let CloseDecision::Notify { generation } = gate.on_close_requested() else { panic!() };
        gate.ack(); // webview is alive and saving
        assert!(!gate.watchdog_should_close(generation));
        assert!(!gate.is_approved());
    }

    #[test]
    fn cancel_after_failed_save_lets_the_next_close_start_over() {
        let gate = CloseGate::default();
        let CloseDecision::Notify { generation } = gate.on_close_requested() else { panic!() };
        gate.ack();
        gate.cancel();
        assert!(!gate.watchdog_should_close(generation)); // old watchdog is dead
        assert_eq!(gate.on_close_requested(), CloseDecision::Notify { generation: 4 });
    }

    #[test]
    fn approved_close_is_allowed_through() {
        let gate = CloseGate::default();
        gate.approve();
        assert_eq!(gate.on_close_requested(), CloseDecision::Allow);
    }


    // ---- tool lookup rules per OS (run on EVERY host) ----------------------

    #[test]
    fn macos_gui_launched_app_still_finds_homebrew_tools() {
        // launchd's minimal PATH, as seen by an app started from the Dock/Finder.
        let launchd_path = std::env::join_paths(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]).unwrap();
        // A temp dir stands in for "/" so the test needs no real Homebrew.
        let root = temp_dir("fake-root");
        for (rel, tool) in [("opt/homebrew/bin", "omnideck-fake-pdftoppm"), ("usr/local/bin", "omnideck-fake-pdftotext")] {
            let dir = root.join(rel);
            std::fs::create_dir_all(&dir).unwrap();
            let f = dir.join(tool);
            std::fs::write(&f, b"#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let dirs = tool_search_dirs_for(TargetOs::MacOs, Some(launchd_path.as_os_str()), &root);
        assert_eq!(find_in_dirs("omnideck-fake-pdftoppm", &dirs, &[]), Some(root.join("opt/homebrew/bin/omnideck-fake-pdftoppm")), "Apple-Silicon Homebrew");
        assert_eq!(find_in_dirs("omnideck-fake-pdftotext", &dirs, &[]), Some(root.join("usr/local/bin/omnideck-fake-pdftotext")), "Intel Homebrew");
        // …and WITHOUT the extra locations (the old behaviour) they are invisible:
        let only_path: Vec<PathBuf> = std::env::split_paths(&launchd_path).collect();
        assert_eq!(find_in_dirs("omnideck-fake-pdftoppm", &only_path, &[]), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn path_entries_come_first_and_nothing_is_duplicated() {
        let root = Path::new("/");
        let path = std::env::join_paths(["/usr/local/bin", "/custom/bin"]).unwrap();
        let dirs = tool_search_dirs_for(TargetOs::Linux, Some(path.as_os_str()), root);
        assert_eq!(dirs[0], PathBuf::from("/usr/local/bin"));
        assert_eq!(dirs[1], PathBuf::from("/custom/bin"));
        let mut seen = std::collections::HashSet::new();
        assert!(dirs.iter().all(|d| seen.insert(d.clone())), "duplicates: {dirs:?}");
    }

    #[test]
    fn windows_has_no_extra_dirs_and_uses_pathext() {
        assert!(extra_tool_dirs(TargetOs::Windows, Path::new("/")).is_empty());
        assert_eq!(executable_extensions(TargetOs::Windows, Some(".EXE;.CMD;")), vec![".EXE", ".CMD"]);
        assert_eq!(executable_extensions(TargetOs::Windows, None), vec![".COM", ".EXE", ".BAT", ".CMD"]);
        assert!(executable_extensions(TargetOs::MacOs, Some(".EXE")).is_empty());
        assert!(executable_extensions(TargetOs::Linux, None).is_empty());
    }

    #[test]
    fn current_os_matches_the_compile_target() {
        let os = TargetOs::current();
        assert_eq!(os == TargetOs::Windows, cfg!(target_os = "windows"));
        assert_eq!(os == TargetOs::MacOs, cfg!(target_os = "macos"));
    }

    #[test]
    fn resolve_tool_falls_back_to_the_bare_name() {
        assert_eq!(resolve_tool("definitely-not-a-real-tool-xyz"), PathBuf::from("definitely-not-a-real-tool-xyz"));
    }

    // ---- running tools: timeout, not-found, output ---------------------------

    fn shell_echo() -> Command {
        if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "echo", "omnideck-ok"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "echo omnideck-ok"]);
            c
        }
    }

    #[test]
    fn run_with_timeout_returns_real_output_and_hides_the_console() {
        let out = run_with_timeout(shell_echo(), Duration::from_secs(20)).expect("echo should run");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("omnideck-ok"));
    }

    #[test]
    fn a_missing_binary_is_not_found_not_a_panic() {
        match run_with_timeout(Command::new("omnideck-definitely-missing-binary"), Duration::from_secs(5)) {
            Err(RunError::NotFound) => {}
            other => panic!("expected NotFound, got {:?}", other.map(|o| o.status)),
        }
    }

    #[test]
    fn a_hung_tool_is_killed_at_the_timeout() {
        let cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "for /L %i in (1,1,2000000000) do @rem"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 60"]);
            c
        };
        let started = Instant::now();
        match run_with_timeout(cmd, Duration::from_millis(1500)) {
            Err(RunError::TimedOut) => {}
            other => panic!("expected TimedOut, got {:?}", other.map(|o| o.status)),
        }
        assert!(started.elapsed() < Duration::from_secs(15), "the timeout did not bound the call");
    }

    /// Regression test for the exit-code-8 / orphaned-process bug: a timeout
    /// must kill the WHOLE process tree, not just the PID `spawn()` returned.
    /// Only meaningful on Windows (see `kill_process_tree`'s `#[cfg(windows)]`
    /// gate) — the launcher-spawns-a-worker split is a Windows `soffice.exe`
    /// behaviour, so on Unix this is skipped rather than asserting anything
    /// about `taskkill`, which doesn't exist there.
    #[test]
    #[cfg(windows)]
    fn a_hung_tools_child_process_is_also_killed_at_the_timeout() {
        // The parent (`cmd`) starts a background grandchild (`ping`, chosen
        // because it's always present and easy to spot in `tasklist` by a
        // distinctive marker) that keeps running for well over the test's
        // timeout, then hangs itself — mirroring soffice.exe (parent) that
        // hangs while soffice.bin (the real worker) is the one still going.
        // If `kill_process_tree` only killed the parent PID, this grandchild
        // would still show up in `tasklist` after `run_with_timeout` returns.
        let marker = format!("omnideck-portable-test-{}", std::process::id());
        let mut cmd = Command::new("cmd");
        cmd.args([
            "/C",
            &format!(
                "start /B \"{marker}\" ping -n 60 127.0.0.1 >nul & for /L %i in (1,1,2000000000) do @rem"
            ),
        ]);

        match run_with_timeout(cmd, Duration::from_millis(1500)) {
            Err(RunError::TimedOut) => {}
            other => panic!("expected TimedOut, got {:?}", other.map(|o| o.status)),
        }

        // Give the OS a moment to finish tearing the tree down, then confirm
        // no process tagged with our marker window title is still alive.
        std::thread::sleep(Duration::from_millis(500));
        let mut tasklist = Command::new("tasklist");
        tasklist.args(["/FI", &format!("WINDOWTITLE eq {marker}"), "/NH"]);
        let out = tasklist.output().expect("tasklist should run");
        let listing = String::from_utf8_lossy(&out.stdout);
        assert!(
            !listing.contains("ping.exe"),
            "the ping.exe grandchild survived the timeout — only the parent PID was killed:\n{listing}"
        );
    }


    // ---- audience placement (hot-plug safety) --------------------------------

    #[test]
    fn audience_on_its_own_display_is_ok() {
        let v = classify_audience_placement(true, &[(0, 0), (1920, 0)], Some((0, 0)), Some((1920, 0)));
        assert_eq!(v, PlacementVerdict { open: true, ok: true, problem: None });
    }

    #[test]
    fn unplugging_the_second_display_is_detected_first() {
        let v = classify_audience_placement(true, &[(0, 0)], Some((0, 0)), Some((0, 0)));
        assert_eq!(v.problem, Some("second-display-disconnected"));
        assert!(!v.ok);
    }

    #[test]
    fn a_window_dragged_onto_the_presenters_display_is_flagged() {
        let v = classify_audience_placement(true, &[(0, 0), (1920, 0)], Some((0, 0)), Some((0, 0)));
        assert_eq!(v.problem, Some("audience-on-presenter-display"));
    }

    #[test]
    fn a_window_on_no_known_monitor_is_flagged() {
        assert_eq!(classify_audience_placement(true, &[(0, 0), (1920, 0)], Some((0, 0)), None).problem, Some("audience-off-screen"));
        assert_eq!(classify_audience_placement(true, &[(0, 0), (1920, 0)], Some((0, 0)), Some((3840, 0))).problem, Some("audience-off-screen"));
    }

    #[test]
    fn renumbered_monitors_are_judged_by_position_not_index() {
        // Hot-plug re-ordered the list; the audience is still on the non-presenter screen.
        let v = classify_audience_placement(true, &[(1920, 0), (0, 0)], Some((0, 0)), Some((1920, 0)));
        assert!(v.ok);
    }

    #[test]
    fn no_audience_window_means_nothing_to_protect() {
        let v = classify_audience_placement(false, &[(0, 0), (1920, 0)], Some((0, 0)), None);
        assert!(!v.open && v.problem == Some("no-audience-window"));
    }

    // ---- REAL Windows behaviour (compiled and run only for Windows targets) ----

    #[cfg(windows)]
    #[test]
    fn windows_finds_cmd_via_pathext_on_the_real_path() {
        let found = find_executable("cmd").expect("cmd.exe must be found through PATH + PATHEXT");
        assert!(found.to_string_lossy().to_lowercase().ends_with("cmd.exe"), "got {found:?}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_canonicalized_paths_produce_a_valid_file_url() {
        // std::fs::canonicalize on Windows returns "\\?\C:\..." — the exact
        // shape that used to leak "%3F" into LibreOffice's profile URL.
        let dir = temp_dir("Pat Smith");
        let canon = std::fs::canonicalize(&dir).unwrap();
        assert!(canon.to_string_lossy().starts_with(r"\\?\"), "expected an extended-length path, got {canon:?}");
        let url = path_to_file_url(&canon);
        assert!(url.starts_with("file:///"), "{url}");
        assert!(!url.contains("%3F") && !url.contains('\\') && !url.contains(' '), "{url}");
        assert!(url.contains("Pat%20Smith"), "{url}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_presentation_check_and_stale_page_cleanup_work_on_real_files() {
        let dir = temp_dir("win files");
        let ok = dir.join("deck.pptx");
        std::fs::write(&ok, [0x50, 0x4b, 0x03, 0x04, 0, 0]).unwrap();
        assert!(ensure_presentation_file(&ok).is_ok());
        let bad = dir.join("bad.pptx");
        std::fs::write(&bad, b"nope").unwrap();
        assert!(ensure_presentation_file(&bad).is_err());
        std::fs::write(dir.join("slide-1.png"), b"x").unwrap();
        clear_stale_pages(dir.to_str().unwrap());
        assert!(!dir.join("slide-1.png").exists() && ok.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
    // ---- bundled LibreOffice discovery (layouts of installed packages) -------

    fn touch_exe(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn installed_linux_package_layout_is_found_via_resource_dir_not_exe_dir() {
        // /usr/bin/omnideck  +  /usr/lib/OmniDeck/resources/libreoffice/opt/libreoffice26.8/program/soffice
        let root = temp_dir("deb-layout");
        let exe_dir = root.join("usr/bin");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let soffice = root.join("usr/lib/OmniDeck/resources/libreoffice/opt/libreoffice26.8/program/soffice");
        touch_exe(&soffice);
        let res = root.join("usr/lib/OmniDeck");
        let roots = bundled_runtime_roots(&exe_dir, Some(&res), TargetOs::Linux);
        assert_eq!(find_bundled_soffice(&roots, TargetOs::Linux), Some(soffice.clone()));
        // Even if Tauri's resource dir were unavailable, the lib/<productName> fallback finds it.
        // This fallback deliberately contains exe_dir/../lib; compare canonical paths so
        // the test checks file identity rather than requiring a normalized path spelling.
        let fallback = bundled_runtime_roots(&exe_dir, None, TargetOs::Linux);
        let found_fallback = find_bundled_soffice(&fallback, TargetOs::Linux);
        assert_eq!(
            found_fallback.map(|p| std::fs::canonicalize(p).unwrap()),
            Some(std::fs::canonicalize(soffice).unwrap()),
            "exe-relative fallback should resolve to the installed resource even when its path contains .."
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_non_executable_or_missing_runtime_is_not_reported_as_bundled() {
        let root = temp_dir("not-exec");
        let p = root.join("res/resources/libreoffice/opt/libreoffice26.8/program/soffice");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"not executable").unwrap(); // default mode: not +x
        let roots = bundled_runtime_roots(&root.join("bin"), Some(&root.join("res")), TargetOs::Linux);
        assert_eq!(find_bundled_soffice(&roots, TargetOs::Linux), None);
        assert_eq!(find_bundled_soffice(&[root.join("nowhere")], TargetOs::Linux), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn macos_bundle_layout_is_found_inside_contents_resources() {
        let root = temp_dir("mac-layout");
        let exe_dir = root.join("OmniDeck.app/Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let soffice = root.join("OmniDeck.app/Contents/Resources/resources/libreoffice/LibreOffice.app/Contents/MacOS/soffice");
        touch_exe(&soffice);
        let roots = bundled_runtime_roots(&exe_dir, None, TargetOs::MacOs);
        let found = find_bundled_soffice(&roots, TargetOs::MacOs).expect("bundled soffice not found");
        assert!(found.ends_with("LibreOffice.app/Contents/MacOS/soffice"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn bundled_runtime_is_listed_before_system_candidates() {
        // soffice_candidates() puts the bundled path first when one exists; the
        // pure-layout part is covered above, here we assert the ordering rule on
        // the static candidate list: bare "soffice" (PATH) never precedes a bundled absolute path.
        let c = soffice_candidates();
        if let Some(pos_bare) = c.iter().position(|x| x == "soffice") {
            assert!(c[..pos_bare].iter().all(|x| Path::new(x).is_absolute()));
        }
    }

    // ---- updater gating -------------------------------------------------------

    #[test]
    fn updater_needs_a_real_key_and_an_https_endpoint() {
        let good = serde_json::json!({"pubkey": "A".repeat(60), "endpoints": ["https://github.com/o/r/releases/latest/download/latest.json"]});
        assert!(updater_config_ready(Some(&good)));
        assert!(!updater_config_ready(None));
        assert!(!updater_config_ready(Some(&serde_json::json!({"pubkey": "", "endpoints": ["https://x/y"]}))));
        assert!(!updater_config_ready(Some(&serde_json::json!({"pubkey": "short", "endpoints": ["https://x/y"]}))));
        assert!(!updater_config_ready(Some(&serde_json::json!({"pubkey": "A".repeat(60)}))));
        assert!(!updater_config_ready(Some(&serde_json::json!({"pubkey": "A".repeat(60), "endpoints": ["http://insecure/latest.json"]}))));
    }

    #[test]
    fn deb_and_rpm_installs_cannot_self_update_but_appimage_windows_and_mac_can() {
        assert_eq!(updater_can_self_install(TargetOs::Linux, true), (true, None));
        let (ok, why) = updater_can_self_install(TargetOs::Linux, false);
        assert!(!ok && why.unwrap().contains(".deb"));
        assert!(updater_can_self_install(TargetOs::Windows, false).0);
        assert!(updater_can_self_install(TargetOs::MacOs, false).0);
    }

}
