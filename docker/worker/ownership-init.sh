#!/usr/bin/env bash

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Manor ownership initialization must run as root." >&2
  exit 70
fi

appliance_uid="${MANOR_APPLIANCE_UID:-1001}"
appliance_gid="${MANOR_APPLIANCE_GID:-1001}"

if [[ ! "${appliance_uid}" =~ ^[0-9]+$ || ! "${appliance_gid}" =~ ^[0-9]+$ ]]; then
  echo "Manor appliance UID and GID must be numeric." >&2
  exit 64
fi

for root in "$@"; do
  if [[ ! -d "${root}" ]]; then
    echo "Managed volume mount is missing: ${root}" >&2
    exit 70
  fi

  find "${root}" -xdev \( ! -uid "${appliance_uid}" -o ! -gid "${appliance_gid}" \) \
    -exec chown -h "${appliance_uid}:${appliance_gid}" {} +
done
