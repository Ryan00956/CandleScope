const resources = new Map();
const dependencies = new Map();
const leases = new Map();

function scopedKey(owner, key) {
  return `${owner}:${key}`;
}

function normalizePart(value, fallback = "") {
  return String(value ?? fallback).trim();
}

export function klineDependencyKey({
  exchange = "binance",
  marketType = "spot",
  symbol = "",
  interval = "",
} = {}) {
  return [
    normalizePart(exchange, "binance").toLowerCase(),
    normalizePart(marketType, "spot").toLowerCase(),
    normalizePart(symbol).toUpperCase(),
    normalizePart(interval),
  ].join(":");
}

export function registerCacheResource(owner, key, patch = {}) {
  if (!owner || !key) return null;
  const id = scopedKey(owner, key);
  const current = resources.get(id) || {};
  const now = Date.now();
  const next = {
    ...current,
    ...patch,
    owner,
    key,
    id,
    registeredAtMs: current.registeredAtMs || now,
    lastSeenMs: now,
  };
  resources.set(id, next);
  return next;
}

export function unregisterCacheResource(owner, key) {
  const id = scopedKey(owner, key);
  resources.delete(id);
  dependencies.delete(id);
  for (const leaseKey of Array.from(leases.keys())) {
    if (leaseKey.startsWith(`${id}:`)) leases.delete(leaseKey);
  }
}

export function registerCacheDependency(owner, key, dependencyKey) {
  if (!owner || !key || !dependencyKey) return;
  const id = scopedKey(owner, key);
  const deps = dependencies.get(id) || new Set();
  deps.add(dependencyKey);
  dependencies.set(id, deps);
}

export function acquireCacheLease(owner, key, leaseId, detail = {}) {
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

export function releaseCacheLease(owner, key, leaseId) {
  leases.delete(`${scopedKey(owner, key)}:${leaseId}`);
}

export function dependencyAvailable(dependencyKey) {
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

export function dependencyState(owner, key) {
  const id = scopedKey(owner, key);
  const deps = Array.from(dependencies.get(id) || []);
  const missing = deps.filter((dependencyKey) => !dependencyAvailable(dependencyKey));
  return {
    dependencies: deps,
    missingDependencies: missing,
    orphan: missing.length > 0,
  };
}

export function snapshotCacheRegistry() {
  return {
    resources: Array.from(resources.values()),
    dependencies: Array.from(dependencies.entries()).map(([id, deps]) => ({
      id,
      dependencies: Array.from(deps),
    })),
    leases: Array.from(leases.values()),
  };
}

export function resetCacheRegistry() {
  resources.clear();
  dependencies.clear();
  leases.clear();
}
