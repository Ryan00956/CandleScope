import { parseOrderBookSocketMessage } from "./orderBookParser.js";
import type {
  OrderBookBook,
  OrderBookExternalStore,
  OrderBookIdentity,
  OrderBookMode,
  OrderBookUpdateIntervalMs,
  PartialDepthLevel,
  PriceGrouping,
} from "./orderBookTypes.js";

const SOCKET_OPEN = 1;
const PARTIAL_PROTOCOL = "orderbook.v1";
const FULL_PROTOCOL = "orderbook.full.v1";

export interface OrderBookSocket {
  readonly OPEN?: number;
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  send(payload: string): void;
  close(): void;
}

export interface OrderBookStreamControllerOptions {
  url: string;
  identity: OrderBookIdentity;
  mode: OrderBookMode;
  partialDepth: PartialDepthLevel;
  updateIntervalMs: OrderBookUpdateIntervalMs;
  fullOutputLimit: number;
  fullPriceGrouping: PriceGrouping;
  store: OrderBookExternalStore;
  socketFactory?: (url: string) => OrderBookSocket;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  commandTimeoutMs?: number;
  staleAfterMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface ExpectedStream {
  exchange: string;
  market_type: string;
  symbol: string;
  channel: "depth" | "full_depth";
  params: Record<string, number | string>;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function describeStaleReason(reason: string | null): string {
  if (!reason) return "后端正在重同步连续订单簿";
  const normalized = reason.toLowerCase();
  if (normalized === "initial_sync") return "正在同步完整订单簿";
  if (normalized.includes("gap") || normalized.includes("bridge") || normalized.includes("sequence")) {
    return "检测到序列缺口，正在重新同步";
  }
  if (normalized.includes("reconnect")) return "上游连接恢复中，等待重新同步";
  return "订单簿暂不可用，正在重新同步";
}

export class OrderBookStreamController {
  private readonly url: string;
  private readonly identity: OrderBookIdentity;
  private readonly mode: OrderBookMode;
  private readonly partialDepth: PartialDepthLevel;
  private readonly updateIntervalMs: OrderBookUpdateIntervalMs;
  private readonly fullOutputLimit: number;
  private readonly fullPriceGrouping: PriceGrouping;
  private readonly store: OrderBookExternalStore;
  private readonly socketFactory: (url: string) => OrderBookSocket;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly commandTimeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly setTimer: NonNullable<OrderBookStreamControllerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<OrderBookStreamControllerOptions["clearTimer"]>;
  private socket: OrderBookSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private commandTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private stopped = true;
  private subscribed = false;
  private requestSequence = 0;
  private pendingRequestId: string | null = null;
  private hasConnected = false;

  constructor({
    url,
    identity,
    mode,
    partialDepth,
    updateIntervalMs,
    fullOutputLimit,
    fullPriceGrouping,
    store,
    socketFactory = (target) => new WebSocket(target),
    reconnectBaseMs = 1_000,
    reconnectMaxMs = 15_000,
    commandTimeoutMs = 10_000,
    staleAfterMs = Math.max(5_000, updateIntervalMs * 10),
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
  }: OrderBookStreamControllerOptions) {
    this.url = url;
    this.identity = {
      exchange: identity.exchange.toLowerCase(),
      marketType: identity.marketType.toLowerCase(),
      symbol: identity.symbol.toUpperCase(),
    };
    this.mode = mode;
    this.partialDepth = partialDepth;
    this.updateIntervalMs = updateIntervalMs;
    this.fullOutputLimit = fullOutputLimit;
    this.fullPriceGrouping = fullPriceGrouping;
    this.store = store;
    this.socketFactory = socketFactory;
    this.reconnectBaseMs = Math.max(0, reconnectBaseMs);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, reconnectMaxMs);
    this.commandTimeoutMs = Math.max(0, commandTimeoutMs);
    this.staleAfterMs = Math.max(1, staleAfterMs);
    this.reconnectDelayMs = this.reconnectBaseMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectDelayMs = this.reconnectBaseMs;
    this.connect();
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearAllTimers();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      if (this.subscribed && this.isOpen(socket)) {
        socket.send(JSON.stringify({
          action: "unsubscribe",
          request_id: this.nextRequestId("unsubscribe"),
        }));
      }
    } catch {
      // Socket close still releases the backend lease.
    }
    try { socket.close(); } catch { /* best-effort close */ }
    this.subscribed = false;
    this.pendingRequestId = null;
  }

