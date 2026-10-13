#!/usr/bin/env bash
# Real-runtime end-to-end verification on Linux: launches the RELEASE build of
# OmniDeck in a real WebKitGTK webview (via tauri-driver + WebKitWebDriver),
# on a virtual two-monitor X display, with real LibreOffice + Poppler, a real
# window manager, and the real Tauri fs/dialog/event plugins and ACL.
#
# Prerequisites (Ubuntu 24.04):
#   sudo apt install webkit2gtk-driver tigervnc-standalone-server openbox wmctrl \
#        xdotool x11-xserver-utils imagemagick libreoffice-impress poppler-utils
#   cargo install tauri-driver --locked
#   npm run build:release-binary   # or: npx tauri build --no-bundle
#
# Usage: bash tests/e2e/run-linux-e2e.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
export DISPLAY=:99
export E2E_DATA_HOME=/tmp/omnideck-e2e-data
export E2E_BIN="$PWD/src-tauri/target/release/omnideck"
export E2E_OUT="${E2E_OUT:-/tmp/omnideck-e2e-out}"
mkdir -p "$E2E_OUT"
rm -rf "$E2E_DATA_HOME"; mkdir -p "$E2E_DATA_HOME"

pkill -f "Xtigervnc :99" 2>/dev/null || true; rm -f /tmp/.X99-lock
setsid Xtigervnc :99 -geometry 3840x1080 -depth 24 -SecurityTypes None -localhost yes -ac >/tmp/e2e-xvnc.log 2>&1 </dev/null &
sleep 3
xrandr --output VNC-0 --mode 1920x1080 --pos 0x0
xrandr --fb 3840x1080
xrandr --setmonitor DP-2 1920/508x1080/286+1920+0 none   # a second, real RandR monitor to the right
setsid openbox >/tmp/e2e-openbox.log 2>&1 </dev/null &
sleep 1
xrandr --listmonitors
exec node "${E2E_SCRIPT:-tests/e2e/linux-e2e.mjs}"
