import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useEffect, useState } from "react";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";

import { useManorRestartApproval } from "../../src/web/useManorRestartApproval.js";
import type { ManorRestartProgressView } from "../../src/shared/manor-restart.js";
import type { PairDetail } from "../../src/shared/pairing.js";

function pair(id: string): PairDetail {
  return { id, pendingManorRestartRequest: null } as PairDetail;
}

function progress(status: ManorRestartProgressView["status"], runId: string): ManorRestartProgressView {
  return {
    requestId: `request-${runId}`,
    runId,
    startedAt: 1,
    status,
    completedAt: status === "completed" ? 2 : null,
    currentStep: null,
    error: status === "failed" ? "The host controller could not complete the restart." : null
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => { resolve = next; });
  return { promise, resolve };
}

function Harness({ selected }: { selected: PairDetail }) {
  const [activePair, setActivePair] = useState<PairDetail | null>(selected);
  useEffect(() => setActivePair(selected), [selected]);
  const { dialog } = useManorRestartApproval(activePair, setActivePair, { connected: true, hasConnected: true });
  return <>{dialog}</>;
}

async function withDom(run: (dom: ReturnType<typeof parseHTML>, root: ReturnType<typeof createRoot>) => Promise<void>) {
  const dom = parseHTML("<html><body><div id=root></div></body></html>");
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = {
    document: globals.document,
    window: globals.window,
    HTMLElement: globals.HTMLElement,
    fetch: globals.fetch,
    actEnvironment: globals.IS_REACT_ACT_ENVIRONMENT
  };
  Object.assign(dom.window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    cancelAnimationFrame: () => undefined
  });
  Object.assign(globals, {
    document: dom.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  });
  const container = dom.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await run(dom, root);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globals, previous);
  }
}

test("restart progress ignores a late response from the previously selected pair", async () => {
  await withDom(async (dom, root) => {
    const pairA = deferredResponse();
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async (input) => {
      const url = String(input);
      if (url.includes("pair-a")) return pairA.promise;
      if (url.includes("pair-b")) return Response.json({ progress: progress("completed", "run-b") });
      throw new Error(`Unexpected request: ${url}`);
    };

    await act(async () => root.render(<Harness selected={pair("pair-a")} />));
    await act(async () => root.render(<Harness selected={pair("pair-b")} />));
    assert.match(dom.document.body.textContent, /Manor restarted/);

    await act(async () => pairA.resolve(Response.json({ progress: progress("failed", "run-a") })));
    assert.match(dom.document.body.textContent, /Manor restarted/);
    assert.doesNotMatch(dom.document.body.textContent, /Restart failed/);
  });
});

test("restart progress ignores an older overlapping status response", async () => {
  await withDom(async (dom, root) => {
    const older = deferredResponse();
    const newer = deferredResponse();
    let calls = 0;
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = async () => {
      calls += 1;
      if (calls === 1) return Response.json({ progress: progress("unconfirmed", "run-1") });
      if (calls === 2) return older.promise;
      if (calls === 3) return newer.promise;
      throw new Error(`Unexpected progress call ${calls}`);
    };

    await act(async () => root.render(<Harness selected={pair("pair-1")} />));
    const retry = [...dom.document.querySelectorAll("button")].find((button) => button.textContent === "Check again");
    assert.ok(retry);
    await act(async () => {
      retry.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
      retry.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    });

    await act(async () => newer.resolve(Response.json({ progress: progress("completed", "run-1") })));
    assert.match(dom.document.body.textContent, /Manor restarted/);
    await act(async () => older.resolve(Response.json({ progress: progress("running", "run-1") })));
    assert.match(dom.document.body.textContent, /Manor restarted/);
  });
});
