#!/usr/bin/env bash

set -euo pipefail

ensure_writable_dir() {
  local dir="$1"

  if ! mkdir -p "${dir}" 2>/dev/null || [[ ! -w "${dir}" ]]; then
    echo "Required directory is not writable by the codex user: ${dir}" >&2
    echo "Recreate or fix the mounted codex config volume, then restart Manor." >&2
    exit 70
  fi
}

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"

mkdir -p "${CODEX_HOME:-$HOME/.codex}" /state /repos /artifacts
ensure_writable_dir "${config_home}"
ensure_writable_dir "${config_home}/gh"
ensure_writable_dir "${config_home}/manor"

/usr/local/bin/codex-bootstrap-tools
/usr/local/bin/manor-codex-auto-update

github_host="${GITHUB_HOST:-github.com}"

if gh auth status --hostname "${github_host}" >/dev/null 2>&1; then
  gh auth setup-git --hostname "${github_host}" >/dev/null 2>&1 || true
fi

# Keep the interactive browser terminal on zsh, but force the Codex worker
# itself onto a plain shell so app-server command execution does not try to
# launch zsh.
export SHELL=/usr/bin/bash
export TERM="${TERM:-xterm-256color}"

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

ensure_capability_token_file() {
  local token_file="${CODEX_APP_SERVER_WS_TOKEN_FILE:-}"

  if [[ "${CODEX_APP_SERVER_WS_AUTH:-}" != "capability-token" || -z "${token_file}" ]]; then
    return
  fi

  mkdir -p "$(dirname "${token_file}")"
  if [[ ! -s "${token_file}" ]]; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64") + "\n")' >"${token_file}"
  fi
  chmod 600 "${token_file}" 2>/dev/null || true
}

append_toml_string_config() {
  local key="$1"
  local value="$2"
  local encoded=""

  encoded="$(
    python3 - "$value" <<'PY'
import json
import sys

print(json.dumps(sys.argv[1]))
PY
  )"

  args+=(-c "${key}=${encoded}")
}

validate_personality() {
  local value="$1"
  case "$value" in
    none|friendly|pragmatic) ;;
    *)
      echo "CODEX_PERSONALITY must be one of: none, friendly, pragmatic" >&2
      echo "Use CODEX_MODEL_INSTRUCTIONS_FILE for markdown instruction overrides." >&2
      exit 1
      ;;
  esac
}

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
  validate_personality "${CODEX_PERSONALITY}"
  append_toml_string_config "personality" "${CODEX_PERSONALITY}"
fi

if [[ -n "${CODEX_MODEL_INSTRUCTIONS_FILE:-}" ]]; then
  if [[ ! -f "${CODEX_MODEL_INSTRUCTIONS_FILE}" ]]; then
    echo "CODEX_MODEL_INSTRUCTIONS_FILE does not exist: ${CODEX_MODEL_INSTRUCTIONS_FILE}" >&2
    exit 1
  fi
  append_toml_string_config "model_instructions_file" "${CODEX_MODEL_INSTRUCTIONS_FILE}"
fi

ttyd \
  --port "${ttyd_port}" \
  --base-path "${ttyd_base_path}" \
  --writable \
  --cwd /repos \
  bash -lc 'exec zsh -li' &
ttyd_pid=$!

/usr/local/bin/codex-auth bootstrap
ensure_capability_token_file

codex "${args[@]}" &
codex_pid=$!

wait -n "${ttyd_pid}" "${codex_pid}"
