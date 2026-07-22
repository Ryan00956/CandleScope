import {
  getBuiltinIndicatorName,
  isBuiltinIndicator,
  isWsHostedIndicator,
} from "./indicatorPayloadRuntime.js";
import type {
  IndicatorDefinition,
  IndicatorParams,
} from "./indicatorTypes.js";

export interface LocalIndicatorExecution {
  mode: "builtin" | "script";
  name?: string;
  params: IndicatorParams;
  script?: string;
  securityMode?: string;
}

export type LocalIndicatorExecutionResolution =
  | { kind: "hosted" }
  | { kind: "invalid"; error: string }
  | { kind: "local"; execution: LocalIndicatorExecution };

export function resolveLocalIndicatorExecution(
  indicator: IndicatorDefinition | null | undefined,
): LocalIndicatorExecutionResolution {
  if (indicator?.executionTarget !== "local") {
    return isWsHostedIndicator(indicator)
      ? { kind: "hosted" }
      : {
          kind: "invalid",
          error: "Hosted indicator requires an engine name or non-empty script",
        };
  }
  const builtinName = getBuiltinIndicatorName(indicator)
    || ((indicator.kind === "builtin" || indicator.is_builtin === true)
      ? String(indicator.name || "").trim()
      : "");
  if (isBuiltinIndicator(indicator) || builtinName) {
    if (!builtinName) {
      return { kind: "invalid", error: "Local builtin indicator requires a name" };
    }
    return {
      kind: "local",
      execution: {
        mode: "builtin",
        name: builtinName,
        params: indicator.params || {},
      },
    };
  }
  const script = String(indicator.script || "").trim();
  if (!script) {
    return { kind: "invalid", error: "Local script indicator requires a non-empty script" };
  }
  return {
    kind: "local",
    execution: {
      mode: "script",
      params: indicator.params || {},
      script,
      ...(indicator.securityMode ? { securityMode: indicator.securityMode } : {}),
    },
  };
}

export function buildIndicatorComputeLifecycleKey({
  dataSignature,
  datasetKey,
  exchange,
  interval,
  marketType,
  symbol,
}: {
  dataSignature: string;
  datasetKey: string;
  exchange: string;
  interval: string;
  marketType: string;
  symbol: string;
}): string {
  return JSON.stringify([
    datasetKey,
    exchange.toLowerCase(),
    marketType.toLowerCase(),
    symbol.toUpperCase(),
    interval,
    dataSignature,
  ]);
}

export function buildIndicatorComputeJobKey({
  forceGeneration = 0,
  indicator,
  lifecycleKey,
  params,
}: {
  forceGeneration?: number;
  indicator: IndicatorDefinition;
  lifecycleKey: string;
  params: IndicatorParams;
}): string {
  const resolution = resolveLocalIndicatorExecution(indicator);
  const execution = resolution.kind === "local" ? resolution.execution : null;
  const executionIdentity = canonicalStringify({
    indicatorId: indicator.id,
    mode: execution?.mode || resolution.kind,
    name: execution?.name || getBuiltinIndicatorName(indicator) || "",
    params: params || {},
    script: execution?.script || indicator.script || "",
    securityMode: execution?.securityMode || indicator.securityMode || "",
  });
  const normalizedForceGeneration = Number.isFinite(forceGeneration)
    ? Math.max(0, Math.floor(forceGeneration))
    : 0;
  return [
    "indicator-compute:v2",
    boundedDoubleDigest(lifecycleKey),
    boundedDoubleDigest(executionIdentity),
    `f${normalizedForceGeneration}`,
  ].join(":");
}

function canonicalStringify(value: unknown): string {
  const ancestors = new Set<object>();

  function serialize(current: unknown, inArray = false): string | undefined {
    if (current === null) return "null";
    switch (typeof current) {
      case "string":
        return JSON.stringify(current);
      case "boolean":
        return current ? "true" : "false";
      case "number":
        return Number.isFinite(current) ? JSON.stringify(current) : "null";
      case "bigint":
        return JSON.stringify(current.toString());
      case "undefined":
      case "function":
      case "symbol":
        return inArray ? "null" : undefined;
      case "object": {
        const object = current as object;
        if (ancestors.has(object)) {
          throw new TypeError("Indicator compute params must not contain cycles");
        }
        ancestors.add(object);
        try {
          if (Array.isArray(current)) {
            return `[${current.map((item) => serialize(item, true) ?? "null").join(",")}]`;
          }
          const entries = Object.keys(current as Record<string, unknown>)
            .sort()
            .flatMap((key) => {
              const serialized = serialize((current as Record<string, unknown>)[key]);
              return serialized === undefined
                ? []
                : [`${JSON.stringify(key)}:${serialized}`];
            });
          return `{${entries.join(",")}}`;
        } finally {
          ancestors.delete(object);
        }
      }
      default:
        return undefined;
    }
  }

  return serialize(value) ?? "null";
}

function hash32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= hash >>> 13;
  }
  return hash >>> 0;
}

function boundedDoubleDigest(value: string): string {
  const first = hash32(value, 0x811c9dc5).toString(16).padStart(8, "0");
  const second = hash32(value, 0x9e3779b9).toString(16).padStart(8, "0");
  return `${first}${second}`;
}

interface KeyedJob {
  jobKey: string;
}

interface KeyedResult {
  jobKey: string;
}

interface PhysicalBatchOutcome {
  results: KeyedResult[];
  stale: boolean;
}

interface InFlightBatch {
  batchId: number;
  promise: Promise<PhysicalBatchOutcome>;
}

export interface IndicatorComputeScheduleResult<TResult> {
  joined: number;
  queued: number;
  results: TResult[];
  skipped: number;
  stale: boolean;
}

