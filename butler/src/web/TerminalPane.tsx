import { TerminalTabIcon } from "./icons";

import type { TerminalTarget } from "../shared/terminal";

type TerminalPaneProps = {
  active: boolean;
  target: TerminalTarget;
  onTarget: (target: TerminalTarget) => void;
  labels: Record<TerminalTarget, string>;
  urls: Record<TerminalTarget, string>;
};

export function TerminalPane({ active, target, onTarget, labels, urls }: TerminalPaneProps) {
  return (
    <section
      className={`cli-pane ${active ? "is-active" : ""}`}
      aria-label="Box CLIs"
      aria-hidden={!active}
    >
      <div className="cli-panel">
        <header className="cli-head">
          <div className="cli-head-info">
            <span className="cli-head-icon" aria-hidden="true">
              <TerminalTabIcon />
            </span>
            <h1>CLI</h1>
            <span className="cli-head-sub">Pick a target to keep the session alive across tabs.</span>
          </div>
          <div className="cli-tabs" role="tablist" aria-label="CLI target">
            {(["butler", "codex"] as TerminalTarget[]).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={target === item}
                className={`cli-tab ${target === item ? "is-active" : ""}`}
                onClick={() => onTarget(item)}
              >
                {labels[item]}
              </button>
            ))}
          </div>
        </header>
        <div className="cli-body">
          {(["butler", "codex"] as TerminalTarget[]).map((item) => (
            <iframe
              key={item}
              className={`cli-frame ${target === item ? "is-active" : ""}`}
              title={labels[item]}
              src={urls[item]}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
