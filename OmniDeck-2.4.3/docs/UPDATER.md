# Automatic updates (GitHub Releases)

* Uses the official Tauri v2 updater plugin. It checks `latest.json` on this repository's latest **published**
  release over HTTPS, downloads the platform artifact and **verifies its minisign signature against the public
  key compiled into the app** before anything is installed. An unsigned, tampered or truncated download is
  rejected and discarded.
* Registered only in release builds that have a public key + https endpoint (`updater_config_ready` in
  `util.rs`). Dev/PR builds show "Automatic updates aren't enabled in this build."
* UI: one quiet check per launch (never while presenting, silent when offline) → a toast and a dot on
  Settings; **Settings → Updates** has *Check for updates*, release notes, *Download & install*, a progress bar and
  *Cancel*. Saves are flushed before install; if they can't be flushed the update is **not** installed.
* Cancel: the plugin can't abort an in-flight download, so Cancel discards the finished download and installs
  nothing.
* Errors are explained separately for: offline, no release/manifest, failed signature/integrity, failed install,
  unsaved work. In every case the current version keeps working.
* `.deb`/`.rpm` installs can't self-update (Tauri limitation): they are told to download the new package.
* Setup, secrets and release steps: `docs/RELEASING.md`. **Not production-proven** until a signed N → N+1
  update has been run end to end by a person.
