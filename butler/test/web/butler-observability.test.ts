import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ActivityOnlyBubble, Bubble, ButlerPane, durableActivitySupersedesLive, findActiveOperatorQuestionMessage, LiveBubble, pendingActivityOwner, persistedButlerMessageCoversLive, ReviewActivityBubble, WorkerWaitIndicator, WorkLoaderBubble } from "../../src/web/ButlerPane.js";
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

test("completed trace renders above and outside the final Butler message", () => {
  const markup = renderToStaticMarkup(React.createElement(Bubble, {
    message: {
      id: "message-1",
      role: "butler",
      lane: "butler",
      text: "There are 9 floating files.",
      at: 200,
      sourceThreadId: null,
      memoryObservationId: null,
      metadata: {},
      trace: [{
        id: "tool-1",
        type: "dynamic_tool_call",
        status: "completed",
        title: "inspect_filesystem",
        text: "Listed /repos",
        at: 100,
        completedAt: 150
      }]
    },
    pairId: "pair-1",
    onPairUpdate: () => undefined,
    activeQuestionMessageId: null,
    onPreviewImage: () => undefined
  }));

  assert.match(markup, /^<div class="butler-turn"><details class="bubble-disclosure"/);
  assert.ok(markup.indexOf("bubble-disclosure") < markup.indexOf("bubble is-butler"));
  assert.doesNotMatch(markup, /<article class="bubble is-butler"[^>]*>[\s\S]*bubble-disclosure/);
  assert.doesNotMatch(markup, /bubble-disclosure-icon/);
});

test("user bubble renders tiny attachments without internal reference text", () => {
  const markup = renderToStaticMarkup(React.createElement(Bubble, {
    message: {
      id: "message-user-1",
      role: "user",
      lane: "butler",
      text: "What do you see?",
      at: 200,
      sourceThreadId: null,
      memoryObservationId: null,
      metadata: {},
      attachments: [
        { id: "image-1", kind: "image", name: "screen.png", mimeType: "image/png", sizeBytes: 20, url: "/api/images/image-1" },
        { id: "file-1", kind: "file", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 30, url: "/api/files/file-1" }
      ]
    },
    pairId: "pair-1",
    onPairUpdate: () => undefined,
    activeQuestionMessageId: null,
    onPreviewImage: () => undefined
  }));

  assert.match(markup, /class="bubble-attachment is-image"/);
  assert.match(markup, /src="\/api\/images\/image-1"/);
  assert.match(markup, /class="bubble-attachment is-file"/);
  assert.match(markup, />pdf<\/a>/i);
  assert.doesNotMatch(markup, /Stored reference/);
  assert.ok(markup.indexOf("What do you see?") < markup.indexOf("bubble-attachments"));
});

test("Butler shared markdown files open in the in-app previewer", () => {
  const markup = renderToStaticMarkup(React.createElement(Bubble, {
    message: {
      id: "message-butler-file",
      role: "butler",
      lane: "butler",
      text: "[Open specification](/api/project-artifacts/boardwalk/artifact-1/file)",
      at: 200,
      sourceThreadId: null,
      memoryObservationId: null,
      metadata: {},
      attachments: [{
        id: "artifact-1",
        kind: "file",
        name: "SPEC.md",
        mimeType: "text/markdown",
        sizeBytes: 30,
        url: "/api/project-artifacts/boardwalk/artifact-1/file",
        downloadUrl: "/api/project-artifacts/boardwalk/artifact-1/file?download=1"
      }]
    },
    pairId: "pair-1",
    onPairUpdate: () => undefined,
    activeQuestionMessageId: null,
    onPreviewImage: () => undefined,
    onPreviewProjectArtifact: () => undefined,
    onPreviewProjectFile: () => undefined
  }));

  assert.match(markup, /aria-label="Preview SPEC\.md"/);
  assert.doesNotMatch(markup, /aria-label="Download SPEC\.md"/);
});

