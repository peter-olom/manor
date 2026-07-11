import { useEffect, useState } from "react";

import { TerminalTabIcon } from "./icons";

import {
  TERMINAL_LABELS,
  TERMINAL_TARGETS,
  TERMINAL_URLS,
  type TerminalTarget
} from "../shared/terminal";

type TerminalPaneProps = {
  active: boolean;
  target: TerminalTarget;
  onTarget: (target: TerminalTarget) => void;
};

export function TerminalPane({ active, target, onTarget }: TerminalPaneProps) {
  const [visited, setVisited] = useState(active);
  const [mountedTargets, setMountedTargets] = useState<Set<TerminalTarget>>(() => new Set([target]));

  useEffect(() => {
    if (!active) return;
    setVisited(true);
    setMountedTargets((current) => {
      if (current.has(target)) return current;
      const next = new Set(current);
      next.add(target);
      return next;
    });
  }, [active, target]);

  if (!visited) return null;

  return (
    <section
      className={`cli-pane ${active ? "is-active" : ""}`}
      aria-label="Agent CLIs"
      aria-hidden={!active}
    >
      <div className="cli-panel">
        <header className="cli-head">
          <div className="cli-head-info">
            <span className="cli-head-icon" aria-hidden="true">
              <TerminalTabIcon />
            </span>
            <h1>CLI</h1>
            <span className="cli-head-sub">Choose an agent environment. Sessions stay alive across views.</span>
          </div>
          <div className="cli-tabs" role="tablist" aria-label="CLI target">
            {TERMINAL_TARGETS.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={target === item}
                className={`cli-tab ${target === item ? "is-active" : ""}`}
                onClick={() => onTarget(item)}
              >
                {TERMINAL_LABELS[item]}
              </button>
            ))}
          </div>
        </header>
        <div className="cli-body">
          {TERMINAL_TARGETS.map((item) => {
            const url = TERMINAL_URLS[item];
            if (!mountedTargets.has(item)) return null;
            return (
              <iframe
                key={`${item}:${url}`}
                className={`cli-frame ${target === item ? "is-active" : ""}`}
                title={TERMINAL_LABELS[item]}
                src={url}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
