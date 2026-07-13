import {
  ApiPayloadError,
  isJsonRecord,
  parseKlineBar,
  type JsonRecord,
} from "../../../services/apiPayloadParsers.js";
import type {
  KlineApi,
  KlineStreamBackfillMessage,
  KlineStreamControlMessage,
  KlineStreamController,
  KlineStreamDataMessage,
  KlineStreamOptions,
  KlineStreamSocket,
  KlineStreamStatusMessage,
} from "../klineContracts.js";
import {
  toEpochSeconds,
  type KlineBar,
  type MarketSeries,
} from "../marketDataTypes.js";
import type { IntervalString } from "../../../utils/intervals.js";

const SOCKET_OPEN = 1;

type StreamSeries = Pick<MarketSeries, "symbol" | "marketType" | "exchange">;

interface KlineStreamSubscriptionConfig extends KlineStreamOptions {
  api: KlineApi;
  series: StreamSeries;
}

interface StreamCallbacks {
  onOpen: NonNullable<KlineStreamOptions["onOpen"]>;
  onStreamStatus: NonNullable<KlineStreamOptions["onStreamStatus"]>;
  onControlMessage: NonNullable<KlineStreamOptions["onControlMessage"]>;
  onBackfillCompleted: NonNullable<KlineStreamOptions["onBackfillCompleted"]>;
  onKline: NonNullable<KlineStreamOptions["onKline"]>;
  onError: NonNullable<KlineStreamOptions["onError"]>;
  onClose: NonNullable<KlineStreamOptions["onClose"]>;
  onParseError: NonNullable<KlineStreamOptions["onParseError"]>;
}

type ParsedStreamMessage =
  | { kind: "status"; message: KlineStreamStatusMessage }
  | { kind: "control"; message: KlineStreamControlMessage }
  | { kind: "backfill"; message: KlineStreamBackfillMessage }
  | { kind: "kline"; message: KlineStreamDataMessage }
  | { kind: "ignored" };

function expectRecord(value: unknown, path: string): JsonRecord {
  if (!isJsonRecord(value)) throw new ApiPayloadError(path, "expected an object");
  return value;
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiPayloadError(path, "expected a non-empty string");
  }
  return value;
}

function parseBackfillMessage(record: JsonRecord): KlineStreamBackfillMessage {
  const detail = expectRecord(record.detail, "websocket.detail");
  return {
    ...record,
    type: "backfill_completed",
    exchange: expectNonEmptyString(record.exchange, "websocket.exchange"),
    market_type: expectNonEmptyString(record.market_type, "websocket.market_type"),
    symbol: expectNonEmptyString(record.symbol, "websocket.symbol"),
    interval: expectNonEmptyString(record.interval, "websocket.interval"),
    detail,
  };
}

function parseKlineMessage(record: JsonRecord): KlineStreamDataMessage {
  const interval = expectNonEmptyString(record.interval, "websocket.interval");
  const transportBar = parseKlineBar(record.data, "websocket.data");
  const time = toEpochSeconds(transportBar.time);
  if (time === null) throw new ApiPayloadError("websocket.data.time", "expected unix seconds");
  const data: KlineBar = { ...transportBar, time };
  return { ...record, type: "kline", interval, data };
}

export function parseKlineStreamMessage(value: unknown): ParsedStreamMessage {
  const record = expectRecord(value, "websocket");
  const type = expectNonEmptyString(record.type, "websocket.type");

  if (type === "stream_status") {
    return { kind: "status", message: { ...record, type } };
  }
  if (
    type === "subscribed" ||
    type === "connected" ||
    type === "warning" ||
    type === "error"
  ) {
    return { kind: "control", message: { ...record, type } };
  }
  if (type === "backfill_completed") {
    return { kind: "backfill", message: parseBackfillMessage(record) };
  }
  if (type === "kline") {
    return { kind: "kline", message: parseKlineMessage(record) };
  }
  if (type === "unsubscribed") {
    return { kind: "ignored" };
  }
  throw new ApiPayloadError("websocket.type", `unsupported message type ${JSON.stringify(type)}`);
}

