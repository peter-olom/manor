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
