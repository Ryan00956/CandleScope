import type {
  ReplayPublicTimeBatchResponse,
} from "./replayIntegrityModel.js";
import type { ReplayV2TimeDisclosurePolicy } from "./replayV2Types.js";
import { t } from "../../i18n/index.js";

export const REPLAY_PUBLIC_TIME_BATCH_SIZE = 2_000;
export const REPLAY_PUBLIC_TIME_MAX_TIMELINE_VALUES = 20_000;

export interface ReplayPublicTimeProjectionApi {
  publicTimesRun(
    runId: string,
    timelineMs: readonly number[],
    signal?: AbortSignal,
  ): Promise<ReplayPublicTimeBatchResponse>;
}

export interface ReplayPublicTimeProjectionOptions {
  readonly runId: string | null;
  readonly policy: ReplayV2TimeDisclosurePolicy;
  readonly originMs: number | null;
  readonly timelineOriginMs: number | null;
  readonly timelineMs: readonly number[];
}

export interface ReplayPublicTimeProjectionSnapshot {
  readonly labels: ReadonlyMap<number, string>;
  readonly loading: boolean;
  readonly error: string | null;
}

interface ReplayPublicTimeProjectionScope {
  readonly runId: string | null;
  readonly policy: ReplayV2TimeDisclosurePolicy;
  readonly originMs: number | null;
  readonly timelineOriginMs: number | null;
}

const EMPTY_LABELS: ReadonlyMap<number, string> = new Map();
const EMPTY_SNAPSHOT: ReplayPublicTimeProjectionSnapshot = Object.freeze({
  labels: EMPTY_LABELS,
  loading: false,
  error: null,
});

function sameScope(
  left: ReplayPublicTimeProjectionScope | null,
  right: ReplayPublicTimeProjectionScope,
): boolean {
  return left !== null
    && left.runId === right.runId
    && left.policy === right.policy
    && left.originMs === right.originMs
    && left.timelineOriginMs === right.timelineOriginMs;
}

function sameTimeline(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function needsServerProjection(scope: ReplayPublicTimeProjectionScope): boolean {
  return scope.policy !== "NONE"
    || (
      scope.originMs !== null
      && scope.timelineOriginMs !== null
      && scope.originMs !== scope.timelineOriginMs
    );
}

function projectionError(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("core.error.replayPublicTime");
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

export function boundedReplayPublicTimeline(values: readonly number[]): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    if (Number.isSafeInteger(value) && value >= 0) unique.add(value);
    if (unique.size >= REPLAY_PUBLIC_TIME_MAX_TIMELINE_VALUES) break;
  }
  return [...unique].sort((left, right) => left - right);
}

/**
 * Incremental, single-flight cache for server-authoritative public clock labels.
 *
 * Runtime projection frames can add thousands of timeline values per second.
 * The controller coalesces synchronous updates into one browser task, requests
 * only cache misses, and publishes at most once at request start/completion.
 * It intentionally lives outside React so transport completion cannot create a
 * useEffect -> setState render loop.
 */
export class ReplayPublicTimeProjectionController {
  private readonly listeners = new Set<() => void>();
  private snapshot: ReplayPublicTimeProjectionSnapshot = EMPTY_SNAPSHOT;
  private scope: ReplayPublicTimeProjectionScope | null = null;
  private desiredTimeline: readonly number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private generation = 0;
  private requestActive = false;

  constructor(private readonly api: ReplayPublicTimeProjectionApi) {}

  readonly getSnapshot = (): ReplayPublicTimeProjectionSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(options: ReplayPublicTimeProjectionOptions): void {
    const nextScope: ReplayPublicTimeProjectionScope = {
      runId: options.runId,
      policy: options.policy,
      originMs: options.originMs,
      timelineOriginMs: options.timelineOriginMs,
    };
    const nextTimeline = boundedReplayPublicTimeline(options.timelineMs);
    const scopeChanged = !sameScope(this.scope, nextScope);
    const timelineChanged = !sameTimeline(this.desiredTimeline, nextTimeline);

    if (!scopeChanged && !timelineChanged) return;

    if (scopeChanged) {
      this.cancelWork();
      this.scope = nextScope;
      this.publish(EMPTY_SNAPSHOT);
    }
    this.desiredTimeline = nextTimeline;

    if (!needsServerProjection(nextScope) || nextScope.runId === null || nextTimeline.length === 0) {
      this.cancelWork();
      this.publish(EMPTY_SNAPSHOT);
      return;
    }
    this.schedule();
  }

