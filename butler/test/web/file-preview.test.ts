import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser as LinkedomDOMParser } from "linkedom";

import {
  BLOCKED_HTML_SELECTORS,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SANDBOX,
  buildSandboxedHtmlPreview,
  isSafeHtmlReference
} from "../../src/web/FilePreviewModal.js";
import { MarkdownImage } from "../../src/web/Markdown.js";

test("HTML preview policy blocks active content and remote resources", () => {
  assert.match(BLOCKED_HTML_SELECTORS, /script/);
  assert.match(BLOCKED_HTML_SELECTORS, /iframe/);
  assert.match(BLOCKED_HTML_SELECTORS, /meta/);
  assert.match(BLOCKED_HTML_SELECTORS, /base/);
  assert.match(HTML_PREVIEW_CSP, /default-src 'none'/);
  assert.match(HTML_PREVIEW_CSP, /form-action 'none'/);
  assert.equal(HTML_PREVIEW_SANDBOX, "");
  assert.equal(isSafeHtmlReference("src", "https://tracker.example/pixel.png"), false);
  assert.equal(isSafeHtmlReference("srcset", "https://tracker.example/a.png 1x"), false);
  assert.equal(isSafeHtmlReference("href", "javascript:alert(1)"), false);
  assert.equal(isSafeHtmlReference("href", "#section"), true);
  assert.equal(isSafeHtmlReference("src", "data:image/png;base64,AAAA"), true);
});

test("HTML preview sanitizer removes active content and network-capable references end to end", () => {
  const originalDomParser = globalThis.DOMParser;
  Object.defineProperty(globalThis, "DOMParser", { configurable: true, writable: true, value: LinkedomDOMParser });
  try {
    const sanitized = buildSandboxedHtmlPreview(`<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=https://tracker.example/refresh">
      <base href="https://tracker.example/"><link rel="stylesheet" href="https://tracker.example/style.css">
      <style>.remote{background:url(https://tracker.example/bg.png)}.inline{background:url(data:image/png;base64,AAAA)}</style>
      </head><body onload="alert(1)">
      <form action="https://tracker.example/submit"><p onclick="alert(1)">Safe content</p></form>
      <img src="https://tracker.example/pixel.png" srcset="https://tracker.example/2x.png 2x">
      <img src="data:image/png;base64,AAAA"><a href="javascript:alert(1)">Unsafe link</a>
      <script>document.body.textContent='SCRIPT RAN'</script><iframe src="https://tracker.example/frame"></iframe>
      </body></html>`);
    assert.doesNotMatch(sanitized, /<script|<iframe|<form|<base(?:\s|>)|<link/i);
    assert.doesNotMatch(sanitized, /http-equiv="refresh"/i);
    assert.doesNotMatch(sanitized, /onload=|onclick=|javascript:/i);
    assert.doesNotMatch(sanitized, /tracker\.example/i);
    assert.match(sanitized, /Safe content/);
    assert.match(sanitized, /data:image\/png;base64,AAAA/);
    assert.match(sanitized, /default-src 'none'/);
  } finally {
    if (originalDomParser) {
      Object.defineProperty(globalThis, "DOMParser", { configurable: true, writable: true, value: originalDomParser });
    } else {
      delete (globalThis as { DOMParser?: unknown }).DOMParser;
    }
  }
});

test("uploaded Markdown image syntax produces no network-capable image element", () => {
  const omitted = renderToStaticMarkup(createElement(MarkdownImage, {
    allowRemoteImages: false,
    alt: "tracking pixel",
    src: "https://tracker.example/pixel.png"
  }));
  assert.doesNotMatch(omitted, /<img/i);
  assert.doesNotMatch(omitted, /tracker\.example/);
  assert.match(omitted, /Image omitted: tracking pixel/);
});
