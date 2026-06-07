import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompletionTabAlertTitle,
  buildCompletionSoundSnapshot,
  shouldPlayCompletionNotificationSound,
  type CompletionSoundSnapshot
} from "../../src/web/notification-sound.js";
import type { PreviewVerificationArtifact, ShellSnapshot, ThreadStatus } from "../../src/web/types.js";
import { isBrowserOpenableProofArtifact } from "../../src/web/utils.js";

function shellSnapshot(input: {
  butlerBusy?: boolean;
  threads?: Array<{ id: string; status: ThreadStatus }>;
}): ShellSnapshot {
  return {
    butler: {
      pending: input.butlerBusy ?? false,
      isStreaming: input.butlerBusy ?? false
    },
    codex: {
      threads: input.threads ?? []
    }
  } as unknown as ShellSnapshot;
}

function artifact(
  input: Partial<PreviewVerificationArtifact> & Pick<PreviewVerificationArtifact, "fileName" | "contentType">
): PreviewVerificationArtifact {
  return {
    kind: "file",
    label: input.fileName,
    filePath: `/tmp/${input.fileName}`,
    sizeBytes: 10,
    url: `/api/artifacts/${input.fileName}`,
    downloadUrl: `/api/artifacts/${input.fileName}?download=1`,
    availability: "available",
    retainedUntilAt: null,
    expiredAt: null,
    ...input
  };
}

test("completion sound does not play on initial snapshot", () => {
  const current = buildCompletionSoundSnapshot(shellSnapshot({ butlerBusy: true }));

  assert.equal(shouldPlayCompletionNotificationSound(null, current), false);
});

test("completion sound plays when Butler becomes idle", () => {
  const previous: CompletionSoundSnapshot = buildCompletionSoundSnapshot(shellSnapshot({ butlerBusy: true }));
  const current = buildCompletionSoundSnapshot(shellSnapshot({ butlerBusy: false }));

  assert.equal(shouldPlayCompletionNotificationSound(previous, current), true);
});

test("completion sound plays when a Codex thread stops being active", () => {
  const previous = buildCompletionSoundSnapshot(shellSnapshot({ threads: [{ id: "thread-1", status: "active" }] }));
  const current = buildCompletionSoundSnapshot(shellSnapshot({ threads: [{ id: "thread-1", status: "idle" }] }));

  assert.equal(shouldPlayCompletionNotificationSound(previous, current), true);
});

test("completion tab alert title toggles without nesting prefixes", () => {
  assert.equal(buildCompletionTabAlertTitle("Butler", true), "[Done] Butler");
  assert.equal(buildCompletionTabAlertTitle("[Done] Butler", true), "[Done] Butler");
  assert.equal(buildCompletionTabAlertTitle("[Done] Butler", false), "Butler");
});

test("proof artifacts open text-like files inline and keep binary files download-only", () => {
  assert.equal(isBrowserOpenableProofArtifact(artifact({ fileName: "report.json", contentType: "application/json" })), true);
  assert.equal(isBrowserOpenableProofArtifact(artifact({ fileName: "output.log", contentType: "application/octet-stream" })), true);
  assert.equal(isBrowserOpenableProofArtifact(artifact({ fileName: "bundle.zip", contentType: "application/zip" })), false);
});
