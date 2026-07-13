export type ExtensionUiLane = "butler" | "worker";
export type ExtensionUiDialogMethod = "select" | "confirm" | "input" | "editor";

export type ExtensionUiDialog = {
  id: string;
  lane: ExtensionUiLane;
  method: ExtensionUiDialogMethod;
  title: string;
  message: string | null;
  options: string[];
  placeholder: string | null;
  prefill: string | null;
  createdAt: number;
};

export type ExtensionUiNotice = {
  id: string;
  lane: ExtensionUiLane;
  message: string;
  tone: "info" | "warning" | "error";
};

export type ExtensionUiWidget = {
  id: string;
  lane: ExtensionUiLane;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
};

export type ExtensionUiView = {
  dialog: ExtensionUiDialog | null;
  notices: ExtensionUiNotice[];
  statuses: Array<{ id: string; lane: ExtensionUiLane; text: string }>;
  widgets: ExtensionUiWidget[];
  titles: Array<{ lane: ExtensionUiLane; text: string }>;
  editorText: { id: string; lane: ExtensionUiLane; text: string } | null;
};

export type ExtensionUiDialogResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };
