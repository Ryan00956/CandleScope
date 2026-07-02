export class InflightRegistry {
  constructor() {
    this.inflight = new Map();
  }

  run(key, factory) {
    if (this.inflight.has(key)) return this.inflight.get(key);

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

  has(key) {
    return this.inflight.has(key);
  }

  size() {
    return this.inflight.size;
  }

  clear() {
    this.inflight.clear();
  }
}
