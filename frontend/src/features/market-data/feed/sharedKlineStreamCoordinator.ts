import { canonicalizeIntervalValue } from "../../../utils/intervals.js";
import type { IntervalString } from "../../../utils/intervals.js";
import type {
  KlineApi,
  KlineStreamControlMessage,
  KlineStreamController,
  KlineStreamFactory,
  KlineStreamOptions,
} from "../klineContracts.js";
import type { MarketSeries } from "../marketDataTypes.js";
import { KlineStreamSubscription } from "./klineStreamSubscription.js";

type StreamSeries = Pick<MarketSeries, "exchange" | "marketType" | "symbol">;

type PhysicalStreamFactory = (
  series: StreamSeries,
  options: KlineStreamOptions,
) => KlineStreamController;

interface LogicalSubscriber {
  id: number;
  intervals: Set<IntervalString>;
  options: KlineStreamOptions;
  closed: boolean;
  controller: KlineStreamController;
}

interface SharedStreamEntry {
  key: string;
  series: StreamSeries;
  controller: KlineStreamController | null;
  subscribers: Map<number, LogicalSubscriber>;
  activeIntervals: Set<IntervalString>;
  open: boolean;
  disposed: boolean;
  lastPingAt: number;
}

export interface SharedKlineStreamCoordinatorOptions {
  createPhysicalStream?: PhysicalStreamFactory;
}

function canonicalIntervals(intervals: readonly IntervalString[] = []): IntervalString[] {
  const values = new Set<IntervalString>();
  for (const interval of intervals) {
    const canonical = canonicalizeIntervalValue(interval);
    if (canonical) values.add(canonical);
  }
  return Array.from(values);
}

function streamKey(series: StreamSeries): string {
  return [
    String(series.exchange || "").trim().toLowerCase(),
    String(series.marketType || "").trim().toLowerCase(),
    String(series.symbol || "").trim().toUpperCase(),
  ].join("|");
}

function relevantIntervals(
  intervals: readonly IntervalString[] | undefined,
  desired: Set<IntervalString>,
): IntervalString[] | undefined {
  if (intervals === undefined) return undefined;
  return canonicalIntervals(intervals).filter((interval) => desired.has(interval));
}

function filterControlMessage(
  message: KlineStreamControlMessage,
  desired: Set<IntervalString>,
): KlineStreamControlMessage | null {
  const requested = relevantIntervals(message.requested_intervals, desired);
  const intervals = relevantIntervals(message.intervals, desired);
  const active = relevantIntervals(message.active_intervals, desired);
  const failed = message.failed?.filter((failure) => desired.has(failure.interval));
  const hasRelevantInterval = [requested, intervals, active].some((values) => Boolean(values?.length))
    || Boolean(failed?.length);
  if ((message.type === "subscribed" || message.type === "unsubscribed") && !hasRelevantInterval) {
    return null;
  }
  return {
    ...message,
    ...(requested === undefined ? {} : { requested_intervals: requested }),
    ...(intervals === undefined ? {} : { intervals }),
    ...(active === undefined ? {} : { active_intervals: active }),
    ...(failed === undefined ? {} : { failed }),
  };
}

function updateActiveIntervals(
  activeIntervals: Set<IntervalString>,
  message: KlineStreamControlMessage,
): void {
  if (message.active_intervals !== undefined) {
    activeIntervals.clear();
    canonicalIntervals(message.active_intervals).forEach((interval) => activeIntervals.add(interval));
    return;
  }
  const requested = canonicalIntervals(message.intervals || message.requested_intervals || []);
  const rejected = new Set(canonicalIntervals(message.failed?.map((failure) => failure.interval) || []));
  if (message.type === "subscribed") {
    requested.forEach((interval) => {
      if (!rejected.has(interval)) activeIntervals.add(interval);
    });
  } else if (message.type === "unsubscribed") {
    requested.forEach((interval) => activeIntervals.delete(interval));
  }
}

/**
 * Pools the physical K-line WebSocket by instrument while preserving the
 * existing per-chart subscription contract. Each chart still owns its own
 * callbacks and interval set; only the transport is shared.
 */
export class SharedKlineStreamCoordinator {
  private readonly entries = new Map<string, SharedStreamEntry>();
  private readonly createPhysicalStream: PhysicalStreamFactory;
  private nextSubscriberId = 0;

  constructor(api: KlineApi, options: SharedKlineStreamCoordinatorOptions = {}) {
    this.createPhysicalStream = options.createPhysicalStream || ((series, streamOptions) => (
      new KlineStreamSubscription({ api, series, ...streamOptions })
    ));
  }

  readonly subscribe: KlineStreamFactory = (series, options = {}) => {
    const key = streamKey(series);
    let entry = this.entries.get(key);
    if (!entry || entry.disposed) {
      entry = this.createEntry(key, series, options);
      this.entries.set(key, entry);
    }

    const subscriber = this.createSubscriber(entry, options);
    entry.subscribers.set(subscriber.id, subscriber);
    this.reconcileIntervals(entry);

    if (entry.open) {
      queueMicrotask(() => {
        if (subscriber.closed || !entry?.open) return;
        subscriber.options.onOpen?.(subscriber.controller);
        const active = Array.from(entry.activeIntervals).filter((interval) => (
          subscriber.intervals.has(interval)
        ));
        if (active.length > 0) {
          subscriber.options.onControlMessage?.({
            type: "subscribed",
            requested_intervals: Array.from(subscriber.intervals),
            intervals: active,
            active_intervals: active,
          }, subscriber.controller);
        }
      });
    }
    return subscriber.controller;
  };

