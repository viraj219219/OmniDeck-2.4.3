# Presenter View & the audience display

## Audit of what existed (before this change)
Already correct and kept: a native second window (`audience.html`) opened full-screen on a chosen monitor;
sync over **native Tauri events** (`presenter:slide-state`), not `localStorage`/`BroadcastChannel`/`postMessage`;
an `audience:ready` handshake so the first slide is never lost; a hot-plug watcher that closes the audience
window if the projector disappears (so it can't cover the controls) and reopens it on return; a Rust guard that
refuses to open the audience window on the presenter's own monitor; the audience window renders the *same*
`renderPresentStage` (no second renderer) and contains no controls.

Gaps against the requirement (fixed): the controller showed only the current slide and a text "Next:" chip — no
next-slide preview, no slide list, no direct selection, no status, no way to choose the display during the
show; the audience didn't follow video play/pause/seek, and both windows could play sound.
Also found: after a display loss the "Next:" chip stayed until the next click.

Not present in this codebase at all: **OBS/Web Output, Stage Display, remote controller, presenter notes.**
There was nothing to regress and nothing was added.

## How it works now
* **`PresenterSession`** (`src/js/services/PresenterSession.js`) holds the single authoritative state: slide
  index, quiz/media state, which display is the audience output, connection status. The controller view,
  previews and audience are all projections of it. Every change is pushed immediately (no polling for slide
  sync); the only poll is the existing 1.5 s hot-plug check, because Tauri v2 has no monitor-change event.
* **One display:** unchanged layout — this screen is the output; no audience window is created.
* **Two displays (automatic, or choose in the bar):** this screen becomes the **Presenter View**:
  live preview ("Now showing", slide N of M), **next-slide preview**, a scrollable **list of all slides** with
  thumbnails (current highlighted, click to jump), Previous/Next, counter, an **output status** indicator
  (connected + display name/resolution, one display, disconnected + why), an **Audience display** chooser (never the
  presenter's own screen), and **End show · Editor (Esc)**. A presentation starts from the editor's Present
  button as before.
* **Audience window:** only the slide, full-screen, scaled by the same `fitSlideBox`; goes blank (then closes)
  when the show ends; follows the presenter's video (the audience copy has sound, the presenter's is muted).
* **Keyboard:** ←/→/PageUp/PageDown/Home/End/Esc. Keys are ignored while typing in an input, textarea, select or
  contenteditable (Esc still exits).
* **Choosing a display** is detected via the existing `list_monitors` command (Tauri `available_monitors`) and
  saved in the existing display settings.

## Tests
`tests/presenter-session.test.mjs` (49 checks) and `tests/presenter-view.test.mjs` (27) use **mocked** monitors:
single display, second display, next/prev/direct selection, resolution change, unplug/replug (with debounce),
display switching, forced single mode, failures (open fails, fullscreen refused, unreadable display list),
exit/blanking/idempotence, audience payload contains no controller data, keyboard guard, inert previews.

## NOT verified (needs a physical projector / webview)
Actual rendering of the Presenter View layout in WebView2/WKWebView/WebKitGTK; real monitor hot-plug and
resolution switching on each OS; window-manager behaviour of the fullscreen audience window (Wayland in
particular); video sync drift on a real file; projector scaling/overscan; `skip_taskbar` behaviour per OS.
Manual checklist: 1) launch with one display; 2) plug a projector, start a show, confirm it opens on the
projector with only the slide; 3) click next / a thumbnail / press ←→; 4) change resolution on either screen;
5) unplug, confirm presenter keeps working and a message appears, replug, confirm the current slide returns;
6) play a video, confirm sound only from the projector side and play/pause/seek follow; 7) press Esc and confirm
the projector goes blank/closes and you land in the editor.
