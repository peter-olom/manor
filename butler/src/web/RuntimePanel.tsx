import { PreviewVerificationSummary } from "./PreviewVerificationSummary";
import type { PreviewMedia, RuntimeSnapshot } from "./types";
import { formatLeaseState, formatPreviewBootstrap, formatStackStorage } from "./utils";

export function RuntimePanel({
  stacks,
  previews,
  services,
  busyStackId,
  busyServiceId,
  onFocusThread,
  onPinStack,
  onStopStack,
  onPinPreview,
  onStopPreview,
  onPinService,
  onStopService,
  onPreviewArtifact,
  onResourceUnavailable
}: {
  stacks: RuntimeSnapshot["stacks"];
  previews: RuntimeSnapshot["previews"];
  services: RuntimeSnapshot["services"];
  busyStackId: string | null;
  busyServiceId: string | null;
  onFocusThread: (threadId: string | null) => void;
  onPinStack: (stackId: string, pinned: boolean) => void;
  onStopStack: (stackId: string) => void;
  onPinPreview: (leaseId: string, pinned: boolean) => void;
  onStopPreview: (leaseId: string) => void;
  onPinService: (serviceId: string, pinned: boolean) => void;
  onStopService: (serviceId: string) => void;
  onPreviewArtifact: (media: PreviewMedia) => void;
  onResourceUnavailable: (message: string) => void;
}) {
  return (
    <>
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
                  <button className="panel-action" onClick={() => onPinStack(stack.id, !stack.pinned)}>
                    {stack.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button className="panel-action" onClick={() => onStopStack(stack.id)} disabled={busyStackId === stack.id}>
                    {busyStackId === stack.id ? "Stopping…" : "Stop"}
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
                  <button className="panel-action" onClick={() => onPinPreview(lease.id, !lease.pinned)}>
                    {lease.pinned ? "Unpin" : "Pin"}
                  </button>
                  <a className="panel-action panel-action-link" href={lease.operatorUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                  <button className="panel-action" onClick={() => onStopPreview(lease.id)}>
                    Stop
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
                  <button className="panel-action" onClick={() => onPinService(service.id, !service.pinned)}>
                    {service.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button className="panel-action" onClick={() => onStopService(service.id)} disabled={busyServiceId === service.id}>
                    {busyServiceId === service.id ? "Stopping…" : "Stop"}
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
