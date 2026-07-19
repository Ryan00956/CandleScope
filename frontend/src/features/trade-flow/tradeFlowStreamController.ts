import { parseTradeFlowSocketMessage } from "./tradeFlowParser.js";
import type {
  TradeFlowExternalStore,
  TradeFlowIdentity,
} from "./tradeFlowTypes.js";

const SOCKET_OPEN = 1;

export interface TradeFlowSocket {
  readonly OPEN?: number;
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  send(payload: string): void;
  close(): void;
}

export interface TradeFlowStreamControllerOptions {
  url: string;
  identity: TradeFlowIdentity;
  store: TradeFlowExternalStore;
  recentLimit?: number;
  socketFactory?: (url: string) => TradeFlowSocket;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxAutomaticRetries?: number;
  commandTimeoutMs?: number;
  stableAfterMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class TradeFlowStreamController {
  private readonly url: string;
  private readonly identity: TradeFlowIdentity;
  private readonly store: TradeFlowExternalStore;
  private readonly recentLimit: number;
  private readonly socketFactory: (url: string) => TradeFlowSocket;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxAutomaticRetries: number;
  private readonly commandTimeoutMs: number;
  private readonly stableAfterMs: number;
  private readonly setTimer: NonNullable<TradeFlowStreamControllerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<TradeFlowStreamControllerOptions["clearTimer"]>;
  private socket: TradeFlowSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private commandTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private automaticRetryCount = 0;
  private stopped = true;
  private subscribed = false;
  private recentReceived = false;
  private hasConnected = false;
  private requestSequence = 0;
  private requestId: string | null = null;
  private lastBatchSequence: number | null = null;

  constructor({
    url,
    identity,
    store,
    recentLimit = 1_000,
    socketFactory = (target) => new WebSocket(target),
    reconnectBaseMs = 1_000,
    reconnectMaxMs = 15_000,
    maxAutomaticRetries = 5,
    commandTimeoutMs = 10_000,
    stableAfterMs = 10_000,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
  }: TradeFlowStreamControllerOptions) {
    this.url = url;
    this.identity = identity;
    this.store = store;
    this.recentLimit = Math.max(0, Math.min(2_000, Math.floor(recentLimit)));
    this.socketFactory = socketFactory;
    this.reconnectBaseMs = Math.max(0, reconnectBaseMs);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, reconnectMaxMs);
    this.maxAutomaticRetries = Math.max(0, Math.floor(maxAutomaticRetries));
    this.commandTimeoutMs = Math.max(0, commandTimeoutMs);
    this.stableAfterMs = Math.max(0, stableAfterMs);
    this.reconnectDelayMs = this.reconnectBaseMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.automaticRetryCount = 0;
    this.reconnectDelayMs = this.reconnectBaseMs;
    this.connect();
  }

