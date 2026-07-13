export function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

export function withLocalStorage(initial, callback) {
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
      delete globalThis.localStorage;
    }
  }
}
