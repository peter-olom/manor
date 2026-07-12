import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const controllerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "controller.mjs");
const repoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composePath = path.join(repoPath, "compose.yml");
const composeBuildPath = path.join(repoPath, "compose.build.yml");
const launcherPath = path.join(repoPath, "manor-start");
const lifecyclePath = path.join(repoPath, "manor.sh");
const buildComposePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../compose.build.yml");
const dockerfilePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "Dockerfile");
const activationPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "controller-activation.mjs");

test("source restart preserves the working tree and retries from clean HEAD", async () => {
  const source = await readFile(controllerPath, "utf8");
  const executeRunBody = source.slice(
    source.indexOf("async function executeRun"),
    source.indexOf("function createRun")
  );
  const updateIndex = executeRunBody.indexOf("await updateSource(run)");
  const restartIndex = executeRunBody.indexOf("await restartSourceAppliance(run,");
  const rollbackSnapshotIndex = executeRunBody.indexOf("activationRollbackSource = await prepareControllerRollbackSource(run)");

  assert.ok(updateIndex >= 0);
  assert.ok(rollbackSnapshotIndex >= 0);
  assert.ok(rollbackSnapshotIndex < updateIndex);
  assert.ok(restartIndex > updateIndex);
  assert.doesNotMatch(source, /"git", \["reset", "--hard"\]/);
  assert.doesNotMatch(source, /"git", \["clean", "-fd"\]/);
  assert.doesNotMatch(source, /clearGitWorktree/);
  assert.match(source, /const args = \["compose", "-f", "compose\.yml", "-f", "compose\.build\.yml"\]/);

  const restartBody = source.slice(
    source.indexOf("async function restartSourceAppliance"),
    source.indexOf("async function executeRun")
  );
  assert.match(restartBody, /await buildSourceImages\(run\)/);
  assert.match(restartBody, /await prepareCleanHeadSource\(run\)/);
  assert.match(restartBody, /await buildCleanHeadSourceImages\(run, cleanHead\)/);
  assert.match(restartBody, /await restartAppliance\(run, cleanHead\.compose, cleanHead\.cleanDir\)/);
  assert.match(restartBody, /await cleanupCleanHeadSource\(cleanHead\)/);
  assert.match(restartBody, /if \(cleanHead && !fallbackRunning\)/);
  assert.match(restartBody, /cleanupOtherCleanHeadSources\(\[cleanHead\.cleanDir, controllerRollbackDir\]\.filter\(Boolean\)\)/);
  assert.match(restartBody, /run\.hotReload = false/);
  assert.match(restartBody, /return run\.build !== false/);
  assert.match(restartBody, /return false/);

  const fallbackBody = source.slice(
    source.indexOf("async function prepareCleanHeadSource"),
    source.indexOf("async function restartAppliance")
  );
  assert.match(fallbackBody, /"git", \["archive", "--format=tar", `--output=\$\{archivePath\}`, "HEAD"\]/);
  assert.match(fallbackBody, /path\.join\(manorDir, "state", "host-controller"\)/);
  assert.match(fallbackBody, /"Build clean HEAD source images"/);
  assert.match(fallbackBody, /fs\.rm\(cleanDir, \{ recursive: true, force: true \}\)/);
  assert.match(source, /async function prepareControllerRollbackSource/);
  assert.match(source, /JSON\.parse\(await commandOutput\("docker", \["inspect", "manor-host-controller"\], 1_000_000\)\)/);
  assert.match(source, /container\.Config\.Env/);
  assert.match(source, /environment\[key\] = `\\\$\{\$\{key\}\}`/);
  assert.doesNotMatch(source, /environment\[entry\.slice\(0, separator\)\] = entry\.slice\(separator \+ 1\)/);
  assert.match(source, /container\.NetworkSettings\?\.Networks/);
  assert.match(source, /container\.Mounts/);
  assert.match(source, /controller-rollback\.override\.json/);
  assert.match(source, /mode: 0o600/);
  assert.match(source, /rollbackSource\.compose\.push\("-f", overridePath\)/);
});

