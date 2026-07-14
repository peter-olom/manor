import { AutomationIcon, TrashIcon } from "./icons";

import type { PairSummary } from "../shared/pairing";

function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDay(value: number): string {
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? formatTime(value)
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function PairRow({
  pair,
  isActive,
  onSelect,
  onDelete
}: {
  pair: PairSummary;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`pair-item ${isActive ? "is-active" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className={`pair-dot is-${pair.status}`} aria-hidden="true" />
      <div className="pair-title">
        <span>{pair.title}</span>
        {pair.automation ? (
          <span
            className={`pair-automation-icon ${pair.automation.enabled ? "" : "is-paused"} ${pair.automation.lastRun?.outcome === "failed" ? "is-failed" : ""}`}
            role="img"
            aria-label={`Automation ${pair.automation.state}: ${pair.automation.scheduleLabel}`}
          ><AutomationIcon /></span>
        ) : null}
      </div>
      <div className="pair-preview">{pair.lastMessage?.text ?? "No messages yet"}</div>
      <div className="pair-meta">
        <span className="pair-meta-time">{formatDay(pair.updatedAt)}</span>
        <span>{pair.messageCount}</span>
      </div>
      <button
        className="icon-button pair-delete"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        aria-label={`Delete ${pair.title}`}
      >
        <TrashIcon />
      </button>
    </div>
  );
}
