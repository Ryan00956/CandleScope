import type {
  CacheLease,
  CacheRegistrySnapshot,
  CacheResource,
} from "./cacheGcTypes.js";

const resources = new Map<string, CacheResource>();
const dependencies = new Map<string, Set<string>>();
const leases = new Map<string, CacheLease>();

function scopedKey(owner: string, key: string): string {
  return `${owner}:${key}`;
}

function normalizePart(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim();
}

export function klineDependencyKey({
  exchange = "binance",
  marketType = "spot",
  symbol = "",
  interval = "",
}: {
  exchange?: unknown;
  marketType?: unknown;
  symbol?: unknown;
  interval?: unknown;
} = {}): string {
  return [
    normalizePart(exchange, "binance").toLowerCase(),
    normalizePart(marketType, "spot").toLowerCase(),
    normalizePart(symbol).toUpperCase(),
    normalizePart(interval),
  ].join(":");
}

export function registerCacheResource(
  owner: string,
  key: string,
  patch: Record<string, unknown> = {},
): CacheResource | null {
  if (!owner || !key) return null;
  const id = scopedKey(owner, key);
  const current = resources.get(id);
  const now = Date.now();
  const next = {
    ...(current || {}),
    ...patch,
    owner,
    key,
    id,
    registeredAtMs: current?.registeredAtMs || now,
    lastSeenMs: now,
  };
  resources.set(id, next);
  return next;
}

export function unregisterCacheResource(owner: string, key: string): void {
  const id = scopedKey(owner, key);
  resources.delete(id);
  dependencies.delete(id);
  // Runtime holders own their leases. A lease may intentionally outlive a
  // resource instance so a recreated cache entry remains protected.
}

export function registerCacheDependency(owner: string, key: string, dependencyKey: string): void {
  if (!owner || !key || !dependencyKey) return;
  const id = scopedKey(owner, key);
  const deps = dependencies.get(id) || new Set();
  deps.add(dependencyKey);
  dependencies.set(id, deps);
}

export function acquireCacheLease(
  owner: string,
  key: string,
  leaseId: string,
  detail: Record<string, unknown> = {},
): (() => void) | null {
  if (!owner || !key || !leaseId) return null;
  const now = Date.now();
  const id = `${scopedKey(owner, key)}:${leaseId}`;
  const lease = {
    owner,
    key,
    leaseId,
    detail,
    acquiredAtMs: now,
    lastSeenMs: now,
  };
  leases.set(id, lease);
  return () => releaseCacheLease(owner, key, leaseId);
}

export function releaseCacheLease(owner: string, key: string, leaseId: string): void {
  leases.delete(`${scopedKey(owner, key)}:${leaseId}`);
}

export function cacheLeaseCount(owner: string, key: string): number {
  if (!owner || !key) return 0;
  const prefix = `${scopedKey(owner, key)}:`;
  let count = 0;
  for (const leaseKey of leases.keys()) {
    if (leaseKey.startsWith(prefix)) count += 1;
  }
  return count;
}

export function hasCacheLease(owner: string, key: string): boolean {
  return cacheLeaseCount(owner, key) > 0;
}

export function dependencyAvailable(dependencyKey: string): boolean {
  for (const resource of resources.values()) {
    if (
      resource.type === "kline"
      && resource.dependencyKey === dependencyKey
      && Number(resource.bars || 0) > 0
    ) {
      return true;
    }
  }
  return false;
}

export function dependencyState(owner: string, key: string): {
  dependencies: string[];
  missingDependencies: string[];
  orphan: boolean;
} {
  const id = scopedKey(owner, key);
  const deps = Array.from(dependencies.get(id) || []);
  const missing = deps.filter((dependencyKey) => !dependencyAvailable(dependencyKey));
  return {
    dependencies: deps,
    missingDependencies: missing,
    orphan: missing.length > 0,
  };
}

export function snapshotCacheRegistry(): CacheRegistrySnapshot {
  return {
    resources: Array.from(resources.values()),
    dependencies: Array.from(dependencies.entries()).map(([id, deps]) => ({
      id,
      dependencies: Array.from(deps),
    })),
    leases: Array.from(leases.values()),
  };
}

export function resetCacheRegistry(): void {
  resources.clear();
  dependencies.clear();
  leases.clear();
}
