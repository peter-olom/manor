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
  --source       Force source restart mode.
  --image        Force image restart mode.
  --ref <ref>    Source ref for source mode.
  --tag <tag>    Image tag for image mode.
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
  local field="$2"
  printf '%s' "${json}" | sed -n "s/.*\"${field}\":\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

controller_curl() {
  local method="$1"
  local path="$2"
  local payload="${3:-}"
  if [[ -n "${payload}" ]]; then
    docker exec -e MANOR_RESTART_PAYLOAD="${payload}" manor-host-controller sh -lc \
      "curl --silent --show-error --fail-with-body -X ${method} \
        -H 'content-type: application/json' \
        -H \"x-manor-host-controller-token: \${MANOR_HOST_CONTROLLER_TOKEN:?missing}\" \
        --data-binary \"\${MANOR_RESTART_PAYLOAD}\" \
        \"http://127.0.0.1:\${MANOR_HOST_CONTROLLER_PORT:-8092}${path}\""
  else
    docker exec manor-host-controller sh -lc \
      "curl --silent --show-error --fail-with-body -X ${method} \
        -H \"x-manor-host-controller-token: \${MANOR_HOST_CONTROLLER_TOKEN:?missing}\" \
        \"http://127.0.0.1:\${MANOR_HOST_CONTROLLER_PORT:-8092}${path}\""
  fi
}

target="current"
mode=""
git_ref=""
image_tag=""
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
    --source)
      mode="source"
      ;;
    --image)
      mode="image"
      ;;
    --ref)
      if [[ -z "${2:-}" ]]; then
        echo "--ref requires a value." >&2
        exit 64
      fi
      git_ref="$2"
      shift
      ;;
    --tag)
      if [[ -z "${2:-}" ]]; then
        echo "--tag requires a value." >&2
        exit 64
      fi
      image_tag="$2"
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

if [[ -n "${git_ref}" && -n "${image_tag}" ]]; then
  echo "Use either --ref or --tag, not both." >&2
  exit 64
fi

payload="{\"confirmation\":\"restart Manor\",\"target\":$(json_string "${target}"),\"update\":$([[ "${target}" == "latest" ]] && echo true || echo false),\"includeDesktop\":${include_desktop}"
if [[ -n "${mode}" ]]; then
  payload+=",\"mode\":$(json_string "${mode}")"
fi
if [[ -n "${git_ref}" ]]; then
  payload+=",\"gitRef\":$(json_string "${git_ref}")"
fi
if [[ -n "${image_tag}" ]]; then
  payload+=",\"imageTag\":$(json_string "${image_tag}")"
fi
if [[ -n "${build}" ]]; then
  payload+=",\"build\":${build}"
fi
payload+="}"

require_docker
require_controller

response="$(controller_curl POST /restart "${payload}")"
run_id="$(json_field "${response}" id)"
echo "Manor restart accepted: ${run_id:-unknown run}"

if [[ "${wait_for_finish}" != true ]]; then
  exit 0
fi

while true; do
  status_response="$(controller_curl GET /status)"
  status="$(json_field "${status_response}" status)"
  case "${status}" in
    completed)
      echo "Manor restart completed."
      exit 0
      ;;
    failed)
      error="$(json_field "${status_response}" error)"
      echo "Manor restart failed: ${error:-no error detail reported}" >&2
      exit 1
      ;;
    running|"")
      sleep 2
      ;;
    *)
      echo "Manor restart status: ${status}"
      sleep 2
      ;;
  esac
done
