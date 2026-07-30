import type { PluginMarketIdentity } from "./pluginPlatformTypes.js";

export const UI_BRIDGE_PROTOCOL = "candlescope.ui-bridge/1" as const;
export const UI_BRIDGE_MAX_MESSAGE_BYTES = 32 * 1024;

const TOKEN = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const generations = new Map<string, number>();

export type SandboxBridgeState =
  | "created"
  | "connecting"
  | "ready"
  | "suspended"
  | "failed"
  | "disposed";

export interface SandboxBridgeIdentity {
  pluginId: string;
  viewId: string;
  instanceId: string;
  generation: number;
}

export interface SandboxHostSnapshot {
  theme: "dark" | "light";
  locale: string;
  market: PluginMarketIdentity;
}

interface SandboxEnvelope {
  protocol: typeof UI_BRIDGE_PROTOCOL;
  token: string;
  pluginId: string;
  viewId: string;
  instanceId: string;
  generation: number;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

export type SandboxInboundMessage =
  | { type: "sandbox.ready"; payload: { capabilities: []; documentTitle: string } }
  | { type: "view.resize"; payload: { height: number } }
  | { type: "view.announce"; payload: { message: string; politeness: "polite" | "assertive" } }
  | { type: "view.error"; payload: { code: string; message: string } };

export interface SandboxBridgeCallbacks {
  onReady?(): void;
  onResize?(height: number): void;
  onAnnounce?(message: string, politeness: "polite" | "assertive"): void;
  onFailure?(code: string): void;
  onStateChange?(state: SandboxBridgeState): void;
}

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function bounded(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= UI_BRIDGE_MAX_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim();
}

export function parseSandboxBridgeMessage(
  value: unknown,
  identity: SandboxBridgeIdentity,
  token: string,
  expectedSequence: number,
): SandboxInboundMessage | null {
  const data = record(value);
  if (
    !data
    || !bounded(data)
    || !exact(data, ["protocol", "token", "pluginId", "viewId", "instanceId", "generation", "sequence", "type", "payload"])
    || data.protocol !== UI_BRIDGE_PROTOCOL
    || data.token !== token
    || data.pluginId !== identity.pluginId
    || data.viewId !== identity.viewId
    || data.instanceId !== identity.instanceId
    || data.generation !== identity.generation
    || data.sequence !== expectedSequence
  ) return null;
  const payload = record(data.payload);
  if (!payload) return null;
  if (data.type === "sandbox.ready") {
    if (
      !exact(payload, ["capabilities", "documentTitle"])
      || !Array.isArray(payload.capabilities)
      || payload.capabilities.length !== 0
      || !boundedString(payload.documentTitle, 128)
    ) return null;
    return { type: "sandbox.ready", payload: { capabilities: [], documentTitle: payload.documentTitle } };
  }
  if (data.type === "view.resize") {
    if (!exact(payload, ["height"]) || !Number.isSafeInteger(payload.height) || Number(payload.height) < 180 || Number(payload.height) > 1_200) return null;
    return { type: "view.resize", payload: { height: Number(payload.height) } };
  }
  if (data.type === "view.announce") {
    if (
      !exact(payload, ["message", "politeness"])
      || !boundedString(payload.message, 256)
      || !["polite", "assertive"].includes(String(payload.politeness))
    ) return null;
    return {
      type: "view.announce",
      payload: {
        message: payload.message,
        politeness: payload.politeness as "polite" | "assertive",
      },
    };
  }
  if (data.type === "view.error") {
    if (!exact(payload, ["code", "message"]) || !boundedString(payload.code, 64) || !boundedString(payload.message, 256)) return null;
    return { type: "view.error", payload: { code: payload.code, message: payload.message } };
  }
  return null;
}

export function nextSandboxBridgeGeneration(viewId: string): number {
  const next = (generations.get(viewId) ?? 0) + 1;
  generations.set(viewId, next);
  return next;
}

export class SandboxBridgeSession {
  private readonly token = randomHex(32);
  private port: MessagePort | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private outboundSequence = 0;
  private inboundSequence = 0;
  private focused = false;
  private _state: SandboxBridgeState = "created";

  constructor(
    readonly identity: SandboxBridgeIdentity,
    private snapshot: SandboxHostSnapshot,
    private readonly callbacks: SandboxBridgeCallbacks = {},
    private readonly connectTimeoutMs = 5_000,
  ) {
    if (
      !IDENTIFIER.test(identity.pluginId)
      || !identity.viewId.startsWith(`${identity.pluginId}.`)
      || !TOKEN.test(identity.instanceId)
      || !Number.isSafeInteger(identity.generation)
      || identity.generation < 1
    ) throw new Error("Sandbox bridge identity is invalid");
  }

