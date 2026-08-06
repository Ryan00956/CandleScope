import {
  IndicatorStreamConnection,
  type IndicatorStreamConnectionOptions,
  type IndicatorStreamMessageContext,
  type IndicatorStreamSocket,
  type IndicatorStreamSubscription,
} from "./indicatorStreamConnection.js";
import type { IndicatorWsMessage } from "./indicatorTypes.js";

export interface IndicatorStreamIdentity {
  cellId: string;
  windowId: string;
  workspaceId: string;
}

export interface SharedIndicatorLogicalOptions {
  onConnectionReset?: IndicatorStreamConnectionOptions["onConnectionReset"];
  onError?: IndicatorStreamConnectionOptions["onError"];
  onMessage?: IndicatorStreamConnectionOptions["onMessage"];
  onParseError?: IndicatorStreamConnectionOptions["onParseError"];
  onSocketOpen?: IndicatorStreamConnectionOptions["onSocketOpen"];
  onSubscriptionPending?: IndicatorStreamConnectionOptions["onSubscriptionPending"];
}

export interface SharedIndicatorLogicalConnection {
  close(): void;
  forceResubscribe(): boolean;
  setSubscriptions(subscriptions: readonly IndicatorStreamSubscription[]): boolean;
  start(): void;
}

interface LogicalClient {
  closed: boolean;
  controller: SharedIndicatorLogicalConnection;
  id: number;
  identity: IndicatorStreamIdentity;
  options: SharedIndicatorLogicalOptions;
  started: boolean;
  subscriptions: Map<string, IndicatorStreamSubscription>;
}

interface WireSubscriptionOwner {
  localClientId: string;
  logical: LogicalClient;
  subscription: IndicatorStreamSubscription;
  wireClientId: string;
}

interface PhysicalShard {
  connection: IndicatorStreamConnection;
  index: number;
  owners: Map<string, WireSubscriptionOwner>;
  started: boolean;
}

export interface SharedIndicatorStreamCoordinatorOptions {
  maxSubscriptions?: number;
  socketFactory?: (url: string) => IndicatorStreamSocket;
  url: string;
}

export interface SharedIndicatorStreamDiagnostics {
  logicalClients: number;
  maxSubscriptions: number;
  physicalShards: number;
  shards: Array<{
    index: number;
    subscriptions: number;
  }>;
  subscriptions: number;
}

function validIdentityPart(value: string): boolean {
  return Boolean(value && value.trim() === value && [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 31 && code !== 127;
  }));
}

export function indicatorWireClientId(
  identity: IndicatorStreamIdentity,
  indicatorId: string,
): string | null {
  const parts = [identity.workspaceId, identity.windowId, identity.cellId, indicatorId];
  if (parts.some((part) => !validIdentityPart(part))) return null;
  const clientId = parts.map((part) => encodeURIComponent(part)).join("/");
  return clientId.length <= 256 ? clientId : null;
}

function localizeMessage(message: IndicatorWsMessage, localClientId: string): IndicatorWsMessage {
  return { ...message, clientId: localClientId } as IndicatorWsMessage;
}

/**
 * Window-level indicator WebSocket broker. Logical per-Cell controllers keep
 * the existing hook contract while subscriptions are namespaced and packed
 * into physical shards no larger than the backend-advertised limit.
 */
export class SharedIndicatorStreamCoordinator {
  private readonly url: string;
  private readonly socketFactory: ((url: string) => IndicatorStreamSocket) | undefined;
  private readonly logicalClients = new Map<number, LogicalClient>();
  private readonly shards: PhysicalShard[] = [];
  private nextLogicalId = 0;
  private maxSubscriptions: number;
  private disposed = false;

  constructor({
    maxSubscriptions = 1,
    socketFactory,
    url,
  }: SharedIndicatorStreamCoordinatorOptions) {
    this.url = url;
    this.socketFactory = socketFactory;
    this.maxSubscriptions = Math.max(1, Math.floor(maxSubscriptions));
  }

  createLogicalConnection(
    identity: IndicatorStreamIdentity,
    options: SharedIndicatorLogicalOptions = {},
  ): SharedIndicatorLogicalConnection {
    this.nextLogicalId += 1;
    const logical = {
      closed: false,
      controller: null as unknown as SharedIndicatorLogicalConnection,
      id: this.nextLogicalId,
      identity,
      options,
      started: false,
      subscriptions: new Map<string, IndicatorStreamSubscription>(),
    };
    logical.controller = {
      start: () => {
        if (logical.closed || logical.started || this.disposed) return;
        logical.started = true;
        this.reconcile();
      },
      setSubscriptions: (subscriptions) => {
        if (logical.closed || this.disposed) return false;
        const next = new Map<string, IndicatorStreamSubscription>();
        for (const subscription of subscriptions) {
          if (!subscription.clientId || !subscription.signature) continue;
          if (!indicatorWireClientId(logical.identity, subscription.clientId)) continue;
          next.set(subscription.clientId, subscription);
        }
        logical.subscriptions = next;
        return this.reconcile();
      },
      forceResubscribe: () => {
        if (logical.closed || this.disposed) return false;
        let resubscribed = false;
        for (const shard of this.shards) {
          if ([...shard.owners.values()].some((owner) => owner.logical === logical)) {
            resubscribed = shard.connection.forceResubscribe() || resubscribed;
          }
        }
        return resubscribed;
      },
      close: () => {
        if (logical.closed) return;
        logical.closed = true;
        logical.subscriptions.clear();
        this.logicalClients.delete(logical.id);
        this.reconcile();
      },
    };
    this.logicalClients.set(logical.id, logical);
    return logical.controller;
  }

