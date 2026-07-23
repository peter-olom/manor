import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dockerfilePath = new URL('../../../docker/butler/Dockerfile', import.meta.url);
const startScriptPath = new URL('../../../docker/butler/start.sh', import.meta.url);
const packageJsonPath = new URL('../../package.json', import.meta.url);
const composePath = new URL('../../../compose.yml', import.meta.url);

test('Butler image contains locked development dependencies and never installs them at startup', async () => {
  const [dockerfile, startScript, packageJson] = await Promise.all([
    readFile(dockerfilePath, 'utf8'),
    readFile(startScriptPath, 'utf8'),
    readFile(packageJsonPath, 'utf8'),
  ]);
  const manifest = JSON.parse(packageJson) as { dependencies?: Record<string, string> };

  assert.equal(manifest.dependencies?.['@earendil-works/pi-ai'], '0.80.6');
  assert.equal(manifest.dependencies?.['@earendil-works/pi-coding-agent'], '0.80.6');
  assert.match(dockerfile, /FROM --platform=\$BUILDPLATFORM \$\{NODE_BUILD_IMAGE\} AS build/);
  assert.match(dockerfile, /FROM \$\{NODE_BUILD_IMAGE\} AS runtime-deps/);
  assert.match(dockerfile, /RUN --mount=type=cache,target=\/root\/\.npm \\\n\s+npm ci/);
  assert.match(dockerfile, /COPY --chown=butler:butler --from=runtime-deps \/opt\/manor\/butler\/node_modules \.\/node_modules/);
  assert.doesNotMatch(dockerfile, /npm install\s+"@mariozechner\/pi-ai/);
  assert.doesNotMatch(dockerfile, /npm install\s+.*"@mariozechner\/pi-coding-agent/);
  assert.doesNotMatch(startScript, /npm install/);
  assert.doesNotMatch(startScript, /manor-(?:codex|pi)-auto-update/);
});

test('Manor appliance images are local source builds', async () => {
  const compose = await readFile(composePath, 'utf8');

  assert.doesNotMatch(compose, /ghcr\.io\/peter-olom\/manor-/);
  assert.doesNotMatch(compose, /MANOR_IMAGE_(?:REGISTRY|TAG)/);
  assert.equal((compose.match(/image: manor-[a-z-]+:local/g) ?? []).length, 10);
});

test('Worker cannot mutate Butler-owned durable artifacts directly', async () => {
  const compose = await readFile(composePath, 'utf8');
  const workerService = compose.match(/\n  worker:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]*:\n)/)?.[1] ?? '';

  assert.match(workerService, /\n      - artifacts:\/artifacts:ro\n/);
});
