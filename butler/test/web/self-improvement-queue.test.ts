import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { SelfImprovementQueue } from "../../src/web/SelfImprovementQueue.js";
import type { SelfImprovementQueueResponse } from "../../src/shared/self-improvement.js";

const data: SelfImprovementQueueResponse = {
  eligibility: { enabled: true, sourceCwd: "/repos/manor", reasons: [] },
  requests: [{
    id: "request-1",
    status: "pending",
    trigger: "Worker cannot inspect preview images.",
    symptoms: "Visual review is incomplete.",
    logs: "",
    observations: "The Worker only receives extracted metadata.",
    suspectedCause: "Preview images are isolated from the Worker.",
    proposedChange: "Bridge preview images into the Worker context.",
    risk: "Low.",
    desiredOutcome: "The Worker can complete visual review.",
    operatorContext: null,
    sourceThreadId: null,
    sourceProjectLabel: null,
    createdBy: "butler",
    requestedAt: 1,
    updatedAt: 1,
    dismissedAt: null,
    dismissedReason: null,
    approvedAt: null,
    startedAt: null,
    completedAt: null,
    threadId: null,
    workerThreadIds: [],
    pairId: null,
    workspaceCwd: null,
    branchName: null,
    commitSha: null,
    pullRequestUrl: null
  }]
};

test("pending self-improvement approval offers optional context before approve", () => {
  const markup = renderToStaticMarkup(React.createElement(SelfImprovementQueue, {
    data,
    selectedId: "request-1",
    onReload: async () => undefined,
    onOpenSession: async () => undefined
  }));

  assert.match(markup, /Additional context/);
  assert.match(markup, /Optional/);
  assert.match(markup, /maxLength="8000"/);
  assert.match(markup, /This context will be included in the approved job\./);
  assert.ok(markup.indexOf("self-improvement-operator-context") < markup.indexOf(">Approve<"));
});

test("approval submits the current context and locks the field while starting", async () => {
  const dom = parseHTML("<html><body><div id=\"root\"></div></body></html>");
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = {
    document: globals.document,
    window: globals.window,
    HTMLElement: globals.HTMLElement,
    Event: globals.Event,
    fetch: globals.fetch,
    actEnvironment: globals.IS_REACT_ACT_ENVIRONMENT
  };
  Object.assign(globals, {
    document: dom.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true
  });

  let submittedBody: Record<string, unknown> | null = null;
  let finishReload: (() => void) | null = null;
  const reload = new Promise<void>((resolve) => { finishReload = resolve; });
  globals.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    submittedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return Response.json({ request: { ...data.requests[0], status: "running" } }, { status: 202 });
  };

  const container = dom.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(SelfImprovementQueue, {
        data,
        selectedId: "request-1",
        onReload: () => reload,
        onOpenSession: async () => undefined
      }));
    });
    const textarea = dom.document.querySelector("textarea");
    const approve = dom.document.querySelector(".improve-approval-footer button");
    assert.ok(textarea instanceof dom.window.HTMLTextAreaElement);
    assert.ok(approve instanceof dom.window.HTMLButtonElement);

    await act(async () => {
      textarea.value = "Keep the existing authorization boundary.";
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      textarea.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await act(async () => {
      approve.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });

    assert.deepEqual(submittedBody, { operatorContext: "Keep the existing authorization boundary." });
    assert.equal(textarea.disabled, true);
    finishReload?.();
    await act(async () => { await reload; });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globals, {
      document: previous.document,
      window: previous.window,
      HTMLElement: previous.HTMLElement,
      Event: previous.Event,
      fetch: previous.fetch,
      IS_REACT_ACT_ENVIRONMENT: previous.actEnvironment
    });
  }
});
