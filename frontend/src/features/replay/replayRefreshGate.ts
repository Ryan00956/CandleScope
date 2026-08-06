export class ReplayRefreshGate {
  private readonly inFlight = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const current = this.inFlight.get(key);
    if (current !== undefined) return current;

    const pending = Promise.resolve().then(task);
    this.inFlight.set(key, pending);
    const clear = () => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    };
    void pending.then(clear, clear);
    return pending;
  }
}
