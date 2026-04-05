#!/usr/bin/env bash

set -euo pipefail

cd /opt/manor/butler

export HOME=/home/butler
export USER=butler
export LOGNAME=butler
export SHELL=/bin/zsh
export ZDOTDIR=/home/butler
export TERM="${TERM:-xterm-256color}"

exec zsh -li
