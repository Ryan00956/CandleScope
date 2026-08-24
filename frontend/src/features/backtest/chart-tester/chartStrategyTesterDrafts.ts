import {
  StrategyDraftStore,
  createLocalStorageStrategyDraftAdapter,
  createMemoryStrategyDraftAdapter,
} from "./StrategyDraftStore.js";

let browserStore: StrategyDraftStore | null = null;

export function getChartStrategyDraftStore(): StrategyDraftStore {
  if (browserStore) return browserStore;
  let adapter = createMemoryStrategyDraftAdapter();
  if (typeof window !== "undefined") {
    try {
      if (window.localStorage) adapter = createLocalStorageStrategyDraftAdapter(window.localStorage);
    } catch {
      // Some embedded/private browser contexts expose localStorage but reject access.
    }
  }
  browserStore = new StrategyDraftStore(adapter);
  return browserStore;
}

export function createChartStrategyDraftId(randomValue?: string): string {
  const entropy = randomValue
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random()}`;
  const normalized = entropy.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 152);
  return `draft-${normalized.padEnd(8, "0")}`;
}

export function strategyDraftContentRevision(source: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