test("Butler shared images render as a first-class preview attachment", () => {
  const markup = renderToStaticMarkup(React.createElement(Bubble, {
    message: {
      id: "message-butler-image",
      role: "butler",
      lane: "butler",
      text: "**Board proof**\n\n[Open proof.png](/api/project-artifacts/boardwalk/artifact-1/file) · [Download](/api/project-artifacts/boardwalk/artifact-1/file?download=1)",
      at: 200,
      sourceThreadId: null,
      memoryObservationId: null,
      metadata: {},
      attachments: [{
        id: "image-proof",
        kind: "image",
        name: "proof.png",
        mimeType: "image/png",
        sizeBytes: 20,
        url: "/api/images/image-proof",
        downloadUrl: "/api/project-artifacts/boardwalk/artifact-1/file?download=1"
      }]
    },
    pairId: "pair-1",
    onPairUpdate: () => undefined,
    activeQuestionMessageId: null,
    onPreviewImage: () => undefined
  }));

  assert.match(markup, /class="bubble-attachments is-presented"/);
  assert.match(markup, /aria-label="Preview proof\.png"/);
  assert.match(markup, /src="\/api\/images\/image-proof"/);
});

test("live trace stays expanded above the streaming Butler message", () => {
  const markup = renderToStaticMarkup(React.createElement(LiveBubble, {
    text: "There are 9 floating files.",
    pending: true,
    items: [{
      id: "tool-1",
      type: "dynamic_tool_call",
      status: "in_progress",
      title: "inspect_filesystem",
      text: "Listing /repos",
      at: 100
    }]
  }));

  assert.match(markup, /^<div class="butler-turn"><details class="bubble-disclosure" open=""/);
  assert.ok(markup.indexOf("bubble-disclosure") < markup.indexOf("bubble is-butler is-live"));
});

test("completed live trace collapses above the completed Butler message", () => {
  const markup = renderToStaticMarkup(React.createElement(LiveBubble, {
    text: "There are 9 floating files.",
    pending: false,
    items: [{
      id: "tool-1",
      type: "dynamic_tool_call",
      status: "completed",
      title: "inspect_filesystem",
      text: "Listed /repos",
      at: 100,
      completedAt: 150
    }]
  }));

  assert.match(markup, /^<div class="butler-turn"><details class="bubble-disclosure">/);
  assert.doesNotMatch(markup, /<details class="bubble-disclosure" open/);
  assert.ok(markup.indexOf("bubble-disclosure") < markup.indexOf("bubble is-butler is-live-complete"));
});

test("persisted Butler reply suppresses its live duplicate before turn completion", () => {
  const message = {
    id: "message-1",
    role: "butler",
    lane: "butler",
    text: "There are 9 floating files.",
    at: 200,
    sourceThreadId: null,
    memoryObservationId: null,
    metadata: {}
  } as const;

  assert.equal(persistedButlerMessageCoversLive(message, "There are 9 floating files.", 100, null), true);
  assert.equal(persistedButlerMessageCoversLive(message, "Still drafting.", 100, null), false);
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
  assert.doesNotMatch(markup, /class="bubble(?:\s|")/);
});

test("active Butler activity is flat instead of a message bubble", () => {
  const markup = renderToStaticMarkup(React.createElement(WorkLoaderBubble, {
    startedAt: Date.now(),
    lastUpdateAt: Date.now(),
    items: [{
      id: "thinking-1",
      type: "reasoning",
      status: "in_progress",
      title: "Thinking",
      text: "Checking the current state.",
      at: Date.now()
    }]
  }));

  assert.match(markup, /class="butler-activity-indicator"/);
  assert.match(markup, /aria-label="Butler is working"/);
  assert.doesNotMatch(markup, /class="bubble(?:\s|")/);
  assert.ok(markup.indexOf("bubble-disclosure") < markup.indexOf("working-indicator"));
});

test("an active operator decision stays after later Butler narration until delivery completes", () => {
  const questionMessage = {
    id: "question-message",
    role: "butler",
    lane: "butler",
    text: "Approve this change?",
    at: 2,
    sourceThreadId: null,
    memoryObservationId: null,
    metadata: {},
    question: {
      id: "question-1",
      prompt: "Approve this change?",
      context: null,
      options: [{ id: "approve", label: "Approve", description: null }],
      allowFreeform: false,
      createdAt: 2,
      selectedOptionId: null,
      freeformAnswer: null,
      answeredAt: null,
      deliveryState: "idle" as const
    }
  } as const;
  const messages = [
    { ...questionMessage, id: "request", role: "user" as const, text: "Install it", at: 1, question: undefined },
    questionMessage,
    { ...questionMessage, id: "narration", text: "I am waiting for your approval.", at: 3, question: undefined }
  ];

  assert.equal(findActiveOperatorQuestionMessage(messages)?.id, "question-message");
  assert.equal(findActiveOperatorQuestionMessage([
    ...messages,
    { ...questionMessage, id: "queued-user", role: "user", text: "A queued follow-up", at: 4, question: undefined }
  ])?.id, "question-message");
  assert.equal(findActiveOperatorQuestionMessage(messages.map((message) => message.id === "question-message"
    ? { ...message, question: { ...questionMessage.question, selectedOptionId: "approve", answeredAt: 4, deliveryState: "pending" as const } }
    : message))?.id, "question-message");
  assert.equal(findActiveOperatorQuestionMessage(messages.map((message) => message.id === "question-message"
    ? { ...message, question: { ...questionMessage.question, selectedOptionId: "approve", answeredAt: 4, deliveryState: "delivered" as const } }
    : message)), null);
});

