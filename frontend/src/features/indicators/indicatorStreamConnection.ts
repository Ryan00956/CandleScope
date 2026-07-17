import {
  parseIndicatorWsMessage,
  resolveIndicatorWsSequenceState,
} from "./indicatorWsRuntime.js";
import type {
  IndicatorSubscribeMessage,
  IndicatorWsMessage,
} from "./indicatorTypes.js";

const SOCKET_OPEN = 1;

export const INDICATOR_WS_RECONNECT_BASE_MS = 1_000;
export const INDICATOR_WS_RECONNECT_MAX_MS = 8_000;
export const INDICATOR_WS_SUBSCRIPTION_ACK_TIMEOUT_MS = 2_000;
export const INDICATOR_WS_MAX_SUBSCRIPTION_ATTEMPTS = 2;

export interface IndicatorStreamSocket {
  readonly OPEN?: number;
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  send(payload: string): void;
  close(): void;
}

export interface IndicatorStreamSubscription {
  clientId: string;
  signature: string;
  message: IndicatorSubscribeMessage;
}

export interface IndicatorStreamMessageContext {
  wsGeneration: number;
}

type ConnectionResetReason = "opened" | "closed";

interface PendingSubscription {
  attempts: number;
  signature: string;
  suppressValuesUntilAcknowledged: boolean;
}

export interface IndicatorStreamConnectionOptions {
  url: string;
  socketFactory?: (url: string) => IndicatorStreamSocket;
  onConnectionReset?: (reason: ConnectionResetReason) => void;
  onError?: (error: unknown) => void;
  onMessage?: (
    message: IndicatorWsMessage,
    context: IndicatorStreamMessageContext,
  ) => void;
  onParseError?: (error: Error) => void;
  onSocketOpen?: (context: IndicatorStreamMessageContext) => void;
  onSubscriptionPending?: (indicatorId: string, attempts: number) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  subscriptionAckTimeoutMs?: number;
  maxSubscriptionAttempts?: number;
  sequenceGapResubscribeMs?: number;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Owns one indicator WebSocket and makes the desired hosted subscriptions
 * converge after reconnects, dropped acknowledgement frames, or a server-side
 * subscription reset. The server protocol has no request id for subscriptions,
 * so a superseded in-flight subscription is resolved by replacing the socket
 * instead of accepting an ambiguous late acknowledgement on the same socket.
 */
export class IndicatorStreamConnection {
  private readonly url: string;
  private readonly socketFactory: (url: string) => IndicatorStreamSocket;
  private readonly onConnectionReset: NonNullable<IndicatorStreamConnectionOptions["onConnectionReset"]>;
  private readonly onError: NonNullable<IndicatorStreamConnectionOptions["onError"]>;
  private readonly onMessage: NonNullable<IndicatorStreamConnectionOptions["onMessage"]>;
  private readonly onParseError: NonNullable<IndicatorStreamConnectionOptions["onParseError"]>;
  private readonly onSocketOpen: NonNullable<IndicatorStreamConnectionOptions["onSocketOpen"]>;
  private readonly onSubscriptionPending: NonNullable<IndicatorStreamConnectionOptions["onSubscriptionPending"]>;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly subscriptionAckTimeoutMs: number;
  private readonly maxSubscriptionAttempts: number;
  private readonly sequenceGapResubscribeMs: number;
  private readonly setTimer: NonNullable<IndicatorStreamConnectionOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<IndicatorStreamConnectionOptions["clearTimer"]>;

  private readonly desiredSubscriptions = new Map<string, IndicatorStreamSubscription>();
  private readonly activeSubscriptions = new Map<string, string>();
  private readonly pendingSubscriptions = new Map<string, PendingSubscription>();
  private socket: IndicatorStreamSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionAckTimer: ReturnType<typeof setTimeout> | null = null;
  private sequenceGapTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private stopped = true;
  private lastSeq = 0;
  private wsGeneration = 0;

