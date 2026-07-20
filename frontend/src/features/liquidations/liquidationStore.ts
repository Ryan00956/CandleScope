import type { AdvancedMarketConnectionStatus } from "../advanced-market-data/advancedMarketDataTypes.js";
import type {
  LiquidationEvent,
  LiquidationIdentity,
  LiquidationQualityMetadata,
  LiquidationRollup,
  LiquidationSnapshot,
} from "./liquidationTypes.js";

const MAX_ROLLUPS_PER_IDENTITY = 100_000;
const MAX_LIVE_EVENTS_PER_IDENTITY = 10_000;

export const EMPTY_LIQUIDATION_SNAPSHOT: LiquidationSnapshot = Object.freeze({
  rollups: Object.freeze([]),
  liveEvents: Object.freeze([]),
  connectionStatus: "disabled",
  quality: null,
  revision: 0,
});

interface LiquidationEntry {
  rollups: Map<string, LiquidationRollup>;
  liveEvents: Map<string, LiquidationEvent>;
  sortedRollups: readonly LiquidationRollup[];
  sortedLiveEvents: readonly LiquidationEvent[];
  listeners: Set<() => void>;
  connectionStatus: AdvancedMarketConnectionStatus;
  quality: LiquidationQualityMetadata | null;
  revision: number;
  snapshot: LiquidationSnapshot;
}

function identityKey(identity: LiquidationIdentity): string {
  return [
    identity.exchange.trim().toLowerCase(),
    identity.marketType.trim().toLowerCase(),
    identity.symbol.trim().toUpperCase(),
  ].join(":");
}

function rollupKey(rollup: Pick<LiquidationRollup, "bucketStartMs" | "positionSide">): string {
  return `${rollup.bucketStartMs}:${rollup.positionSide}`;
}

function eventMatchesIdentity(event: LiquidationEvent, expectedIdentityKey: string): boolean {
  return identityKey({
    exchange: event.exchange,
    marketType: event.marketType,
    symbol: event.symbol,
  }) === expectedIdentityKey;
}

function rollupMatchesIdentity(rollup: LiquidationRollup, expectedIdentityKey: string): boolean {
  return identityKey({
    exchange: rollup.exchange,
    marketType: rollup.marketType,
    symbol: rollup.symbol,
  }) === expectedIdentityKey;
}

function shouldReplaceRollup(
  current: LiquidationRollup | undefined,
  incoming: LiquidationRollup,
): boolean {
  if (!current) return true;
  if (current.isFinal !== incoming.isFinal) return incoming.isFinal;
  if (incoming.updatedAtMs !== current.updatedAtMs) {
    return incoming.updatedAtMs > current.updatedAtMs;
  }
  return incoming.revision > current.revision;
}

function rollupCoversEvent(rollup: LiquidationRollup | undefined, event: LiquidationEvent): boolean {
  if (!rollup) return false;
  if (rollup.updatedAtMs > event.receivedAtMs) return true;
  return rollup.updatedAtMs === event.receivedAtMs
    && rollup.lastEventTimeMs >= event.tradeTimeMs;
}

function mergeSortedChanges<T>(
  current: readonly T[],
  changes: readonly T[],
  keyOf: (value: T) => string,
  compare: (left: T, right: T) => number,
): readonly T[] {
  if (changes.length === 0) return current;
  const changedKeys = new Set(changes.map(keyOf));
  const retained = current.filter((value) => !changedKeys.has(keyOf(value)));
  const sortedChanges = [...changes].sort(compare);
  const merged: T[] = [];
  let currentIndex = 0;
  let changeIndex = 0;
  while (currentIndex < retained.length || changeIndex < sortedChanges.length) {
    const currentValue = retained[currentIndex];
    const changedValue = sortedChanges[changeIndex];
    if (changedValue === undefined || (
      currentValue !== undefined && compare(currentValue, changedValue) <= 0
    )) {
      if (currentValue !== undefined) merged.push(currentValue);
      currentIndex += 1;
    } else {
      merged.push(changedValue);
      changeIndex += 1;
    }
  }
  return Object.freeze(merged);
}

