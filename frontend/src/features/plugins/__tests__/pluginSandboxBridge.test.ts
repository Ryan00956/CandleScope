import assert from "node:assert/strict";
import test from "node:test";
import {
  newSandboxInstanceId,
  parseSandboxBridgeMessage,
  SandboxBridgeSession,
  UI_BRIDGE_MAX_MESSAGE_BYTES,
  UI_BRIDGE_PROTOCOL,
  type SandboxBridgeIdentity,
} from "../pluginSandboxBridge.js";

const identity: SandboxBridgeIdentity = {
  pluginId: "acme.sandbox",
  viewId: "acme.sandbox.main-view",
  instanceId: "1".repeat(64),
  generation: 7,
};

const snapshot = {
  theme: "dark" as const,
  locale: "zh-CN",
  market: { exchange: "binance", marketType: "spot", symbol: "BTCUSDT", interval: "1h" },
};

function envelope(
  connect: Record<string, unknown>,
  type: string,
  payload: Record<string, unknown>,
  sequence: number,
): Record<string, unknown> {
  return {
    protocol: connect.protocol,
    token: connect.token,
    pluginId: connect.pluginId,
    viewId: connect.viewId,
    instanceId: connect.instanceId,
    generation: connect.generation,
    sequence,
    type,
    payload,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for MessageChannel delivery");
}

function unrefForNode(port: MessagePort): void {
  (port as MessagePort & { unref?(): void }).unref?.();
}

test("bridge parser rejects stale generations, replayed sequence, extras, and oversized messages", () => {
  const token = "a".repeat(64);
  const ready = {
    protocol: UI_BRIDGE_PROTOCOL,
    token,
    ...identity,
    sequence: 1,
    type: "sandbox.ready",
    payload: { capabilities: [], documentTitle: "Sandbox" },
  };
  assert.equal(parseSandboxBridgeMessage(ready, identity, token, 1)?.type, "sandbox.ready");
  assert.equal(parseSandboxBridgeMessage(ready, identity, token, 2), null);
  assert.equal(parseSandboxBridgeMessage({ ...ready, generation: 6 }, identity, token, 1), null);
  assert.equal(parseSandboxBridgeMessage({ ...ready, origin: "trusted" }, identity, token, 1), null);
  const oversized = {
    ...ready,
    type: "view.announce",
    payload: { message: "x".repeat(UI_BRIDGE_MAX_MESSAGE_BYTES), politeness: "polite" },
  };
  assert.equal(parseSandboxBridgeMessage(oversized, identity, token, 1), null);
  assert.match(newSandboxInstanceId(), /^[a-f0-9]{64}$/);
});

test("host bridge rejects an oversized initial snapshot before transfer", () => {
  const failures: string[] = [];
  const target = {
    postMessage() {
      assert.fail("oversized bridge message must not be transferred");
    },
  } as unknown as Window;
  const session = new SandboxBridgeSession(
    identity,
    { ...snapshot, locale: "x".repeat(UI_BRIDGE_MAX_MESSAGE_BYTES) },
    { onFailure: (code) => failures.push(code) },
  );
  assert.throws(() => session.connect(target), /byte limit/);
  assert.equal(session.state, "failed");
  assert.deepEqual(failures, ["PLUGIN_SANDBOX_CONNECT_FAILED"]);
  session.dispose();
});

test("one-time MessageChannel carries only lifecycle and bounded view messages", async (context) => {
  let connect: Record<string, unknown> | null = null;
  let pluginPort: MessagePort | null = null;
  const states: string[] = [];
  const resized: number[] = [];
  const announcements: string[] = [];
  const failures: string[] = [];
  const hostMessages: Record<string, unknown>[] = [];
  const target = {
    postMessage(message: unknown, origin: string, ports: Transferable[]) {
      assert.equal(origin, "*");
      connect = message as Record<string, unknown>;
      pluginPort = ports[0] as MessagePort;
      unrefForNode(pluginPort);
      pluginPort.onmessage = (event) => hostMessages.push(event.data as Record<string, unknown>);
      pluginPort.start();
    },
  } as unknown as Window;
  const session = new SandboxBridgeSession(identity, snapshot, {
    onResize: (height) => resized.push(height),
    onAnnounce: (message) => announcements.push(message),
    onFailure: (code) => failures.push(code),
    onStateChange: (state) => states.push(state),
  }, 1_000);
  context.after(() => {
    session.dispose();
    pluginPort?.close();
  });
  session.connect(target);
  const connectMessage = connect as Record<string, unknown> | null;
  const port = pluginPort as MessagePort | null;
  assert.ok(connectMessage);
  assert.ok(port);
  assert.deepEqual(connectMessage.payload, {
    capabilities: [],
    locale: "zh-CN",
    market: snapshot.market,
    theme: "dark",
  });
  assert.throws(() => session.connect(target), /one-time/);

  port.postMessage(envelope(connectMessage, "sandbox.ready", { capabilities: [], documentTitle: "Sandbox" }, 1));
  await waitFor(() => session.state === "ready");
  assert.equal(session.state, "ready");
  await waitFor(() => hostMessages.length > 0);
  assert.equal(hostMessages.at(-1)?.type, "host.lifecycle");

  port.postMessage(envelope(connectMessage, "view.resize", { height: 520 }, 2));
  port.postMessage(envelope(connectMessage, "view.announce", { message: "Ready", politeness: "polite" }, 3));
  await waitFor(() => resized.length === 1 && announcements.length === 1);
  assert.deepEqual(resized, [520]);
  assert.deepEqual(announcements, ["Ready"]);
  session.suspend();
  assert.equal(session.state, "suspended");
  session.resume();
  assert.equal(session.state, "ready");
  session.updateSnapshot({ ...snapshot, theme: "light" });
  session.setFocused(true);
  await waitFor(() => (hostMessages.at(-1)?.payload as { focused?: boolean } | undefined)?.focused === true);
  assert.equal((hostMessages.at(-1)?.payload as { focused?: boolean }).focused, true);
  assert.equal((hostMessages.at(-1)?.payload as { theme?: string }).theme, "light");
  session.dispose();
  assert.equal(session.state, "disposed");
  assert.deepEqual(failures, []);
  assert.deepEqual(states.slice(0, 4), ["connecting", "ready", "suspended", "ready"]);
  port.close();
});

test("ready replay fails and closes the channel", async (context) => {
  let connect: Record<string, unknown> | null = null;
  let pluginPort: MessagePort | null = null;
  const failures: string[] = [];
  const target = {
    postMessage(message: unknown, _origin: string, ports: Transferable[]) {
      connect = message as Record<string, unknown>;
      pluginPort = ports[0] as MessagePort;
      unrefForNode(pluginPort);
      pluginPort.start();
    },
  } as unknown as Window;
  const session = new SandboxBridgeSession(identity, snapshot, {
    onFailure: (code) => failures.push(code),
  }, 1_000);
  context.after(() => {
    session.dispose();
    pluginPort?.close();
  });
  session.connect(target);
  const connectMessage = connect as Record<string, unknown> | null;
  const port = pluginPort as MessagePort | null;
  assert.ok(connectMessage);
  assert.ok(port);
  port.postMessage(envelope(connectMessage, "sandbox.ready", { capabilities: [], documentTitle: "Sandbox" }, 1));
  await waitFor(() => session.state === "ready");
  port.postMessage(envelope(connectMessage, "sandbox.ready", { capabilities: [], documentTitle: "Replay" }, 2));
  await waitFor(() => session.state === "failed");
  assert.equal(session.state, "failed");
  assert.deepEqual(failures, ["PLUGIN_SANDBOX_READY_REPLAYED"]);
  port.close();
});
