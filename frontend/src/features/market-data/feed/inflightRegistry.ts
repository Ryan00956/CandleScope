export type InflightFactory<TResult> = () => TResult | PromiseLike<TResult>;

export class InflightRegistry {
  private inflight: Map<string, Promise<unknown>>;

  constructor() {
    this.inflight = new Map();
  }

  run<TResult>(key: string, factory: InflightFactory<TResult>): Promise<TResult> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<TResult>;

    const promise = Promise.resolve()
      .then(factory)
      .finally(() => {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
        }
      });

    this.inflight.set(key, promise);
    return promise;
  }

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  size(): number {
    return this.inflight.size;
  }

  clear(): void {
    this.inflight.clear();
  }
}