function trimOldestSorted<T>(
  values: Map<string, T>,
  sortedValues: readonly T[],
  limit: number,
  keyOf: (value: T) => string,
): readonly T[] {
  if (sortedValues.length <= limit) return sortedValues;
  const excess = sortedValues.length - limit;
  for (let index = 0; index < excess; index += 1) {
    const value = sortedValues[index];
    if (value !== undefined) values.delete(keyOf(value));
  }
  return Object.freeze(sortedValues.slice(excess));
}

function trimOldestEvents(
  values: Map<string, LiquidationEvent>,
  sortedValues: readonly LiquidationEvent[],
  limit: number,
): readonly LiquidationEvent[] {
  if (values.size <= limit) return sortedValues;
  const removed = new Set<string>();
  while (values.size > limit) {
    let oldest: LiquidationEvent | null = null;
    for (const event of values.values()) {
      if (!oldest || event.receivedAtMs < oldest.receivedAtMs) oldest = event;
    }
    if (!oldest) break;
    values.delete(oldest.fingerprint);
    removed.add(oldest.fingerprint);
  }
  return removed.size === 0
    ? sortedValues
    : Object.freeze(sortedValues.filter((event) => !removed.has(event.fingerprint)));
}

const compareRollups = (left: LiquidationRollup, right: LiquidationRollup): number => (
  left.bucketStartMs - right.bucketStartMs
  || left.positionSide.localeCompare(right.positionSide)
);

const compareEvents = (left: LiquidationEvent, right: LiquidationEvent): number => (
  left.tradeTimeMs - right.tradeTimeMs
  || left.receivedAtMs - right.receivedAtMs
  || left.fingerprint.localeCompare(right.fingerprint)
);

function createEntry(): LiquidationEntry {
  return {
    rollups: new Map(),
    liveEvents: new Map(),
    sortedRollups: Object.freeze([]),
    sortedLiveEvents: Object.freeze([]),
    listeners: new Set(),
    connectionStatus: "disabled",
    quality: null,
    revision: 0,
    snapshot: EMPTY_LIQUIDATION_SNAPSHOT,
  };
}

export class LiquidationStore {
  private readonly entries = new Map<string, LiquidationEntry>();

  subscribe(identity: LiquidationIdentity | string, listener: () => void): () => void {
    const key = typeof identity === "string" ? identity : identityKey(identity);
    const entry = this.entry(key);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }

  getSnapshot(identity: LiquidationIdentity | string): LiquidationSnapshot {
    const key = typeof identity === "string" ? identity : identityKey(identity);
    return this.entries.get(key)?.snapshot ?? EMPTY_LIQUIDATION_SNAPSHOT;
  }

  mergeHistory(
    identity: LiquidationIdentity,
    rollups: readonly LiquidationRollup[],
    quality: LiquidationQualityMetadata,
  ): void {
    const key = identityKey(identity);
    const entry = this.entry(key);
    let changed = entry.quality !== quality;
    const changedRollups = new Map<string, LiquidationRollup>();
    entry.quality = quality;
    for (const rollup of rollups) {
      if (!rollupMatchesIdentity(rollup, key)) continue;
      const naturalKey = rollupKey(rollup);
      const current = entry.rollups.get(naturalKey);
      if (!shouldReplaceRollup(current, rollup)) continue;
      entry.rollups.set(naturalKey, rollup);
      changedRollups.set(naturalKey, rollup);
      changed = true;
    }
    if (changedRollups.size > 0) {
      entry.sortedRollups = mergeSortedChanges(
        entry.sortedRollups,
        [...changedRollups.values()],
        rollupKey,
        compareRollups,
      );
    }
    const retainedLiveEvents: LiquidationEvent[] = [];
    for (const event of entry.sortedLiveEvents) {
      const base = entry.rollups.get(rollupKey({
        bucketStartMs: Math.floor(event.tradeTimeMs / 60_000) * 60_000,
        positionSide: event.positionSide,
      }));
      if (rollupCoversEvent(base, event)) {
        entry.liveEvents.delete(event.fingerprint);
        changed = true;
      } else {
        retainedLiveEvents.push(event);
      }
    }
    if (retainedLiveEvents.length !== entry.sortedLiveEvents.length) {
      entry.sortedLiveEvents = Object.freeze(retainedLiveEvents);
    }
    entry.sortedRollups = trimOldestSorted(
      entry.rollups,
      entry.sortedRollups,
      MAX_ROLLUPS_PER_IDENTITY,
      rollupKey,
    );
    if (changed) this.publish(entry);
  }

