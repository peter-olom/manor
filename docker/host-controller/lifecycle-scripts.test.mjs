import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const repoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const updatePath = path.join(repoPath, "update.sh");
const lifecyclePath = path.join(repoPath, "manor.sh");

test("update waiter follows only its accepted run through controller activation", async () => {
  const source = await readFile(updatePath, "utf8");

  assert.match(source, /run_id="\$\(json_field "\$\{response\}" run\.id\)"/);
  assert.match(source, /if \[\[ -z "\$\{run_id\}" \]\]/);
  assert.match(source, /status_response="\$\(controller_curl GET \/status 2>\/dev\/null \|\| true\)"/);
  assert.match(source, /--connect-timeout 2 --max-time 5/);
  assert.match(source, /latest_run_id="\$\(json_field "\$\{status_response\}" latestRun\.id\)"/);
  assert.match(source, /"\$\{latest_run_id\}" != "\$\{run_id\}"/);
  assert.match(source, /if \[\[ -z "\$\{latest_run_id\}" \]\]; then\s+status=""/);
  assert.match(source, /MANOR_UPDATE_WAIT_TIMEOUT:-\$\(env_value MANOR_UPDATE_WAIT_TIMEOUT \|\| true\)/);
  assert.match(source, /wait_timeout="\$\{wait_timeout:-900\}"/);
  assert.match(source, /wait_timeout < 30 \|\| wait_timeout > 3600/);
  assert.match(source, /if \(\( SECONDS >= deadline \)\)/);
  assert.ok(source.indexOf("MANOR_UPDATE_WAIT_TIMEOUT:-$(env_value") < source.indexOf("controller_curl POST /restart"));
});

