import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ManorRestartDialog } from "../../src/web/ManorRestartDialog.js";
import type { ManorRestartRequestView } from "../../src/shared/manor-restart.js";

function restartRequest(): ManorRestartRequestView {
  return {
    id: "restart/request 1",
    target: "current",
    gitRef: "feature/restart-fix",
    includeDesktop: false,
    build: true,
    update: false,
    reason: "Apply the active self-improvement changes.",
    details: "Run the full verification after Manor returns.",
    requestedAt: 1,
    status: "pending",
    authorizedAt: null
  };
}

test("restart dialog presents the decision and request details", () => {
  const markup = renderToStaticMarkup(React.createElement(ManorRestartDialog, {
    pairId: "pair-1",
    request: restartRequest(),
    onCleared() {}
  }));

  assert.match(markup, /role="alertdialog"/);
  assert.match(markup, /tabindex="-1"/);
  assert.match(markup, /Authorize Manor restart\?/);
  assert.match(markup, /feature\/restart-fix/);
  assert.match(markup, /Apply the active self-improvement changes\./);
  assert.match(markup, /Update source<\/dt><dd>Yes/);
  assert.match(markup, /Rebuild services<\/dt><dd>Yes/);
  assert.match(markup, /Keep running/);
  assert.match(markup, /Authorize restart/);
});

test("restart dialog posts authorization to the pair-scoped request", async () => {
  const dom = parseHTML("<html><body><div id=\"root\"></div></body></html>");
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

  let submitted: { url: string; body: unknown } | null = null;
  let cleared = 0;
  globals.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    submitted = { url: String(input), body: JSON.parse(String(init?.body ?? "{}")) };
    return Response.json({ ok: true }, { status: 202 });
  };

  const container = dom.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(ManorRestartDialog, {
        pairId: "pair/one",
        request: restartRequest(),
        onCleared: () => { cleared += 1; }
      }));
    });
    const authorize = [...dom.document.querySelectorAll("button")].find((button) => button.textContent === "Authorize restart");
    assert.ok(authorize instanceof dom.window.HTMLButtonElement);

    await act(async () => {
      authorize.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });

    assert.deepEqual(submitted, {
      url: "/api/pairs/pair%2Fone/manor-restart-requests/restart%2Frequest%201/authorize",
      body: { operatorAction: "authorize_restart" }
    });
    assert.equal(cleared, 1);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globals, previous);
  }
});

test("restart dialog keeps the request visible when authorization fails", async () => {
  const dom = parseHTML("<html><body><div id=\"root\"></div></body></html>");
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
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => Response.json({ error: "A Manor restart is already running." }, { status: 409 })
  });

  const container = dom.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(ManorRestartDialog, {
        pairId: "pair-1",
        request: restartRequest(),
        onCleared() { assert.fail("failed authorization must not clear the request"); }
      }));
    });
    const authorize = [...dom.document.querySelectorAll("button")].find((button) => button.textContent === "Authorize restart");
    assert.ok(authorize instanceof dom.window.HTMLButtonElement);
    await act(async () => {
      authorize.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });

    assert.match(dom.document.body.textContent, /A Manor restart is already running\./);
    assert.ok(dom.document.querySelector('[role="alertdialog"]'));
    assert.equal(authorize.disabled, false);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globals, previous);
  }
});