  /**
   * Cancels transport and clears cache while keeping the controller reusable.
   * React StrictMode may run effect cleanup/setup twice in development.
   */
  cancel(): void {
    this.cancelWork();
    this.scope = null;
    this.desiredTimeline = [];
    this.snapshot = EMPTY_SNAPSHOT;
  }

  private cancelWork(): void {
    this.generation += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    this.requestActive = false;
  }

  private publish(next: ReplayPublicTimeProjectionSnapshot): void {
    if (
      this.snapshot.labels === next.labels
      && this.snapshot.loading === next.loading
      && this.snapshot.error === next.error
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private schedule(): void {
    if (this.timer !== null || this.requestActive) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.requestMissing(generation);
    }, 0);
  }

  private trimLabelsToDesired(
    labels: ReadonlyMap<number, string>,
  ): ReadonlyMap<number, string> {
    if (labels.size === 0) return labels;
    const desired = new Set(this.desiredTimeline);
    let requiresTrim = false;
    for (const key of labels.keys()) {
      if (!desired.has(key)) {
        requiresTrim = true;
        break;
      }
    }
    if (!requiresTrim) return labels;
    const trimmed = new Map<number, string>();
    for (const value of this.desiredTimeline) {
      const label = labels.get(value);
      if (label !== undefined) trimmed.set(value, label);
    }
    return trimmed;
  }

  private async requestMissing(generation: number): Promise<void> {
    const scope = this.scope;
    if (generation !== this.generation || scope === null || scope.runId === null) return;
    if (!needsServerProjection(scope)) return;

    const retained = this.trimLabelsToDesired(this.snapshot.labels);
    const missing = this.desiredTimeline.filter((value) => !retained.has(value));
    if (missing.length === 0) {
      this.publish({ labels: retained, loading: false, error: null });
      return;
    }

    const abort = new AbortController();
    this.abortController = abort;
    this.requestActive = true;
    this.publish({ labels: retained, loading: true, error: null });
    const batches: number[][] = [];
    for (
      let index = 0;
      index < missing.length;
      index += REPLAY_PUBLIC_TIME_BATCH_SIZE
    ) {
      batches.push(missing.slice(index, index + REPLAY_PUBLIC_TIME_BATCH_SIZE));
    }

    let succeeded = false;
    try {
      const responses = await Promise.all(
        batches.map((batch) => this.api.publicTimesRun(
          scope.runId as string,
          batch,
          abort.signal,
        )),
      );
      if (generation !== this.generation || abort.signal.aborted) return;

      const expected = new Set(missing);
      const projected = new Map<number, string>();
      for (const response of responses) {
        if (response.run_id !== scope.runId || response.policy !== scope.policy) {
          throw new TypeError("public-time scope changed during projection");
        }
        for (const item of response.items) {
          if (!expected.has(item.input_timeline_ms)
            || projected.has(item.input_timeline_ms)) {
            throw new TypeError("public-time response does not match its request");
          }
          projected.set(item.input_timeline_ms, item.public_time.label);
        }
      }
      if (projected.size !== expected.size) {
        throw new TypeError("public-time response is incomplete");
      }

      const merged = new Map(retained);
      for (const [value, label] of projected) merged.set(value, label);
      this.publish({
        labels: this.trimLabelsToDesired(merged),
        loading: false,
        error: null,
      });
      succeeded = true;
    } catch (cause: unknown) {
      if (generation !== this.generation || abort.signal.aborted || isAbortError(cause)) return;
      // A failed authoritative projection cannot leave a partially trusted map.
      this.publish({
        labels: EMPTY_LABELS,
        loading: false,
        error: projectionError(cause),
      });
    } finally {
      if (generation === this.generation) {
        this.abortController = null;
        this.requestActive = false;
        if (succeeded) this.schedule();
      }
    }
  }
}
