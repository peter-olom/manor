import type { ButlerActivityTurnView } from "./types.js";
import { normalizeButlerActivitySummaryTurns } from "./butler-activity.js";
import { readJsonStateFile, writeJsonStateFileAtomic } from "./json-state-file.js";

type ActivitySummaryWriter = (filePath: string, turns: ButlerActivityTurnView[]) => Promise<void>;

function cloneTurns(turns: ButlerActivityTurnView[]): ButlerActivityTurnView[] {
  return turns.map((turn) => ({
    ...turn,
    items: turn.items.map((item) => ({ ...item }))
  }));
}

export class ButlerActivitySummaryState {
  private saveTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly turns: ButlerActivityTurnView[],
    private readonly onSaveError: (error: unknown) => void,
    private readonly write: ActivitySummaryWriter = (target, value) => writeJsonStateFileAtomic(target, value)
  ) {}

  async load(): Promise<void> {
    const parsed = await readJsonStateFile(this.filePath, []);
    this.turns.splice(0, this.turns.length, ...normalizeButlerActivitySummaryTurns(parsed));
  }

  persistTurn(turn: ButlerActivityTurnView): Promise<void> {
    const nextTurns = normalizeButlerActivitySummaryTurns([
      ...this.turns.filter((entry) => entry.id !== turn.id),
      turn
    ]);
    this.turns.splice(0, this.turns.length, ...nextTurns);
    return this.save();
  }

  save(): Promise<void> {
    const snapshot = cloneTurns(this.turns);
    const save = this.saveTail.catch(() => undefined).then(() => this.write(this.filePath, snapshot));
    this.saveTail = save;
    void save.catch((error) => this.onSaveError(error));
    return save;
  }

  drain(): Promise<void> {
    return this.saveTail;
  }
}
