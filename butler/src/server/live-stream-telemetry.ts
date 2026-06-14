import crypto from "node:crypto";

import type { ProviderRuntimeLivePatch, ProviderRuntimePatchTelemetry } from "../shared/provider-runtime.js";

type LiveStreamEventName = "butlerPatch";

export type LiveStreamTelemetryBrowserAck = {
  id: string;
  eventName?: LiveStreamEventName;
  browserReceivedAt: number;
  browserStateAppliedAt: number;
  browserRenderedAt: number;
};

export type LiveStreamTelemetrySample = {
  id: string;
  eventName: LiveStreamEventName;
  patchKind: ProviderRuntimeLivePatch["kind"];
  itemType: string | null;
  streamKind: string | null;
  provider: string;
  providerEventAt: number;
  serverReceivedAt: number;
  serverSentAt: number;
  browserReceivedAt: number | null;
  browserStateAppliedAt: number | null;
  browserRenderedAt: number | null;
};

export type LiveStreamMetricSummary = {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

export type LiveStreamTelemetrySnapshot = {
  generatedAt: number;
  retainedSamples: number;
  acknowledgedSamples: number;
  metrics: {
    serverQueueMs: LiveStreamMetricSummary;
    browserApplyMs: LiveStreamMetricSummary;
    browserRenderMs: LiveStreamMetricSummary;
    browserTotalMs: LiveStreamMetricSummary;
    approximateEndToEndMs: LiveStreamMetricSummary;
    browserClockOffsetMs: LiveStreamMetricSummary;
  };
  recent: LiveStreamTelemetrySample[];
};

type TelemetryInput = Omit<ProviderRuntimePatchTelemetry, "id"> & { id?: string };

const DEFAULT_SAMPLE_LIMIT = 600;
const RECENT_SAMPLE_LIMIT = 80;

function metric(values: number[]): LiveStreamMetricSummary {
  const finiteValues = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (finiteValues.length === 0) {
    return { count: 0, p50: null, p95: null, max: null };
  }

  const percentile = (ratio: number) => finiteValues[Math.min(finiteValues.length - 1, Math.floor((finiteValues.length - 1) * ratio))]!;
  return {
    count: finiteValues.length,
    p50: Math.round(percentile(0.5)),
    p95: Math.round(percentile(0.95)),
    max: Math.round(finiteValues[finiteValues.length - 1]!)
  };
}

function itemType(patch: ProviderRuntimeLivePatch): string | null {
  return "itemType" in patch ? patch.itemType : null;
}

function streamKind(patch: ProviderRuntimeLivePatch): string | null {
  return patch.kind === "content-delta" ? patch.streamKind : null;
}

function normalizeAck(input: unknown): LiveStreamTelemetryBrowserAck | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Partial<LiveStreamTelemetryBrowserAck>;
  if (
    typeof candidate.id !== "string" ||
    !Number.isFinite(candidate.browserReceivedAt) ||
    !Number.isFinite(candidate.browserStateAppliedAt) ||
    !Number.isFinite(candidate.browserRenderedAt)
  ) {
    return null;
  }
  return {
    id: candidate.id,
    eventName: candidate.eventName === "butlerPatch" ? candidate.eventName : undefined,
    browserReceivedAt: Number(candidate.browserReceivedAt),
    browserStateAppliedAt: Number(candidate.browserStateAppliedAt),
    browserRenderedAt: Number(candidate.browserRenderedAt)
  };
}

export class LiveStreamTelemetryStore {
  private readonly samples = new Map<string, LiveStreamTelemetrySample>();
  private readonly sampleOrder: string[] = [];

  constructor(private readonly sampleLimit = DEFAULT_SAMPLE_LIMIT) {}

