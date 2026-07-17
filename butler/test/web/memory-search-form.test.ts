import assert from "node:assert/strict";
import { test } from "node:test";

import React, { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

import { MemoryDashboard, MemorySearchForm } from "../../src/web/MemoryDashboard.js";

test("Agent memory typing updates only the draft until the form is submitted", () => {
  let draft = "";
  let submissions = 0;
  const form = MemorySearchForm({
    mode: "agent",
    section: "jobs",
    value: "unfinished question",
    onChange: (value) => { draft = value; },
    onSubmit: () => { submissions += 1; }
  });
  const formChildren = React.Children.toArray(form.props.children);
  const search = formChildren[0] as ReactElement<{ children: React.ReactNode }>;
  const input = React.Children.toArray(search.props.children)[1] as ReactElement<{
    onChange: (event: { target: { value: string } }) => void;
    onKeyDown: (event: { key: string; preventDefault: () => void }) => void;
  }>;

  input.props.onChange({ target: { value: "still typing" } });
  assert.equal(draft, "still typing");
  assert.equal(submissions, 0);

  let enterPrevented = false;
  input.props.onKeyDown({ key: "Enter", preventDefault: () => { enterPrevented = true; } });
  assert.equal(enterPrevented, true);
  assert.equal(submissions, 1);

  let prevented = false;
  form.props.onSubmit({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(submissions, 2);
});

test("Agent memory draft renders an explicit Search action without starting a preview", () => {
  const controls = renderToStaticMarkup(React.createElement(MemorySearchForm, {
    mode: "agent",
    section: "jobs",
    value: "draft only",
    onChange: () => undefined,
    onSubmit: () => undefined
  }));
  assert.match(controls, /<form class="memory-search-form"/);
  assert.match(controls, /type="submit"/);
  assert.match(controls, /aria-label="Search memory"/);
  assert.match(controls, />Search<\/span>/);

  const dashboard = renderToStaticMarkup(React.createElement(MemoryDashboard, {
    showHeader: false,
    showSections: false,
    searchMode: "agent",
    search: "draft only",
    agentSearch: null
  }));
  assert.match(dashboard, /Enter a question above/);
  assert.doesNotMatch(dashboard, /memory-preview-loading/);
  assert.doesNotMatch(dashboard, /aria-label="Memory section"/);

  const standaloneDashboard = renderToStaticMarkup(React.createElement(MemoryDashboard, {
    showHeader: false,
    showSections: true,
    searchMode: "agent",
    search: "",
    agentSearch: null
  }));
  assert.doesNotMatch(standaloneDashboard, /aria-label="Memory section"/);

  const staleDashboard = renderToStaticMarkup(React.createElement(MemoryDashboard, {
    showHeader: false,
    showSections: false,
    searchMode: "agent",
    search: "new draft",
    agentSearch: { query: "previous query", projectId: "", sequence: 1 }
  }));
  assert.match(staleDashboard, /Search to update the preview/);
  assert.doesNotMatch(staleDashboard, /Query “previous query”/);
});

test("Agent retrieval runs only when a submitted search snapshot changes", async () => {
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
  const requests: string[] = [];
  setGlobal("window", dom.window);
  setGlobal("document", dom.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/api/memory/retrieve?")) {
      return Response.json({
        formatted: "",
        retrieval: {
          query: new URL(url, "http://localhost").searchParams.get("query"),
          retrievedAt: Date.now(),
          projectRollups: [],
          jobMemories: [],
          butlerMemories: [],
          pendingPromotionCandidates: [],
          warnings: []
        }
      });
    }
    return Response.json({ items: [] });
  });
  const container = dom.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const render = async (props: Record<string, unknown>) => {
    await act(async () => {
      root.render(React.createElement(MemoryDashboard, {
        showHeader: false,
        showSections: false,
        searchMode: "agent",
        search: "draft query",
        agentSearch: null,
        ...props
      }));
      await Promise.resolve();
    });
  };

  try {
    await render({});
    assert.equal(requests.filter((url) => url.startsWith("/api/memory/retrieve?")).length, 0);

    await render({ agentSearch: { query: "submitted query", projectId: "project-1", sequence: 1 } });
    const retrievals = requests.filter((url) => url.startsWith("/api/memory/retrieve?"));
    assert.equal(retrievals.length, 1);
    assert.equal(new URL(retrievals[0], "http://localhost").searchParams.get("projectId"), "project-1");

    await render({ searchMode: "browse", agentSearch: { query: "submitted query", projectId: "project-1", sequence: 1 } });
    await render({ searchMode: "agent", agentSearch: { query: "submitted query", projectId: "project-1", sequence: 1 } });
    assert.equal(requests.filter((url) => url.startsWith("/api/memory/retrieve?")).length, 1);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<PropertyKey, unknown>)[key];
    }
  }
});
