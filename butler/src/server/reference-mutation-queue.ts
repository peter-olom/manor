import { AsyncLocalStorage } from "node:async_hooks";

export class ReferenceMutationQueue {
  private readonly context = new AsyncLocalStorage<boolean>();
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return operation();
    const execute = () => this.context.run(true, operation);
    const result = this.tail.then(execute, execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
