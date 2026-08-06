import { getBatchKlineStreamUrl } from "../../../services/api.js";
import { isJsonRecord, type JsonRecord } from "../../../services/apiPayloadParsers.js";
import { canonicalizeIntervalValue, type IntervalString } from "../../../utils/intervals.js";
import type {
  KlineStreamControlMessage,
  KlineStreamController,
  KlineStreamFactory,
  KlineStreamOptions,
  KlineStreamSocket,
} from "../klineContracts.js";
import type { MarketSeries } from "../marketDataTypes.js";
import { parseKlineStreamMessage } from "./klineStreamSubscription.js";

const SOCKET_OPEN = 1;
type StreamSeries = Pick<MarketSeries, "exchange" | "marketType" | "symbol">;

interface LogicalBatchSubscription {
  clientId: string;
  series: StreamSeries;
  intervals: IntervalString[];
  options: KlineStreamOptions;
  controller: KlineStreamController;
  closed: boolean;
  serverState: "absent" | "subscribing" | "subscribed";
  activeIntervals: IntervalString[];
}

export interface BatchKlineStreamCoordinatorOptions {
  socketFactory?: (url: string) => KlineStreamSocket;
  url?: string;
}

function canonicalIntervals(values: readonly IntervalString[] = []): IntervalString[] {
  const result = new Set<IntervalString>();
  values.forEach((value) => {
    const canonical = canonicalizeIntervalValue(value);
    if (canonical) result.add(canonical);
  });
  return [...result];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): IntervalString[] {
  return Array.isArray(value)
    ? canonicalIntervals(value.filter((item): item is IntervalString => typeof item === "string"))
    : [];
}

/** One window-level physical socket with stable logical client IDs per Cell. */
export class BatchKlineStreamCoordinator {
  private readonly subscriptions = new Map<string, LogicalBatchSubscription>();
  private readonly socketFactory: (url: string) => KlineStreamSocket;
  private readonly url: string;
  private socket: KlineStreamSocket | null = null;
  private sequence = 0;
  private requestSequence = 0;

  constructor(options: BatchKlineStreamCoordinatorOptions = {}) {
    this.socketFactory = options.socketFactory || ((url) => new WebSocket(url));
    this.url = options.url || getBatchKlineStreamUrl();
  }

  readonly subscribe: KlineStreamFactory = (series, options = {}) => {
    const clientId = `chart-cell-${++this.sequence}`;
    const subscription = {
      clientId,
      series: { ...series },
      intervals: canonicalIntervals(options.intervals),
      options,
      controller: null as unknown as KlineStreamController,
      closed: false,
      serverState: "absent" as const,
      activeIntervals: [],
    };
    subscription.controller = {
      readyState: () => this.socket?.readyState,
      isOpen: () => this.isOpen(),
      send: (payload) => this.sendRaw(payload),
      sendPing: () => this.sendRaw("ping"),
      updateIntervals: (intervals) => {
        if (subscription.closed) return;
        subscription.intervals = canonicalIntervals(intervals);
        if (subscription.intervals.length === 0) return;
        if (subscription.serverState === "absent") {
          this.sendCommand("subscribe", [subscription]);
        } else if (subscription.serverState === "subscribed") {
          this.sendCommand("update", [subscription]);
        }
      },
      close: () => this.closeSubscription(subscription),
    };
    this.subscriptions.set(clientId, subscription);
    this.ensureSocket();
    if (this.isOpen() && subscription.intervals.length > 0) {
      this.sendCommand("subscribe", [subscription]);
    }
    return subscription.controller;
  };

  diagnostics(): Record<string, unknown> {
    return {
      mode: "batch",
      physicalStreams: this.socket === null ? 0 : 1,
      open: this.isOpen(),
      logicalSubscribers: this.subscriptions.size,
      logicalSubscriptions: [...this.subscriptions.values()].reduce(
        (total, item) => total + item.intervals.length,
        0,
      ),
      clientIds: [...this.subscriptions.keys()].sort(),
    };
  }

  activePhysicalStreamCount(): number {
    return this.socket === null ? 0 : 1;
  }

