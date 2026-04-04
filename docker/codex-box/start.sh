#!/usr/bin/env bash

set -euo pipefail

mkdir -p "${CODEX_HOME:-$HOME/.codex}" /state /repos /artifacts

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

/usr/local/bin/codex-auth bootstrap

exec codex "${args[@]}"