  applyEvents(
    identity: LiquidationIdentity,
    events: readonly LiquidationEvent[],
    quality: LiquidationQualityMetadata,
  ): void {
    const key = identityKey(identity);
    const entry = this.entry(key);
    let changed = entry.quality !== quality;
    const changedEvents: LiquidationEvent[] = [];
    entry.quality = quality;
    for (const event of events) {
      if (!eventMatchesIdentity(event, key) || entry.liveEvents.has(event.fingerprint)) continue;
      const base = entry.rollups.get(rollupKey({
        bucketStartMs: Math.floor(event.tradeTimeMs / 60_000) * 60_000,
        positionSide: event.positionSide,
      }));
      if (rollupCoversEvent(base, event)) continue;
      entry.liveEvents.set(event.fingerprint, event);
      changedEvents.push(event);
      changed = true;
    }
    if (changedEvents.length > 0) {
      entry.sortedLiveEvents = mergeSortedChanges(
        entry.sortedLiveEvents,
        changedEvents,
        (event) => event.fingerprint,
        compareEvents,
      );
    }
    entry.sortedLiveEvents = trimOldestEvents(
      entry.liveEvents,
      entry.sortedLiveEvents,
      MAX_LIVE_EVENTS_PER_IDENTITY,
    );
    if (changed) this.publish(entry);
  }

  setConnectionStatus(
    identity: LiquidationIdentity,
    status: AdvancedMarketConnectionStatus,
    quality?: LiquidationQualityMetadata | null,
  ): void {
    const entry = this.entry(identityKey(identity));
    const nextQuality = quality === undefined ? entry.quality : quality;
    if (entry.connectionStatus === status && entry.quality === nextQuality) return;
    entry.connectionStatus = status;
    entry.quality = nextQuality;
    this.publish(entry);
  }

  clearUnconfirmed(identity: LiquidationIdentity): void {
    const entry = this.entry(identityKey(identity));
    let changed = entry.liveEvents.size > 0;
    entry.liveEvents.clear();
    entry.sortedLiveEvents = Object.freeze([]);
    for (const [key, row] of entry.rollups) {
      if (row.isFinal) continue;
      entry.rollups.delete(key);
      changed = true;
    }
    if (changed) {
      entry.sortedRollups = Object.freeze(
        entry.sortedRollups.filter((row) => row.isFinal),
      );
    }
    if (changed) this.publish(entry);
  }

  clearForTests(): void {
    this.entries.clear();
  }

  private entry(key: string): LiquidationEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = createEntry();
      this.entries.set(key, entry);
    }
    return entry;
  }

  private publish(entry: LiquidationEntry): void {
    entry.revision += 1;
    entry.snapshot = Object.freeze({
      rollups: Object.freeze(
        entry.sortedRollups,
      ),
      liveEvents: Object.freeze(
        entry.sortedLiveEvents,
      ),
      connectionStatus: entry.connectionStatus,
      quality: entry.quality,
      revision: entry.revision,
    });
    for (const listener of entry.listeners) listener();
  }
}

export const liquidationStore = new LiquidationStore();