  closeAll(): void {
    this.subscriptions.forEach((item) => { item.closed = true; });
    this.subscriptions.clear();
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* best effort */ }
  }

  private ensureSocket(): void {
    if (this.socket !== null) return;
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.onopen = () => {
      const active = [...this.subscriptions.values()].filter((item) => (
        !item.closed && item.intervals.length > 0
      ));
      active.forEach((item) => item.options.onOpen?.(item.controller));
      this.sendCommand("subscribe", active);
    };
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = (event) => {
      this.subscriptions.forEach((item) => item.options.onError?.(event, item.controller));
    };
    socket.onclose = (event) => {
      if (this.socket === socket) this.socket = null;
      this.subscriptions.forEach((item) => {
        item.serverState = "absent";
        item.activeIntervals = [];
        item.options.onClose?.(event, item.controller);
      });
    };
  }

  private isOpen(): boolean {
    const socket = this.socket;
    return socket !== null && socket.readyState === (socket.OPEN ?? SOCKET_OPEN);
  }

  private sendRaw(payload: string): boolean {
    if (!this.isOpen() || !this.socket) return false;
    this.socket.send(payload);
    return true;
  }

  private sendCommand(
    action: "subscribe" | "update" | "unsubscribe",
    subscriptions: LogicalBatchSubscription[],
  ): void {
    if (!this.isOpen() || subscriptions.length === 0) return;
    if (action === "subscribe") {
      subscriptions.forEach((item) => { item.serverState = "subscribing"; });
    }
    const sent = this.sendRaw(JSON.stringify({
      action,
      request_id: `kline-batch-${++this.requestSequence}`,
      items: subscriptions.map((item) => ({
        clientId: item.clientId,
        exchange: item.series.exchange,
        market_type: item.series.marketType,
        symbol: item.series.symbol,
        intervals: item.intervals,
      })),
    }));
    if (!sent && action === "subscribe") {
      subscriptions.forEach((item) => { item.serverState = "absent"; });
    }
  }

  private closeSubscription(subscription: LogicalBatchSubscription): void {
    if (subscription.closed) return;
    this.sendCommand("unsubscribe", [subscription]);
    subscription.closed = true;
    this.subscriptions.delete(subscription.clientId);
    if (this.subscriptions.size === 0) {
      const socket = this.socket;
      this.socket = null;
      try { socket?.close(); } catch { /* best effort */ }
    }
  }

  private handleMessage(event: MessageEvent<string>): void {
    if (event.data === "pong") return;
    let record: JsonRecord = {};
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!isJsonRecord(parsed)) throw new TypeError("batch K-line message must be an object");
      record = parsed;
      if (record.type === "connected") {
        this.subscriptions.forEach((item) => item.options.onControlMessage?.(
          { ...record, type: "connected" },
          item.controller,
        ));
        return;
      }
      if (record.type === "subscription_ack") {
        this.handleAcknowledgement(record);
        return;
      }
      const clientId = text(record.client_id);
      const subscription = this.subscriptions.get(clientId);
      if (!subscription || subscription.closed) return;
      const result = parseKlineStreamMessage(record);
      if (result.kind === "status") {
        subscription.options.onStreamStatus?.(result.message, subscription.controller);
      } else if (result.kind === "control") {
        subscription.options.onControlMessage?.(result.message, subscription.controller);
      } else if (result.kind === "backfill") {
        subscription.options.onBackfillCompleted?.(result.message, subscription.controller);
      } else if (result.kind === "kline") {
        subscription.options.onKline?.({
          interval: result.message.interval,
          tick: result.message.data,
          message: result.message,
        }, subscription.controller);
      }
    } catch (error) {
      const clientId = text(record?.client_id);
      const subscription = this.subscriptions.get(clientId);
      if (subscription) subscription.options.onParseError?.(error, event, subscription.controller);
      else this.subscriptions.forEach((item) => (
        item.options.onParseError?.(error, event, item.controller)
      ));
    }
  }

  private handleAcknowledgement(record: JsonRecord): void {
    const clientId = text(record.client_id);
    const subscription = this.subscriptions.get(clientId);
    if (!subscription || subscription.closed) return;
    const action = text(record.action);
    const active = stringList(record.active_intervals);
    const failures = Array.isArray(record.failed) ? record.failed : [];
    const type: KlineStreamControlMessage["type"] = (
      record.ok === false && record.status !== "partial"
    )
      ? "error"
      : action === "unsubscribe" ? "unsubscribed" : "subscribed";
    if (action === "subscribe") {
      subscription.serverState = type === "error" || active.length === 0
        ? "absent"
        : "subscribed";
      subscription.activeIntervals = active;
    } else if (action === "update" && type !== "error") {
      subscription.serverState = "subscribed";
      subscription.activeIntervals = active;
    } else if (action === "unsubscribe") {
      subscription.serverState = "absent";
      subscription.activeIntervals = [];
    }
    const message: KlineStreamControlMessage = {
      ...record,
      type,
      requested_intervals: [...subscription.intervals],
      intervals: active,
      active_intervals: active,
      failed: failures
        .filter(isJsonRecord)
        .map((failure) => ({
          ...failure,
          interval: text(failure.interval),
        }))
        .filter((failure) => Boolean(failure.interval)),
    };
    subscription.options.onControlMessage?.(message, subscription.controller);
    if (action === "subscribe"
      && subscription.serverState === "subscribed"
      && JSON.stringify(subscription.activeIntervals) !== JSON.stringify(subscription.intervals)) {
      this.sendCommand("update", [subscription]);
    }
  }
}
