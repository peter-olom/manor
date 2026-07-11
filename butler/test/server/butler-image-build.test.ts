import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dockerfilePath = new URL('../../../docker/butler/Dockerfile', import.meta.url);
const startScriptPath = new URL('../../../docker/butler/start.sh', import.meta.url);
const packageJsonPath = new URL('../../package.json', import.meta.url);
const workflowPath = new URL('../../../.github/workflows/publish-images.yml', import.meta.url);

test('Butler image contains locked development dependencies and never installs them at startup', async () => {
  const [dockerfile, startScript, packageJson] = await Promise.all([
    readFile(dockerfilePath, 'utf8'),
    readFile(startScriptPath, 'utf8'),
    readFile(packageJsonPath, 'utf8'),
  ]);
  const manifest = JSON.parse(packageJson) as { dependencies?: Record<string, string> };

  assert.equal(manifest.dependencies?.['@mariozechner/pi-ai'], '0.73.0');
  assert.equal(manifest.dependencies?.['@mariozechner/pi-coding-agent'], '0.73.0');
  assert.match(dockerfile, /FROM --platform=\$BUILDPLATFORM \$\{NODE_BUILD_IMAGE\} AS build/);
  assert.match(dockerfile, /FROM \$\{NODE_BUILD_IMAGE\} AS runtime-deps/);
  assert.match(dockerfile, /RUN --mount=type=cache,target=\/root\/\.npm \\\n\s+npm ci/);
  assert.match(dockerfile, /COPY --from=runtime-deps \/opt\/manor\/butler\/node_modules \.\/node_modules/);
  assert.doesNotMatch(dockerfile, /npm install\s+"@mariozechner\/pi-ai/);
  assert.doesNotMatch(dockerfile, /npm install\s+.*"@mariozechner\/pi-coding-agent/);
  assert.doesNotMatch(startScript, /npm install/);
  assert.doesNotMatch(startScript, /manor-(?:codex|pi)-auto-update/);
});

test('Butler publish job keeps BuildKit cache enabled', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /cache-from: type=gha,scope=\$\{\{ matrix\.image \}\}/);
  assert.match(workflow, /cache-to: type=gha,mode=max,scope=\$\{\{ matrix\.image \}\}/);
});
