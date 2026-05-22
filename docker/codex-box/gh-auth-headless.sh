#!/usr/bin/env bash

set -euo pipefail

host="${GITHUB_HOST:-github.com}"
git_protocol="${GITHUB_GIT_PROTOCOL:-https}"

export BROWSER=/usr/local/bin/gh-headless-browser

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"

if ! mkdir -p "${config_home}/gh" 2>/dev/null || [[ ! -w "${config_home}/gh" ]]; then
  echo "GitHub CLI config is not writable by the codex user: ${config_home}/gh" >&2
  echo "Recreate or fix the mounted codex config volume, then restart Manor." >&2
  exit 70
fi

printf 'Starting GitHub sign-in for %s.\n' "${host}"
printf 'This terminal will stay headless. Press Enter when GitHub asks to continue.\n'
printf 'The approval URL and one-time code will be shown here.\n\n'

gh auth login --hostname "${host}" --git-protocol "${git_protocol}" --web "$@"
gh auth setup-git --hostname "${host}"

printf '\nGitHub sign-in complete. Raw git now uses GitHub CLI credentials for %s.\n' "${host}"