test("successful full source lifecycle reclaims only unused clean HEAD snapshots", async () => {
  const source = await readFile(lifecyclePath, "utf8");
  const cleanupBody = source.slice(
    source.indexOf("cleanup_obsolete_clean_head_sources()"),
    source.indexOf("recover_from_clean_head()")
  );
  const runUpBody = source.slice(source.indexOf("run_up()"), source.indexOf("run_logs()"));

  assert.match(cleanupBody, /docker ps --all --quiet/);
  assert.match(cleanupBody, /! mounted_sources="\$\(docker inspect --format '\{\{range \.Mounts\}\}\{\{println \.Source\}\}\{\{end\}\}'/);
  assert.match(cleanupBody, /index\(\$0, directory "\/"\) == 1/);
  assert.match(cleanupBody, /rm -rf -- "\$\{clean_dir\}"/);
  assert.match(runUpBody, /if run_compose "\$\{up_args\[@\]\}"; then[\s\S]*cleanup_obsolete_clean_head_sources/);
  assert.ok(runUpBody.indexOf("cleanup_obsolete_clean_head_sources") < runUpBody.indexOf("recover_from_clean_head"));

  for (const command of ["start", "restart", "dev-restart"]) {
    const commandIndex = source.indexOf(`  ${command})`);
    assert.ok(commandIndex >= 0);
    const commandBody = source.slice(commandIndex, source.indexOf("    ;;", commandIndex));
    assert.match(commandBody, /cleanup_recovery_snapshots=1/);
  }

  const desktopIndex = source.indexOf("  desktop)");
  const desktopBody = source.slice(desktopIndex, source.indexOf("  *)", desktopIndex));
  assert.doesNotMatch(desktopBody, /cleanup_recovery_snapshots=1/);
});

test("startup removes the retired Worker harness and its persistent volumes", async () => {
  const source = await readFile(lifecyclePath, "utf8");
  const cleanupBody = source.slice(
    source.indexOf("cleanup_retired_worker_resources()"),
    source.indexOf("remove_lifecycle_heartbeats()")
  );
  const runUpBody = source.slice(source.indexOf("run_up()"), source.indexOf("run_logs()"));
  const recoveryBody = source.slice(source.indexOf("recover_from_clean_head()"), source.indexOf("run_up()"));

  assert.match(cleanupBody, /manor-codex-box manor-codex/);
  assert.match(cleanupBody, /codex-config codex-home codex-state butler-home/);
  assert.match(runUpBody, /cleanup_retired_worker_resources/);
  assert.match(runUpBody, /--remove-orphans/);
  assert.match(recoveryBody, /--remove-orphans/);
});

test("host lifecycle mutations use the shared Docker lock", async () => {
  const source = await readFile(lifecyclePath, "utf8");
  const lockBody = source.slice(
    source.indexOf("acquire_lifecycle_lock()"),
    source.indexOf("cleanup_obsolete_clean_head_sources()")
  );
  assert.match(source, /compose_project_name="\$\{MANOR_COMPOSE_PROJECT_NAME/);
  assert.ok(source.indexOf('compose_project_name="${MANOR_COMPOSE_PROJECT_NAME') < source.indexOf('COMPOSE_PROJECT_NAME:-$(env_value COMPOSE_PROJECT_NAME'));
  assert.match(source, /export COMPOSE_PROJECT_NAME="\$\{compose_project_name\}"/);
  assert.match(source, /export MANOR_COMPOSE_PROJECT_NAME="\$\{compose_project_name\}"/);
  assert.match(source, /lifecycle_lock_name="\$\{compose_project_name\}_lifecycle-lock"/);
  assert.match(lockBody, /compose_project_name/);
  assert.match(source, /docker network create[\s\S]*com\.manor\.lifecycle-lock=1/);
  assert.match(source, /com\.manor\.lifecycle-created/);
  assert.match(lockBody, /lifecycle_heartbeat_is_fresh/);
  assert.match(source, /acquire_lifecycle_takeover_guard/);
  assert.match(source, /release_lifecycle_takeover_guard/);
  assert.match(source, /controller_health.*unhealthy/s);
  assert.match(source, /state\/lifecycle-guards/);
  assert.match(source, /chmod 0777/);
  assert.match(source, /MANOR_HOST_UID/);
  assert.match(source, /\.stale\.\$\{lifecycle_takeover_token\}/);
  assert.match(source, /trap cleanup_lifecycle_locks EXIT/);
  for (const command of ["start", "stop", "restart", "dev-restart"]) {
    const commandIndex = source.indexOf(`  ${command})`);
    const commandBody = source.slice(commandIndex, source.indexOf("    ;;", commandIndex));
    assert.match(commandBody, /acquire_lifecycle_lock/);
  }
});

test("Manor-specific project names drive both Compose and the lifecycle lock", async (context) => {
  const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "manor-project-name-")));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const binDir = path.join(fixture, "bin");
  const logPath = path.join(fixture, "docker.log");
  await mkdir(binDir, { recursive: true });
  await copyFile(lifecyclePath, path.join(fixture, "manor.sh"));
  const dockerMock = path.join(binDir, "docker");
  await writeFile(dockerMock, `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "$COMPOSE_PROJECT_NAME" "$MANOR_COMPOSE_PROJECT_NAME" "$*" >> "$DOCKER_LOG"
if [[ "$1" == "info" ]]; then exit 0; fi
if [[ "$1" == "compose" && "$2" == "version" ]]; then exit 0; fi
if [[ "$1" == "network" && "$2" == "create" ]]; then
  printf '%s\\n' "${'$'}{@: -2:1}" > "$LOCK_OWNER_FILE"
  exit 0
fi
if [[ "$1" == "network" && "$2" == "inspect" ]]; then cat "$LOCK_OWNER_FILE"; exit 0; fi
if [[ "$1" == "network" && "$2" == "rm" ]]; then exit 0; fi
if [[ "$1" == "ps" ]]; then exit 0; fi
if [[ "$1" == "compose" ]]; then exit 0; fi
exit 1
`, "utf8");
  await chmod(dockerMock, 0o755);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    DOCKER_LOG: logPath,
    LOCK_OWNER_FILE: path.join(fixture, "lock-owner"),
    MANOR_COMPOSE_PROJECT_NAME: "custom-manor"
  };
  delete env.COMPOSE_PROJECT_NAME;

  const result = spawnSync("bash", ["manor.sh", "start"], { cwd: fixture, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const calls = await readFile(logPath, "utf8");
  for (const line of calls.trim().split(/\r?\n/)) {
    assert.match(line, /^custom-manor\|custom-manor\|/);
  }
  assert.match(calls, /network create.*custom-manor_lifecycle-lock/);
  assert.match(calls, /compose -f compose\.yml -f compose\.build\.yml up/);
});

