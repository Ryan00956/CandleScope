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

type MarketStreamCommandAction = "subscribe" | "unsubscribe";

interface PendingChannelCommand {
  action: MarketStreamCommandAction;
  requestId: string;
  channels: AdvancedMarketChannel[];
}

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
  commandTimeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class MarketStreamController {
  private readonly url: string;
  private readonly identity: AdvancedMarketIdentity;
  private desiredChannels: AdvancedMarketChannel[];
  private readonly socketFactory: (url: string) => AdvancedMarketSocket;
  private readonly onRecords: (records: MarketStateRecord[]) => void;
  private readonly onStatus: (status: AdvancedMarketConnectionStatus) => void;
  private readonly onError: (error: unknown) => void;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly commandTimeoutMs: number;
  private readonly setTimer: NonNullable<MarketStreamControllerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<MarketStreamControllerOptions["clearTimer"]>;
  private socket: AdvancedMarketSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private commandTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private stopped = true;
  private requestSequence = 0;
  private readonly activeChannels = new Set<AdvancedMarketChannel>();
  private pendingCommand: PendingChannelCommand | null = null;
  private live = false;

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
    commandTimeoutMs = 30_000,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
  }: MarketStreamControllerOptions) {
    this.url = url;
    this.identity = identity;
    this.desiredChannels = Array.from(new Set(channels));
    this.socketFactory = socketFactory;
    this.onRecords = onRecords;
    this.onStatus = onStatus;
    this.onError = onError;
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

  setChannels(channels: readonly AdvancedMarketChannel[]): void {
    this.desiredChannels = Array.from(new Set(channels));
    const socket = this.socket;
    if (this.stopped || socket === null || !this.isOpen(socket)) return;
    try {
      this.reconcileChannels(socket);
    } catch (error) {
      this.onError(error);
      this.failSocket(socket);
    }
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    const activeChannels = Array.from(this.activeChannels);
    this.socket = null;
    this.resetConnectionState();
    if (!socket) return;
    try {
      if (this.isOpen(socket) && activeChannels.length > 0) {
        socket.send(JSON.stringify(this.command("unsubscribe", activeChannels)));
      }
    } catch {
      // Best-effort release; backend also releases leases when the socket closes.
    }
    try { socket.close(); } catch { /* best-effort close */ }
  }

  private connect(): void {
    if (this.stopped || this.socket !== null) return;
    this.resetConnectionState();
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
        this.reconcileChannels(socket);
      } catch (error) {
        this.onError(error);
        this.failSocket(socket);
      }
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const message = parseMarketSocketMessage(JSON.parse(String(event.data)) as unknown);
        if (message.type === "subscribed" || message.type === "unsubscribed") {
          const pending = this.pendingCommand;
          if (pending === null || !this.matchesCommandAck(message.type, message.request_id, message.streams)) {
            this.onError(new Error(`Advanced market ${message.type} acknowledgement did not match the request`));
            this.failSocket(socket);
            return;
          }
          if (pending.action === "subscribe") {
            for (const channel of pending.channels) this.activeChannels.add(channel);
          } else {
            for (const channel of pending.channels) this.activeChannels.delete(channel);
          }
          this.clearCommandTimer();
          this.pendingCommand = null;
          this.reconnectDelayMs = this.reconnectBaseMs;
          this.reconcileChannels(socket);
        } else if (message.type === "snapshot" || message.type === "update") {
          const activeRecords = message.data.filter((record) => (
            this.activeChannels.has(record.channel)
          ));
          if (activeRecords.length > 0) this.onRecords(activeRecords);
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
      this.resetConnectionState();
      this.scheduleReconnect();
    };
  }

  private failSocket(socket: AdvancedMarketSocket): void {
    if (this.stopped || this.socket !== socket) return;
    this.socket = null;
    this.resetConnectionState();
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

  private reconcileChannels(socket: AdvancedMarketSocket): void {
    if (
      this.stopped
      || this.socket !== socket
      || !this.isOpen(socket)
      || this.pendingCommand !== null
    ) {
      return;
    }

    const desired = new Set(this.desiredChannels);
    const removals = Array.from(this.activeChannels).filter((channel) => !desired.has(channel));
    if (removals.length > 0) {
      this.sendCommand(socket, "unsubscribe", removals);
      return;
    }

    const additions = this.desiredChannels.filter((channel) => !this.activeChannels.has(channel));
    if (additions.length > 0) {
      this.sendCommand(socket, "subscribe", additions);
      return;
    }

    if (!this.live) {
      this.live = true;
      this.reconnectDelayMs = this.reconnectBaseMs;
      this.onStatus("live");
    }
  }

  private sendCommand(
    socket: AdvancedMarketSocket,
    action: MarketStreamCommandAction,
    channels: AdvancedMarketChannel[],
  ): void {
    const command = this.command(action, channels);
    this.pendingCommand = {
      action,
      requestId: command.request_id,
      channels: [...channels],
    };
    socket.send(JSON.stringify(command));
    if (this.commandTimeoutMs > 0) {
      const requestId = command.request_id;
      this.commandTimer = this.setTimer(() => {
        this.commandTimer = null;
        if (
          this.stopped
          || this.socket !== socket
          || this.pendingCommand?.requestId !== requestId
        ) {
          return;
        }
        this.onError(new Error(
          `Advanced market ${action} acknowledgement timed out after ${this.commandTimeoutMs}ms`,
        ));
        this.failSocket(socket);
      }, this.commandTimeoutMs);
    }
  }

  private command(action: MarketStreamCommandAction, channels: readonly AdvancedMarketChannel[]): {
    action: MarketStreamCommandAction;
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
      streams: channels.map((channel) => ({
        exchange: this.identity.exchange,
        market_type: this.identity.marketType,
        symbol: this.identity.symbol,
        channel,
      })),
    };
  }

  private matchesCommandAck(
    messageType: "subscribed" | "unsubscribed",
    requestId: string | undefined,
    streams: readonly MarketStreamKeyPayload[],
  ): boolean {
    const pending = this.pendingCommand;
    const expectedType = pending?.action === "subscribe" ? "subscribed" : "unsubscribed";
    if (
      pending === null
      || messageType !== expectedType
      || requestId !== pending.requestId
      || streams.length !== pending.channels.length
    ) {
      return false;
    }

    const remainingChannels = new Set(pending.channels);
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

  private resetConnectionState(): void {
    this.clearCommandTimer();
    this.activeChannels.clear();
    this.pendingCommand = null;
    this.live = false;
  }

  private clearCommandTimer(): void {
    if (this.commandTimer === null) return;
    this.clearTimer(this.commandTimer);
    this.commandTimer = null;
  }

  private isOpen(socket: AdvancedMarketSocket): boolean {
    return socket.readyState === (socket.OPEN ?? SOCKET_OPEN);
  }
}
