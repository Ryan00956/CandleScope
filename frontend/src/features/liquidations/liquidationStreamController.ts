import { parseLiquidationSocketMessage } from "./liquidationParser.js";
import type { AdvancedMarketConnectionStatus } from "../advanced-market-data/advancedMarketDataTypes.js";
import type {
  LiquidationEvent,
  LiquidationIdentity,
  LiquidationQualityMetadata,
  LiquidationStreamKey,
} from "./liquidationTypes.js";

const SOCKET_OPEN = 1;

export interface LiquidationSocket {
  readonly OPEN?: number;
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  send(payload: string): void;
  close(code?: number): void;
}

export interface LiquidationStreamControllerOptions {
  url: string;
  identity: LiquidationIdentity;
  recentLimit?: number;
  socketFactory?: (url: string) => LiquidationSocket;
  onEvents?: (events: LiquidationEvent[], quality: LiquidationQualityMetadata) => void;
  onStatus?: (status: AdvancedMarketConnectionStatus) => void;
  onQuality?: (quality: LiquidationQualityMetadata) => void;
  onError?: (error: unknown) => void;
  onResyncRequired?: () => void;
  onSubscribed?: () => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  commandTimeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class LiquidationStreamController {
  private readonly url: string;
  private readonly identity: LiquidationIdentity;
  private readonly recentLimit: number;
  private readonly socketFactory: (url: string) => LiquidationSocket;
  private readonly onEvents: NonNullable<LiquidationStreamControllerOptions["onEvents"]>;
  private readonly onStatus: NonNullable<LiquidationStreamControllerOptions["onStatus"]>;
  private readonly onQuality: NonNullable<LiquidationStreamControllerOptions["onQuality"]>;
  private readonly onError: NonNullable<LiquidationStreamControllerOptions["onError"]>;
  private readonly onResyncRequired: NonNullable<LiquidationStreamControllerOptions["onResyncRequired"]>;
  private readonly onSubscribed: NonNullable<LiquidationStreamControllerOptions["onSubscribed"]>;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly commandTimeoutMs: number;
  private readonly setTimer: NonNullable<LiquidationStreamControllerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<LiquidationStreamControllerOptions["clearTimer"]>;
  private socket: LiquidationSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private commandTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private stopped = true;
  private requestSequence = 0;
  private requestId: string | null = null;
  private acknowledged = false;
  private recentReceived = false;

  constructor({
    url,
    identity,
    recentLimit = 500,
    socketFactory = (target) => new WebSocket(target),
    onEvents = () => undefined,
    onStatus = () => undefined,
    onQuality = () => undefined,
    onError = () => undefined,
    onResyncRequired = () => undefined,
    onSubscribed = () => undefined,
    reconnectBaseMs = 1000,
    reconnectMaxMs = 15_000,
    commandTimeoutMs = 30_000,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
  }: LiquidationStreamControllerOptions) {
    this.url = url;
    this.identity = identity;
    this.recentLimit = Math.max(0, Math.min(2000, Math.floor(recentLimit)));
    this.socketFactory = socketFactory;
    this.onEvents = onEvents;
    this.onStatus = onStatus;
    this.onQuality = onQuality;
    this.onError = onError;
    this.onResyncRequired = onResyncRequired;
    this.onSubscribed = onSubscribed;
    this.reconnectBaseMs = Math.max(0, reconnectBaseMs);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, reconnectMaxMs);
    this.commandTimeoutMs = Math.max(0, commandTimeoutMs);
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
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      if (this.acknowledged && this.isOpen(socket)) {
        socket.send(JSON.stringify({
          action: "unsubscribe",
          request_id: `liquidation-unsubscribe-${++this.requestSequence}`,
        }));
      }
    } catch {
      // Best-effort lease release; socket close also releases the backend lease.
    }
    try { socket.close(); } catch { /* best-effort close */ }
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    this.resetHandshake();
    this.onStatus(this.reconnectDelayMs === this.reconnectBaseMs ? "connecting" : "reconnecting");
    let socket: LiquidationSocket;
    try {
      socket = this.socketFactory(this.url);
    } catch (error) {
      this.onError(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => undefined;
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const message = parseLiquidationSocketMessage(JSON.parse(String(event.data)) as unknown);
        if (message.type === "connected") {
          if (this.requestId !== null) throw new Error("Duplicate liquidation connected message");
          this.onQuality(message.quality);
          this.subscribe(socket);
          return;
        }
        if (message.type === "subscribed") {
          if (!this.matchesAcknowledgement(message.requestId, message.streams)) {
            throw new Error("Liquidation subscribed acknowledgement did not match the request");
          }
          this.acknowledged = true;
          if (message.quality) this.onQuality(message.quality);
          return;
        }
        if (message.type === "recent") {
          if (!this.acknowledged || message.requestId !== this.requestId || this.recentReceived) {
            throw new Error("Liquidation recent snapshot arrived outside the handshake");
          }
          this.recentReceived = true;
          this.clearCommandTimer();
          this.reconnectDelayMs = this.reconnectBaseMs;
          this.onEvents(message.data, message.quality);
          this.onSubscribed();
          this.onStatus("live");
          return;
        }
        if (message.type === "liquidation.batch") {
          if (!this.recentReceived) throw new Error("Liquidation batch arrived before recent snapshot");
          this.onEvents(message.data, message.quality);
          return;
        }
        if (message.type === "resync_required") {
          this.onQuality(message.quality);
          this.onResyncRequired();
          this.failSocket(socket);
          return;
        }
        if (message.type === "error") {
          throw new Error(message.detail || message.code);
        }
      } catch (error) {
        this.onError(error);
        this.failSocket(socket);
      }
    };
    socket.onerror = (event) => {
      if (this.stopped || this.socket !== socket) return;
      this.onError(event);
      this.failSocket(socket);
    };
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = null;
      this.resetHandshake();
      this.scheduleReconnect();
    };
  }

  private subscribe(socket: LiquidationSocket): void {
    if (!this.isOpen(socket)) throw new Error("Liquidation socket is not open");
    this.requestSequence += 1;
    this.requestId = `liquidation-${this.requestSequence}`;
    socket.send(JSON.stringify({
      action: "subscribe",
      request_id: this.requestId,
      streams: [{
        exchange: this.identity.exchange,
        market_type: this.identity.marketType,
        symbol: this.identity.symbol,
        channel: "liquidation",
      }],
      recent_limit: this.recentLimit,
    }));
    if (this.commandTimeoutMs > 0) {
      this.commandTimer = this.setTimer(() => {
        this.commandTimer = null;
        if (this.stopped || this.socket !== socket || this.recentReceived) return;
        this.onError(new Error(
          `Liquidation subscription timed out after ${this.commandTimeoutMs}ms`,
        ));
        this.failSocket(socket);
      }, this.commandTimeoutMs);
    }
  }

  private matchesAcknowledgement(
    requestId: string,
    streams: readonly LiquidationStreamKey[],
  ): boolean {
    const stream = streams[0];
    return requestId === this.requestId
      && streams.length === 1
      && stream !== undefined
      && stream.exchange === this.identity.exchange.toLowerCase()
      && stream.market_type === this.identity.marketType.toLowerCase()
      && stream.symbol === this.identity.symbol.toUpperCase()
      && Object.keys(stream.params).length === 0;
  }

  private failSocket(socket: LiquidationSocket): void {
    if (this.stopped || this.socket !== socket) return;
    this.socket = null;
    this.resetHandshake();
    try { socket.close(); } catch { /* best-effort close */ }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.onStatus("reconnecting");
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

  private resetHandshake(): void {
    this.clearCommandTimer();
    this.requestId = null;
    this.acknowledged = false;
    this.recentReceived = false;
  }

  private clearCommandTimer(): void {
    if (this.commandTimer === null) return;
    this.clearTimer(this.commandTimer);
    this.commandTimer = null;
  }

  private clearTimers(): void {
    this.clearCommandTimer();
    if (this.reconnectTimer === null) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private isOpen(socket: LiquidationSocket): boolean {
    return socket.readyState === (socket.OPEN ?? SOCKET_OPEN);
  }
}
