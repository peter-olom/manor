#!/usr/bin/env bash

set -euo pipefail

yes_mode=0
start_after=1

usage() {
  cat <<'EOF'
Usage:
  ./install.sh [options]

Options:
  -y, --yes           Use defaults and do not prompt.
  --no-start          Write and validate configuration without starting Manor.
  -h, --help          Show this help.
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
    case "${default}" in
      1|true|TRUE|yes|YES|y|Y|on|ON)
        printf '1\n'
        return
        ;;
      0|false|FALSE|no|NO|n|N|off|OFF|"")
        printf '0\n'
        return
        ;;
    esac
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

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  if [[ -r /dev/urandom ]] && command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    printf '\n'
    return
  fi

  echo "Could not generate a local secret. Install openssl or set the required tokens manually." >&2
  exit 1
}

is_placeholder_secret() {
  case "$1" in
    ""|change-me|change-me-*|replace-me|replace-me-*|REPLACE_ME|REPLACE_ME_*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

render_env() {
  local output_file="$1"

  if [[ -f "${env_file}" ]]; then
    awk '
      BEGIN {
        skip["BUTLER_HOST_PORT"] = 1
        skip["MANOR_HOST_PROJECT_DIR"] = 1
        skip["MANOR_HOST_PROJECT_SOURCE_DIR"] = 1
        skip["CODEX_SERVICE_TIER"] = 1
        skip["MANOR_CODEX_AUTO_UPDATE"] = 1
        skip["MANOR_CODEX_AUTO_UPDATE_VERSION"] = 1
        skip["MANOR_CODEX_AUTO_UPDATE_REQUIRED"] = 1
        skip["MANOR_PI_AUTO_UPDATE"] = 1
        skip["MANOR_PI_AUTO_UPDATE_VERSION"] = 1
        skip["MANOR_PI_AUTO_UPDATE_REQUIRED"] = 1
        skip["RUNTIME_BROKER_TOKEN"] = 1
        skip["MANOR_HOST_CONTROLLER_TOKEN"] = 1
      }
      {
        split($0, parts, "=")
        if ($0 ~ /^[[:space:]]*#/ || !(parts[1] in skip)) {
          print
        }
      }
    ' "${env_file}" > "${output_file}"
  else
    : > "${output_file}"
  fi

  {
    printf 'BUTLER_HOST_PORT=%s\n' "${butler_host_port}"
    printf 'MANOR_HOST_PROJECT_DIR=%s\n' "${host_project_dir}"
    if [[ -n "${host_project_source_dir}" ]]; then
      printf 'MANOR_HOST_PROJECT_SOURCE_DIR=%s\n' "${host_project_source_dir}"
    fi
    printf 'CODEX_SERVICE_TIER=%s\n' "${codex_service_tier}"
    printf 'RUNTIME_BROKER_TOKEN=%s\n' "${runtime_broker_token}"
    printf 'MANOR_HOST_CONTROLLER_TOKEN=%s\n' "${host_controller_token}"
  } >> "${output_file}"
}

require_docker

butler_host_port_default="${BUTLER_HOST_PORT:-$(env_value BUTLER_HOST_PORT || true)}"
butler_host_port_default="${butler_host_port_default:-8180}"
butler_host_port="$(prompt_value "Host port for Manor" "${butler_host_port_default}")"
validate_port "${butler_host_port}"

host_project_source_dir_default="${MANOR_HOST_PROJECT_SOURCE_DIR:-$(env_value MANOR_HOST_PROJECT_SOURCE_DIR || true)}"
host_project_source_dir="${host_project_source_dir_default:-$(pwd -P)}"

host_project_dir_default="${MANOR_HOST_PROJECT_DIR:-$(env_value MANOR_HOST_PROJECT_DIR || true)}"
if [[ -n "${host_project_dir_default}" ]]; then
  host_project_dir="${host_project_dir_default}"
elif [[ "${host_project_source_dir}" = /* ]]; then
  host_project_dir="${host_project_source_dir}"
else
  host_project_dir="/host-project"
fi

codex_service_tier="${CODEX_SERVICE_TIER:-$(env_value CODEX_SERVICE_TIER || true)}"
codex_service_tier="${codex_service_tier:-auto}"

if [[ "${start_after}" -eq 1 ]]; then
  start_after="$(prompt_bool "Start Manor after install" "1")"
fi

runtime_broker_token_default="${RUNTIME_BROKER_TOKEN:-$(env_value RUNTIME_BROKER_TOKEN || true)}"
if is_placeholder_secret "${runtime_broker_token_default}"; then
  runtime_broker_token="$(generate_secret)"
else
  runtime_broker_token="${runtime_broker_token_default}"
fi

host_controller_token_default="${MANOR_HOST_CONTROLLER_TOKEN:-$(env_value MANOR_HOST_CONTROLLER_TOKEN || true)}"
if is_placeholder_secret "${host_controller_token_default}"; then
  host_controller_token="$(generate_secret)"
else
  host_controller_token="${host_controller_token_default}"
fi

env_candidate="$(mktemp "${env_file}.tmp.XXXXXX")"
trap 'rm -f "${env_candidate}"' EXIT
render_env "${env_candidate}"

docker compose --env-file "${env_candidate}" -f compose.yml -f compose.build.yml config >/dev/null
mv "${env_candidate}" "${env_file}"
trap - EXIT

if [[ "${start_after}" -eq 1 ]]; then
  ./manor-start start
else
  echo "Configuration written. Start Manor with: ./manor-start"
fi