  activePhysicalStreamCount(): number {
    return this.entries.size;
  }

  closeAll(): void {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    for (const entry of entries) {
      entry.disposed = true;
      entry.subscribers.forEach((subscriber) => {
        subscriber.closed = true;
      });
      entry.subscribers.clear();
      entry.controller?.close();
    }
  }

  private createEntry(
    key: string,
    series: StreamSeries,
    initialOptions: KlineStreamOptions,
  ): SharedStreamEntry {
    const entry: SharedStreamEntry = {
      key,
      series,
      controller: null,
      subscribers: new Map(),
      activeIntervals: new Set(),
      open: false,
      disposed: false,
      lastPingAt: 0,
    };
    entry.controller = this.createPhysicalStream(series, {
      ...initialOptions,
      intervals: [],
      onOpen: () => {
        if (entry.disposed) return;
        entry.open = true;
        entry.subscribers.forEach((subscriber) => {
          if (!subscriber.closed) subscriber.options.onOpen?.(subscriber.controller);
        });
        this.reconcileIntervals(entry);
      },
      onStreamStatus: (message) => {
        entry.subscribers.forEach((subscriber) => {
          if (
            !subscriber.closed
            && (message.interval == null || subscriber.intervals.has(message.interval))
          ) {
            subscriber.options.onStreamStatus?.(message, subscriber.controller);
          }
        });
      },
      onControlMessage: (message) => {
        updateActiveIntervals(entry.activeIntervals, message);
        entry.subscribers.forEach((subscriber) => {
          if (subscriber.closed) return;
          const filtered = filterControlMessage(message, subscriber.intervals);
          if (filtered) subscriber.options.onControlMessage?.(filtered, subscriber.controller);
        });
      },
      onBackfillCompleted: (message) => {
        let handled = false;
        entry.subscribers.forEach((subscriber) => {
          if (
            subscriber.closed
            || (message.interval != null && !subscriber.intervals.has(message.interval))
          ) return;
          handled = subscriber.options.onBackfillCompleted?.(
            message,
            subscriber.controller,
          ) === true || handled;
        });
        return handled;
      },
      onKline: (event) => {
        entry.activeIntervals.add(event.interval);
        entry.subscribers.forEach((subscriber) => {
          if (!subscriber.closed && subscriber.intervals.has(event.interval)) {
            subscriber.options.onKline?.(event, subscriber.controller);
          }
        });
      },
      onError: (event) => {
        entry.subscribers.forEach((subscriber) => {
          if (!subscriber.closed) subscriber.options.onError?.(event, subscriber.controller);
        });
      },
      onClose: (event) => {
        if (entry.disposed) return;
        entry.open = false;
        entry.disposed = true;
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
        entry.subscribers.forEach((subscriber) => {
          if (!subscriber.closed) subscriber.options.onClose?.(event, subscriber.controller);
        });
      },
      onParseError: (error, event) => {
        entry.subscribers.forEach((subscriber) => {
          if (!subscriber.closed) {
            subscriber.options.onParseError?.(error, event, subscriber.controller);
          }
        });
      },
    });
    return entry;
  }

  private createSubscriber(
    entry: SharedStreamEntry,
    options: KlineStreamOptions,
  ): LogicalSubscriber {
    this.nextSubscriberId += 1;
    const subscriber = {
      id: this.nextSubscriberId,
      intervals: new Set(canonicalIntervals(options.intervals)),
      options,
      closed: false,
      controller: null as unknown as KlineStreamController,
    };
    subscriber.controller = {
      readyState: () => entry.controller?.readyState(),
      isOpen: () => entry.open && entry.controller?.isOpen() === true,
      send: (payload) => entry.controller?.send(payload) === true,
      sendPing: () => {
        const now = Date.now();
        if (now - entry.lastPingAt < 1_000) return entry.open;
        entry.lastPingAt = now;
        return entry.controller?.sendPing() === true;
      },
      updateIntervals: (intervals) => {
        if (subscriber.closed) return;
        subscriber.intervals = new Set(canonicalIntervals(intervals));
        this.reconcileIntervals(entry);
      },
      close: () => this.closeSubscriber(entry, subscriber),
    };
    return subscriber;
  }

  private closeSubscriber(entry: SharedStreamEntry, subscriber: LogicalSubscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    entry.subscribers.delete(subscriber.id);
    if (entry.subscribers.size === 0) {
      entry.disposed = true;
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      entry.controller?.close();
      return;
    }
    this.reconcileIntervals(entry);
  }

  private reconcileIntervals(entry: SharedStreamEntry): void {
    if (entry.disposed || !entry.controller) return;
    const intervals = new Set<IntervalString>();
    entry.subscribers.forEach((subscriber) => {
      if (!subscriber.closed) {
        subscriber.intervals.forEach((interval) => intervals.add(interval));
      }
    });
    entry.controller.updateIntervals(Array.from(intervals));
  }
}
