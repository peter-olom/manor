#!/usr/bin/env bash

set -euo pipefail

yes_mode=0
start_after=1
build_from_source_forced=0
image_registry_arg=""
image_tag_arg=""

usage() {
  cat <<'EOF'
Usage:
  ./install.sh [options]

Options:
  -y, --yes             Use defaults and do not prompt.
  --no-start            Write configuration and validate Docker, but do not start Manor.
  --build-from-source   Build local images instead of pulling published images.
  --image-registry <r>  Image registry namespace. Default: ghcr.io/peter-olom.
  --image-tag <tag>     Image tag to pull. Default: latest.
  -h, --help            Show this help.
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
    --build-from-source|--source)
      build_from_source_forced=1
      ;;
    --image-registry)
      if [[ -z "${2:-}" ]]; then
        echo "--image-registry requires a value." >&2
        exit 64
      fi
      image_registry_arg="$2"
      shift
      ;;
    --image-tag)
      if [[ -z "${2:-}" ]]; then
        echo "--image-tag requires a value." >&2
        exit 64
      fi
      image_tag_arg="$2"
      shift
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

write_env() {
  local temp_file=""

  temp_file="$(mktemp)"

  if [[ -f "${env_file}" ]]; then
    awk '
      BEGIN {
        skip["BUTLER_HOST_PORT"] = 1
        skip["MANOR_HOST_PROJECT_DIR"] = 1
        skip["MANOR_HOST_PROJECT_SOURCE_DIR"] = 1
        skip["MANOR_BUILD_FROM_SOURCE"] = 1
        skip["MANOR_IMAGE_REGISTRY"] = 1
        skip["MANOR_IMAGE_TAG"] = 1
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
    ' "${env_file}" > "${temp_file}"
  fi

  {
    printf 'BUTLER_HOST_PORT=%s\n' "${butler_host_port}"
    printf 'MANOR_HOST_PROJECT_DIR=%s\n' "${host_project_dir}"
    if [[ -n "${host_project_source_dir}" ]]; then
      printf 'MANOR_HOST_PROJECT_SOURCE_DIR=%s\n' "${host_project_source_dir}"
    fi
    printf 'MANOR_BUILD_FROM_SOURCE=%s\n' "${build_from_source}"
    printf 'MANOR_IMAGE_REGISTRY=%s\n' "${image_registry}"
    printf 'MANOR_IMAGE_TAG=%s\n' "${image_tag}"
    printf 'MANOR_CODEX_AUTO_UPDATE=%s\n' "${codex_auto_update}"
    printf 'MANOR_CODEX_AUTO_UPDATE_VERSION=%s\n' "${codex_auto_update_version}"
    printf 'MANOR_CODEX_AUTO_UPDATE_REQUIRED=%s\n' "${codex_auto_update_required}"
    printf 'MANOR_PI_AUTO_UPDATE=%s\n' "${pi_auto_update}"
    printf 'MANOR_PI_AUTO_UPDATE_VERSION=%s\n' "${pi_auto_update_version}"
    printf 'MANOR_PI_AUTO_UPDATE_REQUIRED=%s\n' "${pi_auto_update_required}"
    printf 'RUNTIME_BROKER_TOKEN=%s\n' "${runtime_broker_token}"
    printf 'MANOR_HOST_CONTROLLER_TOKEN=%s\n' "${host_controller_token}"
  } >> "${temp_file}"

  mv "${temp_file}" "${env_file}"
}

require_docker

butler_host_port_default="${BUTLER_HOST_PORT:-$(env_value BUTLER_HOST_PORT || true)}"
butler_host_port_default="${butler_host_port_default:-8180}"
butler_host_port="$(prompt_value "Host port for Manor" "${butler_host_port_default}")"
validate_port "${butler_host_port}"

host_project_dir_default="${MANOR_HOST_PROJECT_DIR:-$(env_value MANOR_HOST_PROJECT_DIR || true)}"
host_project_dir="${host_project_dir_default:-/host-project}"

host_project_source_dir_default="${MANOR_HOST_PROJECT_SOURCE_DIR:-$(env_value MANOR_HOST_PROJECT_SOURCE_DIR || true)}"
host_project_source_dir="${host_project_source_dir_default:-}"

build_from_source_default="${MANOR_BUILD_FROM_SOURCE:-$(env_value MANOR_BUILD_FROM_SOURCE || true)}"
build_from_source_default="${build_from_source_default:-0}"
if [[ "${build_from_source_forced}" -eq 1 ]]; then
  build_from_source="1"
else
  build_from_source="$(prompt_bool "Build images from source instead of pulling published images" "${build_from_source_default}")"
fi

image_registry_default="${MANOR_IMAGE_REGISTRY:-$(env_value MANOR_IMAGE_REGISTRY || true)}"
image_registry_default="${image_registry_arg:-${image_registry_default:-ghcr.io/peter-olom}}"
image_tag_default="${MANOR_IMAGE_TAG:-$(env_value MANOR_IMAGE_TAG || true)}"
image_tag_default="${image_tag_arg:-${image_tag_default:-latest}}"

if [[ "${build_from_source}" = "1" ]]; then
  image_registry="${image_registry_default}"
  image_tag="${image_tag_default}"
else
  image_registry="$(prompt_value "Image registry namespace" "${image_registry_default}")"
  image_tag="$(prompt_value "Image tag" "${image_tag_default}")"
fi

if [[ -z "${image_registry}" || -z "${image_tag}" ]]; then
  echo "Image registry and tag must not be empty." >&2
  exit 1
fi

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

pi_auto_update_default="${MANOR_PI_AUTO_UPDATE:-$(env_value MANOR_PI_AUTO_UPDATE || true)}"
pi_auto_update_default="${pi_auto_update_default:-0}"
pi_auto_update="$(prompt_bool "Auto-update PI on Manor reboot" "${pi_auto_update_default}")"

pi_auto_update_version="${MANOR_PI_AUTO_UPDATE_VERSION:-$(env_value MANOR_PI_AUTO_UPDATE_VERSION || true)}"
pi_auto_update_version="${pi_auto_update_version:-latest}"
pi_auto_update_required="${MANOR_PI_AUTO_UPDATE_REQUIRED:-$(env_value MANOR_PI_AUTO_UPDATE_REQUIRED || true)}"
pi_auto_update_required="${pi_auto_update_required:-0}"

if [[ "${pi_auto_update}" = "1" ]]; then
  pi_auto_update_version="$(prompt_value "PI auto-update target" "${pi_auto_update_version}")"
  pi_auto_update_required="$(prompt_bool "Require PI auto-update to succeed before startup" "${pi_auto_update_required}")"
else
  pi_auto_update_required="0"
fi

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

write_env

compose_args=(-f compose.yml)
if [[ "${build_from_source}" = "1" ]]; then
  compose_args+=(-f compose.build.yml)
fi

run_compose() {
  docker compose "${compose_args[@]}" "$@"
}

run_compose config >/dev/null

if [[ "${start_after}" -eq 1 ]]; then
  if [[ "${build_from_source}" = "1" ]]; then
    run_compose up -d --build
  else
    run_compose pull
    run_compose up -d
  fi
  echo "Manor is running on http://127.0.0.1:${butler_host_port}"
else
  if [[ "${build_from_source}" = "1" ]]; then
    echo "Configuration written. Start Manor with: ./manor.sh start --build"
  else
    echo "Configuration written. Start Manor with: ./manor.sh start"
  fi
fi
