#!/usr/bin/env bash

set -euo pipefail

case "${MANOR_PI_AUTO_UPDATE:-0}" in
  1|true|TRUE|yes|YES|on|ON) ;;
  ""|0|false|FALSE|no|NO|off|OFF)
    exit 0
    ;;
  *)
    echo "MANOR_PI_AUTO_UPDATE must be one of: 1, true, yes, on, 0, false, no, off" >&2
    exit 64
    ;;
esac

target="${MANOR_PI_AUTO_UPDATE_VERSION:-latest}"
strict="${MANOR_PI_AUTO_UPDATE_REQUIRED:-0}"
real_path="${MANOR_REAL_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
app_dir="${MANOR_PI_AUTO_UPDATE_APP_DIR:-/opt/manor/butler}"

run_smoke_check() {
  PATH="${real_path}" node --input-type=module <<'NODE'
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

const authPath = `${process.env.PI_AGENT_DIR || "/home/butler/.pi/agent"}/auth.json`;
const registry = ModelRegistry.inMemory(AuthStorage.create(authPath));
const model = registry.find("openai-codex", "gpt-5.5") || registry.find("openai", "gpt-5.5");

if (!model) {
  throw new Error("PI registry does not expose gpt-5.5");
}

console.log(`PI model registry OK: ${model.provider}/${model.id}`);
NODE
}

echo "Updating PI packages to @mariozechner/*@${target} before startup..."
if ! (cd "${app_dir}" && PATH="${real_path}" npm install --omit=dev "@mariozechner/pi-ai@${target}" "@mariozechner/pi-coding-agent@${target}"); then
  echo "PI auto-update failed." >&2
  case "${strict}" in
    1|true|TRUE|yes|YES|on|ON)
      exit 1
      ;;
    *)
      echo "Continuing with the existing PI packages." >&2
      exit 0
      ;;
  esac
fi

if ! (cd "${app_dir}" && run_smoke_check); then
  echo "PI auto-update smoke check failed." >&2
  case "${strict}" in
    1|true|TRUE|yes|YES|on|ON)
      exit 1
      ;;
    *)
      echo "Continuing with the updated PI packages." >&2
      exit 0
      ;;
  esac
fi
