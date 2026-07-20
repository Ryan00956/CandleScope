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
  KlineStreamIntervalFailure,
  KlineStreamOptions,
  KlineStreamSocket,
  KlineStreamStatusMessage,
} from "../klineContracts.js";
import {
  toEpochSeconds,
  type KlineBar,
  type MarketSeries,
} from "../marketDataTypes.js";
import {
  canonicalizeIntervalValue,
  type IntervalString,
} from "../../../utils/intervals.js";

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

type SubscriptionAction = "subscribe" | "unsubscribe";

interface PendingSubscriptionRequest {
  action: SubscriptionAction;
  intervals: Set<IntervalString>;
}

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

function parseOptionalString(value: unknown, path: string): string | undefined {
  if (value == null) return undefined;
  return expectNonEmptyString(value, path);
}

function parseOptionalMetadataString(value: unknown, path: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new ApiPayloadError(path, "expected a string");
  return value;
}

function parseOptionalIntervalList(
  value: unknown,
  path: string,
): IntervalString[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new ApiPayloadError(path, "expected an array");
  return value.map((interval, index) => (
    expectNonEmptyString(interval, `${path}[${index}]`)
  ));
}

function parseOptionalFailures(
  value: unknown,
  path: string,
): KlineStreamControlMessage["failed"] {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new ApiPayloadError(path, "expected an array");
  return value.map((failure, index) => {
    const record = expectRecord(failure, `${path}[${index}]`);
    const parsed: KlineStreamIntervalFailure = {
      ...record,
      interval: expectNonEmptyString(record.interval, `${path}[${index}].interval`),
    };
    const code = parseOptionalMetadataString(record.code, `${path}[${index}].code`);
    const message = parseOptionalMetadataString(record.message, `${path}[${index}].message`);
    const error = parseOptionalMetadataString(record.error, `${path}[${index}].error`);
    if (code !== undefined) parsed.code = code;
    if (message !== undefined) parsed.message = message;
    if (error !== undefined) parsed.error = error;
    return parsed;
  });
}

function parseControlMessage(
  record: JsonRecord,
  type: KlineStreamControlMessage["type"],
): KlineStreamControlMessage {
  const message: KlineStreamControlMessage = { ...record, type };
  const requestId = parseOptionalString(record.request_id, "websocket.request_id");
  const requestedIntervals = parseOptionalIntervalList(
    record.requested_intervals,
    "websocket.requested_intervals",
  );
  const intervals = parseOptionalIntervalList(record.intervals, "websocket.intervals");
  const activeIntervals = parseOptionalIntervalList(
    record.active_intervals,
    "websocket.active_intervals",
  );
  const failed = parseOptionalFailures(record.failed, "websocket.failed");
  if (requestId !== undefined) message.request_id = requestId;
  if (requestedIntervals !== undefined) message.requested_intervals = requestedIntervals;
  if (intervals !== undefined) message.intervals = intervals;
  if (activeIntervals !== undefined) message.active_intervals = activeIntervals;
  if (failed !== undefined) message.failed = failed;
  return message;
}

function canonicalInterval(interval: unknown): IntervalString {
  return canonicalizeIntervalValue(interval) || String(interval || "").trim();
}

function canonicalIntervalList(intervals: readonly IntervalString[] = []): IntervalString[] {
  const canonical: IntervalString[] = [];
  const seen = new Set<IntervalString>();
  intervals.forEach((interval) => {
    const value = canonicalInterval(interval);
    if (!value || seen.has(value)) return;
    seen.add(value);
    canonical.push(value);
  });
  return canonical;
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
    type === "unsubscribed" ||
    type === "connected" ||
    type === "warning" ||
    type === "error"
  ) {
    return { kind: "control", message: parseControlMessage(record, type) };
  }
  if (type === "backfill_completed") {
    return { kind: "backfill", message: parseBackfillMessage(record) };
  }
  if (type === "kline") {
    return { kind: "kline", message: parseKlineMessage(record) };
  }
  throw new ApiPayloadError("websocket.type", `unsupported message type ${JSON.stringify(type)}`);
}