  constructor({
    url,
    socketFactory = (target) => new WebSocket(target),
    onConnectionReset = () => undefined,
    onError = () => undefined,
    onMessage = () => undefined,
    onParseError = () => undefined,
    onSocketOpen = () => undefined,
    onSubscriptionPending = () => undefined,
    reconnectBaseMs = INDICATOR_WS_RECONNECT_BASE_MS,
    reconnectMaxMs = INDICATOR_WS_RECONNECT_MAX_MS,
    subscriptionAckTimeoutMs = INDICATOR_WS_SUBSCRIPTION_ACK_TIMEOUT_MS,
    maxSubscriptionAttempts = INDICATOR_WS_MAX_SUBSCRIPTION_ATTEMPTS,
    sequenceGapResubscribeMs = 100,
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (timer) => clearTimeout(timer),
  }: IndicatorStreamConnectionOptions) {
    this.url = url;
    this.socketFactory = socketFactory;
    this.onConnectionReset = onConnectionReset;
    this.onError = onError;
    this.onMessage = onMessage;
    this.onParseError = onParseError;
    this.onSocketOpen = onSocketOpen;
    this.onSubscriptionPending = onSubscriptionPending;
    this.reconnectBaseMs = Math.max(0, Math.floor(reconnectBaseMs));
    this.reconnectMaxMs = Math.max(
      this.reconnectBaseMs,
      Math.floor(reconnectMaxMs),
    );
    this.subscriptionAckTimeoutMs = Math.max(
      0,
      Math.floor(subscriptionAckTimeoutMs),
    );
    this.maxSubscriptionAttempts = Math.max(
      1,
      Math.floor(maxSubscriptionAttempts),
    );
    this.sequenceGapResubscribeMs = Math.max(
      0,
      Math.floor(sequenceGapResubscribeMs),
    );
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.reconnectDelayMs = this.reconnectBaseMs;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectDelayMs = this.reconnectBaseMs;
    this.connect();
  }

  setSubscriptions(subscriptions: readonly IndicatorStreamSubscription[]): boolean {
    const next = new Map<string, IndicatorStreamSubscription>();
    for (const subscription of subscriptions) {
      if (!subscription.clientId || !subscription.signature) continue;
      next.set(subscription.clientId, subscription);
    }
    this.desiredSubscriptions.clear();
    for (const [clientId, subscription] of next) {
      this.desiredSubscriptions.set(clientId, subscription);
    }

    const socket = this.socket;
    if (!socket || !this.isOpen(socket)) return false;

    // A subscription acknowledgement cannot be correlated to a request. Any
    // same-client signature replacement therefore uses a fresh socket so a
    // late acknowledgement or preview from the old configuration can never
    // attach to the new configuration.
    for (const [clientId, pending] of this.pendingSubscriptions) {
      const desired = this.desiredSubscriptions.get(clientId);
      if (desired && desired.signature !== pending.signature) {
        this.restartSocketForConfigurationChange(socket);
        return false;
      }
    }

    // A prior subscribe acknowledgement can still be queued after it made the
    // active map. Since the wire protocol has no request id, accepting that
    // frame while a same-client replacement is pending would incorrectly mark
    // the new configuration as acknowledged. Isolate every active signature
    // change on a new socket instead.
    for (const [clientId, activeSignature] of this.activeSubscriptions) {
      const desired = this.desiredSubscriptions.get(clientId);
      if (desired && desired.signature !== activeSignature) {
        this.restartSocketForConfigurationChange(socket);
        return false;
      }
    }

    return this.reconcileSubscriptions(socket);
  }

  forceResubscribe(): boolean {
    const socket = this.socket;
    if (this.stopped || !socket || !this.isOpen(socket)) return false;

    for (const subscription of this.desiredSubscriptions.values()) {
      if (this.pendingSubscriptions.has(subscription.clientId)) continue;
      this.sendSubscribe(socket, subscription);
    }
    return true;
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearSubscriptionAckTimer();
    this.clearSequenceGapTimer();

    const socket = this.socket;
    this.socket = null;
    const subscriptionIds = new Set<string>([
      ...this.activeSubscriptions.keys(),
      ...this.pendingSubscriptions.keys(),
    ]);
    this.resetConnectionState();
    if (!socket) return;

    if (this.isOpen(socket)) {
      for (const clientId of subscriptionIds) {
        try {
          socket.send(JSON.stringify({ action: "unsubscribe", clientId }));
        } catch {
          // Closing the socket remains the authoritative cleanup path.
        }
      }
    }
    try { socket.close(); } catch { /* best-effort close */ }
  }