test("source restart stays active until the rebuilt controller confirms health", async () => {
  const [source, activation, buildCompose, dockerfile] = await Promise.all([
    readFile(controllerPath, "utf8"),
    readFile(activationPath, "utf8"),
    readFile(buildComposePath, "utf8"),
    readFile(dockerfilePath, "utf8")
  ]);
  const buildBody = source.slice(
    source.indexOf("async function buildSourceImages"),
    source.indexOf("async function activeEnvFileArgs")
  );
  const cleanHeadBuildBody = source.slice(
    source.indexOf("async function buildCleanHeadSourceImages"),
    source.indexOf("async function restartAppliance")
  );
  const executeBody = source.slice(
    source.indexOf("async function executeRun"),
    source.indexOf("function createRun")
  );
  const scheduleBody = source.slice(
    source.indexOf("async function scheduleHostControllerActivation"),
    source.indexOf("async function cleanupStaleReplacementContainers")
  );
  assert.match(source, /const sourceBuildServices = \[\.\.\.applianceServices, "host-controller"\]/);
  assert.match(buildBody, /"build",\s+\.\.\.sourceBuildServices/);
  assert.match(buildBody, /run\.includeDesktop \? \["desktop-proof"\] : \[\]/);
  assert.match(cleanHeadBuildBody, /run\.includeDesktop \? \["desktop-proof"\] : \[\]/);
  assert.match(executeBody, /activateHostController = await restartSourceAppliance\(run, activationRollbackSource\?\.cleanDir \?\? null\)/);
  assert.match(executeBody, /await scheduleHostControllerActivation\(run, activationRollbackSource\)/);
  assert.match(executeBody, /if \(activateHostController\)[\s\S]*else \{[\s\S]*run\.status = "completed"/);
  assert.match(scheduleBody, /"--force-recreate"/);
  assert.match(scheduleBody, /"--wait"/);
  assert.match(scheduleBody, /"--restart",\s+"unless-stopped"/);
  assert.doesNotMatch(scheduleBody, /"--rm"/);
  assert.match(scheduleBody, /\.\.\.rollbackSource\.compose/);
  assert.match(scheduleBody, /controllerActivationPending = true/);
  assert.match(scheduleBody, /controllerActivationImage = desiredImage/);
  assert.match(scheduleBody, /"--entrypoint",\s+"node",\s+rollbackImage,\s+"\/opt\/manor\/host-controller\/controller-activation\.mjs"/);
  assert.match(scheduleBody, /controllerActivationDeadline = now\(\) \+ \(restartWaitTimeoutSeconds \+ 60\) \* 1000/);
  assert.match(scheduleBody, /`\$\{stateVolume\}:\/state`/);
  assert.match(scheduleBody, /"--network",\s+controlNetwork/);
  assert.match(scheduleBody, /`com\.manor\.restart-run=\$\{run\.id\}`/);
  assert.match(source, /const lifecycleLockName = `\$\{composeProjectName\}_lifecycle-lock`/);
  assert.match(source, /async function acquireLifecycleLock/);
  assert.match(source, /async function acquireLifecycleLock\(run, previousLatestRun = null\)/);
  assert.match(source, /com\.manor\.lifecycle-lock=1/);
  assert.match(source, /com\.manor\.lifecycle-created/);
  assert.match(source, /owner\?\.startsWith\("host-"\)/);
  assert.match(source, /hostLifecycleHeartbeatStatus/);
  assert.match(source, /lifecycleHostLeaseDir/);
  assert.match(source, /heartbeatStatus === "stale"/);
  assert.match(source, /removeHostLifecycleHeartbeats/);
  assert.match(source, /acquireLifecycleTakeoverGuard/);
  assert.match(source, /releaseLifecycleTakeoverGuard/);
  assert.match(source, /Lifecycle lock ownership changed during takeover/);
  assert.match(source, /lifecycleTakeoverDir/);
  assert.match(source, /fs\.chmod\(lifecycleTakeoverRoot, 0o777\)/);
  assert.match(source, /fs\.chown\(sharedStateRoot, hostUid, hostGid\)/);
  assert.match(source, /\.stale\.\$\{token\}/);
  assert.match(source, /async function releaseLifecycleLock/);
  assert.match(source, /async function reconcileOrphanLifecycleLock/);
  assert.match(source, /await reconcileOrphanLifecycleLock\(\)/);
  assert.match(source, /owner === previousLatestRun\?\.id/);
  assert.match(source, /await acquireLifecycleLock\(run, previousLatestRun\)/);
  assert.match(source, /async function withRestartAdmission/);
  const restartRoute = source.slice(source.indexOf('app.post("/restart"'), source.indexOf('app.post("/activation/complete"'));
  assert.match(restartRoute, /await withRestartAdmission/);
  assert.ok(restartRoute.indexOf("latestRun = run") < restartRoute.indexOf("await persist()"));
  assert.ok(restartRoute.indexOf("await persist()") < restartRoute.indexOf("await acquireLifecycleLock(run, previousLatestRun)"));
  assert.match(scheduleBody, /controller-activation\.mjs/);
  assert.match(scheduleBody, /"host-controller"/);
  assert.match(source, /app\.post\("\/activation\/complete"/);
  assert.match(source, /running\.image !== run\.controllerActivationImage/);
  assert.match(source, /run\.controllerActivationRollingBack === true/);
  assert.match(source, /running\.projectDir !== manorDir/);
  assert.match(source, /running\.projectDir === run\.controllerActivationRollbackProjectDir/);
  assert.match(source, /latestRun\.status === "completed" && latestRun\.controllerActivationPending !== true/);
  assert.match(source, /reconcilePendingActivation/);
  assert.match(source, /`label=com\.manor\.restart-run=\$\{run\.id\}`/);
  assert.match(source, /persisted\.latestRun\.status === "failed"/);
  assert.match(source, /persisted\.latestRun\.controllerActivationRollingBack === true/);
  assert.match(source, /failExpiredActivation/);
  assert.match(source, /markActivationRollbackStarting/);
  assert.match(source, /controllerActivationRollingBack/);
  assert.match(source, /fs\.rename\(nextStatePath, statePath\)/);
  assert.match(activation, /if \(docker\(desiredArgs\) === 0\)/);
  assert.match(activation, /AbortSignal\.timeout\(2000\)/);
  assert.match(activation, /state\.latestRun\.status === "completed"/);
  assert.match(activation, /activationNoLongerNeedsRollback/);
  const noRollbackBody = activation.slice(
    activation.indexOf("async function activationNoLongerNeedsRollback"),
    activation.indexOf("async function reportRollbackStarting")
  );
  assert.doesNotMatch(noRollbackBody, /status === "failed"/);
  assert.match(noRollbackBody, /run\.id === runId && run\.status === "completed"/);
  assert.match(activation, /\/activation\/fail/);
  assert.match(activation, /\/activation\/rollback/);
  assert.match(activation, /docker\(\["update", "--restart=no", helperName\]\)/);
  assert.match(activation, /initialState\.controllerActivationRollingBack === true/);
  assert.match(activation, /initialState\.status === "failed" \|\| initialState\.controllerActivationRollingBack === true/);
  assert.match(activation, /!initialState \|\| initialState\.id !== runId \|\| initialState\.status === "failed"/);
  assert.match(activation, /!await reportRollbackStarting\(rollbackMessage\) && await activationNoLongerNeedsRollback\(\)/);
  assert.match(activation, /controllerActivationDeadline = Date\.now\(\) \+ \(rollbackWaitSeconds \+ 60\) \* 1000/);
  assert.match(activation, /\["tag", rollbackImage, "manor-host-controller:local"\]/);
  assert.match(activation, /docker\(rollbackArgs\)/);
  assert.match(activation, /performRollback\(JSON\.parse\(rollbackJson\)\)/);
  assert.match(activation, /\/activation\/complete/);
  assert.doesNotMatch(buildCompose, /controller\.mjs:\/opt\/manor\/host-controller\/controller\.mjs/);
  assert.match(dockerfile, /node --check \/opt\/manor\/host-controller\/controller\.mjs/);
  assert.match(dockerfile, /node --check \/opt\/manor\/host-controller\/controller-policy\.mjs/);
  assert.match(dockerfile, /node --check \/opt\/manor\/host-controller\/controller-activation\.mjs/);
});

test("source restart checks local target refs before fetching", async () => {
  const source = await readFile(controllerPath, "utf8");
  const updateSourceBody = source.slice(
    source.indexOf("async function updateSource"),
    source.indexOf("async function updateImage")
  );
  const localCheckIndex = updateSourceBody.indexOf("await localGitRefExists(run.gitRef)");
  const localCheckoutIndex = updateSourceBody.indexOf("\"Checkout local target ref\"");
  const fetchIndex = updateSourceBody.indexOf("\"Fetch source refs\"");

  assert.ok(localCheckIndex >= 0);
  assert.ok(localCheckoutIndex > localCheckIndex);
  assert.ok(fetchIndex > localCheckoutIndex);
  assert.match(source, /"git", \["rev-parse", "--verify", "--quiet", `\$\{gitRef\}\^\{commit\}`\]/);
  assert.match(source, /http\.proxy=http:\/\/egress:3128/);
  assert.match(source, /url\.https:\/\/github\.com\/\.insteadOf=git@github\.com:/);
});

test("host controller compose commands use the Manor project name", async () => {
  const source = await readFile(controllerPath, "utf8");
  const commandEnvBody = source.slice(
    source.indexOf("function commandEnv"),
    source.indexOf("async function runStep")
  );

  assert.match(source, /const composeProjectName = process\.env\.MANOR_COMPOSE_PROJECT_NAME \?\? process\.env\.COMPOSE_PROJECT_NAME \?\? "manor"/);
  assert.match(commandEnvBody, /COMPOSE_PROJECT_NAME: composeProjectName/);
});

test("host controller receives every Compose override needed for later restarts", async () => {
  const composeSource = await readFile(composePath, "utf8");
  const buildSource = await readFile(composeBuildPath, "utf8");
  const hostController = composeSource.slice(composeSource.lastIndexOf("\n  host-controller:"), composeSource.indexOf("\n  playwright:"));
  const environment = hostController.slice(hostController.indexOf("\n    environment:"), hostController.indexOf("\n    volumes:"));
  const interpolated = new Set([...`${composeSource}\n${buildSource}`.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]));
  const forwarded = new Set([...environment.matchAll(/^\s{6}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]));
  const missing = [...interpolated].filter((variable) => variable !== "PWD" && !forwarded.has(variable)).sort();

  assert.deepEqual(missing, []);
  assert.ok(forwarded.has("MANOR_HOST_PROJECT_SOURCE_DIR"));
  assert.ok(forwarded.has("COMPOSE_PROJECT_NAME"));
  assert.ok(forwarded.has("MANOR_COMPOSE_PROJECT_NAME"));
  assert.ok(forwarded.has("MANOR_HOST_RESTART_DELAY_MS"));
  assert.match(hostController, /networks:\n\s+- control\n\s+- work/);
});

test("canonical launcher recovers dirty-source startup from clean HEAD without resetting files", async () => {
  const launcher = await readFile(launcherPath, "utf8");
  const lifecycle = await readFile(lifecyclePath, "utf8");

  assert.match(launcher, /exec "\$\{repo_dir\}\/manor\.sh"/);
  assert.match(lifecycle, /git status --porcelain --untracked-files=normal/);
  assert.match(lifecycle, /git archive --format=tar HEAD/);
  assert.match(lifecycle, /--project-directory "\$\{clean_dir\}"/);
  assert.match(lifecycle, /clean_compose\[@\].*recovery_args\[@\]/s);
  assert.doesNotMatch(lifecycle, /run_base_compose/);
  assert.doesNotMatch(lifecycle, /git reset/);
  assert.doesNotMatch(lifecycle, /git clean/);
});