  get state(): SandboxBridgeState {
    return this._state;
  }

  private changeState(state: SandboxBridgeState): void {
    this._state = state;
    this.callbacks.onStateChange?.(state);
  }

  connect(target: Window): void {
    if (this._state !== "created") throw new Error("Sandbox bridge token is one-time use");
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event) => this.receive(event.data);
    this.port.onmessageerror = () => this.fail("PLUGIN_SANDBOX_MESSAGE_INVALID");
    this.port.start();
    this.changeState("connecting");
    this.timeout = setTimeout(() => this.fail("PLUGIN_SANDBOX_CONNECT_TIMEOUT"), this.connectTimeoutMs);
    try {
      const message = this.envelope("host.connect", {
        capabilities: [],
        locale: this.snapshot.locale,
        market: this.snapshot.market,
        theme: this.snapshot.theme,
      });
      target.postMessage(message, "*", [channel.port2]);
    } catch (error) {
      channel.port2.close();
      this.fail("PLUGIN_SANDBOX_CONNECT_FAILED");
      throw error;
    }
  }

  private envelope(type: string, payload: Record<string, unknown>): SandboxEnvelope {
    this.outboundSequence += 1;
    const message: SandboxEnvelope = {
      protocol: UI_BRIDGE_PROTOCOL,
      token: this.token,
      pluginId: this.identity.pluginId,
      viewId: this.identity.viewId,
      instanceId: this.identity.instanceId,
      generation: this.identity.generation,
      sequence: this.outboundSequence,
      type,
      payload,
    };
    if (!bounded(message)) throw new Error("Sandbox bridge message exceeds its byte limit");
    return message;
  }

  private sendLifecycle(state: "visible" | "suspended" | "disposed"): void {
    if (!this.port) return;
    try {
      this.port.postMessage(this.envelope("host.lifecycle", {
        focused: this.focused,
        locale: this.snapshot.locale,
        market: this.snapshot.market,
        state,
        theme: this.snapshot.theme,
      }));
    } catch {
      this.fail("PLUGIN_SANDBOX_HOST_MESSAGE_INVALID");
    }
  }

  private sendVisibleIfReady(): void {
    if (this._state === "ready") this.sendLifecycle("visible");
  }

  private receive(value: unknown): void {
    if (!["connecting", "ready", "suspended"].includes(this._state)) return;
    const message = parseSandboxBridgeMessage(value, this.identity, this.token, this.inboundSequence + 1);
    if (!message) {
      this.fail("PLUGIN_SANDBOX_MESSAGE_INVALID");
      return;
    }
    this.inboundSequence += 1;
    if (message.type === "sandbox.ready") {
      if (this._state !== "connecting") {
        this.fail("PLUGIN_SANDBOX_READY_REPLAYED");
        return;
      }
      if (this.timeout !== null) clearTimeout(this.timeout);
      this.timeout = null;
      this.changeState("ready");
      this.callbacks.onReady?.();
      this.sendVisibleIfReady();
      return;
    }
    if (this._state !== "ready") {
      this.fail("PLUGIN_SANDBOX_MESSAGE_WHILE_SUSPENDED");
      return;
    }
    if (message.type === "view.resize") this.callbacks.onResize?.(message.payload.height);
    if (message.type === "view.announce") this.callbacks.onAnnounce?.(message.payload.message, message.payload.politeness);
    if (message.type === "view.error") this.fail("PLUGIN_SANDBOX_REPORTED_ERROR");
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    if (this._state === "ready") this.sendLifecycle("visible");
  }

  updateSnapshot(snapshot: SandboxHostSnapshot): void {
    this.snapshot = snapshot;
    if (this._state === "ready") this.sendLifecycle("visible");
  }

  suspend(): void {
    if (this._state !== "ready") return;
    this.changeState("suspended");
    this.sendLifecycle("suspended");
  }

  resume(): void {
    if (this._state !== "suspended") return;
    this.changeState("ready");
    this.sendLifecycle("visible");
  }

  private fail(code: string): void {
    if (["failed", "disposed"].includes(this._state)) return;
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
    this.port?.close();
    this.port = null;
    this.changeState("failed");
    this.callbacks.onFailure?.(code);
  }

  dispose(): void {
    if (this._state === "disposed") return;
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.timeout = null;
    if (this.port) this.sendLifecycle("disposed");
    this.port?.close();
    this.port = null;
    this.changeState("disposed");
  }
}

export function newSandboxInstanceId(): string {
  return randomHex(32);
}
