import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ActivityOnlyBubble, durableActivitySupersedesLive, ReviewActivityBubble, WorkLoaderBubble } from "../../src/web/ButlerPane.js";
import { ThinkingTrace } from "../../src/web/ThinkingTrace.js";
import { applyPatchToState, type LiveTurnState } from "../../src/web/useLiveButlerTurn.js";

const idle: LiveTurnState = {
  turnId: "turn-1",
  items: new Map(),
  assistantItemId: null,
  assistantText: "",
  status: "streaming",
  startedAt: 100,
  completedAt: null
};

const disconnected: LiveTurnState = {
  turnId: null,
  items: new Map(),
  assistantItemId: null,
  assistantText: "",
  status: "idle",
  startedAt: null,
  completedAt: null
};

test("the first tool lifecycle patch after reconnect is retained", () => {
  const next = applyPatchToState(disconnected, {
    kind: "item-lifecycle",
    threadId: "butler:pair-1",
    turnId: "turn-reconnected",
    itemId: "tool-1",
    itemType: "dynamic_tool_call",
    status: "in_progress",
    title: "inspect_filesystem",
    text: "path: /repos",
    at: 200
  }, () => undefined);

  assert.equal(next.turnId, "turn-reconnected");
  assert.equal(next.status, "streaming");
  assert.deepEqual([...next.items.values()].map((item) => ({ title: item.title, text: item.text, status: item.status })), [{
    title: "inspect_filesystem",
    text: "path: /repos",
    status: "in_progress"
  }]);
});

test("the first reasoning delta after reconnect is retained", () => {
  const next = applyPatchToState(disconnected, {
    kind: "content-delta",
    threadId: "butler:pair-1",
    turnId: "turn-reconnected",
    itemId: "thinking-1",
    itemType: "reasoning",
    streamKind: "reasoning_text",
    delta: "Checking the current state. ",
    itemTextLength: 28,
    at: 210
  }, () => undefined);

  assert.equal(next.turnId, "turn-reconnected");
  assert.equal(next.status, "streaming");
  assert.equal(next.items.get("thinking-1")?.text, "Checking the current state. ");
  assert.equal(next.items.get("thinking-1")?.status, "in_progress");
});

test("runtime errors become visible failed trace items", () => {
  const next = applyPatchToState(idle, {
    kind: "runtime-message",
    threadId: "butler:pair-1",
    tone: "error",
    message: "Provider request failed after retry: invalid tool schema",
    at: 200
  }, () => undefined);

  assert.equal(next.status, "failed");
  assert.deepEqual([...next.items.values()].map((item) => ({ type: item.type, status: item.status, text: item.text })), [{
    type: "error",
    status: "failed",
    text: "Provider request failed after retry: invalid tool schema"
  }]);
});

test("failed tool traces expand their exact diagnostics", () => {
  const markup = renderToStaticMarkup(React.createElement(ThinkingTrace, { items: [{
    id: "tool-1",
    type: "dynamic_tool_call",
    status: "failed",
    title: "ask_operator",
    text: "Schema validation failed: questions[0].options is required",
    at: 100,
    completedAt: 200
  }] }));

  assert.match(markup, /<details[^>]*open/);
  assert.match(markup, /Schema validation failed: questions\[0\]\.options is required/);
});

test("durable failed Butler activity renders its terminal state and exact detail", () => {
  const markup = renderToStaticMarkup(React.createElement(WorkLoaderBubble, {
    failed: true,
    detail: "Provider rejected the tool schema at questions[0].options",
    startedAt: 100,
    lastUpdateAt: 250,
    items: [{
      id: "tool-1",
      type: "dynamic_tool_call",
      status: "failed",
      title: "ask_operator",
      text: "questions[0].options is required",
      at: 120,
      completedAt: 250
    }]
  }));

  assert.match(markup, /Butler stopped with an error/);
  assert.match(markup, /Exact failure details/);
  assert.match(markup, /Provider rejected the tool schema/);
  assert.match(markup, /questions\[0\]\.options is required/);
});

test("durable interrupted Butler activity renders as stopped after reload", () => {
  const markup = renderToStaticMarkup(React.createElement(ActivityOnlyBubble, {
    trace: null,
    outcome: {
      status: "interrupted",
      startedAt: 100,
      completedAt: 200,
      detail: "Butler was stopped by the operator."
    }
  }));

  assert.match(markup, /aria-label="Stopped Butler activity"/);
  assert.match(markup, />stopped</);
  assert.match(markup, /Butler was stopped by the operator/);
  assert.doesNotMatch(markup, />complete</);
});