test("clean HEAD cleanup preserves snapshots mounted by a running container", async (context) => {
  const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "manor-lifecycle-")));
  context.after(() => rm(fixture, { recursive: true, force: true }));

  const binDir = path.join(fixture, "bin");
  const recoveryRoot = path.join(fixture, "state", "clean-head");
  const usedSnapshot = path.join(recoveryRoot, "used");
  const unusedSnapshot = path.join(recoveryRoot, "unused");
  await Promise.all([
    mkdir(binDir, { recursive: true }),
    mkdir(path.join(usedSnapshot, "config"), { recursive: true }),
    mkdir(unusedSnapshot, { recursive: true }),
    copyFile(lifecyclePath, path.join(fixture, "manor.sh"))
  ]);

  const dockerMock = path.join(binDir, "docker");
  await writeFile(dockerMock, `#!/bin/sh
if [ "$1" = "info" ]; then exit 0; fi
if [ "$1" = "compose" ]; then exit 0; fi
if [ "$1" = "network" ] && [ "$2" = "create" ]; then exit 0; fi
if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then printf '%s\\n' "$LOCK_OWNER"; exit 0; fi
if [ "$1" = "network" ] && [ "$2" = "rm" ]; then exit 0; fi
if [ "$1" = "ps" ]; then printf '%s\\n' running-container; exit 0; fi
if [ "$1" = "inspect" ]; then
  if [ "$FAIL_INSPECT" = "1" ]; then exit 1; fi
  printf '%s\\n' "$MOUNTED_SOURCE"
  exit 0
fi
exit 1
`, "utf8");
  await chmod(dockerMock, 0o755);

  const result = spawnSync("bash", ["manor.sh", "start"], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      MOUNTED_SOURCE: path.join(usedSnapshot, "config", "settings.json")
    }
  });

  assert.equal(result.status, 0, result.stderr);
  await access(usedSnapshot);
  await assert.rejects(access(unusedSnapshot), { code: "ENOENT" });

  const retainedOnInspectionFailure = path.join(recoveryRoot, "inspection-failed");
  await mkdir(retainedOnInspectionFailure);
  const failedInspectionResult = spawnSync("bash", ["manor.sh", "start"], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAIL_INSPECT: "1"
    }
  });
  assert.equal(failedInspectionResult.status, 0, failedInspectionResult.stderr);
  await access(retainedOnInspectionFailure);
});

test("update waiter survives activation outage and rejects another run", async (context) => {
  const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "manor-update-")));
  context.after(() => rm(fixture, { recursive: true, force: true }));

  const binDir = path.join(fixture, "bin");
  await mkdir(binDir, { recursive: true });
  await copyFile(updatePath, path.join(fixture, "update.sh"));

  const dockerMock = path.join(binDir, "docker");
  await writeFile(dockerMock, `#!/usr/bin/env bash
if [[ "$1" == "info" || "$1" == "inspect" ]]; then exit 0; fi
if [[ "$1" != "exec" ]]; then exit 1; fi
joined="$*"
if [[ "$joined" == *" node -e "* ]]; then
  field="\${!#}"
  "$REAL_NODE" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      let value = JSON.parse(input);
      for (const key of process.argv[1].split(".")) value = value?.[key];
      if (value !== undefined && value !== null) process.stdout.write(String(value));
    });
  ' "$field"
  exit 0
fi
if [[ "$joined" == *"-X POST"* ]]; then
  printf '%s\\n' '{"run":{"id":"accepted-run"}}'
  exit 0
fi
if [[ "$joined" == *"-X GET"* ]]; then
  count=0
  if [[ -f "$COUNTER_FILE" ]]; then count="$(<"$COUNTER_FILE")"; fi
  count=$((count + 1))
  printf '%s' "$count" > "$COUNTER_FILE"
  if [[ "$FIRST_OUTAGE" == "1" && "$count" == "1" ]]; then exit 1; fi
  printf '{"latestRun":{"id":"%s","status":"completed"}}\\n' "\${MOCK_LATEST_ID:-accepted-run}"
  exit 0
fi
exit 1
`, "utf8");
  await chmod(dockerMock, 0o755);
  const sleepMock = path.join(binDir, "sleep");
  await writeFile(sleepMock, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(sleepMock, 0o755);

  const baseEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    REAL_NODE: process.execPath,
    MANOR_UPDATE_WAIT_TIMEOUT: "30"
  };
  const outageResult = spawnSync("bash", ["update.sh"], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...baseEnv, COUNTER_FILE: path.join(fixture, "outage-count"), FIRST_OUTAGE: "1" }
  });
  assert.equal(outageResult.status, 0, outageResult.stderr);
  assert.match(outageResult.stdout, /Manor restart completed\./);

  const mismatchResult = spawnSync("bash", ["update.sh"], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...baseEnv,
      COUNTER_FILE: path.join(fixture, "mismatch-count"),
      FIRST_OUTAGE: "0",
      MOCK_LATEST_ID: "other-run"
    }
  });
  assert.equal(mismatchResult.status, 1);
  assert.match(mismatchResult.stderr, /result was replaced by another run/);

  const invalidTimeoutResult = spawnSync("bash", ["update.sh"], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...baseEnv, MANOR_UPDATE_WAIT_TIMEOUT: "29" }
  });
  assert.equal(invalidTimeoutResult.status, 64);
  assert.match(invalidTimeoutResult.stderr, /must be between 30 and 3600 seconds/);
});
