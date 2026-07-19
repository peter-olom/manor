import assert from "node:assert/strict";
import { test } from "node:test";

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

import { SessionControlsButton, WorkerCompactionStatus } from "../../src/web/WorkerSessionControls.js";

test("Butler sessions expose an explicitly labelled session controls entry point", () => {
  const markup = renderToStaticMarkup(React.createElement(SessionControlsButton, {
    pairId: "pair-1",
    lane: "butler",
    disabled: false
  }));
  assert.match(markup, /class="icon-button"/);
  assert.match(markup, /aria-label="Butler session controls"/);
  assert.match(markup, /title="Butler session controls"/);
  assert.doesNotMatch(markup, />Session controls</);
  assert.doesNotMatch(markup, /disabled/);
});

test("Worker compaction status explains progress, success, and real failure", () => {
  const running = renderToStaticMarkup(React.createElement(WorkerCompactionStatus, {
    operation: { id: "one", status: "running", startedAt: 1, completedAt: null, error: null },
    runtimeCompacting: true
  }));
  assert.match(running, /Compacting context/);
  assert.match(running, /several minutes/);

  const completed = renderToStaticMarkup(React.createElement(WorkerCompactionStatus, {
    operation: { id: "one", status: "completed", startedAt: 1, completedAt: 2, error: null },
    runtimeCompacting: false
  }));
  assert.match(completed, /Context compacted successfully/);

  const failed = renderToStaticMarkup(React.createElement(WorkerCompactionStatus, {
    operation: { id: "one", status: "failed", startedAt: 1, completedAt: 2, error: "Provider unavailable" },
    runtimeCompacting: false
  }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Provider unavailable/);
});

test("Worker compaction switches to lightweight status polling after acceptance", async () => {
  const originalDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>([
    ["window", Object.getOwnPropertyDescriptor(globalThis, "window")],
    ["document", Object.getOwnPropertyDescriptor(globalThis, "document")],
    ["fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
    ["IS_REACT_ACT_ENVIRONMENT", Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")]
  ]);
  const setGlobal = (key: PropertyKey, value: unknown) => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const dom = parseHTML("<html><body><div id=\"root\"></div></body></html>");
  const requests: Array<{ method: string; url: string }> = [];
  const operation = { id: "compact-1", status: "starting" as const, startedAt: 1, completedAt: null, error: null };
  const controls = {
    threadId: "worker-1",
    busy: false,
    compacting: false,
    autoCompactionEnabled: true,
    pendingMessageCount: 0,
    manualCompaction: null,
    sessionName: null,
    stats: null,
    forkPoints: [],
    diagnostics: null
  };
  setGlobal("window", dom.window);
  setGlobal("document", dom.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (method === "POST") return Response.json({ ok: true, operation }, { status: 202 });
    if (url.endsWith("/compaction")) return Response.json({ operation });
    return Response.json({ controls });
  });
  const container = dom.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(React.createElement(SessionControlsButton, { pairId: "pair-1", lane: "worker", disabled: false }));
    });
    const trigger = dom.document.querySelector('button[aria-label="Worker session controls"]') as HTMLButtonElement | null;
    assert.ok(trigger);
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    const compact = [...dom.document.querySelectorAll("button")].find((button) => button.textContent === "Compact now") as HTMLButtonElement | undefined;
    assert.ok(compact);
    await act(async () => {
      compact.click();
      await Promise.resolve();
    });

    assert.equal(requests.filter(({ method }) => method === "POST").length, 1);
    assert.equal(requests.filter(({ method, url }) => method === "GET" && url.endsWith("/worker/controls")).length, 1);
    assert.match(container.textContent ?? "", /Starting context compaction/);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<PropertyKey, unknown>)[key];
    }
  }
});

test("Butler compaction reloads controls after synchronous completion", async () => {
  const originalDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>([
    ["window", Object.getOwnPropertyDescriptor(globalThis, "window")],
    ["document", Object.getOwnPropertyDescriptor(globalThis, "document")],
    ["fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
    ["IS_REACT_ACT_ENVIRONMENT", Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")]
  ]);
  const setGlobal = (key: PropertyKey, value: unknown) => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const dom = parseHTML("<html><body><div id=\"root\"></div></body></html>");
  let controlLoads = 0;
  const controls = {
    threadId: "butler-1",
    busy: false,
    compacting: false,
    autoCompactionEnabled: true,
    pendingMessageCount: 0,
    manualCompaction: null,
    sessionName: null,
    stats: null,
    forkPoints: [],
    diagnostics: null
  };
  setGlobal("window", dom.window);
  setGlobal("document", dom.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") return Response.json({ ok: true });
    controlLoads += 1;
    return Response.json({ controls });
  });
  const container = dom.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(React.createElement(SessionControlsButton, { pairId: "pair-1", lane: "butler", disabled: false }));
    });
    const trigger = dom.document.querySelector('button[aria-label="Butler session controls"]') as HTMLButtonElement | null;
    assert.ok(trigger);
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    const compact = [...dom.document.querySelectorAll("button")].find((button) => button.textContent === "Compact now") as HTMLButtonElement | undefined;
    assert.ok(compact);
    await act(async () => {
      compact.click();
      await Promise.resolve();
    });
    assert.equal(controlLoads, 2);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<PropertyKey, unknown>)[key];
    }
  }
});
