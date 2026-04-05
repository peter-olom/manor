#!/usr/bin/env bash

set -euo pipefail

mkdir -p "${CODEX_HOME:-$HOME/.codex}" "${PI_AGENT_DIR:-$HOME/.pi/agent}" /state /repos /artifacts

/usr/local/bin/butler-auth bootstrap

ttyd_port="${BUTLER_TTYD_PORT:-7682}"
ttyd_base_path="${BUTLER_TTYD_BASE_PATH:-/butler-terminal/}"
ttyd_pid=""
butler_pid=""

cleanup() {
  local exit_code=$?

  if [[ -n "${butler_pid}" ]] && kill -0 "${butler_pid}" 2>/dev/null; then
    kill "${butler_pid}" 2>/dev/null || true
  fi

  if [[ -n "${ttyd_pid}" ]] && kill -0 "${ttyd_pid}" 2>/dev/null; then
    kill "${ttyd_pid}" 2>/dev/null || true
  fi

  wait "${butler_pid}" 2>/dev/null || true
  wait "${ttyd_pid}" 2>/dev/null || true

  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

cd /opt/manor/butler

ttyd \
  --port "${ttyd_port}" \
  --base-path "${ttyd_base_path}" \
  --writable \
  --cwd /opt/manor/butler \
  /usr/local/bin/start-butler-shell &
ttyd_pid=$!

if [ "${BUTLER_HOT_RELOAD:-1}" = "1" ]; then
  if [ ! -d node_modules ] || [ ! -x node_modules/.bin/tsx ] || [ ! -x node_modules/.bin/vite ]; then
    npm install --include=dev --no-package-lock
  fi

  npm run dev:start &
  butler_pid=$!
else
  node dist/server/index.js &
  butler_pid=$!
fi

wait -n "${ttyd_pid}" "${butler_pid}"
