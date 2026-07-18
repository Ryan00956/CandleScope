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

function trimOldestBy<T>(
  values: Map<string, T>,
  limit: number,
  timeOf: (value: T) => number,
): void {
  if (values.size <= limit) return;
  const excess = values.size - limit;
  const oldest = [...values.entries()]
    .sort((left, right) => timeOf(left[1]) - timeOf(right[1]))
    .slice(0, excess);
  for (const [key] of oldest) values.delete(key);
}

function createEntry(): LiquidationEntry {
  return {
    rollups: new Map(),
    liveEvents: new Map(),
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
    entry.quality = quality;
    for (const rollup of rollups) {
      if (!rollupMatchesIdentity(rollup, key)) continue;
      const naturalKey = rollupKey(rollup);
      const current = entry.rollups.get(naturalKey);
      if (!shouldReplaceRollup(current, rollup)) continue;
      entry.rollups.set(naturalKey, rollup);
      changed = true;
    }
    for (const [fingerprint, event] of entry.liveEvents) {
      const base = entry.rollups.get(rollupKey({
        bucketStartMs: Math.floor(event.tradeTimeMs / 60_000) * 60_000,
        positionSide: event.positionSide,
      }));
      if (rollupCoversEvent(base, event)) {
        entry.liveEvents.delete(fingerprint);
        changed = true;
      }
    }
    trimOldestBy(entry.rollups, MAX_ROLLUPS_PER_IDENTITY, (row) => row.bucketStartMs);
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
    entry.quality = quality;
    for (const event of events) {
      if (!eventMatchesIdentity(event, key) || entry.liveEvents.has(event.fingerprint)) continue;
      const base = entry.rollups.get(rollupKey({
        bucketStartMs: Math.floor(event.tradeTimeMs / 60_000) * 60_000,
        positionSide: event.positionSide,
      }));
      if (rollupCoversEvent(base, event)) continue;
      entry.liveEvents.set(event.fingerprint, event);
      changed = true;
    }
    trimOldestBy(entry.liveEvents, MAX_LIVE_EVENTS_PER_IDENTITY, (event) => event.receivedAtMs);
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
    for (const [key, row] of entry.rollups) {
      if (row.isFinal) continue;
      entry.rollups.delete(key);
      changed = true;
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
        [...entry.rollups.values()].sort((left, right) => (
          left.bucketStartMs - right.bucketStartMs
          || left.positionSide.localeCompare(right.positionSide)
        )),
      ),
      liveEvents: Object.freeze(
        [...entry.liveEvents.values()].sort((left, right) => (
          left.tradeTimeMs - right.tradeTimeMs
          || left.receivedAtMs - right.receivedAtMs
        )),
      ),
      connectionStatus: entry.connectionStatus,
      quality: entry.quality,
      revision: entry.revision,
    });
    for (const listener of entry.listeners) listener();
  }
}

export const liquidationStore = new LiquidationStore();
