import assert from "node:assert/strict";
import test from "node:test";

import { LiveStreamTelemetryStore } from "../../src/server/live-stream-telemetry.js";
import type { ProviderRuntimeLivePatch } from "../../src/shared/provider-runtime.js";

function patch(itemId: string, at = 1_000): ProviderRuntimeLivePatch {
  return {
    kind: "content-delta",
    threadId: "butler",
    turnId: "turn-1",
    itemId,
    itemType: "assistant_message",
    streamKind: "assistant_text",
    delta: "hello",
    itemTextLength: 5,
    at
  };
}

test("live stream telemetry attaches server timing and accepts browser render acks", () => {
  const store = new LiveStreamTelemetryStore();
  const timedPatch = store.attachServerTiming("butlerPatch", patch("message-1"));
  assert.ok(timedPatch.telemetry?.id);
  assert.equal(timedPatch.telemetry.provider, "butler-pi");
  assert.equal(timedPatch.telemetry.providerEventAt, 1_000);
  assert.ok(timedPatch.telemetry.serverReceivedAt <= timedPatch.telemetry.serverSentAt!);

  const serverSentAt = timedPatch.telemetry.serverSentAt!;
  const accepted = store.recordBrowserAcks({
    id: timedPatch.telemetry.id,
    eventName: "butlerPatch",
    browserReceivedAt: serverSentAt + 10,
    browserStateAppliedAt: serverSentAt + 13,
    browserRenderedAt: serverSentAt + 29
  });

  const snapshot = store.getSnapshot();
  assert.equal(accepted, 1);
  assert.equal(snapshot.retainedSamples, 1);
  assert.equal(snapshot.acknowledgedSamples, 1);
  assert.equal(snapshot.metrics.browserApplyMs.p50, 3);
  assert.equal(snapshot.metrics.browserRenderMs.p50, 16);
  assert.equal(snapshot.metrics.browserTotalMs.p50, 19);
  assert.equal(snapshot.recent[0]?.id, timedPatch.telemetry.id);
});

test("live stream telemetry rejects unknown acks and caps retained samples", () => {
  const store = new LiveStreamTelemetryStore(2);
  const first = store.attachServerTiming("butlerPatch", patch("message-1"));
  const second = store.attachServerTiming("butlerPatch", patch("message-2"));
  const third = store.attachServerTiming("butlerPatch", patch("message-3"));

  assert.equal(store.recordBrowserAcks({ id: "missing", browserReceivedAt: 1, browserStateAppliedAt: 2, browserRenderedAt: 3 }), 0);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.retainedSamples, 2);
  assert.equal(snapshot.recent.some((sample) => sample.id === first.telemetry?.id), false);
  assert.equal(snapshot.recent.some((sample) => sample.id === second.telemetry?.id), true);
  assert.equal(snapshot.recent.some((sample) => sample.id === third.telemetry?.id), true);
});
