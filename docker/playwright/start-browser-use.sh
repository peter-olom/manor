#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
XVFB_SCREEN="${XVFB_SCREEN:-1280x1024x24}"
DISPLAY_NUM="${DISPLAY#:}"
LOCK_FILE="/tmp/.X${DISPLAY_NUM}-lock"
SOCKET_FILE="/tmp/.X11-unix/X${DISPLAY_NUM}"

if [ -f "$LOCK_FILE" ] && ! pgrep -f "Xvfb ${DISPLAY}" >/dev/null 2>&1; then
  rm -f "$LOCK_FILE" "$SOCKET_FILE"
fi

Xvfb "$DISPLAY" -screen 0 "$XVFB_SCREEN" -nolisten tcp &
XVFB_PID=$!

sleep 0.2
if ! kill -0 "$XVFB_PID" >/dev/null 2>&1; then
  echo "Failed to start Xvfb on ${DISPLAY}" >&2
  exit 1
fi

cleanup() {
  if kill -0 "$XVFB_PID" >/dev/null 2>&1; then
    kill "$XVFB_PID" >/dev/null 2>&1 || true
    wait "$XVFB_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

node /opt/manor/playwright/browser-use-server.mjs