test("a polled terminal outcome supersedes a stale streaming patch after reconnect", () => {
  assert.equal(durableActivitySupersedesLive("streaming", 100, {
    status: "failed",
    startedAt: 100,
    completedAt: 200,
    detail: "Provider failed."
  }), true);
  assert.equal(durableActivitySupersedesLive("streaming", 300, {
    status: "failed",
    startedAt: 100,
    completedAt: 200,
    detail: "Older failure."
  }), false);
});

test("blocked review shows model, attempt, exact failure, and model-aware retry", () => {
  const markup = renderToStaticMarkup(React.createElement(ReviewActivityBubble, {
    review: {
      state: "blocked",
      stage: "blocked",
      attempt: 3,
      maxAttempts: 3,
      startedAt: 100,
      deadlineAt: null,
      nextAttemptAt: null,
      lastActivityAt: 200,
      lastActivity: "Failed submit_review: findings must be an array",
      lastTool: "submit_review",
      lastError: "Adversarial review timed out after 120s using ollama-cloud/glm-5.2.",
      errors: [
        { at: 190, stage: "reviewing_changes", tool: "submit_review", message: "findings must be an array" },
        { at: 200, stage: "reviewing_changes", tool: null, message: "Adversarial review timed out after 120s using ollama-cloud/glm-5.2." }
      ],
      modelProvider: "ollama-cloud",
      modelId: "glm-5.2",
      thinkingLevel: "high",
      retryable: true
    },
    blockedReason: null,
    busy: false,
    onRetry: () => undefined,
    onStop: () => undefined
  }));

  assert.match(markup, /Attempt 3 of 3/);
  assert.match(markup, /ollama-cloud/);
  assert.match(markup, /glm-5\.2/);
  assert.match(markup, /Adversarial review timed out after 120s/);
  assert.match(markup, /Retry with current model/);
});

test("active review shows progress and Stop without an arbitrary timeout countdown", () => {
  const markup = renderToStaticMarkup(React.createElement(ReviewActivityBubble, {
    review: {
      state: "running",
      stage: "reviewing_changes",
      attempt: 1,
      maxAttempts: 3,
      startedAt: 100,
      deadlineAt: 220,
      nextAttemptAt: null,
      lastActivityAt: 120,
      lastActivity: "Reviewer is reasoning over the change.",
      lastTool: null,
      lastError: null,
      errors: [],
      modelProvider: "ollama-cloud",
      modelId: "glm-5.2",
      thinkingLevel: "high",
      retryable: false
    },
    blockedReason: null,
    busy: false,
    onRetry: () => undefined,
    onStop: () => undefined
  }));

  assert.match(markup, /Reviewing the Worker change/);
  assert.match(markup, /Reviewer is reasoning over the change/);
  assert.match(markup, /Stop review/);
  assert.doesNotMatch(markup, /before timeout|maximum/);
});

test("non-review closeout blockers do not offer an unusable retry", () => {
  const markup = renderToStaticMarkup(React.createElement(ReviewActivityBubble, {
    review: {
      state: "blocked",
      stage: "blocked",
      attempt: 0,
      maxAttempts: 3,
      startedAt: null,
      deadlineAt: null,
      nextAttemptAt: null,
      lastActivityAt: null,
      lastActivity: null,
      lastTool: null,
      lastError: "Visual proof is still missing.",
      errors: [],
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      retryable: false
    },
    blockedReason: "Visual proof is still missing.",
    busy: false,
    onRetry: () => undefined,
    onStop: () => undefined
  }));

  assert.doesNotMatch(markup, /Retry with current model/);
});

test("a current closeout blocker remains visible alongside earlier review failures", () => {
  const markup = renderToStaticMarkup(React.createElement(ReviewActivityBubble, {
    review: {
      state: "blocked",
      stage: "blocked",
      attempt: 1,
      maxAttempts: 3,
      startedAt: null,
      deadlineAt: null,
      nextAttemptAt: null,
      lastActivityAt: 200,
      lastActivity: "Review reached closeout checks.",
      lastTool: null,
      lastError: "Earlier transient tool failure",
      errors: [{ at: 100, stage: "reviewing_changes", tool: "read_job", message: "Earlier transient tool failure" }],
      modelProvider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "high",
      retryable: false
    },
    blockedReason: "Closeout blocked: acceptance point api-proof still needs request evidence.",
    busy: false,
    onRetry: () => undefined,
    onStop: () => undefined
  }));

  assert.match(markup, /Current blocker/);
  assert.match(markup, /acceptance point api-proof still needs request evidence/);
  assert.match(markup, /Earlier transient tool failure/);
});
