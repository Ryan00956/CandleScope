type StorageSeed = Record<string, unknown>;

export function createMemoryStorage(initial: StorageSeed = {}): Storage {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    get length() {
      return values.size;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
  };
}

export function withLocalStorage<T>(
  initial: StorageSeed,
  callback: (storage: Storage) => T,
): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = createMemoryStorage(initial);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  try {
    return callback(storage);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "localStorage", previous);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
}
