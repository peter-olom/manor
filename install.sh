#!/usr/bin/env bash

set -euo pipefail

yes_mode=0
start_after=1

usage() {
  cat <<'EOF'
Usage:
  ./install.sh [options]

Options:
  -y, --yes     Use defaults and do not prompt.
  --no-start    Write configuration and validate Docker, but do not start Manor.
  -h, --help    Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)
      yes_mode=1
      ;;
    --no-start)
      start_after=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
  shift
done

cd "$(dirname "$0")"

env_file=".env"

env_value() {
  local key="$1"

  if [[ -f "${env_file}" ]]; then
    awk -F= -v key="${key}" '
      $0 !~ /^[[:space:]]*#/ && $1 == key {
        sub(/^[^=]*=/, "")
        print
        found = 1
        exit
      }
      END { if (!found) exit 1 }
    ' "${env_file}" 2>/dev/null || true
  fi
}

prompt_value() {
  local label="$1"
  local default="$2"
  local answer=""

  if [[ "${yes_mode}" -eq 1 ]]; then
    printf '%s\n' "${default}"
    return
  fi

  read -r -p "${label} [${default}]: " answer
  printf '%s\n' "${answer:-$default}"
}

prompt_bool() {
  local label="$1"
  local default="$2"
  local answer=""
  local hint="y/N"

  if [[ "${default}" =~ ^(1|true|yes|on|y)$ ]]; then
    hint="Y/n"
  fi

  if [[ "${yes_mode}" -eq 1 ]]; then
    printf '%s\n' "${default}"
    return
  fi

  while true; do
    read -r -p "${label} [${hint}]: " answer
    answer="${answer:-$default}"
    case "${answer}" in
      1|true|TRUE|yes|YES|y|Y|on|ON)
        printf '1\n'
        return
        ;;
      0|false|FALSE|no|NO|n|N|off|OFF)
        printf '0\n'
        return
        ;;
      *)
        echo "Please answer yes or no." >&2
        ;;
    esac
  done
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker was not found. Install Docker Desktop or Docker Engine with Compose v2." >&2
    exit 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "Docker is installed, but the daemon is not reachable." >&2
    exit 1
  fi

  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 was not found." >&2
    exit 1
  fi
}

validate_port() {
  local port="$1"

  if [[ ! "${port}" =~ ^[0-9]+$ ]] || [[ "${port}" -lt 1 || "${port}" -gt 65535 ]]; then
    echo "Host port must be a number between 1 and 65535." >&2
    exit 1
  fi
}

write_env() {
  local temp_file=""

  temp_file="$(mktemp)"

  if [[ -f "${env_file}" ]]; then
    awk '
      BEGIN {
        skip["BUTLER_HOST_PORT"] = 1
        skip["MANOR_CODEX_AUTO_UPDATE"] = 1
        skip["MANOR_CODEX_AUTO_UPDATE_VERSION"] = 1
        skip["MANOR_CODEX_AUTO_UPDATE_REQUIRED"] = 1
      }
      {
        split($0, parts, "=")
        if ($0 ~ /^[[:space:]]*#/ || !(parts[1] in skip)) {
          print
        }
      }
    ' "${env_file}" > "${temp_file}"
  fi

  {
    printf 'BUTLER_HOST_PORT=%s\n' "${butler_host_port}"
    printf 'MANOR_CODEX_AUTO_UPDATE=%s\n' "${codex_auto_update}"
    printf 'MANOR_CODEX_AUTO_UPDATE_VERSION=%s\n' "${codex_auto_update_version}"
    printf 'MANOR_CODEX_AUTO_UPDATE_REQUIRED=%s\n' "${codex_auto_update_required}"
  } >> "${temp_file}"

  mv "${temp_file}" "${env_file}"
}

require_docker

butler_host_port_default="${BUTLER_HOST_PORT:-$(env_value BUTLER_HOST_PORT || true)}"
butler_host_port_default="${butler_host_port_default:-8180}"
butler_host_port="$(prompt_value "Host port for Manor" "${butler_host_port_default}")"
validate_port "${butler_host_port}"

codex_auto_update_default="${MANOR_CODEX_AUTO_UPDATE:-$(env_value MANOR_CODEX_AUTO_UPDATE || true)}"
codex_auto_update_default="${codex_auto_update_default:-0}"
codex_auto_update="$(prompt_bool "Auto-update Codex on Manor reboot" "${codex_auto_update_default}")"

codex_auto_update_version="${MANOR_CODEX_AUTO_UPDATE_VERSION:-$(env_value MANOR_CODEX_AUTO_UPDATE_VERSION || true)}"
codex_auto_update_version="${codex_auto_update_version:-latest}"
codex_auto_update_required="${MANOR_CODEX_AUTO_UPDATE_REQUIRED:-$(env_value MANOR_CODEX_AUTO_UPDATE_REQUIRED || true)}"
codex_auto_update_required="${codex_auto_update_required:-0}"

if [[ "${codex_auto_update}" = "1" ]]; then
  codex_auto_update_version="$(prompt_value "Codex auto-update target" "${codex_auto_update_version}")"
  codex_auto_update_required="$(prompt_bool "Require Codex auto-update to succeed before startup" "${codex_auto_update_required}")"
else
  codex_auto_update_required="0"
fi

if [[ "${start_after}" -eq 1 ]]; then
  start_after="$(prompt_bool "Start Manor after install" "1")"
fi

write_env

docker compose config >/dev/null

if [[ "${start_after}" -eq 1 ]]; then
  docker compose up -d --build
  echo "Manor is running on http://127.0.0.1:${butler_host_port}"
else
  echo "Configuration written. Start Manor with: docker compose up -d --build"
fi
