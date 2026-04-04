#!/usr/bin/env bash

set -euo pipefail

mkdir -p "${CODEX_HOME:-$HOME/.codex}" "${PI_AGENT_DIR:-$HOME/.pi/agent}" /state /repos /artifacts

/usr/local/bin/butler-auth bootstrap

cd /opt/manor/butler

if [ "${BUTLER_HOT_RELOAD:-1}" = "1" ]; then
  if [ ! -d node_modules ] || [ ! -x node_modules/.bin/tsx ] || [ ! -x node_modules/.bin/vite ]; then
    npm install --include=dev --no-package-lock
  fi

  exec npm run dev:start
fi

exec node dist/server/index.js
