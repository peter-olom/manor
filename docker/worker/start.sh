#!/usr/bin/env bash

set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Worker must run as the non-root worker user." >&2
  exit 70
fi

ensure_writable_dir() {
  local dir="$1"

  if ! mkdir -p "${dir}" 2>/dev/null || [[ ! -w "${dir}" ]]; then
    echo "Required directory is not writable by the Worker user: ${dir}" >&2
    echo "Recreate or fix the mounted Worker state volume, then restart Manor." >&2
    exit 70
  fi
}

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"

mkdir -p "${PI_AGENT_DIR:-/worker-pi/agent}" "${WORKER_PI_SESSION_ROOT:-/worker-pi/sessions}" /worker-runtime /state /repos /artifacts
ensure_writable_dir "${config_home}"
ensure_writable_dir "${config_home}/gh"
ensure_writable_dir "${config_home}/manor"
ensure_writable_dir "${PI_AGENT_DIR:-/worker-pi/agent}"
ensure_writable_dir "${WORKER_PI_SESSION_ROOT:-/worker-pi/sessions}"
ensure_writable_dir /worker-runtime

/usr/local/bin/worker-bootstrap-tools

github_host="${GITHUB_HOST:-github.com}"

if gh auth status --hostname "${github_host}" >/dev/null 2>&1; then
  gh auth setup-git --hostname "${github_host}" >/dev/null 2>&1 || true
fi

git config --global --get user.name >/dev/null 2>&1 || git config --global user.name "${MANOR_GIT_AUTHOR_NAME:-Manor Worker}"
git config --global --get user.email >/dev/null 2>&1 || git config --global user.email "${MANOR_GIT_AUTHOR_EMAIL:-worker@manor.local}"

export SHELL=/usr/bin/bash
export TERM="${TERM:-xterm-256color}"

ttyd_port="${WORKER_TTYD_PORT:-7681}"
ttyd_base_path="${WORKER_TTYD_BASE_PATH:-/terminal/}"
ttyd_pid=""
worker_pi_bridge_pid=""

cleanup() {
  local exit_code=$?

  if [[ -n "${ttyd_pid}" ]] && kill -0 "${ttyd_pid}" 2>/dev/null; then
    kill "${ttyd_pid}" 2>/dev/null || true
  fi

  if [[ -n "${worker_pi_bridge_pid}" ]] && kill -0 "${worker_pi_bridge_pid}" 2>/dev/null; then
    kill "${worker_pi_bridge_pid}" 2>/dev/null || true
  fi

  wait "${ttyd_pid}" 2>/dev/null || true
  wait "${worker_pi_bridge_pid}" 2>/dev/null || true

  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

ttyd \
  --port "${ttyd_port}" \
  --base-path "${ttyd_base_path}" \
  --client-option fontSize=14 \
  --writable \
  --cwd /repos \
  bash -lc 'exec zsh -li' &
ttyd_pid=$!

/usr/local/bin/node /opt/manor/worker/worker-pi-rpc-bridge.mjs &
worker_pi_bridge_pid=$!

wait -n "${ttyd_pid}" "${worker_pi_bridge_pid}"
