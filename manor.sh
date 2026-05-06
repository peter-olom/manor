#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Usage:
  ./manor.sh start [--build] [--dev] [--desktop]
  ./manor.sh stop [--dev] [--desktop]
  ./manor.sh restart [--build] [--dev] [--desktop]
  ./manor.sh status [--dev] [--desktop]
  ./manor.sh logs [--dev] [--desktop] [--follow] [--tail <n>] [service ...]
  ./manor.sh desktop start [--build]
  ./manor.sh desktop stop
  ./manor.sh desktop restart [--build]
  ./manor.sh desktop status

Options:
  --build     Build images while starting.
  --dev       Include the local hot-reload overlay.
  --desktop   Include the headed desktop proof profile.
  --follow    Follow logs.
  --tail <n>  Number of log lines to show. Default: 100.
  -h, --help  Show this help.
EOF
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

env_value() {
  local key="$1"

  if [[ -f ".env" ]]; then
    awk -F= -v key="${key}" '
      $0 !~ /^[[:space:]]*#/ && $1 == key {
        sub(/^[^=]*=/, "")
        print
        found = 1
        exit
      }
      END { if (!found) exit 1 }
    ' ".env" 2>/dev/null || true
  fi
}

compose_args=("-f" "compose.yml")
profile_args=()
build_args=()
log_args=("--tail" "100")
services=()

command="${1:-}"
if [[ -z "${command}" || "${command}" == "-h" || "${command}" == "--help" || "${command}" == "help" ]]; then
  usage
  exit 0
fi
shift || true

add_dev=0
add_desktop=0
follow_logs=0

parse_common_options() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --build)
        build_args=("--build")
        ;;
      --dev)
        add_dev=1
        ;;
      --desktop)
        add_desktop=1
        ;;
      --follow|-f)
        follow_logs=1
        ;;
      --tail)
        if [[ -z "${2:-}" || ! "${2}" =~ ^[0-9]+$ ]]; then
          echo "--tail requires a positive number." >&2
          exit 64
        fi
        log_args=("--tail" "$2")
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        services+=("$@")
        break
        ;;
      -*)
        echo "Unknown option: $1" >&2
        usage >&2
        exit 64
        ;;
      *)
        services+=("$1")
        ;;
    esac
    shift
  done
}

apply_options() {
  if [[ "${add_dev}" -eq 1 ]]; then
    compose_args+=("-f" "compose.dev.yml")
  fi
  if [[ "${add_desktop}" -eq 1 ]]; then
    profile_args+=("--profile" "desktop")
  fi
  if [[ "${follow_logs}" -eq 1 ]]; then
    log_args+=("--follow")
  fi
}

run_compose() {
  local command_args=(docker compose "${compose_args[@]}")
  if [[ "${#profile_args[@]}" -gt 0 ]]; then
    command_args+=("${profile_args[@]}")
  fi
  command_args+=("$@")
  "${command_args[@]}"
}

run_up() {
  local up_args=(up -d)
  if [[ "${#build_args[@]}" -gt 0 ]]; then
    up_args+=("${build_args[@]}")
  fi
  if [[ "$#" -gt 0 ]]; then
    up_args+=("$@")
  fi
  run_compose "${up_args[@]}"
}

run_logs() {
  local args=(logs "${log_args[@]}")
  if [[ "${#services[@]}" -gt 0 ]]; then
    args+=("${services[@]}")
  fi
  run_compose "${args[@]}"
}

print_url() {
  local port="${BUTLER_HOST_PORT:-$(env_value BUTLER_HOST_PORT || true)}"
  port="${port:-8180}"
  echo "Manor is running on http://127.0.0.1:${port}"
}

require_docker

case "${command}" in
  start)
    parse_common_options "$@"
    apply_options
    run_up
    print_url
    ;;
  stop)
    parse_common_options "$@"
    apply_options
    run_compose stop
    ;;
  restart)
    parse_common_options "$@"
    apply_options
    run_up
    print_url
    ;;
  status)
    parse_common_options "$@"
    apply_options
    run_compose ps
    ;;
  logs)
    parse_common_options "$@"
    apply_options
    run_logs
    ;;
  desktop)
    desktop_command="${1:-status}"
    shift || true
    case "${desktop_command}" in
      start)
        parse_common_options "$@"
        add_desktop=1
        apply_options
        run_up desktop-proof runtime-broker
        echo "Desktop proof is available at http://127.0.0.1:${DESKTOP_PROOF_NOVNC_PORT:-6080}/vnc.html"
        ;;
      stop)
        parse_common_options "$@"
        add_desktop=1
        apply_options
        run_compose stop desktop-proof
        ;;
      restart)
        parse_common_options "$@"
        add_desktop=1
        apply_options
        run_up desktop-proof runtime-broker
        echo "Desktop proof is available at http://127.0.0.1:${DESKTOP_PROOF_NOVNC_PORT:-6080}/vnc.html"
        ;;
      status)
        parse_common_options "$@"
        add_desktop=1
        apply_options
        run_compose ps desktop-proof
        ;;
      -h|--help|help)
        usage
        ;;
      *)
        echo "Unknown desktop command: ${desktop_command}" >&2
        usage >&2
        exit 64
        ;;
    esac
    ;;
  *)
    echo "Unknown command: ${command}" >&2
    usage >&2
    exit 64
    ;;
esac
