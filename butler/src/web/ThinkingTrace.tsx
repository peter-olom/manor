import { memo } from "react";

import { BrainIcon, CommandIcon, FileChangeIcon, ToolIcon, DotIcon } from "./icons";
import { Markdown } from "./Markdown";

import type { PairTraceItem } from "../shared/pairing";

const ITEM_LABELS: Record<PairTraceItem["type"], string> = {
  reasoning: "Thinking",
  command_execution: "Command",
  file_change: "File change",
  plan: "Plan",
  mcp_tool_call: "MCP tool",
  dynamic_tool_call: "Tool",
  web_search: "Web search",
  image_view: "Image",
  context_compaction: "Compaction",
  user_message: "User",
  assistant_message: "Assistant",
  error: "Error",
  unknown: "Item"
};

function shortText(value: string, max = 160): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

type TraceItemViewProps = {
  item: PairTraceItem;
};

const TraceItemView = memo(function TraceItemView({ item }: TraceItemViewProps) {
  const statusClass = item.status === "failed" ? "is-failed" : item.status === "in_progress" ? "is-active" : "is-done";
  const label = item.title?.trim() || ITEM_LABELS[item.type] || "Item";
  const icon = (() => {
    switch (item.type) {
      case "reasoning":
        return <BrainIcon />;
      case "command_execution":
        return <CommandIcon />;
      case "file_change":
        return <FileChangeIcon />;
      case "dynamic_tool_call":
      case "mcp_tool_call":
        return <ToolIcon />;
      default:
        return <DotIcon />;
    }
  })();

  if (item.type === "reasoning") {
    return (
      <article className={`trace-item is-reasoning ${statusClass}`}>
        <header className="trace-head">
          <span className="trace-icon">{icon}</span>
          <span className="trace-label">{label}</span>
          {item.status === "in_progress" ? <span className="trace-status">streaming</span> : null}
        </header>
        <Markdown className="trace-body" text={item.text} />
      </article>
    );
  }

  return (
    <details className={`trace-item is-tool ${statusClass}`} open={item.status === "failed"}>
      <summary className="trace-head">
        <span className="trace-icon">{icon}</span>
        <span className="trace-label">{label}</span>
        {item.text ? <span className="trace-summary">{shortText(item.text, 200)}</span> : null}
        <span className="trace-status">{item.status === "in_progress" ? "running" : item.status}</span>
      </summary>
      {item.text ? <Markdown className="trace-body" text={item.text} /> : null}
    </details>
  );
});

type ThinkingTraceProps = {
  items: PairTraceItem[];
};

export const ThinkingTrace = memo(function ThinkingTrace({ items }: ThinkingTraceProps) {
  if (items.length === 0) return null;
  return (
    <div className="trace" role="list" aria-label="Reasoning and tool trace">
      {items.map((item) => (
        <div role="listitem" key={item.id}>
          <TraceItemView item={item} />
        </div>
      ))}
    </div>
  );
});

export function summarizeTrace(items: PairTraceItem[]): { count: number; commands: number; files: number; tools: number; thinking: number; durationMs: number } {
  let commands = 0;
  let files = 0;
  let tools = 0;
  let thinking = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  for (const item of items) {
    if (item.type === "command_execution") commands += 1;
    else if (item.type === "file_change") files += 1;
    else if (item.type === "dynamic_tool_call" || item.type === "mcp_tool_call") tools += 1;
    else if (item.type === "reasoning") thinking += 1;
    if (firstAt === null || item.at < firstAt) firstAt = item.at;
    const end = item.completedAt ?? item.at;
    if (lastAt === null || end > lastAt) lastAt = end;
  }
  const durationMs = firstAt !== null && lastAt !== null ? Math.max(0, lastAt - firstAt) : 0;
  return { count: items.length, commands, files, tools, thinking, durationMs };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function traceDisclosureLabel(items: PairTraceItem[]): string {
  if (items.length === 0) return "Thought for 0 steps";
  const summary = summarizeTrace(items);
  const parts: string[] = [`${summary.count} step${summary.count === 1 ? "" : "s"}`];
  if (summary.commands > 0) parts.push(`${summary.commands} command${summary.commands === 1 ? "" : "s"}`);
  if (summary.files > 0) parts.push(`${summary.files} file${summary.files === 1 ? "" : "s"}`);
  if (summary.tools > 0) parts.push(`${summary.tools} tool${summary.tools === 1 ? "" : "s"}`);
  if (summary.durationMs > 0) parts.push(formatDuration(summary.durationMs));
  return `Thought for ${parts.join(" · ")}`;
}