/**
 * Owns physical local-compute batches. Completed keys are reusable only while
 * the active lifecycle continues to own the acknowledged result cache.
 */
export function createIndicatorComputeJobCoordinator({
  maxCompleted = 512,
}: { maxCompleted?: number } = {}) {
  let activeLifecycleKey = "";
  let epoch = 0;
  let nextBatchId = 0;
  const completed = new Map<string, true>();
  const inFlight = new Map<string, InFlightBatch>();
  const controllers = new Map<number, AbortController>();

  function rememberCompleted(key: string): void {
    completed.delete(key);
    completed.set(key, true);
    const limit = Math.max(1, Math.floor(maxCompleted));
    while (completed.size > limit) {
      const oldest = completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      completed.delete(oldest);
    }
  }

  function activate(lifecycleKey: string): number {
    if (lifecycleKey === activeLifecycleKey) return epoch;
    activeLifecycleKey = lifecycleKey;
    epoch += 1;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    inFlight.clear();
    // Completed work is valid only while its result cache remains owned by
    // this lifecycle. Cross-lifecycle reuse without a cache acknowledgement
    // can otherwise skip work after eviction or data rollback.
    completed.clear();
    return epoch;
  }

  function complete(jobKeys: Iterable<string>): void {
    for (const jobKey of jobKeys) {
      if (jobKey) rememberCompleted(jobKey);
    }
  }

  async function schedule<TJob extends KeyedJob, TResult extends KeyedResult>({
    execute,
    force = false,
    isResultComplete = () => true,
    jobs,
    lifecycleKey,
  }: {
    execute: (jobs: TJob[], signal: AbortSignal) => Promise<TResult[]>;
    force?: boolean;
    isResultComplete?: (result: TResult) => boolean;
    jobs: readonly TJob[];
    lifecycleKey: string;
  }): Promise<IndicatorComputeScheduleResult<TResult>> {
    const taskEpoch = activate(lifecycleKey);
    const unique = new Map<string, TJob>();
    for (const job of jobs) {
      if (!job.jobKey || unique.has(job.jobKey)) continue;
      unique.set(job.jobKey, job);
    }
    let joined = 0;
    let skipped = 0;
    const queued: TJob[] = [];
    const joinedBatches = new Map<number, InFlightBatch>();
    for (const job of unique.values()) {
      if (completed.has(job.jobKey) && !force) {
        skipped += 1;
      } else if (inFlight.has(job.jobKey)) {
        joined += 1;
        const batch = inFlight.get(job.jobKey);
        if (batch) joinedBatches.set(batch.batchId, batch);
      } else {
        completed.delete(job.jobKey);
        queued.push(job);
      }
    }
    if (queued.length === 0 && joinedBatches.size === 0) {
      return { joined, queued: 0, results: [], skipped, stale: false };
    }

    let ownedBatch: InFlightBatch | null = null;
    if (queued.length > 0) {
      nextBatchId += 1;
      const batchId = nextBatchId;
      const controller = new AbortController();
      controllers.set(batchId, controller);
      const promise = Promise.resolve()
        .then(async (): Promise<PhysicalBatchOutcome> => {
          const results = await execute(queued, controller.signal);
          if (
            controller.signal.aborted
            || taskEpoch !== epoch
            || lifecycleKey !== activeLifecycleKey
          ) {
            return { results: [], stale: true };
          }
          const resultByKey = new Map(results.map((result) => [result.jobKey, result]));
          const orderedResults = queued.map((job) => {
            const result = resultByKey.get(job.jobKey);
            if (!result) {
              throw new Error(`Indicator compute batch omitted job ${job.jobKey}`);
            }
            return result;
          });
          const completedKeys = orderedResults.flatMap((result) => (
            isResultComplete(result) ? [result.jobKey] : []
          ));
          for (const jobKey of completedKeys) rememberCompleted(jobKey);
          return { results: orderedResults, stale: false };
        })
        .finally(() => {
          controllers.delete(batchId);
          for (const job of queued) {
            if (inFlight.get(job.jobKey)?.batchId === batchId) {
              inFlight.delete(job.jobKey);
            }
          }
        });
      ownedBatch = { batchId, promise };
      for (const job of queued) inFlight.set(job.jobKey, ownedBatch);
    }

    const awaitedBatches = Array.from(joinedBatches.values());
    if (ownedBatch) awaitedBatches.push(ownedBatch);
    const settled = await Promise.allSettled(awaitedBatches.map((batch) => batch.promise));
    const ownedSettlement = ownedBatch ? settled[settled.length - 1] : undefined;
    if (ownedSettlement?.status === "rejected") throw ownedSettlement.reason;
    if (!ownedBatch) {
      const joinedRejection = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (joinedRejection) throw joinedRejection.reason;
    }
    const lifecycleStale = taskEpoch !== epoch || lifecycleKey !== activeLifecycleKey;
    const joinedOutcomes = ownedBatch
      ? []
      : settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const ownedOutcome = ownedSettlement?.status === "fulfilled"
      ? ownedSettlement.value
      : undefined;
    const stale = lifecycleStale
      || Boolean(ownedOutcome?.stale)
      || joinedOutcomes.some((outcome) => outcome.stale);
    return {
      joined,
      queued: queued.length,
      results: stale ? [] : (ownedOutcome?.results || []) as TResult[],
      skipped,
      stale,
    };
  }

  function dispose(): void {
    activeLifecycleKey = "";
    epoch += 1;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    inFlight.clear();
    completed.clear();
  }

  function snapshot() {
    return {
      activeLifecycleKey,
      completed: completed.size,
      epoch,
      inFlight: inFlight.size,
    };
  }

  return { activate, complete, dispose, schedule, snapshot };
}