  close(): void {
    if (this.stopped) {
      this.clearTimers();
      return;
    }
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      this.resetConnectionState();
      return;
    }
    try {
      if (this.subscribed && this.isOpen(socket)) {
        socket.send(JSON.stringify({
          action: "unsubscribe",
          request_id: this.nextRequestId("unsubscribe"),
        }));
      }
    } catch { /* close still releases the backend lease */ }
    this.detachSocket(socket);
    this.resetConnectionState();
    try { socket.close(); } catch { /* best effort */ }
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    this.resetConnectionState();
    this.store.publishStatus(this.hasConnected ? "reconnecting" : "connecting", {
      clearRecords: true,
      message: this.hasConnected ? "正在重新建立连续成交序列" : "正在连接逐笔成交流",
    });
    let socket: TradeFlowSocket;
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
        const message = parseTradeFlowSocketMessage(JSON.parse(String(event.data)) as unknown);
        if (message.kind === "connected") {
          if (this.requestId || this.subscribed) throw new Error("Unexpected TradeFlow handshake");
          this.hasConnected = true;
          try {
            this.sendSubscribe(socket);
          } catch (error) {
            this.failSocket(socket, error);
          }
          return;
        }
        if (message.kind === "subscribed") {
          if (
            message.requestId !== this.requestId
            || message.streams.length !== 1
            || !this.matchesStream(message.streams[0])
          ) {
            throw new Error("TradeFlow subscription acknowledgement did not match the request");
          }
          this.subscribed = true;
          return;
        }
        if (message.kind === "recent") {
          if (!this.subscribed || this.recentReceived || message.requestId !== this.requestId) {
            throw new Error("Unexpected TradeFlow recent handoff");
          }
          this.assertIdentity(message.records);
          if (!this.store.replaceRecent(message.records)) {
            this.failGap(socket, "近期成交快照不连续");
            return;
          }
          this.recentReceived = true;
          this.requestId = null;
          this.clearCommandTimer();
          this.armStableTimer(socket);
          return;
        }
        if (message.kind === "batch") {
          if (!this.subscribed || !this.recentReceived) {
            throw new Error("Received TradeFlow batch before the recent handoff");
          }
          if (!message.continuity || message.resyncRequired) {
            this.failGap(socket, "后端标记成交批次不连续");
            return;
          }
          // AppendBatchHub sequence is global and diagnostic. A subscription
          // filtered to one symbol can legitimately skip values when batches
          // for other identities contain no matching records.
          if (this.lastBatchSequence !== null && message.sequence <= this.lastBatchSequence) {
            this.failGap(socket, "成交批次序号倒退");
            return;
          }
          this.assertIdentity(message.records);
          if (!this.store.appendBatch(message.records)) {
            this.failGap(socket, "聚合成交 ID 不连续");
            return;
          }
          this.lastBatchSequence = message.sequence;
          return;
        }
        if (message.kind === "resync") {
          this.failGap(socket, message.message);
          return;
        }
        if (message.kind === "error") {
          const error = new Error(`${message.code}: ${message.detail}`);
          if (message.code === "SUBSCRIBE_FAILED") {
            if (
              message.requestId === null
              || message.requestId !== this.requestId
              || this.subscribed
              || this.recentReceived
            ) {
              this.failTerminal(
                socket,
                new Error("TradeFlow subscription failure did not match the pending request"),
              );
              return;
            }
            this.scheduleSubscribeRetry(socket, error);
            return;
          }
          this.failTerminal(socket, error);
          return;
        }
        if (message.kind === "unsubscribed") {
          this.failTerminal(socket, new Error("TradeFlow subscription ended unexpectedly"));
          return;
        }
      } catch (error) {
        this.failTerminal(socket, error);
      }
    };
    socket.onerror = (event) => {
      if (!this.stopped && this.socket === socket) this.failSocket(socket, event);
    };
    socket.onclose = (event) => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = null;
      this.detachSocket(socket);
      this.clearRetryTimer();
      this.resetConnectionState();
      const code = Number(event?.code || 0);
      this.scheduleReconnect(new Error(
        code ? `TradeFlow socket closed (${code})` : "TradeFlow socket closed",
      ));
    };
    if (this.commandTimeoutMs > 0) {
      this.commandTimer = this.setTimer(() => {
        this.commandTimer = null;
        if (this.socket === socket && !this.subscribed) {
          this.failSocket(socket, new Error("TradeFlow handshake timed out"));
        }
      }, this.commandTimeoutMs);
    }
  }

  private sendSubscribe(socket: TradeFlowSocket): void {
    if (!this.isOpen(socket)) throw new Error("TradeFlow socket is not open");
    const requestId = this.nextRequestId("subscribe");
    this.subscribed = false;
    this.recentReceived = false;
    this.lastBatchSequence = null;
    this.requestId = requestId;
    socket.send(JSON.stringify({
      action: "subscribe",
      request_id: requestId,
      recent_limit: this.recentLimit,
      streams: [{
        exchange: this.identity.exchange,
        market_type: this.identity.marketType,
        symbol: this.identity.symbol,
        channel: "agg_trade",
      }],
    }));
    this.clearCommandTimer();
    if (this.commandTimeoutMs > 0) {
      this.commandTimer = this.setTimer(() => {
        this.commandTimer = null;
        if (
          this.socket === socket
          && this.requestId === requestId
          && !this.recentReceived
        ) {
          this.failSocket(socket, new Error("TradeFlow recent handoff timed out"));
        }
      }, this.commandTimeoutMs);
    }
  }

  private assertIdentity(records: readonly { exchange: string; marketType: string; symbol: string }[]): void {
    if (records.some((record) => (
      record.exchange !== this.identity.exchange
      || record.marketType !== this.identity.marketType
      || record.symbol !== this.identity.symbol
    ))) throw new Error("TradeFlow record identity did not match the active subscription");
  }

  private matchesStream(stream: Record<string, unknown> | undefined): boolean {
    return Boolean(stream)
      && String(stream?.exchange || "").toLowerCase() === this.identity.exchange
      && String(stream?.market_type || "").toLowerCase() === this.identity.marketType
      && String(stream?.symbol || "").toUpperCase() === this.identity.symbol
      && String(stream?.channel || "").toLowerCase() === "agg_trade";
  }

  private failGap(socket: TradeFlowSocket, message: string): void {
    if (this.stopped || this.socket !== socket) return;
    this.clearRetryTimer();
    this.store.markGap(message);
    this.dropSocket(socket);
    this.scheduleReconnect(new Error(message), true);
  }

  private failSocket(socket: TradeFlowSocket, error: unknown): void {
    if (this.stopped || this.socket !== socket) return;
    this.clearRetryTimer();
    this.dropSocket(socket);
    this.scheduleReconnect(error);
  }

  private failTerminal(socket: TradeFlowSocket | null, error: unknown): void {
    if (this.stopped || (socket !== null && this.socket !== socket)) return;
    const message = this.errorMessage(error);
    this.stopped = true;
    this.clearTimers();
    if (socket !== null) {
      this.dropSocket(socket);
    } else {
      this.resetConnectionState();
    }
    this.store.publishStatus("error", {
      clearRecords: true,
      message,
      error: message,
    });
  }

  private dropSocket(socket: TradeFlowSocket): void {
    if (this.socket === socket) this.socket = null;
    this.detachSocket(socket);
    this.resetConnectionState();
    try { socket.close(); } catch { /* best effort */ }
  }

  private scheduleSubscribeRetry(socket: TradeFlowSocket, error: unknown): void {
    if (this.stopped || this.socket !== socket || this.retryTimer !== null) return;
    this.clearCommandTimer();
    this.clearStableTimer();
    this.subscribed = false;
    this.recentReceived = false;
    this.requestId = null;
    this.lastBatchSequence = null;
    const delay = this.takeRetryDelay();
    if (delay === null) {
      this.failTerminal(socket, this.retryLimitError(error));
      return;
    }
    const message = this.errorMessage(error);
    this.store.publishStatus("reconnecting", {
      clearRecords: true,
      message,
      error: message,
    });
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.stopped || this.socket !== socket) return;
      try {
        this.sendSubscribe(socket);
      } catch (sendError) {
        this.failSocket(socket, sendError);
      }
    }, delay);
  }

  private scheduleReconnect(error: unknown, preserveGap = false): void {
    if (this.stopped || this.retryTimer !== null) return;
    const delay = this.takeRetryDelay();
    if (delay === null) {
      this.failTerminal(null, this.retryLimitError(error));
      return;
    }
    const message = this.errorMessage(error);
    if (!preserveGap) {
      this.store.publishStatus("reconnecting", {
        clearRecords: true,
        message,
        error: message,
      });
    }
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private takeRetryDelay(): number | null {
    if (this.automaticRetryCount >= this.maxAutomaticRetries) return null;
    this.automaticRetryCount += 1;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      Math.max(this.reconnectBaseMs, this.reconnectDelayMs * 2),
      this.reconnectMaxMs,
    );
    return delay;
  }

  private retryLimitError(error: unknown): Error {
    return new Error(
      `${this.errorMessage(error)}（自动重试已达上限 ${this.maxAutomaticRetries} 次）`,
    );
  }

  private armStableTimer(socket: TradeFlowSocket): void {
    this.clearStableTimer();
    if (this.stableAfterMs === 0) {
      this.resetRetryBudget();
      return;
    }
    this.stableTimer = this.setTimer(() => {
      this.stableTimer = null;
      if (this.stopped || this.socket !== socket || !this.recentReceived) return;
      this.resetRetryBudget();
    }, this.stableAfterMs);
  }

  private resetRetryBudget(): void {
    this.automaticRetryCount = 0;
    this.reconnectDelayMs = this.reconnectBaseMs;
  }

  private resetConnectionState(): void {
    this.clearCommandTimer();
    this.clearStableTimer();
    this.subscribed = false;
    this.recentReceived = false;
    this.requestId = null;
    this.lastBatchSequence = null;
  }

  private detachSocket(socket: TradeFlowSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message
      ? error.message
      : "TradeFlow 连接中断";
  }

  private isOpen(socket: TradeFlowSocket): boolean {
    return socket.readyState === (socket.OPEN ?? SOCKET_OPEN);
  }

  private nextRequestId(action: string): string {
    this.requestSequence += 1;
    return `trade-flow-${action}-${this.requestSequence}`;
  }

  private clearCommandTimer(): void {
    if (this.commandTimer === null) return;
    this.clearTimer(this.commandTimer);
    this.commandTimer = null;
  }

  private clearStableTimer(): void {
    if (this.stableTimer === null) return;
    this.clearTimer(this.stableTimer);
    this.stableTimer = null;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }

  private clearTimers(): void {
    this.clearCommandTimer();
    this.clearStableTimer();
    this.clearRetryTimer();
  }
}
