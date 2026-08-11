import assert from "node:assert/strict";
import test from "node:test";

import type { IndicatorStreamSocket } from "../indicatorStreamConnection.js";
import {
  SharedIndicatorStreamCoordinator,
  indicatorWireClientId,
} from "../sharedIndicatorStreamCoordinator.js";
import type { IndicatorWsMessage } from "../indicatorTypes.js";

class FakeSocket implements IndicatorStreamSocket {
  readonly OPEN = 1;
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  closed = false;
  sent: string[] = [];

  close(): void { this.closed = true; this.readyState = 3; }
  send(payload: string): void { this.sent.push(payload); }
  open(): void { this.readyState = this.OPEN; this.onopen?.(new Event("open")); }
  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<unknown>);
  }
}

function subscription(clientId: string, signature = `${clientId}:v1`) {
  return {
    clientId,
    signature,
    message: {
      action: "subscribe" as const,
      clientId,
      kind: "builtin" as const,
      exchange: "binance",
      marketType: "futures",
      symbol: "BTCUSDT",
      interval: "1m",
      displayName: clientId,
      name: clientId,
      params: {},
      historyLimit: 100,
    },
  };
}

function sent(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

test("wire IDs include workspace, window, Cell, and indicator identity", () => {
  assert.equal(
    indicatorWireClientId(
      { workspaceId: "workspace-a", windowId: "main-window", cellId: "cell-1" },
      "rsi/fast",
    ),
    "workspace-a/main-window/cell-1/rsi%2Ffast",
  );
  assert.equal(
    indicatorWireClientId(
      { workspaceId: "workspace-a", windowId: "main-window", cellId: "cell-1" },
      "x".repeat(256),
    ),
    null,
  );
});

test("logical Cell subscriptions share backend-sized physical shards and localize callbacks", () => {
  const sockets: FakeSocket[] = [];
  const messages: Array<{ cell: string; message: IndicatorWsMessage }> = [];
  const coordinator = new SharedIndicatorStreamCoordinator({
    url: "ws://example/indicators",
    maxSubscriptions: 2,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const first = coordinator.createLogicalConnection(
    { workspaceId: "workspace-a", windowId: "main-window", cellId: "cell-1" },
    { onMessage: (message) => messages.push({ cell: "cell-1", message }) },
  );
  const second = coordinator.createLogicalConnection(
    { workspaceId: "workspace-a", windowId: "main-window", cellId: "cell-2" },
    { onMessage: (message) => messages.push({ cell: "cell-2", message }) },
  );
  first.setSubscriptions([subscription("ma"), subscription("rsi")]);
  second.setSubscriptions([subscription("ma")]);
  first.start();
  second.start();
  assert.equal(sockets.length, 2);
  sockets.forEach((socket) => socket.open());

  const wireIds = sockets.flatMap((socket) => sent(socket))
    .filter((message) => message.action === "subscribe")
    .map((message) => String(message.clientId));
  assert.equal(new Set(wireIds).size, 3);
  assert.ok(wireIds.includes("workspace-a/main-window/cell-1/ma"));
  assert.ok(wireIds.includes("workspace-a/main-window/cell-2/ma"));
  assert.deepEqual(coordinator.diagnostics(), {
    logicalClients: 2,
    maxSubscriptions: 2,
    physicalShards: 2,
    shards: [
      { index: 0, subscriptions: 2 },
      { index: 1, subscriptions: 1 },
    ],
    subscriptions: 3,
  });

  const secondShard = sockets.find((socket) => sent(socket).some((message) => (
    message.clientId === "workspace-a/main-window/cell-2/ma"
  )));
  assert.ok(secondShard);
  secondShard.message({
    type: "indicator.preview",
    clientId: "workspace-a/main-window/cell-2/ma",
    values: { value: 12 },
    barTime: 1_700_000_000,
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.cell, "cell-2");
  assert.equal(messages[0]?.message.clientId, "ma");
  coordinator.closeAll();
});

test("local cancellation removes only that Cell and compacts shards", () => {
  const sockets: FakeSocket[] = [];
  const coordinator = new SharedIndicatorStreamCoordinator({
    url: "ws://example/indicators",
    maxSubscriptions: 1,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const first = coordinator.createLogicalConnection(
    { workspaceId: "w", windowId: "window", cellId: "cell-1" },
  );
  const second = coordinator.createLogicalConnection(
    { workspaceId: "w", windowId: "window", cellId: "cell-2" },
  );
  first.setSubscriptions([subscription("ma")]);
  second.setSubscriptions([subscription("rsi")]);
  first.start();
  second.start();
  assert.equal(coordinator.diagnostics().physicalShards, 2);

  first.close();
  assert.equal(coordinator.diagnostics().logicalClients, 1);
  assert.equal(coordinator.diagnostics().physicalShards, 1);
  assert.equal(coordinator.diagnostics().subscriptions, 1);
  assert.equal(sockets.filter((socket) => socket.closed).length, 1);
  second.close();
  assert.equal(coordinator.diagnostics().physicalShards, 0);
});

test("a capability update reshards without exceeding the advertised limit", () => {
  const sockets: FakeSocket[] = [];
  const coordinator = new SharedIndicatorStreamCoordinator({
    url: "ws://example/indicators",
    maxSubscriptions: 1,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const logical = coordinator.createLogicalConnection(
    { workspaceId: "w", windowId: "window", cellId: "cell-1" },
  );
  logical.setSubscriptions([subscription("a"), subscription("b"), subscription("c")]);
  logical.start();
  assert.equal(coordinator.diagnostics().physicalShards, 3);
  coordinator.setMaxSubscriptions(2);
  assert.equal(coordinator.diagnostics().physicalShards, 2);
  assert.ok(coordinator.diagnostics().shards.every((shard) => shard.subscriptions <= 2));
  coordinator.closeAll();
});