export class KlineStreamSubscription implements KlineStreamController {
  api: KlineApi;
  series: StreamSeries;
  desiredIntervals: IntervalString[];
  activeIntervals: Set<IntervalString>;
  callbacks: StreamCallbacks;
  socket: KlineStreamSocket;

  constructor({
    api,
    series,
    intervals = [],
    socketFactory = (url) => new WebSocket(url),
    onOpen = () => undefined,
    onStreamStatus = () => undefined,
    onControlMessage = () => undefined,
    onBackfillCompleted = () => false,
    onKline = () => undefined,
    onError = () => undefined,
    onClose = () => undefined,
    onParseError = () => undefined,
  }: KlineStreamSubscriptionConfig) {
    this.api = api;
    this.series = series;
    this.desiredIntervals = Array.from(new Set(intervals));
    this.activeIntervals = new Set();
    this.callbacks = {
      onOpen,
      onStreamStatus,
      onControlMessage,
      onBackfillCompleted,
      onKline,
      onError,
      onClose,
      onParseError,
    };
    this.socket = socketFactory(api.getMultiStreamUrl(series.symbol, series.marketType, series.exchange));
    this.bindSocket();
  }

  bindSocket(): void {
    this.socket.onopen = () => {
      this.activeIntervals = new Set();
      this.syncSubscriptions();
      this.callbacks.onOpen(this);
    };
    this.socket.onmessage = (event) => this.handleMessage(event);
    this.socket.onerror = (event) => this.callbacks.onError(event, this);
    this.socket.onclose = (event) => this.callbacks.onClose(event, this);
  }

  readyState(): number | undefined {
    return this.socket?.readyState;
  }

  isOpen(): boolean {
    return this.readyState() === (this.socket?.OPEN ?? SOCKET_OPEN);
  }

  send(payload: string): boolean {
    if (!this.isOpen()) return false;
    this.socket.send(payload);
    return true;
  }

  sendPing(): boolean {
    return this.send("ping");
  }

  updateIntervals(intervals: readonly IntervalString[] = []): void {
    this.desiredIntervals = Array.from(new Set(intervals));
    this.syncSubscriptions();
  }

  syncSubscriptions(): void {
    if (!this.isOpen()) return;

    const desired = new Set(this.desiredIntervals);
    const toSubscribe = this.desiredIntervals.filter((interval) => !this.activeIntervals.has(interval));
    const toUnsubscribe = Array.from(this.activeIntervals).filter((interval) => !desired.has(interval));

    if (toSubscribe.length > 0) {
      this.socket.send(JSON.stringify({ action: "subscribe", intervals: toSubscribe }));
      toSubscribe.forEach((interval) => this.activeIntervals.add(interval));
    }

    if (toUnsubscribe.length > 0) {
      this.socket.send(JSON.stringify({ action: "unsubscribe", intervals: toUnsubscribe }));
      toUnsubscribe.forEach((interval) => this.activeIntervals.delete(interval));
    }
  }

  handleMessage(event: MessageEvent<string>): void {
    if (event.data === "pong") return;

    let result: ParsedStreamMessage;
    try {
      const parsed: unknown = JSON.parse(event.data);
      result = parseKlineStreamMessage(parsed);
    } catch (error) {
      this.callbacks.onParseError(error, event, this);
      return;
    }

    if (result.kind === "status") {
      this.callbacks.onStreamStatus(result.message, this);
    } else if (result.kind === "control") {
      this.callbacks.onControlMessage(result.message, this);
    } else if (result.kind === "backfill") {
      this.callbacks.onBackfillCompleted(result.message, this);
    } else if (result.kind === "kline") {
      this.callbacks.onKline({
        interval: result.message.interval,
        tick: result.message.data,
        message: result.message,
      }, this);
    }
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      // Best effort close during teardown.
    }
  }
}
