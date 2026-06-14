import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ScratchPadPanel, statusLabel } from "../../src/web/ScratchPadPanel.js";
import type { ScratchPad } from "../../src/web/types.js";

test("scratch pad status labels prefer readiness labels", () => {
  assert.equal(statusLabel("ready_for_review"), "ready");
  assert.equal(statusLabel("exploring", "reviewing"), "reviewing");
});

test("scratch pad panel renders compact decision dossier and attachments without depth controls", () => {
  const scratchPad: ScratchPad = {
    counts: {
      captured: 0,
      exploring: 0,
      ready_for_review: 1,
      accepted: 0,
      parked: 0,
      dismissed: 0
    },
    readinessCounts: {
      captured: 0,
      exploring: 0,
      reviewing: 0,
      needs_rework: 0,
      ready: 1,
      accepted: 0,
      parked: 0,
      dismissed: 0,
      blocked: 0
    },
    items: [
      {
        id: "scratch-1",
        title: "Investigate flow",
        text: "Look into the attached workflow.",
        status: "ready_for_review",
        readiness: {
          status: "ready",
          label: "ready",
          summary: "Dossier is ready.",
          updatedAt: 2
        },
        depth: "deep",
        resultKind: "research",
        attachments: [
          {
            id: "file-file-1",
            kind: "file",
            referenceId: "file-1",
            name: "workflow.pdf",
            mimeType: "application/pdf",
            sizeBytes: 100,
            url: "/api/files/file-1",
            available: true,
            used: true,
            note: "Sent with worker brief.",
            createdAt: 1
          }
        ],
        dossier: {
          status: "ready",
          resultSummary: "Found the workflow gap.",
          acceptedEvidence: 2,
          totalEvidence: 3,
          reviewerSummary: "Intent reviewer passed; QA asked for one negative case.",
          reviewerConcerns: ["QA asked for one negative case."],
          attachmentSummary: "1/1 attachments sent; 1/1 available.",
          nextAction: "Decide whether to accept, park, or dismiss.",
          risk: null,
          updatedAt: 2
        },
        cwd: null,
        workspaceMode: "managed_worktree",
        branchName: null,
        threadId: "thread-1",
        reviewNote: null,
        createdAt: 1,
        updatedAt: 2,
        startedAt: 1,
        reviewedAt: null
      }
    ]
  };

  const markup = renderToStaticMarkup(
    React.createElement(ScratchPadPanel, {
      variant: "window",
      scratchPad,
      defaultCwd: null,
      onOpenThread: () => undefined,
      onConfirmCleanup: () => undefined,
      onPreviewImage: () => undefined,
      showToast: () => undefined,
      showErrorToast: () => undefined
    })
  );

  assert.match(markup, /Found the workflow gap/);
  assert.match(markup, /workflow.pdf/);
  assert.match(markup, /2\/3 evidence accepted/);
  assert.match(markup, /QA asked for one negative case/);
  assert.doesNotMatch(markup, /depth/i);
  assert.doesNotMatch(markup, /reviewer picker/i);
  assert.doesNotMatch(markup, /agent picker/i);
});
