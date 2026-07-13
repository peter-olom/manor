import crypto from "node:crypto";

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

import type {
  ExtensionUiDialog,
  ExtensionUiDialogResponse,
  ExtensionUiLane,
  ExtensionUiNotice,
  ExtensionUiView,
  ExtensionUiWidget
} from "../shared/extension-ui.js";

type RpcUiRequest = Record<string, unknown> & { type: "extension_ui_request"; id: string; method: string };
type ScopeState = {
  dialogs: ExtensionUiDialog[];
  dialogResolvers: Map<string, (response: ExtensionUiDialogResponse) => void>;
  notices: ExtensionUiNotice[];
  statuses: Map<string, string>;
  widgets: Map<string, ExtensionUiWidget>;
  title: string | null;
  editorText: { id: string; text: string } | null;
};

function createScopeState(): ScopeState {
  return {
    dialogs: [],
    dialogResolvers: new Map(),
    notices: [],
    statuses: new Map(),
    widgets: new Map(),
    title: null,
    editorText: null
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const rpcTheme = {
  fg: (_color: unknown, value: string) => value,
  bg: (_color: unknown, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
  underline: (value: string) => value,
  inverse: (value: string) => value,
  strikethrough: (value: string) => value,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "truecolor",
  getThinkingBorderColor: () => (value: string) => value,
  getBashModeBorderColor: () => (value: string) => value
} as unknown as Theme;

export class ExtensionUiBroker {
  private readonly scopes = new Map<string, ScopeState>();

  private state(scope: string): ScopeState {
    const existing = this.scopes.get(scope);
    if (existing) return existing;
    const created = createScopeState();
    this.scopes.set(scope, created);
    return created;
  }

  private enqueueDialog(
    scope: string,
    lane: ExtensionUiLane,
    dialog: Omit<ExtensionUiDialog, "lane" | "createdAt">,
    timeout?: number
  ): Promise<ExtensionUiDialogResponse> {
    const state = this.state(scope);
    const next = { ...dialog, lane, createdAt: Date.now() };
    state.dialogs.push(next);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const finish = (response: ExtensionUiDialogResponse) => {
        if (timer) clearTimeout(timer);
        state.dialogResolvers.delete(next.id);
        state.dialogs = state.dialogs.filter((entry) => entry.id !== next.id);
        resolve(response);
      };
      state.dialogResolvers.set(next.id, finish);
      if (timeout && timeout > 0) timer = setTimeout(() => finish({ cancelled: true }), timeout);
    });
  }

  createContext(scope: string, lane: ExtensionUiLane): ExtensionUIContext {
    const createDialog = (
      method: ExtensionUiDialog["method"],
      input: Partial<ExtensionUiDialog>,
      timeout?: number
    ) => this.enqueueDialog(scope, lane, {
      id: crypto.randomUUID(),
      method,
      title: input.title ?? "Extension request",
      message: input.message ?? null,
      options: input.options ?? [],
      placeholder: input.placeholder ?? null,
      prefill: input.prefill ?? null
    }, timeout);
    return {
      select: async (title, options, opts) => {
        const response = await createDialog("select", { title, options }, opts?.timeout);
        return "value" in response ? response.value : undefined;
      },
      confirm: async (title, message, opts) => {
        const response = await createDialog("confirm", { title, message }, opts?.timeout);
        return "confirmed" in response ? response.confirmed : false;
      },
      input: async (title, placeholder, opts) => {
        const response = await createDialog("input", { title, placeholder }, opts?.timeout);
        return "value" in response ? response.value : undefined;
      },
      editor: async (title, prefill) => {
        const response = await createDialog("editor", { title, prefill });
        return "value" in response ? response.value : undefined;
      },
      notify: (message, tone) => this.applyFireAndForget(scope, lane, { id: crypto.randomUUID(), method: "notify", message, notifyType: tone }),
      setStatus: (key, value) => this.applyFireAndForget(scope, lane, { id: crypto.randomUUID(), method: "setStatus", statusKey: key, statusText: value }),
      setWidget: (key, content, options) => {
        if (content === undefined || Array.isArray(content)) {
          this.applyFireAndForget(scope, lane, { id: crypto.randomUUID(), method: "setWidget", widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
        }
      },
      setTitle: (title) => this.applyFireAndForget(scope, lane, { id: crypto.randomUUID(), method: "setTitle", title }),
      setEditorText: (value) => this.applyFireAndForget(scope, lane, { id: crypto.randomUUID(), method: "set_editor_text", text: value }),
      pasteToEditor: (value) => this.applyFireAndForget(scope, lane, { id: crypto.randomUUID(), method: "set_editor_text", text: value }),
      getEditorText: () => "",
      onTerminalInput: () => () => undefined,
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      custom: async () => { throw new Error("Custom extension components are unavailable in Manor."); },
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      get theme() { return rpcTheme; },
      getAllThemes: () => [{ name: "manor", path: undefined }],
      getTheme: (name) => name === "manor" ? rpcTheme : undefined,
      setTheme: () => ({ success: false, error: "Theme switching is unavailable in Manor." }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined
    };
  }

  acceptRpcRequest(
    scope: string,
    lane: ExtensionUiLane,
    request: RpcUiRequest,
    respond: (response: ExtensionUiDialogResponse & { type: "extension_ui_response"; id: string }) => void
  ): void {
    if (["select", "confirm", "input", "editor"].includes(request.method)) {
      void this.enqueueDialog(scope, lane, {
        id: request.id,
        method: request.method as ExtensionUiDialog["method"],
        title: text(request.title) || "Extension request",
        message: text(request.message) || null,
        options: Array.isArray(request.options) ? request.options.filter((item): item is string => typeof item === "string") : [],
        placeholder: text(request.placeholder) || null,
        prefill: text(request.prefill) || null
      }, typeof request.timeout === "number" ? request.timeout : undefined).then((response) => {
        respond({ type: "extension_ui_response", id: request.id, ...response });
      });
      return;
    }
    this.applyFireAndForget(scope, lane, request);
  }

  private applyFireAndForget(scope: string, lane: ExtensionUiLane, request: Record<string, unknown> & { id: string; method: string }): void {
    const state = this.state(scope);
    if (request.method === "notify") {
      state.notices.push({
        id: request.id,
        lane,
        message: text(request.message),
        tone: request.notifyType === "warning" || request.notifyType === "error" ? request.notifyType : "info"
      });
      state.notices = state.notices.slice(-8);
    } else if (request.method === "setStatus") {
      const key = `${lane}:${text(request.statusKey)}`;
      const value = text(request.statusText);
      if (value) state.statuses.set(key, value);
      else state.statuses.delete(key);
    } else if (request.method === "setWidget") {
      const key = `${lane}:${text(request.widgetKey)}`;
      if (!Array.isArray(request.widgetLines)) state.widgets.delete(key);
      else state.widgets.set(key, {
        id: key,
        lane,
        lines: request.widgetLines.filter((item): item is string => typeof item === "string"),
        placement: request.widgetPlacement === "aboveEditor" ? "aboveEditor" : "belowEditor"
      });
    } else if (request.method === "setTitle") {
      state.title = text(request.title) || null;
    } else if (request.method === "set_editor_text") {
      state.editorText = { id: request.id, text: text(request.text) };
    }
  }

  respond(scope: string, requestId: string, response: ExtensionUiDialogResponse): boolean {
    const resolver = this.scopes.get(scope)?.dialogResolvers.get(requestId);
    if (!resolver) return false;
    resolver(response);
    return true;
  }

  dismiss(scope: string, itemId: string): boolean {
    const state = this.scopes.get(scope);
    if (!state) return false;
    const previousCount = state.notices.length;
    const removedEditorText = state.editorText?.id === itemId;
    state.notices = state.notices.filter((notice) => notice.id !== itemId);
    if (removedEditorText) state.editorText = null;
    return previousCount !== state.notices.length || removedEditorText;
  }

  view(scopes: Array<{ scope: string; lane: ExtensionUiLane }>): ExtensionUiView {
    const results = scopes.flatMap(({ scope, lane }) => {
      const state = this.scopes.get(scope);
      return state ? [{ state, lane }] : [];
    });
    return {
      dialog: results.flatMap(({ state }) => state.dialogs).sort((left, right) => left.createdAt - right.createdAt)[0] ?? null,
      notices: results.flatMap(({ state }) => state.notices),
      statuses: results.flatMap(({ state, lane }) => [...state.statuses].map(([id, value]) => ({ id, lane, text: value }))),
      widgets: results.flatMap(({ state }) => [...state.widgets.values()]),
      titles: results.flatMap(({ state, lane }) => state.title ? [{ lane, text: state.title }] : []),
      editorText: results.flatMap(({ state, lane }) => state.editorText ? [{ ...state.editorText, lane }] : [])[0] ?? null
    };
  }
}
