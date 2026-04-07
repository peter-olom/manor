#!/usr/bin/env bash

set -euo pipefail

mkdir -p "${CODEX_HOME:-$HOME/.codex}" "${PI_AGENT_DIR:-$HOME/.pi/agent}" /state /repos /artifacts

/usr/local/bin/butler-auth bootstrap

ttyd_port="${BUTLER_TTYD_PORT:-7682}"
ttyd_base_path="${BUTLER_TTYD_BASE_PATH:-/butler-terminal/}"
butler_port="${BUTLER_PORT:-8080}"
healthcheck_path="${BUTLER_APP_HEALTHCHECK_PATH:-/livez}"
healthcheck_interval_seconds="${BUTLER_APP_HEALTHCHECK_INTERVAL_SECONDS:-5}"
healthcheck_grace_seconds="${BUTLER_APP_HEALTHCHECK_GRACE_SECONDS:-30}"
healthcheck_failure_threshold="${BUTLER_APP_HEALTHCHECK_FAILURE_THRESHOLD:-3}"
ttyd_pid=""
butler_pid=""
watchdog_pid=""

terminate_process_group() {
  local pid="$1"

  if [[ -z "${pid}" ]] || ! kill -0 "${pid}" 2>/dev/null; then
    return
  fi

  kill -CONT "-${pid}" 2>/dev/null || true
  kill -TERM "-${pid}" 2>/dev/null || true

  for _ in 1 2 3 4 5; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      return
    fi
    sleep 1
  done

  kill -KILL "-${pid}" 2>/dev/null || true
}

cleanup() {
  local exit_code=$?

  terminate_process_group "${butler_pid}"

  if [[ -n "${ttyd_pid}" ]] && kill -0 "${ttyd_pid}" 2>/dev/null; then
    kill "${ttyd_pid}" 2>/dev/null || true
  fi

  if [[ -n "${watchdog_pid}" ]] && kill -0 "${watchdog_pid}" 2>/dev/null; then
    kill "${watchdog_pid}" 2>/dev/null || true
  fi

  wait "${butler_pid}" 2>/dev/null || true
  wait "${ttyd_pid}" 2>/dev/null || true
  wait "${watchdog_pid}" 2>/dev/null || true

  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

cd /opt/manor/butler

ttyd \
  --port "${ttyd_port}" \
  --base-path "${ttyd_base_path}" \
  --writable \
  --cwd /opt/manor/butler \
  /usr/local/bin/start-butler-shell &
ttyd_pid=$!

if [ "${BUTLER_HOT_RELOAD:-1}" = "1" ]; then
  if [ ! -d node_modules ] || [ ! -x node_modules/.bin/tsx ] || [ ! -x node_modules/.bin/vite ]; then
    npm install --include=dev --no-package-lock
  fi

  setsid npm run dev:start &
  butler_pid=$!
else
  setsid node dist/server/index.js &
  butler_pid=$!
fi

healthcheck_url="http://127.0.0.1:${butler_port}${healthcheck_path}"
(
  first_success=0
  consecutive_failures=0
  grace_deadline=$((SECONDS + healthcheck_grace_seconds))

  while kill -0 "${butler_pid}" 2>/dev/null; do
    if curl --silent --fail --max-time 2 "${healthcheck_url}" >/dev/null 2>&1; then
      first_success=1
      consecutive_failures=0
    else
      if [ "${first_success}" -eq 0 ] && [ "${SECONDS}" -lt "${grace_deadline}" ]; then
        sleep "${healthcheck_interval_seconds}"
        continue
      fi

      consecutive_failures=$((consecutive_failures + 1))
      if [ "${consecutive_failures}" -ge "${healthcheck_failure_threshold}" ]; then
        echo "Butler health check failed ${consecutive_failures} times at ${healthcheck_url}; exiting container." >&2
        kill -TERM "$$"
        exit 1
      fi
    fi

    sleep "${healthcheck_interval_seconds}"
  done
) &
watchdog_pid=$!

wait -n "${ttyd_pid}" "${butler_pid}"