  private connect(): void {
    if (this.stopped || this.socket !== null) return;
    this.clearConnectionTimers();
    this.subscribed = false;
    this.pendingRequestId = null;
    this.store.publishStatus(this.hasConnected ? "reconnecting" : "connecting", { clearBook: true });
    let socket: OrderBookSocket;
    try {
      socket = this.socketFactory(this.url);
    } catch (error) {
      this.scheduleReconnect(error);
      return;
    }
    this.socket = socket;
    socket.onopen = () => undefined;
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const parsed = parseOrderBookSocketMessage(JSON.parse(String(event.data)) as unknown, this.mode);
        if (parsed.kind === "connected") {
          const expectedProtocol = this.mode === "partial" ? PARTIAL_PROTOCOL : FULL_PROTOCOL;
          if (parsed.protocol !== expectedProtocol || this.pendingRequestId !== null || this.subscribed) {
            throw new Error(`Unexpected order-book protocol handshake: ${parsed.protocol}`);
          }
          this.hasConnected = true;
          this.clearCommandTimer();
          this.sendSubscribe(socket);
          return;
        }
        if (parsed.kind === "subscribed") {
          if (
            parsed.requestId !== this.pendingRequestId
            || parsed.streams.length !== 1
            || !this.matchesExpectedStream(parsed.streams[0])
          ) {
            throw new Error("Order-book subscription acknowledgement did not match the request");
          }
          this.clearCommandTimer();
          this.pendingRequestId = null;
          this.subscribed = true;
          this.reconnectDelayMs = this.reconnectBaseMs;
          return;
        }
        if (parsed.kind === "records") {
          if (!this.subscribed) {
            throw new Error("Received order-book data before subscription acknowledgement");
          }
          const matching = parsed.records.filter((book) => this.matchesIdentity(book.identity));
          if (matching.length !== parsed.records.length) {
            throw new Error("Order-book record identity did not match the active subscription");
          }
          if (matching.some((book) => !this.matchesBookContract(book))) {
            throw new Error("Order-book record parameters did not match the active subscription");
          }
          const latest = matching.reduce((candidate, book) => (
            candidate === null || book.revision > candidate.revision ? book : candidate
          ), null as (typeof matching)[number] | null);
          if (latest) {
            this.store.publishBook(latest);
            if (this.mode === "partial") this.armStaleWatchdog();
          }
          return;
        }
        if (parsed.kind === "stale") {
          if (!this.subscribed || !this.matchesIdentity(parsed.identity)) {
            throw new Error("Order-book stale status did not match the active subscription");
          }
          this.clearStaleTimer();
          this.store.publishStatus("stale", {
            clearBook: true,
            message: describeStaleReason(parsed.message),
          });
          return;
        }
        if (parsed.kind === "error") {
          throw new Error(`${parsed.code}: ${parsed.detail}`);
        }
        if (parsed.kind === "unsubscribed") {
          throw new Error("Order-book subscription ended unexpectedly");
        }
      } catch (error) {
        this.failSocket(socket, error);
      }
    };
    this.commandTimer = this.setTimer(() => {
      if (this.socket === socket && !this.subscribed && this.pendingRequestId === null) {
        this.failSocket(socket, new Error("Order-book protocol handshake timed out"));
      }
    }, this.commandTimeoutMs);
    socket.onerror = (event) => {
      if (this.stopped || this.socket !== socket) return;
      this.failSocket(socket, event);
    };
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = null;
      this.subscribed = false;
      this.pendingRequestId = null;
      this.clearConnectionTimers();
      this.scheduleReconnect(new Error("Order-book socket closed"));
    };
  }

  private sendSubscribe(socket: OrderBookSocket): void {
    if (!this.isOpen(socket)) throw new Error("Order-book socket was not open at handshake");
    const requestId = this.nextRequestId("subscribe");
    this.pendingRequestId = requestId;
    socket.send(JSON.stringify({
      action: "subscribe",
      request_id: requestId,
      streams: [this.expectedStream()],
    }));
    this.commandTimer = this.setTimer(() => {
      if (this.socket === socket && this.pendingRequestId === requestId) {
        this.failSocket(socket, new Error("Order-book subscription acknowledgement timed out"));
      }
    }, this.commandTimeoutMs);
  }

  private expectedStream(): ExpectedStream {
    if (this.mode === "partial") {
      return {
        exchange: this.identity.exchange,
        market_type: this.identity.marketType,
        symbol: this.identity.symbol,
        channel: "depth",
        params: {
          mode: "partial",
          depth_levels: this.partialDepth,
          update_interval_ms: this.updateIntervalMs,
        },
      };
    }
    return {
      exchange: this.identity.exchange,
      market_type: this.identity.marketType,
      symbol: this.identity.symbol,
      channel: "full_depth",
      params: {
        mode: "full",
        snapshot_limit: 1000,
        update_interval_ms: this.updateIntervalMs,
        output_limit: this.fullOutputLimit,
        price_grouping: this.fullPriceGrouping,
      },
    };
  }

  private matchesExpectedStream(raw: Record<string, unknown> | undefined): boolean {
    const expected = this.expectedStream();
    const params = asObject(raw?.params);
    if (!raw || !params) return false;
    if (
      String(raw.exchange).toLowerCase() !== expected.exchange
      || String(raw.market_type).toLowerCase() !== expected.market_type
      || String(raw.symbol).toUpperCase() !== expected.symbol
      || raw.channel !== expected.channel
      || params.mode !== expected.params.mode
      || numeric(params.update_interval_ms) !== this.updateIntervalMs
    ) return false;
    return this.mode === "partial"
      ? numeric(params.depth_levels) === this.partialDepth
      : numeric(params.snapshot_limit) === 1000
        && numeric(raw.output_limit) === this.fullOutputLimit
        && raw.price_grouping === this.fullPriceGrouping;
  }

  private matchesIdentity(identity: OrderBookIdentity): boolean {
    return identity.exchange === this.identity.exchange
      && identity.marketType === this.identity.marketType
      && identity.symbol === this.identity.symbol;
  }

  private matchesBookContract(book: OrderBookBook): boolean {
    if (book.updateIntervalMs !== this.updateIntervalMs) return false;
    if (this.mode === "partial") {
      return book.depthLevels === this.partialDepth
        && book.bids.length <= this.partialDepth
        && book.asks.length <= this.partialDepth;
    }
    return book.outputLimit === this.fullOutputLimit
      && book.priceGrouping === this.fullPriceGrouping
      && book.bids.length <= this.fullOutputLimit
      && book.asks.length <= this.fullOutputLimit;
  }

  private armStaleWatchdog(): void {
    this.clearStaleTimer();
    this.staleTimer = this.setTimer(() => {
      this.staleTimer = null;
      if (this.stopped || !this.subscribed) return;
      this.store.publishStatus("stale", {
        clearBook: true,
        message: "盘口快照长时间未更新",
      });
    }, this.staleAfterMs);
  }

  private failSocket(socket: OrderBookSocket, error: unknown): void {
    if (this.stopped || this.socket !== socket) return;
    this.socket = null;
    this.subscribed = false;
    this.pendingRequestId = null;
    this.clearConnectionTimers();
    try { socket.close(); } catch { /* best-effort close */ }
    this.scheduleReconnect(error);
  }

  private scheduleReconnect(error: unknown): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const message = error instanceof Error ? error.message : "订单簿连接中断";
    this.store.publishStatus("reconnecting", { clearBook: true, message, error: message });
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      Math.max(this.reconnectBaseMs, this.reconnectDelayMs * 2),
      this.reconnectMaxMs,
    );
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private isOpen(socket: OrderBookSocket): boolean {
    return socket.readyState === (socket.OPEN ?? SOCKET_OPEN);
  }

  private nextRequestId(action: string): string {
    this.requestSequence += 1;
    return `order-book-${action}-${this.requestSequence}`;
  }

  private clearCommandTimer(): void {
    if (this.commandTimer === null) return;
    this.clearTimer(this.commandTimer);
    this.commandTimer = null;
  }

  private clearStaleTimer(): void {
    if (this.staleTimer === null) return;
    this.clearTimer(this.staleTimer);
    this.staleTimer = null;
  }

  private clearConnectionTimers(): void {
    this.clearCommandTimer();
    this.clearStaleTimer();
  }

  private clearAllTimers(): void {
    this.clearConnectionTimers();
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
