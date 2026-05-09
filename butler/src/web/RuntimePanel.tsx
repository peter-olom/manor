import { PreviewVerificationSummary } from "./PreviewVerificationSummary";
import { ImageIcon, OpenIcon, PinIcon, StopIcon } from "./icons";
import type { PreviewMedia, RuntimeSnapshot } from "./types";
import { formatLeaseState, formatPreviewBootstrap, formatStackStorage } from "./utils";

export function RuntimePanel({
  stacks,
  previews,
  services,
  desktopSessions,
  busyStackId,
  busyServiceId,
  busyDesktopSessionId,
  onFocusThread,
  onPinStack,
  onStopStack,
  onPinPreview,
  onStopPreview,
  onPinService,
  onStopService,
  onStopDesktopSession,
  onCaptureDesktopScreen,
  onPreviewArtifact,
  onResourceUnavailable
}: {
  stacks: RuntimeSnapshot["stacks"];
  previews: RuntimeSnapshot["previews"];
  services: RuntimeSnapshot["services"];
  desktopSessions: RuntimeSnapshot["desktopSessions"];
  busyStackId: string | null;
  busyServiceId: string | null;
  busyDesktopSessionId: string | null;
  onFocusThread: (threadId: string | null) => void;
  onPinStack: (stackId: string, pinned: boolean) => void;
  onStopStack: (stackId: string) => void;
  onPinPreview: (leaseId: string, pinned: boolean) => void;
  onStopPreview: (leaseId: string) => void;
  onPinService: (serviceId: string, pinned: boolean) => void;
  onStopService: (serviceId: string) => void;
  onStopDesktopSession: (sessionId: string) => void;
  onCaptureDesktopScreen: (sessionId: string) => void;
  onPreviewArtifact: (media: PreviewMedia) => void;
  onResourceUnavailable: (message: string) => void;
}) {
  return (
    <>
      {desktopSessions.length > 0 ? (
        <section className="runtime-group">
          <div className="runtime-group-head">
            <span className="eyebrow">Desktop</span>
            <span className="runtime-group-count">{desktopSessions.length}</span>
          </div>
          <div className="runtime-list">
            {desktopSessions.map((session) => (
              <article key={session.sessionId} className="runtime-item">
                <button className="runtime-item-main" onClick={() => onFocusThread(session.threadId ?? session.attachedThreadIds[0] ?? null)}>
                  <span className="runtime-item-title">{session.title}</span>
                  <span className="runtime-item-meta">
                    {session.projectLabel} • {session.running ? "running" : "stopped"} • {session.interactive ? "interactive" : "proof"} • actions=
                    {session.actionCount}
                    {session.workspaceName ? ` • workspace=${session.workspaceName}${session.workspaceIndex !== null ? `#${session.workspaceIndex}` : ""}` : ""}
                    {session.attachedThreadIds.length > 1 ? ` • threads=${session.attachedThreadIds.length}` : ""}
                    {session.lockOwner ? ` • locked by ${session.lockOwner}` : ""}
                    {session.profileKey ? ` • profile=${session.profileKey}` : ""}
                  </span>
                </button>
                <div className="runtime-item-actions">
                  <a className="panel-action panel-action-link panel-action-icon" href={session.vncUrl} target="_blank" rel="noreferrer" aria-label="Attach to desktop" title="Attach">
                    <OpenIcon />
                  </a>
                  <button className="panel-action panel-action-icon" onClick={() => onCaptureDesktopScreen(session.sessionId)} disabled={busyDesktopSessionId === session.sessionId} aria-label="Capture desktop screen" title="Screenshot">
                    <ImageIcon />
                  </button>
                  <button className="panel-action panel-action-icon panel-action-icon-danger" onClick={() => onStopDesktopSession(session.sessionId)} disabled={busyDesktopSessionId === session.sessionId} aria-label={busyDesktopSessionId === session.sessionId ? "Stopping desktop session" : "Stop desktop session"} title={busyDesktopSessionId === session.sessionId ? "Stopping" : "Stop"}>
                    <StopIcon />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {stacks.length > 0 ? (
        <section className="runtime-group">
          <div className="runtime-group-head">
            <span className="eyebrow">Stacks</span>
            <span className="runtime-group-count">{stacks.length}</span>
          </div>
          <div className="runtime-list">
            {stacks.map((stack) => (
              <article key={stack.id} className="runtime-item">
                <button className="runtime-item-main" onClick={() => onFocusThread(stack.threadId)}>
                  <span className="runtime-item-title">{stack.title}</span>
                  <span className="runtime-item-meta">
                    {stack.projectLabel} • {stack.networkName} • {stack.status} •{" "}
                    {formatLeaseState(stack.lifecycleState, stack.expiresAt, stack.pinned)} • {formatStackStorage(stack)} • previews=
                    {stack.previewIds.length} • services={stack.serviceIds.length}
                  </span>
                </button>
                <div className="runtime-item-actions">
                  <button className="panel-action panel-action-icon" onClick={() => onPinStack(stack.id, !stack.pinned)} aria-label={stack.pinned ? "Unpin stack" : "Pin stack"} title={stack.pinned ? "Unpin" : "Pin"}>
                    <PinIcon pinned={stack.pinned} />
                  </button>
                  <button className="panel-action panel-action-icon panel-action-icon-danger" onClick={() => onStopStack(stack.id)} disabled={busyStackId === stack.id} aria-label={busyStackId === stack.id ? "Stopping stack" : "Stop stack"} title={busyStackId === stack.id ? "Stopping" : "Stop"}>
                    <StopIcon />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {previews.length > 0 ? (
        <section className="runtime-group">
          <div className="runtime-group-head">
            <span className="eyebrow">Previews</span>
            <span className="runtime-group-count">{previews.length}</span>
          </div>
          <div className="runtime-list">
            {previews.map((lease) => (
              <article key={lease.id} className="runtime-item">
                <button className="runtime-item-main" onClick={() => onFocusThread(lease.threadId)}>
                  <span className="runtime-item-title">{lease.title}</span>
                  <span className="runtime-item-meta">
                    {lease.projectLabel} • {lease.branchName ?? "preview"} • {lease.status} •{" "}
                    {formatLeaseState(lease.lifecycleState, lease.expiresAt, lease.pinned)} • {formatPreviewBootstrap(lease)}
                  </span>
                </button>
                {lease.lastVerification ? (
                  <div className="runtime-item-verification">
                    <PreviewVerificationSummary
                      verification={lease.lastVerification}
                      onPreviewArtifact={onPreviewArtifact}
                      onResourceUnavailable={onResourceUnavailable}
                    />
                  </div>
                ) : null}
                <div className="runtime-item-actions">
                  <button className="panel-action panel-action-icon" onClick={() => onPinPreview(lease.id, !lease.pinned)} aria-label={lease.pinned ? "Unpin preview" : "Pin preview"} title={lease.pinned ? "Unpin" : "Pin"}>
                    <PinIcon pinned={lease.pinned} />
                  </button>
                  <a className="panel-action panel-action-link panel-action-icon" href={lease.operatorUrl} target="_blank" rel="noreferrer" aria-label="Open preview" title="Open">
                    <OpenIcon />
                  </a>
                  {lease.tailnetUrl ? (
                    <a className="panel-action panel-action-link panel-action-icon" href={lease.tailnetUrl} target="_blank" rel="noreferrer" aria-label="Open tailnet preview" title="Open tailnet">
                      <OpenIcon />
                    </a>
                  ) : null}
                  <button className="panel-action panel-action-icon panel-action-icon-danger" onClick={() => onStopPreview(lease.id)} aria-label="Stop preview" title="Stop">
                    <StopIcon />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {services.length > 0 ? (
        <section className="runtime-group">
          <div className="runtime-group-head">
            <span className="eyebrow">Services</span>
            <span className="runtime-group-count">{services.length}</span>
          </div>
          <div className="runtime-list">
            {services.map((service) => (
              <article key={service.id} className="runtime-item">
                <button className="runtime-item-main" onClick={() => onFocusThread(service.threadId)}>
                  <span className="runtime-item-title">{service.title}</span>
                  <span className="runtime-item-meta">
                    {service.connection.engine} • {service.connection.host}:{service.connection.port} • {service.storageKind}
                    {service.volumeName ? `(${service.volumeName})` : ""} • {service.status} •{" "}
                    {formatLeaseState(service.lifecycleState, service.expiresAt, service.pinned)}
                  </span>
                </button>
                <div className="runtime-item-actions">
                  <button className="panel-action panel-action-icon" onClick={() => onPinService(service.id, !service.pinned)} aria-label={service.pinned ? "Unpin service" : "Pin service"} title={service.pinned ? "Unpin" : "Pin"}>
                    <PinIcon pinned={service.pinned} />
                  </button>
                  <button className="panel-action panel-action-icon panel-action-icon-danger" onClick={() => onStopService(service.id)} disabled={busyServiceId === service.id} aria-label={busyServiceId === service.id ? "Stopping service" : "Stop service"} title={busyServiceId === service.id ? "Stopping" : "Stop"}>
                    <StopIcon />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
