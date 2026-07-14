import { parseMarketSocketMessage } from "./advancedMarketDataParser.js";
import {
  ADVANCED_MARKET_CHANNELS,
  type AdvancedMarketChannel,
  type AdvancedMarketConnectionStatus,
  type AdvancedMarketIdentity,
  type MarketStreamKeyPayload,
  type MarketStateRecord,
} from "./advancedMarketDataTypes.js";

const SOCKET_OPEN = 1;

export interface AdvancedMarketSocket {
  readonly OPEN?: number;
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  send(payload: string): void;
  close(): void;
}

export interface MarketStreamControllerOptions {
  url: string;
  identity: AdvancedMarketIdentity;
  channels?: readonly AdvancedMarketChannel[];
  socketFactory?: (url: string) => AdvancedMarketSocket;
  onRecords?: (records: MarketStateRecord[]) => void;
  onStatus?: (status: AdvancedMarketConnectionStatus) => void;
  onError?: (error: unknown) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class MarketStreamController {
  private readonly url: string;
  private readonly identity: AdvancedMarketIdentity;
  private readonly channels: readonly AdvancedMarketChannel[];
  private readonly socketFactory: (url: string) => AdvancedMarketSocket;
  private readonly onRecords: (records: MarketStateRecord[]) => void;
  private readonly onStatus: (status: AdvancedMarketConnectionStatus) => void;
  private readonly onError: (error: unknown) => void;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly setTimer: NonNullable<MarketStreamControllerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<MarketStreamControllerOptions["clearTimer"]>;
  private socket: AdvancedMarketSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private stopped = true;
  private requestSequence = 0;
  private pendingSubscribeRequestId: string | null = null;

  constructor({
    url,
    identity,
    channels = ADVANCED_MARKET_CHANNELS,
    socketFactory = (target) => new WebSocket(target),
    onRecords = () => undefined,
    onStatus = () => undefined,
    onError = () => undefined,
    reconnectBaseMs = 1000,
    reconnectMaxMs = 15_000,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
  }: MarketStreamControllerOptions) {
    this.url = url;
    this.identity = identity;
    this.channels = Array.from(new Set(channels));
    this.socketFactory = socketFactory;
    this.onRecords = onRecords;
    this.onStatus = onStatus;
    this.onError = onError;
    this.reconnectBaseMs = Math.max(0, reconnectBaseMs);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, reconnectMaxMs);
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
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.pendingSubscribeRequestId = null;
    if (!socket) return;
    try {
      if (this.isOpen(socket)) socket.send(JSON.stringify(this.command("unsubscribe")));
    } catch {
      // Best-effort release; backend also releases leases when the socket closes.
    }
    try { socket.close(); } catch { /* best-effort close */ }
  }

  private connect(): void {
    if (this.stopped || this.socket !== null) return;
    this.onStatus(this.reconnectDelayMs === this.reconnectBaseMs ? "connecting" : "reconnecting");
    let socket: AdvancedMarketSocket;
    try {
      socket = this.socketFactory(this.url);
    } catch (error) {
      this.onError(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const command = this.command("subscribe");
        this.pendingSubscribeRequestId = command.request_id;
        socket.send(JSON.stringify(command));
      } catch (error) {
        this.onError(error);
        this.failSocket(socket);
      }
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const message = parseMarketSocketMessage(JSON.parse(String(event.data)) as unknown);
        if (message.type === "subscribed") {
          if (!this.matchesSubscribeAck(message.request_id, message.streams)) {
            this.onError(new Error("Advanced market subscribe acknowledgement did not match the request"));
            this.failSocket(socket);
            return;
          }
          this.pendingSubscribeRequestId = null;
          this.reconnectDelayMs = this.reconnectBaseMs;
          this.onStatus("live");
        } else if (
          (message.type === "snapshot" || message.type === "update")
          && this.pendingSubscribeRequestId === null
        ) {
          this.onRecords(message.data);
        } else if (message.type === "error") {
          this.onError(new Error(message.detail || message.code || "Advanced market stream error"));
          this.failSocket(socket);
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
      this.pendingSubscribeRequestId = null;
      this.scheduleReconnect();
    };
  }

  private failSocket(socket: AdvancedMarketSocket): void {
    if (this.stopped || this.socket !== socket) return;
    this.socket = null;
    this.pendingSubscribeRequestId = null;
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

  private command(action: "subscribe" | "unsubscribe"): {
    action: "subscribe" | "unsubscribe";
    request_id: string;
    streams: Array<{
      exchange: string;
      market_type: string;
      symbol: string;
      channel: AdvancedMarketChannel;
    }>;
  } {
    this.requestSequence += 1;
    return {
      action,
      request_id: `advanced-market-${this.requestSequence}`,
      streams: this.channels.map((channel) => ({
        exchange: this.identity.exchange,
        market_type: this.identity.marketType,
        symbol: this.identity.symbol,
        channel,
      })),
    };
  }

  private matchesSubscribeAck(
    requestId: string | undefined,
    streams: readonly MarketStreamKeyPayload[],
  ): boolean {
    if (
      this.pendingSubscribeRequestId === null
      || requestId !== this.pendingSubscribeRequestId
      || streams.length !== this.channels.length
    ) {
      return false;
    }

    const remainingChannels = new Set(this.channels);
    for (const stream of streams) {
      if (
        stream.exchange.toLowerCase() !== this.identity.exchange.toLowerCase()
        || stream.market_type.toLowerCase() !== this.identity.marketType.toLowerCase()
        || stream.symbol.toUpperCase() !== this.identity.symbol.toUpperCase()
        || Object.keys(stream.params).length > 0
        || !remainingChannels.delete(stream.channel)
      ) {
        return false;
      }
    }
    return remainingChannels.size === 0;
  }

  private isOpen(socket: AdvancedMarketSocket): boolean {
    return socket.readyState === (socket.OPEN ?? SOCKET_OPEN);
  }
}
