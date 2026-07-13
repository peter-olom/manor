import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionUiBroker } from "../../src/server/extension-ui-broker.js";

test("embedded Pi dialogs resolve through the broker", async () => {
  const broker = new ExtensionUiBroker();
  const context = broker.createContext("butler:pair-1", "butler");
  const pending = context.select("Choose a target", ["One", "Two"]);
  const dialog = broker.view([{ scope: "butler:pair-1", lane: "butler" }]).dialog;
  assert.equal(dialog?.title, "Choose a target");
  assert.deepEqual(dialog?.options, ["One", "Two"]);
  assert.equal(broker.respond("butler:pair-1", dialog!.id, { value: "Two" }), true);
  assert.equal(await pending, "Two");
  assert.equal(broker.view([{ scope: "butler:pair-1", lane: "butler" }]).dialog, null);
});

test("RPC Pi dialogs return protocol responses and preserve fire-and-forget state", async () => {
  const broker = new ExtensionUiBroker();
  let protocolResponse: unknown;
  broker.acceptRpcRequest("worker-1", "worker", {
    type: "extension_ui_request",
    id: "confirm-1",
    method: "confirm",
    title: "Continue?",
    message: "Apply the extension change"
  }, (response) => { protocolResponse = response; });
  broker.acceptRpcRequest("worker-1", "worker", {
    type: "extension_ui_request",
    id: "status-1",
    method: "setStatus",
    statusKey: "mode",
    statusText: "Reviewing"
  }, () => undefined);
  broker.acceptRpcRequest("worker-1", "worker", {
    type: "extension_ui_request",
    id: "widget-1",
    method: "setWidget",
    widgetKey: "summary",
    widgetLines: ["Line one", "Line two"]
  }, () => undefined);

  const scopes = [{ scope: "worker-1", lane: "worker" as const }];
  const view = broker.view(scopes);
  assert.equal(view.dialog?.method, "confirm");
  assert.equal(view.statuses[0]?.text, "Reviewing");
  assert.deepEqual(view.widgets[0]?.lines, ["Line one", "Line two"]);

  broker.respond("worker-1", "confirm-1", { confirmed: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(protocolResponse, {
    type: "extension_ui_response",
    id: "confirm-1",
    confirmed: true
  });
});

test("editor text and notices remain scoped to their Manor session", () => {
  const broker = new ExtensionUiBroker();
  const context = broker.createContext("butler:pair-1", "butler");
  context.notify("Ready", "info");
  context.setEditorText("Draft from extension");
  const own = broker.view([{ scope: "butler:pair-1", lane: "butler" }]);
  const other = broker.view([{ scope: "butler:pair-2", lane: "butler" }]);
  assert.equal(own.notices[0]?.message, "Ready");
  assert.equal(own.editorText?.text, "Draft from extension");
  assert.equal(other.notices.length, 0);
  assert.equal(other.editorText, null);
});

test("embedded extensions receive a safe readable theme", () => {
  const context = new ExtensionUiBroker().createContext("butler:pair-1", "butler");
  assert.equal(context.theme.fg("accent", "Readable"), "Readable");
  assert.equal(context.theme.bold("Readable"), "Readable");
  assert.equal(context.getTheme("manor"), context.theme);
  assert.deepEqual(context.getAllThemes(), [{ name: "manor", path: undefined }]);
});
