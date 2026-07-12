#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Usage:
  ./update.sh [options]

Options:
  --latest       Update to the latest configured target before restarting.
  --current      Restart the currently configured Manor stack. Default.
  --ref <ref>    Source ref to check out before rebuilding.
  --build        Build source images before restarting.
  --no-build     Do not build source images before restarting.
  --desktop      Include the desktop proof service.
  --no-wait      Return after the controller accepts the run.
  -h, --help     Show this help.
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
}

require_controller() {
  if ! docker inspect manor-host-controller >/dev/null 2>&1; then
    echo "Manor host controller is not running. Start Manor first." >&2
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

json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  printf '"%s"' "${value}"
}

json_field() {
  local json="$1"
  local field_path="$2"
  printf '%s' "${json}" | docker exec -i manor-host-controller node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        let value = JSON.parse(input);
        for (const key of process.argv[1].split(".")) value = value?.[key];
        if (value !== undefined && value !== null) process.stdout.write(String(value));
      } catch {}
    });
  ' "${field_path}" 2>/dev/null || true
}

controller_curl() {
  local method="$1"
  local path="$2"
  local payload="${3:-}"
  if [[ -n "${payload}" ]]; then
    docker exec -e MANOR_RESTART_PAYLOAD="${payload}" manor-host-controller sh -lc \
      "curl --silent --show-error --fail-with-body --connect-timeout 2 --max-time 5 -X ${method} \
        -H 'content-type: application/json' \
        -H \"x-manor-host-controller-token: \${MANOR_HOST_CONTROLLER_TOKEN:?missing}\" \
        --data-binary \"\${MANOR_RESTART_PAYLOAD}\" \
        \"http://127.0.0.1:\${MANOR_HOST_CONTROLLER_PORT:-8092}${path}\""
  else
    docker exec manor-host-controller sh -lc \
      "curl --silent --show-error --fail-with-body --connect-timeout 2 --max-time 5 -X ${method} \
        -H \"x-manor-host-controller-token: \${MANOR_HOST_CONTROLLER_TOKEN:?missing}\" \
        \"http://127.0.0.1:\${MANOR_HOST_CONTROLLER_PORT:-8092}${path}\""
  fi
}

target="current"
git_ref=""
include_desktop=false
build=""
wait_for_finish=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest)
      target="latest"
      ;;
    --current)
      target="current"
      ;;
    --ref)
      if [[ -z "${2:-}" ]]; then
        echo "--ref requires a value." >&2
        exit 64
      fi
      git_ref="$2"
      shift
      ;;
    --build)
      build=true
      ;;
    --no-build)
      build=false
      ;;
    --desktop)
      include_desktop=true
      ;;
    --no-wait)
      wait_for_finish=false
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

payload="{\"confirmation\":\"restart Manor\",\"target\":$(json_string "${target}"),\"update\":$([[ "${target}" == "latest" ]] && echo true || echo false),\"includeDesktop\":${include_desktop}"
if [[ -n "${git_ref}" ]]; then
  payload+=",\"gitRef\":$(json_string "${git_ref}")"
fi
if [[ -n "${build}" ]]; then
  payload+=",\"build\":${build}"
fi
payload+="}"

wait_timeout=""
if [[ "${wait_for_finish}" == true ]]; then
  wait_timeout="${MANOR_UPDATE_WAIT_TIMEOUT:-$(env_value MANOR_UPDATE_WAIT_TIMEOUT || true)}"
  wait_timeout="${wait_timeout:-900}"
  if [[ ! "${wait_timeout}" =~ ^[0-9]+$ ]] || (( wait_timeout < 30 || wait_timeout > 3600 )); then
    echo "MANOR_UPDATE_WAIT_TIMEOUT must be between 30 and 3600 seconds." >&2
    exit 64
  fi
fi

require_docker
require_controller

response="$(controller_curl POST /restart "${payload}")"
run_id="$(json_field "${response}" run.id)"
if [[ -z "${run_id}" ]]; then
  echo "Manor restart was accepted without a run ID; refusing to follow an unrelated run." >&2
  exit 1
fi
echo "Manor restart accepted: ${run_id}"

if [[ "${wait_for_finish}" != true ]]; then
  exit 0
fi

deadline=$((SECONDS + wait_timeout))

while true; do
  status_response="$(controller_curl GET /status 2>/dev/null || true)"
  latest_run_id="$(json_field "${status_response}" latestRun.id)"
  status="$(json_field "${status_response}" latestRun.status)"

  if [[ -n "${latest_run_id}" && "${latest_run_id}" != "${run_id}" ]]; then
    echo "Manor restart result was replaced by another run (${latest_run_id}); expected ${run_id}." >&2
    exit 1
  fi
  if [[ -z "${latest_run_id}" ]]; then
    status=""
  fi

  case "${status}" in
    completed)
      echo "Manor restart completed."
      exit 0
      ;;
    failed)
      error="$(json_field "${status_response}" latestRun.error)"
      echo "Manor restart failed: ${error:-no error detail reported}" >&2
      exit 1
      ;;
    running|"")
      ;;
    *)
      echo "Manor restart status: ${status}"
      ;;
  esac

  if (( SECONDS >= deadline )); then
    echo "Timed out after ${wait_timeout} seconds waiting for Manor restart ${run_id}." >&2
    exit 1
  fi
  sleep 2
done
