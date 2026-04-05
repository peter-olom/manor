#!/usr/bin/env bash

set -euo pipefail

mkdir -p "${CODEX_HOME:-$HOME/.codex}" /state /repos /artifacts

/usr/local/bin/codex-bootstrap-tools

ttyd_port="${CODEX_TTYD_PORT:-7681}"
ttyd_base_path="${CODEX_TTYD_BASE_PATH:-/terminal/}"
ttyd_pid=""
codex_pid=""

cleanup() {
  local exit_code=$?

  if [[ -n "${codex_pid}" ]] && kill -0 "${codex_pid}" 2>/dev/null; then
    kill "${codex_pid}" 2>/dev/null || true
  fi

  if [[ -n "${ttyd_pid}" ]] && kill -0 "${ttyd_pid}" 2>/dev/null; then
    kill "${ttyd_pid}" 2>/dev/null || true
  fi

  wait "${codex_pid}" 2>/dev/null || true
  wait "${ttyd_pid}" 2>/dev/null || true

  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

listen_url="${CODEX_APP_SERVER_LISTEN:-ws://0.0.0.0:8080}"

args=(
  app-server
  --listen "$listen_url"
  -c 'cli_auth_credentials_store="file"'
)

if [[ -n "${CODEX_FORCED_LOGIN_METHOD:-}" ]]; then
  args+=(-c "forced_login_method=\"${CODEX_FORCED_LOGIN_METHOD}\"")
fi

if [[ -n "${CODEX_APP_SERVER_WS_AUTH:-}" ]]; then
  args+=(--ws-auth "${CODEX_APP_SERVER_WS_AUTH}")
fi

if [[ -n "${CODEX_APP_SERVER_WS_TOKEN_FILE:-}" ]]; then
  args+=(--ws-token-file "${CODEX_APP_SERVER_WS_TOKEN_FILE}")
fi

if [[ -n "${CODEX_APP_SERVER_WS_SHARED_SECRET_FILE:-}" ]]; then
  args+=(--ws-shared-secret-file "${CODEX_APP_SERVER_WS_SHARED_SECRET_FILE}")
fi

if [[ -n "${CODEX_APP_SERVER_WS_ISSUER:-}" ]]; then
  args+=(--ws-issuer "${CODEX_APP_SERVER_WS_ISSUER}")
fi

if [[ -n "${CODEX_APP_SERVER_WS_AUDIENCE:-}" ]]; then
  args+=(--ws-audience "${CODEX_APP_SERVER_WS_AUDIENCE}")
fi

if [[ -n "${CODEX_MODEL:-}" ]]; then
  args+=(-c "model=\"${CODEX_MODEL}\"")
fi

if [[ -n "${CODEX_PERSONALITY:-}" ]]; then
  args+=(-c "personality=\"${CODEX_PERSONALITY}\"")
fi

ttyd \
  --port "${ttyd_port}" \
  --base-path "${ttyd_base_path}" \
  --writable \
  --cwd /repos \
  bash -lc 'exec zsh -li' &
ttyd_pid=$!

/usr/local/bin/codex-auth bootstrap

codex "${args[@]}" &
codex_pid=$!

wait -n "${ttyd_pid}" "${codex_pid}"
