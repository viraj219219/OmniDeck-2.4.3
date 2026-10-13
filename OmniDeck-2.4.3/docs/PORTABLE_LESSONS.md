# Portable lesson files (`.omnilesson`)

Make a lesson at home, carry it to church on a USB stick or by email, and open it on **any** OS.

## Using it
* **Export:** Lesson Library → the download icon on a lesson tile ("Export Lesson"), or Settings →
  Backup & Transfer → Export. Pick where to save; you get `<lesson-name>.omnilesson`.
* **Import:** Lesson Library → **Import Lesson** (or Settings → Backup & Transfer → Import Lesson) and pick the
  file. It is added as a **new** lesson and opened. If a lesson with that name exists you get
  "Name (2)", "Name (3)" — nothing is overwritten.
* PowerPoint/PDF files are a different feature: use **New Lesson → Import PowerPoint/PDF**.
* Older single-file `.json` backups still import through the same button.

## What is inside
A ZIP archive (STORE/DEFLATE, UTF-8 names):
```
manifest.json             versioned manifest
assets/<assetId>[.ext]    one file per image / background / video / imported-slide image / PDF
```
`manifest.json`: `format: "omnideck-lesson-package"`, `formatVersion: 1`, `app`, `exportedAt`,
`lesson: { title, pages[] }` (slide order = array order; all slide text, layout, boxes, quiz data), and
`assets[]: { id, kind, name, mime, size, sha256, path }`. Slides reference media by asset id in the same
fields the app already uses. **No absolute paths are ever written.** On import every asset becomes a new media
record on the receiving computer and references are remapped.

## Safety
Corrupt, truncated or tampered packages are rejected **before anything is created**; a failure part-way
rolls back every media file it created. Checked: ZIP structure and CRC, local-header/central-directory
agreement, entry names (no `..`, absolute, drive-letter, backslash, control or duplicate names), zip64/encryption
refused, size and count limits (anti zip-bomb), manifest schema, unknown format versions (a newer package says
"update OmniDeck"), unknown slide types, duplicate slide ids, every referenced asset present, and each asset's
size and SHA-256. The archive is never extracted to disk by name — bytes are read in memory and OmniDeck picks
its own file names.

Export refuses (and says which files) if a media file the lesson uses can't be read, rather than producing a
package that would be incomplete elsewhere.

## Limits
Individual media up to 1 GiB, whole package under 2 GiB, 5000 files (the whole file is read into memory).
Tests ran against an in-memory filesystem; real cross-OS transfer (Windows ⇄ macOS ⇄ Linux) was **not**
exercised on physical machines. Real Tauri file-dialog permissions for user-chosen paths are unverified until a
built app is run.