  private connect(): void {
    if (this.stopped || this.socket !== null) return;
    let socket: IndicatorStreamSocket;
    try {
      socket = this.socketFactory(this.url);
    } catch (error) {
      this.onError(error);
      this.scheduleReconnect();
      return;
    }

    this.wsGeneration += 1;
    const wsGeneration = this.wsGeneration;
    this.socket = socket;
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) return;
      this.resetConnectionState();
      this.onConnectionReset("opened");
      this.onSocketOpen({ wsGeneration });
      this.reconcileSubscriptions(socket);
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      this.handleMessage(socket, event.data, { wsGeneration });
    };
    socket.onerror = (event) => {
      if (this.stopped || this.socket !== socket) return;
      this.failSocket(socket, event);
    };
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = null;
      this.resetConnectionState();
      this.onConnectionReset("closed");
      this.scheduleReconnect();
    };
  }

  private handleMessage(
    socket: IndicatorStreamSocket,
    rawData: unknown,
    context: IndicatorStreamMessageContext,
  ): void {
    const parsed = parseIndicatorWsMessage(rawData);
    if (!parsed.ok) {
      this.onParseError(parsed.error);
      return;
    }

    const message = parsed.message;
    const sequence = resolveIndicatorWsSequenceState(message, this.lastSeq);
    if (sequence.hasGap) this.scheduleSequenceGapRecovery();
    this.lastSeq = sequence.nextSeq;

    if (message.type === "indicator.subscribed") {
      this.handleSubscribed(socket, message, context);
      return;
    }

    if (!this.shouldDispatch(message)) return;
    try {
      this.onMessage(message, context);
    } catch (error) {
      this.onError(error);
    }
  }

  private handleSubscribed(
    socket: IndicatorStreamSocket,
    message: Extract<IndicatorWsMessage, { type: "indicator.subscribed" }>,
    context: IndicatorStreamMessageContext,
  ): void {
    const clientId = message.clientId;
    const desired = this.desiredSubscriptions.get(clientId);
    if (!desired) return;

    const pending = this.pendingSubscriptions.get(clientId);
    if (pending && pending.signature !== desired.signature) {
      // The desired configuration moved while this acknowledgement was in
      // flight. Do not expose the stale acknowledgement to the UI.
      this.pendingSubscriptions.delete(clientId);
      this.reconcileSubscriptions(socket);
      return;
    }

    if (!pending && this.activeSubscriptions.get(clientId) === desired.signature) {
      return;
    }

    this.pendingSubscriptions.delete(clientId);
    this.activeSubscriptions.set(clientId, desired.signature);
    this.reconnectDelayMs = this.reconnectBaseMs;
    this.scheduleSubscriptionAckCheck();
    try {
      this.onMessage(message, context);
    } catch (error) {
      this.onError(error);
    }
    this.reconcileSubscriptions(socket);
  }

  private shouldDispatch(message: IndicatorWsMessage): boolean {
    if (message.type === "connected" || message.type === "heartbeat") return false;
    const clientId = message.clientId;
    if (!clientId || !this.desiredSubscriptions.has(clientId)) return false;
    if (message.type === "indicator.error" || message.type === "error") return true;

    const pending = this.pendingSubscriptions.get(clientId);
    return !pending?.suppressValuesUntilAcknowledged;
  }

  private reconcileSubscriptions(socket: IndicatorStreamSocket): boolean {
    if (this.stopped || this.socket !== socket || !this.isOpen(socket)) return false;

    for (const clientId of Array.from(this.pendingSubscriptions.keys())) {
      if (this.desiredSubscriptions.has(clientId)) continue;
      this.pendingSubscriptions.delete(clientId);
      this.sendUnsubscribe(socket, clientId);
    }

    for (const clientId of Array.from(this.activeSubscriptions.keys())) {
      if (this.desiredSubscriptions.has(clientId)) continue;
      this.activeSubscriptions.delete(clientId);
      this.sendUnsubscribe(socket, clientId);
    }

    for (const subscription of this.desiredSubscriptions.values()) {
      if (this.pendingSubscriptions.has(subscription.clientId)) continue;
      if (this.activeSubscriptions.get(subscription.clientId) === subscription.signature) {
        continue;
      }
      this.sendSubscribe(socket, subscription);
    }

    return true;
  }

  private sendSubscribe(
    socket: IndicatorStreamSocket,
    subscription: IndicatorStreamSubscription,
  ): void {
    if (this.stopped || this.socket !== socket || !this.isOpen(socket)) return;

    const currentPending = this.pendingSubscriptions.get(subscription.clientId);
    const attempts = currentPending?.signature === subscription.signature
      ? currentPending.attempts + 1
      : 1;
    const activeSignature = this.activeSubscriptions.get(subscription.clientId);
    this.pendingSubscriptions.set(subscription.clientId, {
      attempts,
      signature: subscription.signature,
      suppressValuesUntilAcknowledged: (
        activeSignature !== undefined && activeSignature !== subscription.signature
      ),
    });

    try {
      socket.send(JSON.stringify(subscription.message));
    } catch (error) {
      this.pendingSubscriptions.delete(subscription.clientId);
      this.failSocket(socket, error);
      return;
    }

    this.onSubscriptionPending(subscription.clientId, attempts);
    this.scheduleSubscriptionAckCheck();
  }

  private sendUnsubscribe(socket: IndicatorStreamSocket, clientId: string): void {
    if (this.stopped || this.socket !== socket || !this.isOpen(socket)) return;
    try {
      socket.send(JSON.stringify({ action: "unsubscribe", clientId }));
    } catch (error) {
      this.failSocket(socket, error);
    }
  }

  private scheduleSubscriptionAckCheck(): void {
    this.clearSubscriptionAckTimer();
    if (
      this.stopped
      || this.subscriptionAckTimeoutMs <= 0
      || this.pendingSubscriptions.size === 0
    ) {
      return;
    }

    const socket = this.socket;
    if (!socket || !this.isOpen(socket)) return;
    this.subscriptionAckTimer = this.setTimer(() => {
      this.subscriptionAckTimer = null;
      this.handleSubscriptionAckTimeout(socket);
    }, this.subscriptionAckTimeoutMs);
  }

  private handleSubscriptionAckTimeout(socket: IndicatorStreamSocket): void {
    if (this.stopped || this.socket !== socket || !this.isOpen(socket)) return;
    const retryable = Array.from(this.pendingSubscriptions.entries())
      .map(([clientId, pending]) => ({
        clientId,
        pending,
        subscription: this.desiredSubscriptions.get(clientId),
      }));

    for (const entry of retryable) {
      if (!entry.subscription || entry.pending.attempts >= this.maxSubscriptionAttempts) {
        this.failSocket(socket, new Error(
          `Indicator subscription acknowledgement timed out after ${this.subscriptionAckTimeoutMs}ms`,
        ));
        return;
      }
    }

    for (const entry of retryable) {
      if (!entry.subscription) continue;
      this.sendSubscribe(socket, entry.subscription);
    }
  }

  private scheduleSequenceGapRecovery(): void {
    if (this.sequenceGapTimer !== null || this.stopped) return;
    this.sequenceGapTimer = this.setTimer(() => {
      this.sequenceGapTimer = null;
      this.forceResubscribe();
    }, this.sequenceGapResubscribeMs);
  }

  private failSocket(socket: IndicatorStreamSocket, error: unknown): void {
    if (this.stopped || this.socket !== socket) return;
    this.onError(error);
    this.restartSocket(socket);
  }

  private restartSocketForConfigurationChange(socket: IndicatorStreamSocket): void {
    if (this.stopped || this.socket !== socket) return;
    this.restartSocket(socket);
  }

  private restartSocket(socket: IndicatorStreamSocket): void {
    if (this.stopped || this.socket !== socket) return;
    this.socket = null;
    this.resetConnectionState();
    this.onConnectionReset("closed");
    try { socket.close(); } catch { /* best-effort close */ }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      Math.max(this.reconnectBaseMs, this.reconnectDelayMs * 2),
      this.reconnectMaxMs,
    );
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private resetConnectionState(): void {
    this.clearSubscriptionAckTimer();
    this.clearSequenceGapTimer();
    this.activeSubscriptions.clear();
    this.pendingSubscriptions.clear();
    this.lastSeq = 0;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearSubscriptionAckTimer(): void {
    if (this.subscriptionAckTimer === null) return;
    this.clearTimer(this.subscriptionAckTimer);
    this.subscriptionAckTimer = null;
  }

  private clearSequenceGapTimer(): void {
    if (this.sequenceGapTimer === null) return;
    this.clearTimer(this.sequenceGapTimer);
    this.sequenceGapTimer = null;
  }

  private isOpen(socket: IndicatorStreamSocket): boolean {
    return socket.readyState === (socket.OPEN ?? SOCKET_OPEN);
  }
}