export class KlineStreamSubscription implements KlineStreamController {
  api: KlineApi;
  series: StreamSeries;
  desiredIntervals: IntervalString[];
  activeIntervals: Set<IntervalString>;
  rejectedIntervals: Set<IntervalString>;
  pendingRequests: Map<string, PendingSubscriptionRequest>;
  callbacks: StreamCallbacks;
  socket: KlineStreamSocket;
  requestSequence: number;

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
    this.desiredIntervals = canonicalIntervalList(intervals);
    this.activeIntervals = new Set();
    this.rejectedIntervals = new Set();
    this.pendingRequests = new Map();
    this.requestSequence = 0;
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
      this.resetAcknowledgementState();
      this.syncSubscriptions();
      this.callbacks.onOpen(this);
    };
    this.socket.onmessage = (event) => this.handleMessage(event);
    this.socket.onerror = (event) => this.callbacks.onError(event, this);
    this.socket.onclose = (event) => {
      this.resetAcknowledgementState();
      this.callbacks.onClose(event, this);
    };
  }

  resetAcknowledgementState(): void {
    this.activeIntervals.clear();
    this.rejectedIntervals.clear();
    this.pendingRequests.clear();
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
    const nextIntervals = canonicalIntervalList(intervals);
    const next = new Set(nextIntervals);
    this.rejectedIntervals.forEach((interval) => {
      if (!next.has(interval)) this.rejectedIntervals.delete(interval);
    });
    this.desiredIntervals = nextIntervals;
    this.syncSubscriptions();
  }

  pendingIntervals(action: SubscriptionAction): Set<IntervalString> {
    const pending = new Set<IntervalString>();
    this.pendingRequests.forEach((request) => {
      if (request.action !== action) return;
      request.intervals.forEach((interval) => pending.add(interval));
    });
    return pending;
  }

  forgetPendingIntervals(
    action: SubscriptionAction,
    intervals: Iterable<IntervalString>,
  ): void {
    const acknowledged = new Set(intervals);
    if (acknowledged.size === 0) return;
    this.pendingRequests.forEach((request, requestId) => {
      if (request.action !== action) return;
      acknowledged.forEach((interval) => request.intervals.delete(interval));
      if (request.intervals.size === 0) this.pendingRequests.delete(requestId);
    });
  }

  sendSubscriptionRequest(
    action: SubscriptionAction,
    intervals: readonly IntervalString[],
  ): void {
    if (intervals.length === 0) return;
    const requestId = `kline-${action}-${++this.requestSequence}`;
    this.socket.send(JSON.stringify({
      action,
      request_id: requestId,
      intervals,
    }));
    this.pendingRequests.set(requestId, {
      action,
      intervals: new Set(intervals),
    });
  }

  syncSubscriptions(): void {
    if (!this.isOpen()) return;

    const desired = new Set(this.desiredIntervals);
    const pendingSubscriptions = this.pendingIntervals("subscribe");
    const pendingUnsubscriptions = this.pendingIntervals("unsubscribe");
    const toSubscribe = this.desiredIntervals.filter((interval) => (
      !this.activeIntervals.has(interval)
      && !pendingSubscriptions.has(interval)
      && !this.rejectedIntervals.has(interval)
    ));
    const toUnsubscribe = Array.from(this.activeIntervals).filter((interval) => (
      !desired.has(interval) && !pendingUnsubscriptions.has(interval)
    ));

    this.sendSubscriptionRequest("subscribe", toSubscribe);
    this.sendSubscriptionRequest("unsubscribe", toUnsubscribe);
  }

  handleControlMessage(message: KlineStreamControlMessage): void {
    const request = message.request_id
      ? this.pendingRequests.get(message.request_id)
      : undefined;
    const accepted = canonicalIntervalList(message.intervals);
    const requested = canonicalIntervalList(
      message.requested_intervals
      ?? (request ? Array.from(request.intervals) : []),
    );
    const failed = canonicalIntervalList(
      message.failed?.map((failure) => failure.interval),
    );

    if (message.active_intervals !== undefined) {
      this.activeIntervals = new Set(canonicalIntervalList(message.active_intervals));
    } else if (message.type === "subscribed") {
      accepted.forEach((interval) => this.activeIntervals.add(interval));
    } else if (message.type === "unsubscribed") {
      accepted.forEach((interval) => this.activeIntervals.delete(interval));
    }

    if (message.type === "subscribed") {
      accepted.forEach((interval) => this.rejectedIntervals.delete(interval));
      failed.forEach((interval) => {
        this.activeIntervals.delete(interval);
        if (this.desiredIntervals.includes(interval)) this.rejectedIntervals.add(interval);
      });

      const acknowledged = new Set([...accepted, ...failed]);
      if (message.requested_intervals !== undefined || request?.action === "subscribe") {
        requested.forEach((interval) => {
          if (!this.activeIntervals.has(interval) && !acknowledged.has(interval)) {
            this.rejectedIntervals.add(interval);
          }
          acknowledged.add(interval);
        });
      }
      this.forgetPendingIntervals("subscribe", acknowledged);
    } else if (message.type === "unsubscribed") {
      const acknowledged = requested.length > 0 ? requested : accepted;
      this.forgetPendingIntervals("unsubscribe", acknowledged);
    } else if (failed.length > 0) {
      failed.forEach((interval) => {
        this.activeIntervals.delete(interval);
        if (this.desiredIntervals.includes(interval)) this.rejectedIntervals.add(interval);
      });
      this.forgetPendingIntervals("subscribe", failed);
    } else if (message.type === "error" && request?.action === "subscribe") {
      request.intervals.forEach((interval) => {
        if (this.desiredIntervals.includes(interval)) this.rejectedIntervals.add(interval);
      });
      this.pendingRequests.delete(message.request_id ?? "");
    }

    if (message.request_id && message.type === "unsubscribed") {
      this.pendingRequests.delete(message.request_id);
    } else if (
      message.request_id
      && message.type === "subscribed"
      && request?.action === "subscribe"
    ) {
      this.pendingRequests.delete(message.request_id);
    }

    this.callbacks.onControlMessage(message, this);
    this.syncSubscriptions();
  }

  acknowledgeLegacyKline(interval: IntervalString): void {
    const canonical = canonicalInterval(interval);
    if (!canonical || !this.desiredIntervals.includes(canonical)) return;
    this.activeIntervals.add(canonical);
    this.rejectedIntervals.delete(canonical);
    this.forgetPendingIntervals("subscribe", [canonical]);
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
      this.handleControlMessage(result.message);
    } else if (result.kind === "backfill") {
      this.callbacks.onBackfillCompleted(result.message, this);
    } else if (result.kind === "kline") {
      this.acknowledgeLegacyKline(result.message.interval);
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