  setMaxSubscriptions(maxSubscriptions: number): void {
    const next = Math.max(1, Math.floor(maxSubscriptions));
    if (next === this.maxSubscriptions || this.disposed) return;
    this.maxSubscriptions = next;
    this.reconcile();
  }

  diagnostics(): SharedIndicatorStreamDiagnostics {
    const subscriptions = this.shards.reduce((total, shard) => total + shard.owners.size, 0);
    return {
      logicalClients: [...this.logicalClients.values()].filter((logical) => (
        logical.started && !logical.closed
      )).length,
      maxSubscriptions: this.maxSubscriptions,
      physicalShards: this.shards.length,
      shards: this.shards.map((shard) => ({
        index: shard.index,
        subscriptions: shard.owners.size,
      })),
      subscriptions,
    };
  }

  closeAll(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const logical of this.logicalClients.values()) {
      logical.closed = true;
      logical.subscriptions.clear();
    }
    this.logicalClients.clear();
    this.shards.splice(0).forEach((shard) => shard.connection.close());
  }

  private desiredOwners(): WireSubscriptionOwner[] {
    const owners: WireSubscriptionOwner[] = [];
    for (const logical of this.logicalClients.values()) {
      if (logical.closed || !logical.started) continue;
      for (const [localClientId, subscription] of logical.subscriptions) {
        const wireClientId = indicatorWireClientId(logical.identity, localClientId);
        if (!wireClientId) continue;
        owners.push({ localClientId, logical, subscription, wireClientId });
      }
    }
    return owners.sort((left, right) => left.wireClientId.localeCompare(right.wireClientId));
  }

  private reconcile(): boolean {
    if (this.disposed) return false;
    const owners = this.desiredOwners();
    const requiredShards = Math.ceil(owners.length / this.maxSubscriptions);
    while (this.shards.length < requiredShards) {
      this.shards.push(this.createShard(this.shards.length));
    }
    while (this.shards.length > requiredShards) {
      this.shards.pop()?.connection.close();
    }
    let synced = owners.length === 0;
    for (let index = 0; index < this.shards.length; index += 1) {
      const shard = this.shards[index];
      if (!shard) continue;
      const shardOwners = owners.slice(
        index * this.maxSubscriptions,
        (index + 1) * this.maxSubscriptions,
      );
      shard.owners = new Map(shardOwners.map((owner) => [owner.wireClientId, owner]));
      const subscriptions = shardOwners.map((owner) => ({
        clientId: owner.wireClientId,
        message: { ...owner.subscription.message, clientId: owner.wireClientId },
        signature: owner.subscription.signature,
      }));
      synced = shard.connection.setSubscriptions(subscriptions) || synced;
      if (!shard.started) {
        shard.started = true;
        shard.connection.start();
      }
    }
    return synced;
  }

  private createShard(index: number): PhysicalShard {
    const shard = {
      connection: null as unknown as IndicatorStreamConnection,
      index,
      owners: new Map<string, WireSubscriptionOwner>(),
      started: false,
    };
    const notifyOwners = <TArgs extends unknown[]>(
      callback: (logical: LogicalClient, ...args: TArgs) => void,
      ...args: TArgs
    ) => {
      const logicals = new Set([...shard.owners.values()].map((owner) => owner.logical));
      logicals.forEach((logical) => callback(logical, ...args));
    };
    shard.connection = new IndicatorStreamConnection({
      url: this.url,
      ...(this.socketFactory ? { socketFactory: this.socketFactory } : {}),
      onConnectionReset: (reason) => notifyOwners(
        (logical, value) => logical.options.onConnectionReset?.(value),
        reason,
      ),
      onError: (error) => notifyOwners(
        (logical, value) => logical.options.onError?.(value),
        error,
      ),
      onMessage: (message, context) => this.dispatchMessage(shard, message, context),
      onParseError: (error) => notifyOwners(
        (logical, value) => logical.options.onParseError?.(value),
        error,
      ),
      onSocketOpen: (context) => notifyOwners(
        (logical, value) => logical.options.onSocketOpen?.(value),
        context,
      ),
      onSubscriptionPending: (wireClientId, attempts) => {
        const owner = shard.owners.get(wireClientId);
        owner?.logical.options.onSubscriptionPending?.(owner.localClientId, attempts);
      },
    });
    return shard;
  }

  private dispatchMessage(
    shard: PhysicalShard,
    message: IndicatorWsMessage,
    context: IndicatorStreamMessageContext,
  ): void {
    const wireClientId = message.clientId;
    if (!wireClientId) return;
    const owner = shard.owners.get(wireClientId);
    if (!owner || owner.logical.closed) return;
    owner.logical.options.onMessage?.(
      localizeMessage(message, owner.localClientId),
      context,
    );
  }
}
