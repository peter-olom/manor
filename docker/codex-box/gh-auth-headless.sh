#!/usr/bin/env bash

set -euo pipefail

host="${GITHUB_HOST:-github.com}"
git_protocol="${GITHUB_GIT_PROTOCOL:-https}"

export BROWSER=/usr/local/bin/gh-headless-browser

printf 'Starting GitHub sign-in for %s.\n' "${host}"
printf 'This terminal will stay headless. Press Enter when GitHub asks to continue.\n'
printf 'The approval URL and one-time code will be shown here.\n\n'

exec gh auth login --hostname "${host}" --git-protocol "${git_protocol}" --web "$@"
