import type { ProviderRuntimeEvent } from "../shared/provider-runtime.js";

export class CodexOperationGuard {
  private readonly generations = new Map<string, number>();
  private readonly acceptedEventGenerations = new Map<string, number>();
  private readonly resolvedEventGenerations = new Map<string, number>();
  private readonly turnGenerations = new Map<string, Map<string, number>>();
  private readonly bufferedEvents = new Map<string, Map<string, ProviderRuntimeEvent[]>>();

  constructor(private readonly isDeleted: (threadId: string) => boolean) {}

  current(threadId: string): number {
    return this.generations.get(threadId) ?? 0;
  }

  advance(threadId: string): number {
    const generation = this.current(threadId) + 1;
    this.generations.set(threadId, generation);
    return generation;
  }

  begin(threadId: string): number {
    const generation = this.advance(threadId);
    this.acceptedEventGenerations.set(threadId, generation);
    this.resolvedEventGenerations.delete(threadId);
    return generation;
  }

  invalidate(threadId: string): number {
    const generation = this.advance(threadId);
    this.acceptedEventGenerations.delete(threadId);
    this.resolvedEventGenerations.delete(threadId);
    this.bufferedEvents.delete(threadId);
    return generation;
  }

  isCurrent(threadId: string, generation: number): boolean {
    return !this.isDeleted(threadId) && this.current(threadId) === generation;
  }

  hasCurrentAcceptedOperation(threadId: string): boolean {
    const generation = this.current(threadId);
    return !this.isDeleted(threadId) && this.acceptedEventGenerations.get(threadId) === generation;
  }

  bindTurn(threadId: string, turnId: string, generation: number): ProviderRuntimeEvent[] {
    const turns = this.turnGenerations.get(threadId) ?? new Map<string, number>();
    turns.set(turnId, generation);
    this.turnGenerations.set(threadId, turns);
    const operationIsCurrent = this.isCurrent(threadId, generation);
    if (operationIsCurrent) this.resolvedEventGenerations.set(threadId, generation);

    const bufferedTurns = this.bufferedEvents.get(threadId);
    const buffered = bufferedTurns?.get(turnId) ?? [];
    if (operationIsCurrent) {
      this.bufferedEvents.delete(threadId);
    } else {
      bufferedTurns?.delete(turnId);
      if (bufferedTurns?.size === 0) this.bufferedEvents.delete(threadId);
      turns.delete(turnId);
      if (turns.size === 0) this.turnGenerations.delete(threadId);
    }
    return operationIsCurrent ? buffered : [];
  }

  generationForEvent(event: ProviderRuntimeEvent): number | null | undefined {
    if (!this.isOperationScopedEvent(event)) return null;
    if (!event.turnId) {
      const accepted = this.acceptedEventGenerations.get(event.threadId);
      if (accepted === undefined) return this.generations.has(event.threadId) ? undefined : null;
      return this.resolvedEventGenerations.get(event.threadId) === accepted ? accepted : undefined;
    }

    const bound = this.turnGenerations.get(event.threadId)?.get(event.turnId);
    if (bound !== undefined) return bound;
    const accepted = this.acceptedEventGenerations.get(event.threadId);
    if (accepted === undefined) return this.generations.has(event.threadId) ? undefined : null;
    if (this.resolvedEventGenerations.get(event.threadId) === accepted) return undefined;

    const bufferedTurns = this.bufferedEvents.get(event.threadId) ?? new Map<string, ProviderRuntimeEvent[]>();
    if (!bufferedTurns.has(event.turnId) && bufferedTurns.size >= 32) return undefined;
    const buffered = bufferedTurns.get(event.turnId) ?? [];
    if (buffered.length < 128) buffered.push(event);
    bufferedTurns.set(event.turnId, buffered);
    this.bufferedEvents.set(event.threadId, bufferedTurns);
    return undefined;
  }

  eventIsCurrent(threadId: string, generation: number | null): boolean {
    if (this.isDeleted(threadId)) return false;
    return generation === null || (
      this.acceptedEventGenerations.get(threadId) === generation
      && this.current(threadId) === generation
    );
  }

  completeEvent(event: ProviderRuntimeEvent): void {
    if ((event.type !== "turn.completed" && event.type !== "turn.aborted") || !event.turnId) return;
    const turns = this.turnGenerations.get(event.threadId);
    turns?.delete(event.turnId);
    if (turns?.size === 0) this.turnGenerations.delete(event.threadId);
  }

  clearThread(threadId: string): void {
    this.generations.delete(threadId);
    this.acceptedEventGenerations.delete(threadId);
    this.resolvedEventGenerations.delete(threadId);
    this.turnGenerations.delete(threadId);
    this.bufferedEvents.delete(threadId);
  }

  clear(): void {
    this.generations.clear();
    this.acceptedEventGenerations.clear();
    this.resolvedEventGenerations.clear();
    this.turnGenerations.clear();
    this.bufferedEvents.clear();
  }

  private isOperationScopedEvent(event: ProviderRuntimeEvent): boolean {
    return event.type === "thread.state.changed"
      || event.type === "session.exited"
      || event.type.startsWith("turn.")
      || event.type.startsWith("item.")
      || event.type === "content.delta";
  }
}
