import { useEffect, useMemo, useRef, useState } from "react";

import type { PairCodexModelOption, PairWorker } from "../shared/pairing";
import { BudgetSegmented } from "./BudgetSegmented";
import { ModelPicker } from "./ModelPicker";
import { workerModelLabel, workerProviderForModelLabel, workerProviderLabel, workerRuntimeForModel, workerRuntimeLabel } from "./worker-route";

type WorkerSwitchDialogProps = {
  open: boolean;
  activeWorker: PairWorker;
  models: PairCodexModelOption[];
  initialModel: string | null;
  initialEffort: string | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (model: string, effort: string | null) => void;
};

function effortForModel(model: PairCodexModelOption | null, requested: string | null): string | null {
  if (!model || model.supportedReasoningEfforts.length === 0) return null;
  if (requested && model.supportedReasoningEfforts.includes(requested)) return requested;
  return model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? null;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  )].filter((element) => element.getClientRects().length > 0);
}

export function WorkerSwitchDialog({
  open,
  activeWorker,
  models,
  initialModel,
  initialEffort,
  pending,
  error,
  onClose,
  onConfirm
}: WorkerSwitchDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const initializedOpenRef = useRef(false);
  const pendingRef = useRef(pending);
  const onCloseRef = useRef(onClose);
  pendingRef.current = pending;
  onCloseRef.current = onClose;
  const [modelId, setModelId] = useState<string | null>(initialModel);
  const [effort, setEffort] = useState<string | null>(initialEffort);
  const selected = useMemo(() => models.find((model) => model.id === modelId) ?? models[0] ?? null, [modelId, models]);
  const selectedEffort = effortForModel(selected, effort);

  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false;
      return;
    }
    if (initializedOpenRef.current) return;
    initializedOpenRef.current = true;
    const configuredModel = models.find((model) => model.id === initialModel && model.id !== activeWorker.model);
    const nextModel = configuredModel ?? models.find((model) => model.id !== activeWorker.model) ?? models[0] ?? null;
    setModelId(nextModel?.id ?? null);
    setEffort(effortForModel(nextModel, initialEffort));
  }, [activeWorker.model, initialEffort, initialModel, models, open]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const initialTarget = dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="Next worker model"]') ?? closeRef.current;
      initialTarget?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (event.defaultPrevented) return;
        event.preventDefault();
        if (!pendingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;
  const nextRuntime = selected ? workerRuntimeForModel(selected) : null;
  const sameModel = selected?.id === activeWorker.model;
  const hasAlternativeModel = models.some((model) => model.id !== activeWorker.model);

  return (
    <div className="modal-backdrop worker-switch-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section ref={dialogRef} className="modal worker-switch-dialog" role="dialog" aria-modal="true" aria-labelledby="worker-switch-title" aria-describedby="worker-switch-description worker-switch-cache-note" tabIndex={-1}>
        <header>
          <div>
            <h2 id="worker-switch-title">Switch worker</h2>
            <p id="worker-switch-description">Start a new worker with the current task, progress, and review baseline.</p>
          </div>
          <button ref={closeRef} className="icon-button" type="button" aria-label="Close worker switch" disabled={pending} onClick={onClose}>×</button>
        </header>
        <div className="worker-switch-route" aria-label="Worker route change">
          <div><span>Active</span><strong>{workerProviderLabel(activeWorker.provider)} · {workerModelLabel(models, activeWorker.model)} · {workerRuntimeLabel(activeWorker.runtime)}</strong></div>
          <div><span>Next</span><strong>{selected ? `${workerProviderForModelLabel(selected)} · ${selected.label} · ${workerRuntimeLabel(nextRuntime)}` : "No worker available"}</strong></div>
        </div>
        <div className="worker-switch-fields">
          <ModelPicker
            label="Next worker model"
            value={selected?.id ?? null}
            options={models}
            anchor="below"
            className="worker-switch-model"
            disabled={pending}
            onChange={(next) => {
              const nextModel = models.find((model) => model.id === next) ?? null;
              setModelId(nextModel?.id ?? null);
              setEffort(effortForModel(nextModel, effort));
            }}
          />
          {selected && selected.supportedReasoningEfforts.length > 0 ? (
            <BudgetSegmented label="Thinking" value={selectedEffort} options={selected.supportedReasoningEfforts} disabled={pending} onChange={setEffort} />
          ) : <div className="worker-switch-na"><span>Thinking</span><strong>N/A</strong></div>}
        </div>
        <p id="worker-switch-cache-note" className="worker-switch-note">The new provider cache starts cold. The previous worker remains in history.</p>
        {!hasAlternativeModel ? <p className="worker-switch-warning">No other worker model is available.</p> : sameModel ? <p className="worker-switch-warning">Choose a different model. Thinking can be changed on the active worker.</p> : null}
        {error ? <div className="error worker-switch-error" role="alert">{error}</div> : null}
        <footer>
          <button className="button" type="button" disabled={pending} onClick={onClose}>Cancel</button>
          <button className="button is-primary" type="button" disabled={pending || !selected || sameModel || !hasAlternativeModel} onClick={() => selected && onConfirm(selected.id, selectedEffort)}>
            {pending ? "Switching…" : "Switch with handoff"}
          </button>
        </footer>
      </section>
    </div>
  );
}
