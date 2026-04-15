import { StatusIcon } from "./icons";

export function StatusItem({
  kind,
  tone,
  label,
  value
}: {
  kind: "codex" | "auth" | "model" | "context" | "compaction";
  tone: "accent" | "success" | "danger" | "neutral";
  label: string;
  value: string;
}) {
  return (
    <div className={`status-item is-${tone}`}>
      <span className="status-item-icon">
        <StatusIcon kind={kind} />
      </span>
      <span className="status-item-copy">
        <span className="status-item-label">{label}</span>
        <span className="status-item-value">{value}</span>
      </span>
    </div>
  );
}
