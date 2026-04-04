#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  codex-auth bootstrap
  codex-auth status
  codex-auth api-key
  codex-auth device
EOF
}

read_api_key() {
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    printf '%s' "${OPENAI_API_KEY}"
    return 0
  fi

  if [[ -n "${OPENAI_API_KEY_FILE:-}" ]]; then
    if [[ ! -r "${OPENAI_API_KEY_FILE}" ]]; then
      echo "OPENAI_API_KEY_FILE is not readable." >&2
      return 1
    fi

    tr -d '\r' < "${OPENAI_API_KEY_FILE}"
    return 0
  fi

  return 1
}

login_status() {
  codex login status 2>&1 || true
}

bootstrap_api_key() {
  local status
  status="$(login_status)"

  if grep -Eq "Logged in using (an )?API key" <<<"${status}"; then
    return 0
  fi

  if ! grep -q "Not logged in" <<<"${status}"; then
    echo "Skipping API key bootstrap because Codex already has cached non-API credentials." >&2
    return 0
  fi

  local api_key
  api_key="$(read_api_key)"
  printf '%s' "${api_key}" | codex login --with-api-key
}

command_name="${1:-}"

case "${command_name}" in
  bootstrap)
    bootstrap_mode="${CODEX_AUTH_BOOTSTRAP:-auto}"

    case "${bootstrap_mode}" in
      auto|api-key)
        if read_api_key >/dev/null 2>&1; then
          bootstrap_api_key
        fi
        ;;
      none|disabled|off)
        ;;
      *)
        echo "Unsupported CODEX_AUTH_BOOTSTRAP value: ${bootstrap_mode}" >&2
        exit 64
        ;;
    esac
    ;;
  status)
    exec codex login status
    ;;
  api-key)
    api_key="$(read_api_key)"
    printf '%s' "${api_key}" | codex login --with-api-key
    ;;
  device)
    exec codex login --device-auth
    ;;
  *)
    usage
    exit 64
    ;;
esac
