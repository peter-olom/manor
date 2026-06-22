import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

import { getJson, postJson } from "./api";
import { ButlerTabIcon, SendIcon, StatusIcon, ThreadsIcon } from "./icons";
import { useVirtualWindow } from "./useVirtualWindow";
import type { PairDetail, PairDetailResponse, PairListResponse, PairMemoryCard, PairMemoryResponse, PairSummary, PairViewMode, PairWorkerThreadResponse } from "../shared/pairing";

type WorkerItem = {
  id: string;
  type: string;
  status: string;
  text: string;
  at: number;
};

type WorkerTurn = {
  id: string;
  status: string;
  items: WorkerItem[];
};

type WorkerThread = {
  id: string;
  status: string;
  preview?: string;
  supervisor?: { latestAgentReply?: string | null; summary?: string | null };
  turns?: WorkerTurn[];
  workerReport?: { status: string; summary: string; details: string | null; updatedAt: number } | null;
};

const PAIR_PAGE_SIZE = 120;

const VIEW_MODE_LABELS: Record<PairViewMode, string> = {
  butler: "Butler",
  worker: "Codex",
  split: "Both"
};

function formatTime(value: number | null | undefined): string {
  if (!value) return "--:--";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortId(value: string | null | undefined): string {
  if (!value) return "none";
  return value.split("-").at(-1) ?? value.slice(0, 8);
}

function statusLabel(pair: Pick<PairSummary, "status">): string {
  if (pair.status === "ready_to_handoff") return "ready";
  if (pair.status === "worker_running") return "working";
  if (pair.status === "needs_butler_review") return "review";
  return pair.status;
}

function workerStatusText(pair: PairDetail, thread: WorkerThread | null): string {
  if (!pair.worker) return "No worker attached";
  return `${thread?.status ?? pair.worker.status} · one worker max`;
}

function PairList({ pairs, selectedPairId, onSelect, onCreate }: { pairs: PairSummary[]; selectedPairId: string | null; onSelect: (id: string) => void; onCreate: () => void }) {
  const virtual = useVirtualWindow({ count: pairs.length, rowHeight: 86, overscan: 8 });
  const visible = pairs.slice(virtual.start, virtual.end);
  return (
    <aside className="pair-sidebar">
      <div className="pair-sidebar-head">
        <div>
          <div className="pair-brand">Butler pairs</div>
          <div className="pair-brand-sub">{pairs.length} active {pairs.length === 1 ? "thread" : "threads"}</div>
        </div>
        <button className="pair-primary-button" type="button" onClick={onCreate}>
          <ThreadsIcon />
          <span>New</span>
        </button>
      </div>
      <div className="pair-list" ref={virtual.viewportRef} onScroll={virtual.onScroll} data-virtualized-count={pairs.length}>
        <div style={{ height: virtual.totalHeight, position: "relative" }}>
          <div style={{ transform: `translateY(${virtual.offsetTop}px)` }}>
            {visible.map((pair) => (
              <button key={pair.id} className={`pair-list-item ${pair.id === selectedPairId ? "is-selected" : ""}`} type="button" onClick={() => onSelect(pair.id)}>
                <span className="pair-list-title">{pair.title}</span>
                <span className="pair-list-meta">
                  <span className={`pair-status is-${pair.status}`}>{statusLabel(pair)}</span>
                  <span>{pair.messageCount} msgs</span>
                  <span>{formatTime(pair.updatedAt)}</span>
                </span>
                <span className="pair-list-preview">{pair.lastMessage?.text ?? "No messages yet"}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function MessageRows({ pair, onLoadOlder }: { pair: PairDetail; onLoadOlder: () => void }) {
  const messages = useDeferredValue(pair.messages);
  const virtual = useVirtualWindow({ count: messages.length, rowHeight: 154, overscan: 10 });
  const visible = messages.slice(virtual.start, virtual.end);
  return (
    <div className="pair-transcript" ref={virtual.viewportRef} onScroll={virtual.onScroll} data-virtualized-count={messages.length}>
      {pair.hasMore ? <button className="pair-load-button" type="button" onClick={onLoadOlder}>Load older</button> : null}
      <div style={{ height: virtual.totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${virtual.offsetTop}px)` }}>
          {visible.map((message) => (
            <article key={message.id} className={`pair-message is-${message.role} in-${message.lane}`}>
              <header>
                <span>{message.role === "user" ? "You" : message.role === "worker" ? "Codex" : "Butler"}</span>
                <time>{formatTime(message.at)}</time>
              </header>
              <p>{message.text}</p>
              {message.sourceThreadId ? <footer>worker {shortId(message.sourceThreadId)}</footer> : null}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function MemoryStrip({ cards, handoff }: { cards: PairMemoryCard[]; handoff: string | null }) {
  return (
    <section className="pair-memory-strip" aria-label="Pair memory">
      {cards.slice(0, 4).map((card) => (
        <article key={card.id} className={`pair-memory-card is-${card.kind}`}>
          <strong>{card.title}</strong>
          <span>{card.body}</span>
          {card.meta ? <em>{card.meta}</em> : null}
        </article>
      ))}
      {handoff ? (
        <article className="pair-memory-card is-handoff">
          <strong>Latest handoff</strong>
          <span>{handoff}</span>
        </article>
      ) : null}
    </section>
  );
}

function ButlerPane({ pair, cards, draft, busy, onDraft, onSend, onSpinWorker, onLoadOlder }: { pair: PairDetail; cards: PairMemoryCard[]; draft: string; busy: boolean; onDraft: (value: string) => void; onSend: () => void; onSpinWorker: () => void; onLoadOlder: () => void }) {
  return (
    <section className="pair-pane pair-butler-pane">
      <div className="pair-pane-head">
        <div>
          <h1>{pair.title}</h1>
          <span>Butler · {shortId(pair.id)} · {pair.messages.length} loaded</span>
        </div>
        <button className="pair-secondary-button" type="button" disabled={Boolean(pair.worker) || busy} onClick={onSpinWorker}>
          <StatusIcon kind="codex" />
          <span>{pair.worker ? "Worker attached" : "Spin worker"}</span>
        </button>
      </div>
      <MemoryStrip cards={cards} handoff={pair.lastHandoffPrompt} />
      <MessageRows pair={pair} onLoadOlder={onLoadOlder} />
      <form className="pair-composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
        <textarea value={draft} onChange={(event) => onDraft(event.target.value)} placeholder="Message Butler" rows={3} />
        <button className="pair-primary-button" type="submit" disabled={busy || !draft.trim()}>
          <SendIcon />
          <span>Send</span>
        </button>
      </form>
    </section>
  );
}

function flattenWorker(thread: WorkerThread | null): WorkerItem[] {
  if (!thread) return [];
  const turnItems = (thread.turns ?? []).flatMap((turn) => (turn.items ?? []).map((item) => ({ ...item, id: `${turn.id}:${item.id}`, status: item.status || turn.status })));
  if (thread.workerReport) {
    turnItems.push({
      id: `report:${thread.workerReport.updatedAt}`,
      type: "worker_report",
      status: thread.workerReport.status,
      text: `${thread.workerReport.summary}${thread.workerReport.details ? `\n\n${thread.workerReport.details}` : ""}`,
      at: thread.workerReport.updatedAt
    });
  }
  return turnItems.filter((item) => item.text?.trim()).sort((left, right) => left.at - right.at);
}

function WorkerRows({ rows }: { rows: WorkerItem[] }) {
  const virtual = useVirtualWindow({ count: rows.length, rowHeight: 154, overscan: 8 });
  const visible = rows.slice(virtual.start, virtual.end);
  return (
    <div className="pair-transcript worker-transcript" ref={virtual.viewportRef} onScroll={virtual.onScroll} data-virtualized-count={rows.length}>
      <div style={{ height: virtual.totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${virtual.offsetTop}px)` }}>
          {visible.map((row) => (
            <article key={row.id} className={`pair-message is-worker in-worker`}>
              <header>
                <span>{row.type.replace(/_/g, " ")}</span>
                <time>{formatTime(row.at)}</time>
              </header>
              <p>{row.text}</p>
              <footer>{row.status}</footer>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function WorkerPane({ pair, thread, draft, busy, onDraft, onSend, onRevert, onSpinWorker }: { pair: PairDetail; thread: WorkerThread | null; draft: string; busy: boolean; onDraft: (value: string) => void; onSend: () => void; onRevert: () => void; onSpinWorker: () => void }) {
  const rows = useMemo(() => {
    const workerRows = flattenWorker(thread);
    if (workerRows.length > 0 || !pair.worker) return workerRows;
    return [
      {
        id: `task:${pair.worker.threadId}`,
        type: "assigned_task",
        status: pair.worker.status,
        text: pair.worker.task,
        at: pair.worker.startedAt
      },
      {
        id: `handoff:${pair.worker.threadId}`,
        type: "handoff_prompt",
        status: pair.worker.status,
        text: pair.worker.handoffPrompt,
        at: pair.worker.startedAt
      }
    ];
  }, [pair.worker, thread]);
  if (!pair.worker) {
    return (
      <section className="pair-pane pair-worker-pane is-empty">
        <div className="pair-empty-state">
          <h2>No worker attached</h2>
          <p>Start Codex when this chat needs implementation work.</p>
          <button className="pair-primary-button" type="button" disabled={busy} onClick={onSpinWorker}>
            <StatusIcon kind="codex" />
            <span>Spin worker</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="pair-pane pair-worker-pane">
      <div className="pair-pane-head">
        <div>
          <h2>Codex worker {shortId(pair.worker.threadId)}</h2>
          <span>{workerStatusText(pair, thread)}</span>
        </div>
        <button className="pair-secondary-button" type="button" disabled={busy} onClick={onRevert}>
          <ButlerTabIcon />
          <span>Return to Butler</span>
        </button>
      </div>
      <WorkerRows rows={rows} />
      <form className="pair-composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
        <textarea value={draft} onChange={(event) => onDraft(event.target.value)} placeholder="Send to worker" rows={3} />
        <button className="pair-primary-button" type="submit" disabled={busy || !draft.trim()}>
          <SendIcon />
          <span>Handoff</span>
        </button>
      </form>
    </section>
  );
}

export function PairShell() {
  const [pairs, setPairs] = useState<PairSummary[]>([]);
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);
  const [pair, setPair] = useState<PairDetail | null>(null);
  const [memoryCards, setMemoryCards] = useState<PairMemoryCard[]>([]);
  const [workerThread, setWorkerThread] = useState<WorkerThread | null>(null);
  const [viewMode, setViewMode] = useState<PairViewMode>("split");
  const [draft, setDraft] = useState("");
  const [workerDraft, setWorkerDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPairs = useCallback(async () => {
    const payload = await getJson<PairListResponse>("/api/pairs");
    startTransition(() => {
      setPairs(payload.pairs);
      setSelectedPairId((current) => current ?? payload.pairs[0]?.id ?? null);
    });
  }, []);

  const loadPair = useCallback(async (pairId: string) => {
    const payload = await getJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(pairId)}?limit=${PAIR_PAGE_SIZE}`);
    startTransition(() => setPair(payload.pair));
  }, []);

  const loadMemory = useCallback(async (pairId: string) => {
    const payload = await getJson<PairMemoryResponse>(`/api/pairs/${encodeURIComponent(pairId)}/memory`);
    startTransition(() => setMemoryCards(payload.cards));
  }, []);

  const loadWorker = useCallback(async (pairId: string) => {
    const payload = await getJson<PairWorkerThreadResponse>(`/api/pairs/${encodeURIComponent(pairId)}/worker-thread`);
    startTransition(() => setWorkerThread((payload.thread as WorkerThread | null) ?? null));
  }, []);

  useEffect(() => {
    void loadPairs().catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
    const interval = window.setInterval(() => void loadPairs().catch(() => undefined), 2500);
    return () => window.clearInterval(interval);
  }, [loadPairs]);

  useEffect(() => {
    if (!selectedPairId) {
      setPair(null);
      return;
    }
    void loadPair(selectedPairId).catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
    void loadMemory(selectedPairId).catch(() => undefined);
  }, [loadMemory, loadPair, selectedPairId]);

  useEffect(() => {
    if (!pair?.worker || viewMode === "butler") {
      setWorkerThread(null);
      return;
    }
    void loadWorker(pair.id).catch(() => undefined);
    const interval = window.setInterval(() => void loadWorker(pair.id).catch(() => undefined), 3000);
    return () => window.clearInterval(interval);
  }, [loadWorker, pair?.id, pair?.worker?.threadId, viewMode]);

  async function createPair() {
    setBusy(true);
    setError(null);
    try {
      const payload = await postJson<PairDetailResponse>("/api/pairs", { title: "New Butler chat" });
      await loadPairs();
      setSelectedPairId(payload.pair.id);
      setPair(payload.pair);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  }

  async function loadOlder() {
    if (!pair?.hasMore) return;
    const payload = await getJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(pair.id)}?before=${pair.loadedStart}&limit=${PAIR_PAGE_SIZE}`);
    setPair((current) => current && current.id === payload.pair.id ? { ...current, messages: [...payload.pair.messages, ...current.messages], loadedStart: payload.pair.loadedStart, hasMore: payload.pair.hasMore } : current);
  }

  async function sendMessage(target: "butler" | "worker") {
    if (!pair) return;
    const text = target === "worker" ? workerDraft.trim() : draft.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await postJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(pair.id)}/messages`, { text, target });
      setPair(payload.pair);
      if (target === "worker") setWorkerDraft("");
      else setDraft("");
      await loadPairs();
      await loadMemory(pair.id).catch(() => undefined);
      if (target === "worker") await loadWorker(pair.id).catch(() => undefined);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setBusy(false);
    }
  }

  async function spinWorker() {
    if (!pair) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await postJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(pair.id)}/worker`, { task: draft.trim() || pair.title, cwd: pair.defaultCwd, effort: "xhigh" });
      setPair(payload.pair);
      setDraft("");
      setViewMode("split");
      await loadPairs();
      await loadWorker(pair.id).catch(() => undefined);
    } catch (spinError) {
      setError(spinError instanceof Error ? spinError.message : String(spinError));
    } finally {
      setBusy(false);
    }
  }

  async function revertWorker() {
    if (!pair?.worker) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await postJson<PairDetailResponse>(`/api/pairs/${encodeURIComponent(pair.id)}/worker/revert`, {});
      setPair(payload.pair);
      setViewMode("butler");
      await loadPairs();
    } catch (revertError) {
      setError(revertError instanceof Error ? revertError.message : String(revertError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pair-app-shell">
      <PairList pairs={pairs} selectedPairId={selectedPairId} onSelect={setSelectedPairId} onCreate={createPair} />
      <section className="pair-workspace">
        <header className="pair-topbar">
          <div className="pair-segments" role="tablist" aria-label="Pair view mode">
            {(["butler", "worker", "split"] as PairViewMode[]).map((mode) => (
              <button key={mode} type="button" className={viewMode === mode ? "is-selected" : ""} onClick={() => setViewMode(mode)}>{VIEW_MODE_LABELS[mode]}</button>
            ))}
          </div>
          <div className="pair-topbar-status">
            {pair ? <span className={`pair-status is-${pair.status}`}>{statusLabel(pair)}</span> : null}
            {error ? <span className="pair-error">{error}</span> : null}
          </div>
        </header>
        {!pair ? (
          <div className="pair-empty-state">
            <h1>No Butler chats</h1>
            <button className="pair-primary-button" type="button" onClick={createPair}>New Butler chat</button>
          </div>
        ) : (
          <div className={`pair-layout is-${viewMode}`}>
            {viewMode !== "worker" ? <ButlerPane pair={pair} cards={memoryCards} draft={draft} busy={busy} onDraft={setDraft} onSend={() => void sendMessage("butler")} onSpinWorker={() => void spinWorker()} onLoadOlder={() => void loadOlder()} /> : null}
            {viewMode !== "butler" ? <WorkerPane pair={pair} thread={workerThread} draft={workerDraft} busy={busy} onDraft={setWorkerDraft} onSend={() => void sendMessage("worker")} onRevert={() => void revertWorker()} onSpinWorker={() => void spinWorker()} /> : null}
          </div>
        )}
      </section>
    </main>
  );
}