  attachServerTiming(eventName: LiveStreamEventName, patch: ProviderRuntimeLivePatch): ProviderRuntimeLivePatch {
    const telemetry = this.buildTelemetry(patch.telemetry, patch.at);
    const serverSentAt = Date.now();
    const nextTelemetry: ProviderRuntimePatchTelemetry = { ...telemetry, serverSentAt };
    const sample: LiveStreamTelemetrySample = {
      id: nextTelemetry.id,
      eventName,
      patchKind: patch.kind,
      itemType: itemType(patch),
      streamKind: streamKind(patch),
      provider: nextTelemetry.provider,
      providerEventAt: nextTelemetry.providerEventAt,
      serverReceivedAt: nextTelemetry.serverReceivedAt,
      serverSentAt,
      browserReceivedAt: null,
      browserStateAppliedAt: null,
      browserRenderedAt: null
    };
    this.setSample(sample);
    return { ...patch, telemetry: nextTelemetry } as ProviderRuntimeLivePatch;
  }

  recordBrowserAcks(input: unknown): number {
    const rawAcks = Array.isArray(input) ? input : [input];
    let accepted = 0;
    for (const rawAck of rawAcks) {
      const ack = normalizeAck(rawAck);
      if (!ack) {
        continue;
      }
      const sample = this.samples.get(ack.id);
      if (!sample || (ack.eventName && ack.eventName !== sample.eventName)) {
        continue;
      }
      this.samples.set(ack.id, {
        ...sample,
        browserReceivedAt: ack.browserReceivedAt,
        browserStateAppliedAt: ack.browserStateAppliedAt,
        browserRenderedAt: ack.browserRenderedAt
      });
      accepted += 1;
    }
    return accepted;
  }

  getSnapshot(): LiveStreamTelemetrySnapshot {
    const samples = this.sampleOrder.map((id) => this.samples.get(id)).filter((sample): sample is LiveStreamTelemetrySample => Boolean(sample));
    const acknowledgedSamples = samples.filter((sample) => sample.browserRenderedAt !== null);
    return {
      generatedAt: Date.now(),
      retainedSamples: samples.length,
      acknowledgedSamples: acknowledgedSamples.length,
      metrics: {
        serverQueueMs: metric(samples.map((sample) => sample.serverSentAt - sample.serverReceivedAt)),
        browserApplyMs: metric(acknowledgedSamples.map((sample) => sample.browserStateAppliedAt! - sample.browserReceivedAt!)),
        browserRenderMs: metric(acknowledgedSamples.map((sample) => sample.browserRenderedAt! - sample.browserStateAppliedAt!)),
        browserTotalMs: metric(acknowledgedSamples.map((sample) => sample.browserRenderedAt! - sample.browserReceivedAt!)),
        approximateEndToEndMs: metric(acknowledgedSamples.map((sample) => sample.browserRenderedAt! - sample.providerEventAt)),
        browserClockOffsetMs: metric(acknowledgedSamples.map((sample) => sample.browserReceivedAt! - sample.serverSentAt))
      },
      recent: samples.slice(-RECENT_SAMPLE_LIMIT)
    };
  }

  private buildTelemetry(input: TelemetryInput | undefined, fallbackAt: number): ProviderRuntimePatchTelemetry {
    const now = Date.now();
    return {
      id: input?.id ?? crypto.randomUUID(),
      provider: input?.provider ?? "butler-pi",
      providerEventAt: Number.isFinite(input?.providerEventAt) ? input!.providerEventAt : fallbackAt,
      serverReceivedAt: Number.isFinite(input?.serverReceivedAt) ? input!.serverReceivedAt : now,
      ...(Number.isFinite(input?.serverSentAt) ? { serverSentAt: input!.serverSentAt } : {})
    };
  }

  private setSample(sample: LiveStreamTelemetrySample): void {
    if (!this.samples.has(sample.id)) {
      this.sampleOrder.push(sample.id);
    }
    this.samples.set(sample.id, sample);
    while (this.sampleOrder.length > this.sampleLimit) {
      const oldest = this.sampleOrder.shift();
      if (oldest) {
        this.samples.delete(oldest);
      }
    }
  }
}
