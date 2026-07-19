export interface ManorRestartRequestView {
  id: string;
  target: "current" | "latest" | null;
  gitRef: string | null;
  includeDesktop: boolean;
  build: boolean | null;
  update: boolean | null;
  reason: string | null;
  details: string | null;
  requestedAt: number;
  status: "pending" | "authorized" | "dismissed";
  authorizedAt: number | null;
}

export interface ManorRestartTrackingView {
  requestId: string;
  runId: string;
  startedAt: number;
}

export interface ManorRestartProgressView extends ManorRestartTrackingView {
  status: "running" | "completed" | "failed" | "unconfirmed";
  completedAt: number | null;
  currentStep: string | null;
  error: string | null;
}