test("live activity stays above the decision input and suppresses the composer", () => {
  const decision = {
    id: "decision-message", role: "butler", lane: "butler", text: "Approve this change?", at: 2,
    sourceThreadId: null, memoryObservationId: null, metadata: {},
    question: {
      id: "decision", prompt: "Approve this change?", context: null,
      options: [{ id: "approve", label: "Approve", description: null }], allowFreeform: false,
      createdAt: 2, selectedOptionId: null, freeformAnswer: null, answeredAt: null, deliveryState: "idle" as const
    }
  };
  const pair = {
    id: "pair-1", messages: [decision], lastMessage: decision, updatedAt: 3, hasMore: false,
    status: "butler_running", butlerPending: true, butlerPendingReason: null, butlerReady: true,
    review: null, worker: null,
    butlerActivity: [{ id: "thinking", type: "reasoning", status: "in_progress", title: "Thinking", text: "Checking.", at: 3 }],
    butlerActivityOutcome: { status: "active", startedAt: 3, completedAt: null, detail: null }
  } as unknown as React.ComponentProps<typeof ButlerPane>["pair"];
  const markup = renderToStaticMarkup(React.createElement(ButlerPane, {
    pair, draft: "authored text", busy: false, composerBusy: false, sendDisabled: false,
    onDraft: () => undefined, onSend: () => undefined, onLoadOlder: () => undefined, onButlerPatch: null,
    onThinkingLevelChange: () => undefined, onButlerModelChange: () => undefined, onRetryReview: () => undefined,
    onStopReview: () => undefined, onStopButler: () => undefined, stoppingButler: false,
    liveConnected: true, liveHasConnected: true, onOpenProviderSettings: () => undefined,
    attachments: [], onUploadFiles: () => undefined, uploadingFiles: false, uploadError: null,
    onRemoveAttachment: () => undefined, onPreviewImage: () => undefined, onPairUpdate: () => undefined,
    contextItems: [], onContextItemsChange: () => undefined
  }));

  assert.ok(markup.indexOf("working-indicator") < markup.indexOf("operator-question-input"));
  assert.doesNotMatch(markup, /composer-form/);
});

test("worker-running state uses a dedicated Worker indicator", () => {
  assert.equal(pendingActivityOwner({ status: "worker_running", butlerPending: false, butlerPendingReason: null }), "worker");
  assert.equal(pendingActivityOwner({ status: "butler_running", butlerPending: true, butlerPendingReason: null }), "butler");
  assert.equal(pendingActivityOwner({ status: "worker_running", butlerPending: true, butlerPendingReason: null }), "butler");

  const markup = renderToStaticMarkup(React.createElement(WorkerWaitIndicator, {
    worker: {
      threadId: "worker-1",
      status: "running",
      task: "Delete the floating files",
      cwd: "/repos",
      handoffPrompt: "Delete the floating files",
      startedAt: Date.now(),
      lastRevertAt: null,
      lastReportAt: null,
      lastReportStatus: null,
      lastReportSummary: null,
      lastReviewedReportAt: null,
      provider: "ollama-cloud",
      model: "ollama-cloud/glm-5.2"
    },
    startedAt: Date.now()
  }));
  assert.match(markup, /ollama-cloud\/glm-5\.2/);
  assert.doesNotMatch(markup, /ollama-cloud · ollama-cloud\/glm-5\.2/);

  assert.match(markup, /aria-label="Worker is working"/);
  assert.match(markup, /Delete the floating files/);
  assert.doesNotMatch(markup, /bubble is-butler|Reasoning and tool trace/);
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
      errors: [{ at: 110, stage: "reviewing_changes", tool: "read", message: "Worker runtime path is unavailable in this review workspace." }],
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

  assert.match(markup, /Reviewing the Worker result/);
  assert.match(markup, /Reviewer is reasoning over the change/);
  assert.match(markup, /Reviewer tool history/);
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
