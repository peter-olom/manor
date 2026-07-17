#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")"
repo_dir="$(pwd -P)"

usage() {
  cat <<'EOF'
Usage:
  ./manor.sh start [--dev] [--desktop]
  ./manor.sh stop [--dev] [--desktop]
  ./manor.sh restart [--dev] [--desktop]
  ./manor.sh dev-restart [--desktop]
  ./manor.sh status [--dev] [--desktop]
  ./manor.sh logs [--dev] [--desktop] [--follow] [--tail <n>] [service ...]
  ./manor.sh desktop start
  ./manor.sh desktop stop
  ./manor.sh desktop restart
  ./manor.sh desktop status

Options:
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

compose_project_name="${MANOR_COMPOSE_PROJECT_NAME:-$(env_value MANOR_COMPOSE_PROJECT_NAME || true)}"
compose_project_name="${compose_project_name:-${COMPOSE_PROJECT_NAME:-$(env_value COMPOSE_PROJECT_NAME || true)}}"
compose_project_name="${compose_project_name:-manor}"
export COMPOSE_PROJECT_NAME="${compose_project_name}"
export MANOR_COMPOSE_PROJECT_NAME="${compose_project_name}"
export MANOR_HOST_UID="${MANOR_HOST_UID:-$(id -u)}"
export MANOR_HOST_GID="${MANOR_HOST_GID:-$(id -g)}"

base_compose_args=("-f" "compose.yml" "-f" "compose.build.yml")
compose_args=("${base_compose_args[@]}")
profile_args=()
log_args=("--tail" "100")
services=()
preserved_dev=0
cleanup_recovery_snapshots=0
lifecycle_lock_name=""
lifecycle_lock_owner=""
lifecycle_lock_acquired=0
lifecycle_lock_heartbeat_pid=""
lifecycle_lock_heartbeat_a=""
lifecycle_lock_heartbeat_b=""
lifecycle_lock_heartbeat_grace_seconds=30
lifecycle_host_lease_dir=""
lifecycle_takeover_name=""
lifecycle_takeover_token=""
lifecycle_takeover_acquired=0
lifecycle_takeover_heartbeat_pid=""

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

preserve_running_dev_overlay() {
  if [[ "${add_dev}" -eq 1 ]]; then
    return
  fi

  local container_id=""
  container_id="$(docker ps \
    --filter "label=com.docker.compose.project=${compose_project_name}" \
    --filter "label=com.docker.compose.service=butler" \
    --quiet | head -n 1 || true)"

  if [[ -z "${container_id}" ]]; then
    return
  fi

  local running_env=""
  running_env="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${container_id}" 2>/dev/null || true)"
  local config_files=""
  config_files="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "${container_id}" 2>/dev/null || true)"

  if grep -qx 'BUTLER_HOT_RELOAD=1' <<<"${running_env}" || [[ "${config_files}" == *"compose.dev.yml"* ]]; then
    add_dev=1
    preserved_dev=1
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

cleanup_retired_worker_resources() {
  local container_name=""
  for container_name in manor-codex-box manor-codex; do
    if docker container inspect "${container_name}" >/dev/null 2>&1; then
      docker rm --force "${container_name}" >/dev/null
    fi
  done

  local volume_key=""
  local volume_id=""
  for volume_key in codex-config codex-home codex-state butler-home; do
    while IFS= read -r volume_id; do
      [[ -z "${volume_id}" ]] && continue
      docker volume rm "${volume_id}" >/dev/null
    done < <(docker volume ls --quiet \
      --filter "label=com.docker.compose.project=${compose_project_name}" \
      --filter "label=com.docker.compose.volume=${volume_key}")
    volume_id="${compose_project_name}_${volume_key}"
    if docker volume inspect "${volume_id}" >/dev/null 2>&1; then
      docker volume rm "${volume_id}" >/dev/null
    fi
  done
}

remove_lifecycle_heartbeats() {
  local expected_owner="${1:-}"
  local heartbeat details network_id owner
  for heartbeat in "${lifecycle_lock_heartbeat_a}" "${lifecycle_lock_heartbeat_b}"; do
    [[ -z "${heartbeat}" ]] && continue
    if [[ -n "${expected_owner}" ]]; then
      details="$(docker network inspect --format '{{.Id}}|{{index .Labels "com.manor.lifecycle-run"}}' "${heartbeat}" 2>/dev/null || true)"
      network_id="${details%%|*}"
      owner="${details#*|}"
      [[ "${owner}" != "${expected_owner}" ]] && continue
    else
      network_id="${heartbeat}"
    fi
    docker network rm "${network_id}" >/dev/null 2>&1 || true
  done
}

start_lifecycle_heartbeat() {
  lifecycle_host_lease_dir="${repo_dir}/state/lifecycle-guards/${compose_project_name}-host-lease"
  local old_lease="${lifecycle_host_lease_dir}.old.${lifecycle_lock_owner}"
  if [[ -d "${lifecycle_host_lease_dir}" ]] && mv "${lifecycle_host_lease_dir}" "${old_lease}" 2>/dev/null; then
    rm -rf -- "${old_lease}"
  fi
  if ! mkdir "${lifecycle_host_lease_dir}"; then
    return 1
  fi
  if ! chmod 0777 "${lifecycle_host_lease_dir}" || \
    ! printf '%s\n' "${lifecycle_lock_owner}" > "${lifecycle_host_lease_dir}/owner" || \
    ! touch "${lifecycle_host_lease_dir}/heartbeat" || \
    ! chmod 0666 "${lifecycle_host_lease_dir}/owner" "${lifecycle_host_lease_dir}/heartbeat"; then
    rm -rf -- "${lifecycle_host_lease_dir}"
    return 1
  fi

  local parent_pid="$$"
  local parent_started=""
  parent_started="$(ps -o lstart= -p "${parent_pid}" 2>/dev/null | tr -s ' ' || true)"
  (
    while kill -0 "${parent_pid}" 2>/dev/null; do
      if [[ -n "${parent_started}" && "$(ps -o lstart= -p "${parent_pid}" 2>/dev/null | tr -s ' ' || true)" != "${parent_started}" ]]; then
        break
      fi
      [[ "$(sed -n '1p' "${lifecycle_host_lease_dir}/owner" 2>/dev/null || true)" == "${lifecycle_lock_owner}" ]] || break
      touch "${lifecycle_host_lease_dir}/heartbeat" 2>/dev/null || break
      sleep 2
    done
  ) >/dev/null 2>&1 &
  lifecycle_lock_heartbeat_pid="$!"
}

lifecycle_heartbeat_is_fresh() {
  local expected_owner="$1"
  local checked_at="$(date +%s)"
  local owner heartbeat_mtime
  lifecycle_host_lease_dir="${repo_dir}/state/lifecycle-guards/${compose_project_name}-host-lease"
  if [[ ! -d "${lifecycle_host_lease_dir}" ]]; then
    return 1
  fi
  if ! owner="$(sed -n '1p' "${lifecycle_host_lease_dir}/owner" 2>/dev/null)"; then
    return 2
  fi
  [[ "${owner}" == "${expected_owner}" ]] || return 1
  heartbeat_mtime="$(stat -f '%m' "${lifecycle_host_lease_dir}/heartbeat" 2>/dev/null || stat -c '%Y' "${lifecycle_host_lease_dir}/heartbeat" 2>/dev/null || true)"
  [[ "${heartbeat_mtime}" =~ ^[0-9]+$ ]] || return 2
  (( checked_at - heartbeat_mtime <= lifecycle_lock_heartbeat_grace_seconds )) && return 0
  return 1
}

remove_host_lifecycle_lease() {
  local expected_owner="$1"
  lifecycle_host_lease_dir="${repo_dir}/state/lifecycle-guards/${compose_project_name}-host-lease"
  local owner=""
  owner="$(sed -n '1p' "${lifecycle_host_lease_dir}/owner" 2>/dev/null || true)"
  [[ "${owner}" == "${expected_owner}" ]] || return 0
  local removed="${lifecycle_host_lease_dir}.removed.${expected_owner}"
  if mv "${lifecycle_host_lease_dir}" "${removed}" 2>/dev/null; then
    rm -rf -- "${removed}"
  fi
}

create_host_lifecycle_lock() {
  local created_at="$(date +%s)"
  if ! docker network create \
    --label com.manor.lifecycle-lock=1 \
    --label "com.manor.lifecycle-run=${lifecycle_lock_owner}" \
    --label "com.manor.lifecycle-created=${created_at}" \
    "${lifecycle_lock_name}" >/dev/null 2>&1; then
    return 1
  fi
  lifecycle_lock_acquired=1
  if ! start_lifecycle_heartbeat; then
    docker network rm "${lifecycle_lock_name}" >/dev/null 2>&1 || true
    lifecycle_lock_acquired=0
    return 1
  fi
}

release_lifecycle_takeover_guard() {
  if [[ -n "${lifecycle_takeover_heartbeat_pid}" ]]; then
    kill "${lifecycle_takeover_heartbeat_pid}" >/dev/null 2>&1 || true
    wait "${lifecycle_takeover_heartbeat_pid}" 2>/dev/null || true
    lifecycle_takeover_heartbeat_pid=""
  fi
  if [[ "${lifecycle_takeover_acquired}" -ne 1 || -z "${lifecycle_takeover_name}" ]]; then
    return
  fi
  local owner=""
  owner="$(sed -n '1p' "${lifecycle_takeover_name}/owner" 2>/dev/null || true)"
  if [[ "${owner}" == "${lifecycle_takeover_token}" ]]; then
    local released="${lifecycle_takeover_name}.released.${lifecycle_takeover_token}"
    if mv "${lifecycle_takeover_name}" "${released}" 2>/dev/null; then
      rm -rf -- "${released}"
    fi
  fi
  lifecycle_takeover_acquired=0
}

acquire_lifecycle_takeover_guard() {
  lifecycle_takeover_name="${repo_dir}/state/lifecycle-guards/${compose_project_name}-takeover"
  lifecycle_takeover_token="${lifecycle_lock_owner}-takeover"
  local guard_root="$(dirname "${lifecycle_takeover_name}")"
  if [[ ! -d "${guard_root}" ]]; then
    if ! mkdir -p "${guard_root}" || ! chmod 0777 "${guard_root}"; then
      return 1
    fi
  elif [[ ! -w "${guard_root}" ]]; then
    return 1
  fi
  if mkdir "${lifecycle_takeover_name}" 2>/dev/null; then
    if ! chmod 0777 "${lifecycle_takeover_name}" || \
      ! printf '%s\n' "${lifecycle_takeover_token}" > "${lifecycle_takeover_name}/owner" || \
      ! touch "${lifecycle_takeover_name}/heartbeat" || \
      ! chmod 0666 "${lifecycle_takeover_name}/owner" "${lifecycle_takeover_name}/heartbeat"; then
      rm -rf -- "${lifecycle_takeover_name}"
      return 1
    fi
    lifecycle_takeover_acquired=1
    local parent_pid="$$"
    local parent_started=""
    parent_started="$(ps -o lstart= -p "${parent_pid}" 2>/dev/null | tr -s ' ' || true)"
    (
      while kill -0 "${parent_pid}" 2>/dev/null; do
        if [[ -n "${parent_started}" && "$(ps -o lstart= -p "${parent_pid}" 2>/dev/null | tr -s ' ' || true)" != "${parent_started}" ]]; then
          break
        fi
        [[ "$(sed -n '1p' "${lifecycle_takeover_name}/owner" 2>/dev/null || true)" == "${lifecycle_takeover_token}" ]] || break
        touch "${lifecycle_takeover_name}/heartbeat" 2>/dev/null || break
        sleep 2
      done
    ) >/dev/null 2>&1 &
    lifecycle_takeover_heartbeat_pid="$!"
    return 0
  fi

  local heartbeat_mtime=""
  heartbeat_mtime="$(stat -f '%m' "${lifecycle_takeover_name}/heartbeat" 2>/dev/null || stat -c '%Y' "${lifecycle_takeover_name}/heartbeat" 2>/dev/null || stat -f '%m' "${lifecycle_takeover_name}" 2>/dev/null || stat -c '%Y' "${lifecycle_takeover_name}" 2>/dev/null || true)"
  local checked_at="$(date +%s)"
  if [[ "${heartbeat_mtime}" =~ ^[0-9]+$ ]] && (( checked_at - heartbeat_mtime > lifecycle_lock_heartbeat_grace_seconds )); then
    local stale="${lifecycle_takeover_name}.stale.${lifecycle_takeover_token}"
    if mv "${lifecycle_takeover_name}" "${stale}" 2>/dev/null; then
      rm -rf -- "${stale}"
      acquire_lifecycle_takeover_guard
      return $?
    fi
  fi
  return 1
}

cleanup_lifecycle_locks() {
  release_lifecycle_takeover_guard
  release_lifecycle_lock
}

release_lifecycle_lock() {
  if [[ -n "${lifecycle_lock_heartbeat_pid}" ]]; then
    kill "${lifecycle_lock_heartbeat_pid}" >/dev/null 2>&1 || true
    wait "${lifecycle_lock_heartbeat_pid}" 2>/dev/null || true
    lifecycle_lock_heartbeat_pid=""
  fi
  remove_host_lifecycle_lease "${lifecycle_lock_owner}"
  remove_lifecycle_heartbeats "${lifecycle_lock_owner}"
  if [[ "${lifecycle_lock_acquired}" -ne 1 || -z "${lifecycle_lock_name}" ]]; then
    return
  fi
  local owner=""
  local details=""
  details="$(docker network inspect --format '{{.Id}}|{{index .Labels "com.manor.lifecycle-run"}}' "${lifecycle_lock_name}" 2>/dev/null || true)"
  local network_id="${details%%|*}"
  owner="${details#*|}"
  if [[ "${owner}" == "${lifecycle_lock_owner}" ]]; then
    docker network rm "${network_id}" >/dev/null 2>&1 || true
  fi
  lifecycle_lock_acquired=0
}

acquire_lifecycle_lock() {
  lifecycle_lock_name="${compose_project_name}_lifecycle-lock"
  lifecycle_lock_owner="host-$$-$(date +%s)"
  local created_at="$(date +%s)"
  if [[ ! -d "${repo_dir}/state/lifecycle-guards" ]]; then
    if ! mkdir -p "${repo_dir}/state/lifecycle-guards" || ! chmod 0777 "${repo_dir}/state/lifecycle-guards"; then
      echo "Manor lifecycle state could not be initialized." >&2
      return 73
    fi
  elif [[ ! -w "${repo_dir}/state/lifecycle-guards" ]]; then
    echo "Manor lifecycle state is not writable by the current user." >&2
    return 73
  fi
  trap cleanup_lifecycle_locks EXIT

  if create_host_lifecycle_lock; then
    return
  fi

  if ! acquire_lifecycle_takeover_guard; then
    echo "Another Manor lifecycle operation is already running. Wait for it to finish and retry." >&2
    return 75
  fi

  if create_host_lifecycle_lock; then
    release_lifecycle_takeover_guard
    return
  fi

  local current_owner=""
  current_owner="$(docker network inspect --format '{{index .Labels "com.manor.lifecycle-run"}}' "${lifecycle_lock_name}" 2>/dev/null || true)"
  local current_created=""
  current_created="$(docker network inspect --format '{{index .Labels "com.manor.lifecycle-created"}}' "${lifecycle_lock_name}" 2>/dev/null || true)"
  local host_lock_young=0
  if [[ "${current_created}" =~ ^[0-9]+$ ]] && (( created_at - current_created <= lifecycle_lock_heartbeat_grace_seconds )); then
    host_lock_young=1
  fi
  local reclaim_host_lock=0
  if [[ "${current_owner}" =~ ^host-([0-9]+)- ]]; then
    if [[ "${host_lock_young}" -eq 0 ]]; then
      local heartbeat_status=0
      if lifecycle_heartbeat_is_fresh "${current_owner}"; then
        heartbeat_status=0
      else
        heartbeat_status=$?
      fi
      [[ "${heartbeat_status}" -eq 1 ]] && reclaim_host_lock=1
    fi
  fi
  if [[ "${reclaim_host_lock}" -eq 1 ]]; then
    lifecycle_lock_heartbeat_a="${lifecycle_lock_name}-heartbeat-a"
    lifecycle_lock_heartbeat_b="${lifecycle_lock_name}-heartbeat-b"
    local stale_owner="${current_owner}"
    local final_details=""
    final_details="$(docker network inspect --format '{{.Id}}|{{index .Labels "com.manor.lifecycle-run"}}' "${lifecycle_lock_name}" 2>/dev/null || true)"
    local final_network_id="${final_details%%|*}"
    current_owner="${final_details#*|}"
    if [[ "${current_owner}" != "${stale_owner}" ]]; then
      release_lifecycle_takeover_guard
      echo "Another Manor lifecycle operation is already running. Wait for it to finish and retry." >&2
      return 75
    fi
    remove_host_lifecycle_lease "${stale_owner}"
    remove_lifecycle_heartbeats "${stale_owner}"
    current_owner="$(docker network inspect --format '{{index .Labels "com.manor.lifecycle-run"}}' "${lifecycle_lock_name}" 2>/dev/null || true)"
    if [[ "${current_owner}" != "${stale_owner}" ]]; then
      release_lifecycle_takeover_guard
      echo "Another Manor lifecycle operation is already running. Wait for it to finish and retry." >&2
      return 75
    fi
    docker network rm "${final_network_id}" >/dev/null 2>&1 || true
    if create_host_lifecycle_lock; then
      release_lifecycle_takeover_guard
      return
    fi
  fi

  if [[ -n "${current_owner}" && ! "${current_owner}" =~ ^host- ]]; then
    local helper_id=""
    local helper_query_ok=0
    local controller_state=""
    local controller_query_ok=0
    local controller_terminal=""
    local controller_health=""
    if helper_id="$(docker ps --filter "label=com.manor.restart-run=${current_owner}" --quiet 2>/dev/null | head -n 1)"; then
      helper_query_ok=1
    fi
    if controller_state="$(docker ps --all --filter 'name=manor-host-controller' --format '{{.Names}}|{{.State}}' 2>/dev/null | awk -F'|' '$1 == "manor-host-controller" { print $2; exit }')"; then
      controller_query_ok=1
    fi
    if [[ "${controller_state}" == "running" ]]; then
      controller_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' manor-host-controller 2>/dev/null || true)"
      controller_terminal="$(docker exec manor-host-controller node -e '
        const fs = require("node:fs");
        try {
          const state = JSON.parse(fs.readFileSync("/state/restart-status.json", "utf8"));
          if (state.latestRun?.id === process.argv[1] && state.latestRun.status !== "running") process.stdout.write("terminal");
        } catch {}
      ' "${current_owner}" 2>/dev/null || true)"
    fi
    if [[ "${helper_query_ok}" -eq 1 && "${controller_query_ok}" -eq 1 && -z "${helper_id}" && \
      ( -z "${controller_state}" || "${controller_state}" == "exited" || "${controller_state}" == "dead" || "${controller_terminal}" == "terminal" || ( "${controller_health}" == "unhealthy" && "${host_lock_young}" -eq 0 ) ) ]]; then
      local verified_details=""
      verified_details="$(docker network inspect --format '{{.Id}}|{{index .Labels "com.manor.lifecycle-run"}}' "${lifecycle_lock_name}" 2>/dev/null || true)"
      local verified_network_id="${verified_details%%|*}"
      local verified_owner="${verified_details#*|}"
      if [[ "${verified_owner}" != "${current_owner}" ]]; then
        release_lifecycle_takeover_guard
        echo "Another Manor lifecycle operation is already running. Wait for it to finish and retry." >&2
        return 75
      fi
      docker network rm "${verified_network_id}" >/dev/null 2>&1 || true
      if create_host_lifecycle_lock; then
        release_lifecycle_takeover_guard
        return
      fi
    fi
  fi

  release_lifecycle_takeover_guard
  echo "Another Manor lifecycle operation is already running. Wait for it to finish and retry." >&2
  return 75
}

cleanup_obsolete_clean_head_sources() {
  local recovery_root="${repo_dir}/state/clean-head"
  if [[ ! -d "${recovery_root}" ]]; then
    return
  fi

  local container_list=""
  if ! container_list="$(docker ps --all --quiet 2>/dev/null)"; then
    echo "Could not inspect containers; leaving clean HEAD recovery files in place." >&2
    return
  fi

  local -a existing_containers=()
  while IFS= read -r container_id; do
    if [[ -n "${container_id}" ]]; then
      existing_containers+=("${container_id}")
    fi
  done <<<"${container_list}"

  local mounted_sources=""
  if [[ "${#existing_containers[@]}" -gt 0 ]] && \
    ! mounted_sources="$(docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "${existing_containers[@]}" 2>/dev/null)"; then
    echo "Could not inspect container mounts; leaving clean HEAD recovery files in place." >&2
    return
  fi

  local clean_dir=""
  for clean_dir in "${recovery_root}"/*; do
    [[ -d "${clean_dir}" ]] || continue
    if awk -v directory="${clean_dir}" '
      $0 == directory || index($0, directory "/") == 1 { found = 1 }
      END { exit(found ? 0 : 1) }
    ' <<<"${mounted_sources}"; then
      continue
    fi
    if ! rm -rf -- "${clean_dir}"; then
      echo "Could not remove obsolete clean HEAD recovery files at ${clean_dir}." >&2
    fi
  done
  rmdir "${recovery_root}" 2>/dev/null || true
}

recover_from_clean_head() {
  local wait_timeout="$1"
  shift

  if ! command -v git >/dev/null 2>&1 || ! git rev-parse --verify --quiet HEAD >/dev/null; then
    return 1
  fi
  if [[ -z "$(git status --porcelain --untracked-files=normal 2>/dev/null)" ]]; then
    return 1
  fi

  local head_sha=""
  head_sha="$(git rev-parse HEAD)"
  local recovery_root="${repo_dir}/state/clean-head"
  local clean_dir="${recovery_root}/${head_sha}"
  echo "Working-tree startup failed. Retrying with clean HEAD images while leaving local changes untouched." >&2

  if [[ ! -f "${clean_dir}/compose.yml" || ! -f "${clean_dir}/compose.build.yml" ]]; then
    local candidate_dir=""
    mkdir -p "${recovery_root}"
    candidate_dir="$(mktemp -d "${recovery_root}/.${head_sha}.XXXXXX")"
    if ! git archive --format=tar HEAD | tar -xf - -C "${candidate_dir}"; then
      rm -rf "${candidate_dir}"
      echo "Could not export clean HEAD for recovery." >&2
      return 1
    fi
    rm -rf "${clean_dir}"
    mv "${candidate_dir}" "${clean_dir}"
  fi

  local clean_compose=(docker compose --project-directory "${clean_dir}")
  if [[ -f "${repo_dir}/.env" ]]; then
    clean_compose+=(--env-file "${repo_dir}/.env")
  fi
  clean_compose+=("-f" "${clean_dir}/compose.yml" "-f" "${clean_dir}/compose.build.yml")
  if [[ "${#profile_args[@]}" -gt 0 ]]; then
    clean_compose+=("${profile_args[@]}")
  fi

  local recovery_args=(up -d --build --force-recreate --remove-orphans --wait --wait-timeout "${wait_timeout}")
  if [[ "$#" -gt 0 ]]; then
    recovery_args+=("$@")
  fi
  if ! MANOR_HOST_PROJECT_SOURCE_DIR="${MANOR_HOST_PROJECT_SOURCE_DIR:-${repo_dir}}" \
    BUTLER_HOT_RELOAD=0 \
    MANOR_PI_AUTO_UPDATE=0 \
    "${clean_compose[@]}" "${recovery_args[@]}"; then
    echo "Clean HEAD recovery did not become healthy." >&2
    return 1
  fi

  echo "Manor recovered on clean HEAD images. Local source changes remain in place." >&2
}

run_up() {
  local wait_timeout="${MANOR_START_WAIT_TIMEOUT:-$(env_value MANOR_START_WAIT_TIMEOUT || true)}"
  wait_timeout="${wait_timeout:-300}"

  if [[ ! "${wait_timeout}" =~ ^[1-9][0-9]*$ ]]; then
    echo "MANOR_START_WAIT_TIMEOUT must be a positive number of seconds." >&2
    return 64
  fi

  cleanup_retired_worker_resources

  local up_args=(up -d --build --remove-orphans --wait --wait-timeout "${wait_timeout}")
  if [[ "$#" -gt 0 ]]; then
    up_args+=("$@")
  fi

  if run_compose "${up_args[@]}"; then
    if [[ "${cleanup_recovery_snapshots}" -eq 1 ]]; then
      cleanup_obsolete_clean_head_sources
    fi
    return 0
  fi

  echo "Manor did not become healthy. Current service state:" >&2
  run_compose ps >&2 || true
  echo "Recent Manor logs:" >&2
  run_compose logs --tail 80 >&2 || true
  if recover_from_clean_head "${wait_timeout}" "$@"; then
    return 0
  fi
  return 1
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
    acquire_lifecycle_lock
    cleanup_recovery_snapshots=1
    run_up
    print_url
    ;;
  stop)
    parse_common_options "$@"
    apply_options
    acquire_lifecycle_lock
    run_compose stop
    ;;
  restart)
    parse_common_options "$@"
    preserve_running_dev_overlay
    apply_options
    if [[ "${preserved_dev}" -eq 1 ]]; then
      echo "Preserving Butler hot reload mode."
    fi
    acquire_lifecycle_lock
    cleanup_recovery_snapshots=1
    run_up --force-recreate
    print_url
    ;;
  dev-restart)
    parse_common_options "$@"
    add_dev=1
    apply_options
    acquire_lifecycle_lock
    cleanup_recovery_snapshots=1
    run_up --force-recreate
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
        acquire_lifecycle_lock
        run_up desktop-proof runtime-broker
        echo "Desktop proof is available at http://127.0.0.1:${DESKTOP_PROOF_NOVNC_PORT:-6080}/vnc.html"
        ;;
      stop)
        parse_common_options "$@"
        add_desktop=1
        apply_options
        acquire_lifecycle_lock
        run_compose stop desktop-proof
        ;;
      restart)
        parse_common_options "$@"
        add_desktop=1
        apply_options
        acquire_lifecycle_lock
        run_up --force-recreate desktop-proof runtime-broker
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
