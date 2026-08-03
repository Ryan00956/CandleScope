/* SPDX-License-Identifier: GPL-3.0-only */

import { createHash } from "node:crypto";

export const PROTOCOL = "candlescope.plugin/2" as const;
export const HOST_API = "candlescope.host-api/1" as const;
export const TRANSPORT = "jsonl/1" as const;
export const JSONRPC = "2.0" as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type RequestId = string | number;
export type MaybePromise<T> = T | Promise<T>;

export interface JsonLimits {
  readonly maxMessageBytes: number;
  readonly maxDepth: number;
  readonly maxContainerItems: number;
  readonly maxStringBytes: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = Object.freeze({
  maxMessageBytes: 1_048_576,
  maxDepth: 32,
  maxContainerItems: 10_000,
  maxStringBytes: 262_144,
});

const LOCAL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class ContractError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export class ProtocolError extends Error {
  readonly rpcCode: number;
  readonly code: string;
  readonly data: JsonObject;

  constructor(rpcCode: number, code: string, message: string, data: JsonObject = {}) {
    super(message);
    this.name = "ProtocolError";
    this.rpcCode = rpcCode;
    this.code = code;
    this.data = normalizeObject(data, "error.data");
  }

  toWire(): JsonObject {
    return {
      code: this.rpcCode,
      message: this.message,
      data: { ...this.data, code: this.code },
    };
  }
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function checkedLimits(limits: JsonLimits): JsonLimits {
  return Object.freeze({
    maxMessageBytes: positiveLimit(limits.maxMessageBytes, "maxMessageBytes"),
    maxDepth: positiveLimit(limits.maxDepth, "maxDepth"),
    maxContainerItems: positiveLimit(limits.maxContainerItems, "maxContainerItems"),
    maxStringBytes: positiveLimit(limits.maxStringBytes, "maxStringBytes"),
  });
}

function rejectUnpairedSurrogates(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ContractError("INVALID_JSON", `${path} contains an unpaired surrogate`, path);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ContractError("INVALID_JSON", `${path} contains an unpaired surrogate`, path);
    }
  }
}

class StrictParser {
  private readonly text: string;
  private readonly limits: JsonLimits;
  private index = 0;
  private containerItems = 0;

  constructor(payload: Uint8Array, limits: JsonLimits) {
    this.limits = checkedLimits(limits);
    if (payload.byteLength > this.limits.maxMessageBytes) {
      throw new ContractError(
        "MESSAGE_TOO_LARGE",
        `control message exceeds ${this.limits.maxMessageBytes} bytes`,
      );
    }
    try {
      this.text = decoder.decode(payload);
    } catch {
      throw new ContractError("INVALID_JSON", "control message is not strict UTF-8");
    }
  }

  parse(): JsonValue {
    this.space();
    const value = this.value(0, "$", true);
    this.space();
    if (this.index !== this.text.length) this.fail("unexpected trailing data", "$");
    return value;
  }

  private fail(message: string, path: string): never {
    throw new ContractError("INVALID_JSON", `${message} at byte-like offset ${this.index}`, path);
  }

  private space(): void {
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) this.index += 1;
      else break;
    }
  }

  private item(path: string): void {
    this.containerItems += 1;
    if (this.containerItems > this.limits.maxContainerItems) {
      throw new ContractError(
        "JSON_LIMIT_EXCEEDED",
        `JSON container items exceed ${this.limits.maxContainerItems}`,
        path,
      );
    }
  }

  private value(depth: number, path: string, root = false): JsonValue {
    if (!root && depth > this.limits.maxDepth) {
      throw new ContractError("JSON_LIMIT_EXCEEDED", "JSON nesting depth exceeds the limit", path);
    }
    const current = this.text[this.index];
    if (current === "{") return this.object(depth, path);
    if (current === "[") return this.array(depth, path);
    if (current === '"') return this.string(path);
    if (this.text.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (match !== null) {
      this.index = NUMBER.lastIndex;
      const value = Number(match[0]);
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        this.fail("number is non-finite or outside the safe-integer range", path);
      }
      return value;
    }
    this.fail("expected a JSON value", path);
  }

  private string(path: string): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code < 0x20) this.fail("unescaped control character", path);
      if (!escaped && code === 0x22) {
        this.index += 1;
        const token = this.text.slice(start, this.index);
        let value: unknown;
        try {
          value = JSON.parse(token);
        } catch {
          this.fail("invalid JSON string escape", path);
        }
        if (typeof value !== "string") this.fail("invalid JSON string", path);
        rejectUnpairedSurrogates(value, path);
        if (encoder.encode(value).byteLength > this.limits.maxStringBytes) {
          throw new ContractError("JSON_LIMIT_EXCEEDED", "JSON string exceeds the byte limit", path);
        }
        return value;
      }
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      this.index += 1;
    }
    this.fail("unterminated JSON string", path);
  }

  private object(depth: number, path: string): JsonObject {
    const result: JsonObject = Object.create(null) as JsonObject;
    const keys = new Set<string>();
    this.index += 1;
    this.space();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      if (this.text[this.index] !== '"') this.fail("object key must be a string", path);
      const key = this.string(path);
      if (keys.has(key)) {
        throw new ContractError("DUPLICATE_KEY", `duplicate JSON object key: ${key}`, path);
      }
      keys.add(key);
      this.item(path);
      this.space();
      if (this.text[this.index] !== ":") this.fail("expected ':' after object key", path);
      this.index += 1;
      this.space();
      Object.defineProperty(result, key, {
        value: this.value(depth + 1, `${path}.${key}`),
        enumerable: true,
        configurable: false,
        writable: false,
      });
      this.space();
      const separator = this.text[this.index];
      if (separator === "}") {
        this.index += 1;
        return result;
      }
      if (separator !== ",") this.fail("expected ',' or '}'", path);
      this.index += 1;
      this.space();
    }
  }

  private array(depth: number, path: string): JsonValue[] {
    const result: JsonValue[] = [];
    this.index += 1;
    this.space();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      this.item(path);
      result.push(this.value(depth + 1, `${path}[${result.length}]`));
      this.space();
      const separator = this.text[this.index];
      if (separator === "]") {
        this.index += 1;
        return result;
      }
      if (separator !== ",") this.fail("expected ',' or ']'", path);
      this.index += 1;
      this.space();
    }
  }
}

export function parseStrictJson(
  payload: string | Uint8Array,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonValue {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  return new StrictParser(bytes, limits).parse();
}

function normalizeValue(
  value: unknown,
  limits: JsonLimits,
  state: { items: number; seen: Set<object> },
  depth: number,
  path: string,
): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    rejectUnpairedSurrogates(value, path);
    if (encoder.encode(value).byteLength > limits.maxStringBytes) {
      throw new ContractError("JSON_LIMIT_EXCEEDED", `${path} exceeds the string limit`, path);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new ContractError("INVALID_JSON", `${path} is not a finite safe JSON number`, path);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (depth > limits.maxDepth) {
    throw new ContractError("JSON_LIMIT_EXCEEDED", `${path} exceeds the depth limit`, path);
  }
  if (typeof value !== "object") {
    throw new ContractError("INVALID_JSON", `${path} is not JSON serializable`, path);
  }
  if (state.seen.has(value)) {
    throw new ContractError("INVALID_JSON", `${path} contains a cycle`, path);
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      state.items += value.length;
      if (state.items > limits.maxContainerItems) {
        throw new ContractError("JSON_LIMIT_EXCEEDED", `${path} exceeds the item limit`, path);
      }
      return value.map((item, index) =>
        normalizeValue(item, limits, state, depth + 1, `${path}[${index}]`),
      );
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ContractError("INVALID_JSON", `${path} must be a plain object`, path);
    }
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input);
    state.items += keys.length;
    if (state.items > limits.maxContainerItems) {
      throw new ContractError("JSON_LIMIT_EXCEEDED", `${path} exceeds the item limit`, path);
    }
    const result: JsonObject = Object.create(null) as JsonObject;
    for (const key of keys) {
      rejectUnpairedSurrogates(key, path);
      Object.defineProperty(result, key, {
        value: normalizeValue(input[key], limits, state, depth + 1, `${path}.${key}`),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

export function normalizeJson(
  value: unknown,
  path = "$",
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonValue {
  const checked = checkedLimits(limits);
  return normalizeValue(value, checked, { items: 0, seen: new Set<object>() }, 0, path);
}

export function normalizeObject(
  value: unknown,
  path: string,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonObject {
  const normalized = normalizeJson(value, path, limits);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new ContractError("INVALID_CONTRACT", `${path} must be an object`, path);
  }
  return normalized;
}

function canonicalValue(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key]!)}`)
    .join(",")}}`;
}

export function canonicalJson(
  value: unknown,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): string {
  const normalized = normalizeJson(value, "$", limits);
  const result = canonicalValue(normalized);
  if (encoder.encode(result).byteLength > limits.maxMessageBytes) {
    throw new ContractError("MESSAGE_TOO_LARGE", "canonical JSON exceeds the message limit");
  }
  return result;
}

export function canonicalSha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export interface RuntimeDescriptor extends JsonObject {
  protocol: typeof PROTOCOL;
  plugin: JsonObject;
  entrypointId: string;
  contributions: JsonObject[];
  permissions: JsonObject;
  hostApis: JsonObject;
  features: string[];
}

export interface RequestContext extends JsonObject {
  contributionId: string;
  userAction: boolean;
  generation: number;
  traceId: string;
}

export interface InvokeRequest extends JsonObject {
  contributionId: string;
  input: JsonObject;
  requestContext: RequestContext;
}

export interface ActivationRequest extends JsonObject {
  instanceId: string;
  generation: number;
  capabilities: JsonObject[];
}

export interface HostResponse {
  readonly success: boolean;
  readonly result: JsonValue | null;
  readonly error: JsonObject;
  readonly generation: number;
}

export class Deferred {
  readonly token: string;
  constructor(token: string) {
    this.token = boundedString(token, "deferred.token", 128);
  }
}

export class HostCall {
  readonly token: string;
  readonly capabilityHandle: string;
  readonly method: string;
  readonly params: JsonObject;
  readonly requestContext: RequestContext;

  constructor(value: {
    token: string;
    capabilityHandle: string;
    method: string;
    params: JsonObject;
    requestContext: RequestContext;
  }) {
    this.token = boundedString(value.token, "hostCall.token", 128);
    this.capabilityHandle = boundedString(
      value.capabilityHandle,
      "hostCall.capabilityHandle",
      512,
    );
    this.method = boundedString(value.method, "hostCall.method", 128);
    this.params = normalizeObject(value.params, "hostCall.params");
    this.requestContext = validateRequestContext(value.requestContext);
  }
}

export type InvocationOutcome = JsonObject | Deferred | HostCall;

export abstract class CandleScopePlugin {
  abstract describe(): RuntimeDescriptor;
  activate(_request: ActivationRequest): MaybePromise<void> {}
  abstract invoke(request: InvokeRequest): MaybePromise<InvocationOutcome>;
  eventBatch(request: JsonObject): MaybePromise<InvocationOutcome> {
    const events = asArray(request.events, "eventBatch.events");
    return { accepted: events.length };
  }
  healthCheck(): MaybePromise<JsonObject> {
    return { status: "ready" };
  }
  cancel(_token: string): MaybePromise<void> {}
  completeHostCall(_token: string, _response: HostResponse): MaybePromise<InvocationOutcome> {
    throw new ProtocolError(
      -32107,
      "HOST_CALL_COMPLETION_UNSUPPORTED",
      "Plugin initiated a Host API call but cannot consume its response.",
    );
  }
  prepareUpgrade(): MaybePromise<void> {}
  deactivate(_reason: string): MaybePromise<void> {}
  shutdown(): MaybePromise<void> {}
}

interface RpcRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params: JsonObject;
  readonly generation: number;
}

interface RpcResponse {
  readonly id: RequestId;
  readonly success: boolean;
  readonly result: JsonValue | null;
  readonly error: JsonObject;
  readonly generation: number;
}

interface Pending {
  readonly requestId: RequestId;
  readonly generation: number;
  token: string;
  readonly requestContext: RequestContext | JsonObject;
  readonly resultPath: string;
  hostCallId: RequestId | null;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown, path: string): JsonObject {
  if (!isObject(value)) throw invalid(`${path} must be an object`, path);
  return value;
}

function asArray(value: unknown, path: string): JsonValue[] {
  if (!Array.isArray(value)) throw invalid(`${path} must be an array`, path);
  return value;
}

function exact(value: JsonObject, fields: readonly string[], path: string): void {
  const expected = new Set(fields);
  const actual = Object.keys(value);
  const missing = fields.filter((item) => !Object.hasOwn(value, item)).sort();
  const unknown = actual.filter((item) => !expected.has(item)).sort();
  if (missing.length || unknown.length) {
    throw invalid(
      `${path} has invalid fields; missing=[${missing.join(", ")}], unknown=[${unknown.join(", ")}]`,
      path,
    );
  }
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw invalid(`${path} must be a non-empty bounded string`, path);
  }
  return value;
}

function localId(value: unknown, path: string): string {
  const result = boundedString(value, path, 128);
  if (!LOCAL_ID.test(result)) throw invalid(`${path} is invalid`, path);
  return result;
}

function integer(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw invalid(`${path} must be an integer >= ${minimum}`, path);
  }
  return value as number;
}

function requestId(value: unknown, path: string): RequestId {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw invalid(`${path} must be a non-negative integer or non-empty string`, path);
}

function stringList(value: unknown, path: string, allowEmpty: boolean): string[] {
  const raw = asArray(value, path);
  if (!allowEmpty && raw.length === 0) throw invalid(`${path} must not be empty`, path);
  return raw.map((item) => boundedString(item, `${path}[]`, 256));
}

function uniqueStrings(value: unknown, path: string): string[] {
  const result = stringList(value, path, true);
  if (new Set(result).size !== result.length) throw invalid(`${path} must be unique`, path);
  return result;
}

function invalid(message: string, path?: string): ProtocolError {
  return new ProtocolError(-32602, "INVALID_CONTRACT", message, path ? { path } : {});
}

function error(
  rpcCode: number,
  code: string,
  message: string,
  data: JsonObject = {},
): ProtocolError {
  return new ProtocolError(rpcCode, code, message, data);
}

function success(id: RequestId | null, result: unknown, generation: number): JsonObject {
  return { jsonrpc: JSONRPC, id, result: normalizeJson(result, "result"), generation };
}

function failure(
  id: RequestId | null,
  generation: number,
  reason: ProtocolError,
): JsonObject {
  return { jsonrpc: JSONRPC, id, error: reason.toWire(), generation };
}

function outboundRequest(
  id: RequestId,
  method: string,
  params: JsonObject,
  generation: number,
): JsonObject {
  return { jsonrpc: JSONRPC, id, method, params, generation };
}

function parseRequest(frame: JsonObject): RpcRequest {
  exact(frame, ["jsonrpc", "id", "method", "params", "generation"], "request");
  if (frame.jsonrpc !== JSONRPC) throw invalid("jsonrpc must be 2.0", "jsonrpc");
  return {
    id: requestId(frame.id, "id"),
    method: boundedString(frame.method, "method", 128),
    params: asObject(frame.params, "params"),
    generation: integer(frame.generation, "generation", 0),
  };
}

function parseResponse(frame: JsonObject, isSuccess: boolean): RpcResponse {
  exact(
    frame,
    isSuccess
      ? ["jsonrpc", "id", "result", "generation"]
      : ["jsonrpc", "id", "error", "generation"],
    "response",
  );
  if (frame.jsonrpc !== JSONRPC) throw invalid("jsonrpc must be 2.0", "jsonrpc");
  return {
    id: requestId(frame.id, "id"),
    success: isSuccess,
    result: isSuccess ? frame.result! : null,
    error: isSuccess ? {} : asObject(frame.error, "error"),
    generation: integer(frame.generation, "generation", 0),
  };
}

function validateRequestContext(value: unknown): RequestContext {
  const context = asObject(value, "requestContext");
  exact(context, ["contributionId", "userAction", "generation", "traceId"], "requestContext");
  const contributionId = localId(context.contributionId, "requestContext.contributionId");
  if (typeof context.userAction !== "boolean") {
    throw invalid("requestContext.userAction must be a boolean", "requestContext.userAction");
  }
  const generation = integer(context.generation, "requestContext.generation", 1);
  const traceId = boundedString(context.traceId, "requestContext.traceId", 128);
  return { contributionId, userAction: context.userAction, generation, traceId };
}

function validateDescriptor(value: unknown): RuntimeDescriptor {
  const descriptor = normalizeObject(value, "descriptor") as RuntimeDescriptor;
  exact(
    descriptor,
    ["protocol", "plugin", "entrypointId", "contributions", "permissions", "hostApis", "features"],
    "descriptor",
  );
  if (descriptor.protocol !== PROTOCOL) throw invalid(`descriptor.protocol must be ${PROTOCOL}`);
  const identity = asObject(descriptor.plugin, "descriptor.plugin");
  exact(identity, ["id", "name", "version", "publisher"], "descriptor.plugin");
  localId(identity.id, "descriptor.plugin.id");
  boundedString(identity.name, "descriptor.plugin.name", 256);
  boundedString(identity.version, "descriptor.plugin.version", 64);
  localId(identity.publisher, "descriptor.plugin.publisher");
  const entrypoint = localId(descriptor.entrypointId, "descriptor.entrypointId");
  const contributions = asArray(descriptor.contributions, "descriptor.contributions");
  if (contributions.length === 0) throw invalid("descriptor.contributions must not be empty");
  const contributionIds = new Set<string>();
  for (const raw of contributions) {
    const item = asObject(raw, "descriptor.contribution");
    exact(item, ["id", "kind", "title", "entrypoint"], "descriptor.contribution");
    const id = localId(item.id, "descriptor.contribution.id");
    if (contributionIds.has(id)) throw invalid("descriptor contribution ids must be unique");
    contributionIds.add(id);
    boundedString(item.kind, "descriptor.contribution.kind", 64);
    boundedString(item.title, "descriptor.contribution.title", 256);
    if (item.entrypoint !== entrypoint) {
      throw invalid("descriptor contribution belongs to another entrypoint");
    }
  }
  const permissions = asObject(descriptor.permissions, "descriptor.permissions");
  exact(permissions, ["required", "optional"], "descriptor.permissions");
  const requiredPermissions = uniqueStrings(permissions.required, "descriptor.permissions.required");
  const optionalPermissions = uniqueStrings(permissions.optional, "descriptor.permissions.optional");
  if (requiredPermissions.some((item) => optionalPermissions.includes(item))) {
    throw invalid("descriptor permission lists must be disjoint");
  }
  const hostApis = asObject(descriptor.hostApis, "descriptor.hostApis");
  exact(hostApis, ["required", "optional"], "descriptor.hostApis");
  const requiredApis = uniqueStrings(hostApis.required, "descriptor.hostApis.required");
  const optionalApis = uniqueStrings(hostApis.optional, "descriptor.hostApis.optional");
  if (requiredApis.some((item) => optionalApis.includes(item))) {
    throw invalid("descriptor Host API lists must be disjoint");
  }
  uniqueStrings(descriptor.features, "descriptor.features");
  return descriptor;
}

export class Dispatcher {
  readonly descriptor: RuntimeDescriptor;
  private readonly plugin: CandleScopePlugin;
  private readonly maxInFlight: number;
  private readonly contributionIds: Set<string>;
  private readonly requiredPermissions: Set<string>;
  private readonly optionalPermissions: Set<string>;
  private readonly requiredHostApis: string[];
  private readonly optionalHostApis: string[];
  private readonly pending = new Map<RequestId, Pending>();
  private readonly hostCalls = new Map<RequestId, RequestId>();
  private readonly capabilities = new Map<string, string>();
  private readonly negotiatedHostApis = new Set<string>();
  private stateValue = "created";
  private generationValue = 0;
  private highestGeneration = 0;
  private nextHostCallId = 1;

  constructor(plugin: CandleScopePlugin, maxInFlight = 32) {
    if (!(plugin instanceof CandleScopePlugin)) throw new TypeError("plugin must extend CandleScopePlugin");
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
      throw new TypeError("maxInFlight must be a positive integer");
    }
    this.plugin = plugin;
    this.maxInFlight = maxInFlight;
    this.descriptor = validateDescriptor(plugin.describe());
    this.contributionIds = new Set(
      this.descriptor.contributions.map((item) => localId(item.id, "descriptor.contribution.id")),
    );
    const permissions = asObject(this.descriptor.permissions, "descriptor.permissions");
    this.requiredPermissions = new Set(stringList(permissions.required, "permissions.required", true));
    this.optionalPermissions = new Set(stringList(permissions.optional, "permissions.optional", true));
    const hostApis = asObject(this.descriptor.hostApis, "descriptor.hostApis");
    this.requiredHostApis = stringList(hostApis.required, "hostApis.required", true);
    this.optionalHostApis = stringList(hostApis.optional, "hostApis.optional", true);
  }

  get shutdownRequested(): boolean {
    return this.stateValue === "closed";
  }

  get state(): string {
    return this.stateValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  async handle(raw: unknown): Promise<JsonObject[]> {
    const frame = asObject(raw, "frame");
    const request = Object.hasOwn(frame, "method");
    const succeeded = Object.hasOwn(frame, "result");
    const failed = Object.hasOwn(frame, "error");
    if (Number(request) + Number(succeeded) + Number(failed) !== 1) {
      throw invalid("JSON-RPC frame must contain exactly one of method, result, or error", "frame");
    }
    if (request) return this.handleRequest(parseRequest(frame));
    return this.handleHostResponse(parseResponse(frame, succeeded));
  }

  private async handleRequest(request: RpcRequest): Promise<JsonObject[]> {
    if (this.stateValue === "closed") throw error(-32103, "SESSION_CLOSED", "The plugin session is already closed.");
    if (this.pending.has(request.id)) {
      throw error(-32105, "REQUEST_ID_IN_USE", "A request with this id is still in flight.", {
        requestId: request.id,
      });
    }
    if (request.method === "handshake") return [this.handshake(request)];
    if (this.stateValue === "created") {
      throw error(-32101, "HANDSHAKE_REQUIRED", "handshake must complete before other methods");
    }
    switch (request.method) {
      case "describe":
        this.requireControlGeneration(request, true);
        return [success(request.id, this.descriptor, request.generation)];
      case "activate":
        return [await this.activate(request)];
      case "invoke":
        return this.invoke(request, false);
      case "eventBatch":
        return this.invoke(request, true);
      case "healthCheck":
        this.requireCurrentGeneration(request);
        exact(request.params, [], "healthCheck");
        return [success(request.id, normalizeObject(await this.plugin.healthCheck(), "healthCheck.result"), request.generation)];
      case "cancel":
        return this.cancel(request);
      case "prepareUpgrade":
        return this.prepareUpgrade(request);
      case "deactivate":
        return this.deactivate(request);
      case "shutdown":
        return this.shutdown(request);
      default:
        throw error(-32601, "METHOD_NOT_FOUND", `Unknown Plugin Platform method: ${request.method}`, {
          method: request.method,
        });
    }
  }

  private handshake(request: RpcRequest): JsonObject {
    if (this.stateValue !== "created") {
      throw error(-32103, "HANDSHAKE_ALREADY_COMPLETED", "handshake may only be completed once per process session");
    }
    if (request.generation !== 0) throw error(-32104, "GENERATION_MISMATCH", "handshake must use generation 0");
    exact(request.params, ["protocols", "host", "entrypointId", "hostApis", "transports"], "handshake");
    const protocols = stringList(request.params.protocols, "handshake.protocols", false);
    const transports = stringList(request.params.transports, "handshake.transports", false);
    const offered = stringList(request.params.hostApis, "handshake.hostApis", true);
    const host = asObject(request.params.host, "handshake.host");
    exact(host, ["name", "version"], "handshake.host");
    boundedString(host.name, "handshake.host.name", 256);
    boundedString(host.version, "handshake.host.version", 64);
    if (!protocols.includes(PROTOCOL)) {
      throw error(-32102, "PROTOCOL_UNSUPPORTED", `Host did not offer required protocol ${PROTOCOL}.`, {
        supportedProtocols: [PROTOCOL],
      });
    }
    if (!transports.includes(TRANSPORT)) {
      throw error(-32102, "TRANSPORT_UNSUPPORTED", `Host did not offer required transport ${TRANSPORT}.`, {
        supportedTransports: [TRANSPORT],
      });
    }
    const entrypoint = localId(request.params.entrypointId, "handshake.entrypointId");
    if (entrypoint !== this.descriptor.entrypointId) {
      throw error(-32107, "ENTRYPOINT_MISMATCH", "Host requested an entrypoint not owned by this process.", {
        entrypointId: entrypoint,
      });
    }
    const missing = this.requiredHostApis.filter((item) => !offered.includes(item)).sort();
    if (missing.length) {
      throw error(-32102, "HOST_API_UNSUPPORTED", "Host is missing APIs required by this entrypoint.", {
        missingHostApis: missing,
      });
    }
    this.negotiatedHostApis.clear();
    for (const item of [...this.requiredHostApis, ...this.optionalHostApis]) {
      if (offered.includes(item)) this.negotiatedHostApis.add(item);
    }
    this.stateValue = "handshaken";
    return success(
      request.id,
      {
        protocol: PROTOCOL,
        transport: TRANSPORT,
        descriptor: this.descriptor,
        negotiatedHostApis: [...this.negotiatedHostApis],
      },
      0,
    );
  }

  private async activate(request: RpcRequest): Promise<JsonObject> {
    if (this.stateValue !== "handshaken") {
      throw error(-32103, "ACTIVATION_STATE_INVALID", "activate requires a handshaken inactive session");
    }
    exact(request.params, ["instanceId", "generation", "capabilities"], "activate");
    const instanceId = boundedString(request.params.instanceId, "activate.instanceId", 128);
    const generation = integer(request.params.generation, "activate.generation", 1);
    if (request.generation !== generation) {
      throw error(-32104, "GENERATION_MISMATCH", "activate envelope and params generations differ");
    }
    if (generation <= this.highestGeneration) {
      throw error(-32104, "STALE_GENERATION", "activation generation must increase monotonically", {
        highestGeneration: this.highestGeneration,
      });
    }
    const rawCapabilities = asArray(request.params.capabilities, "activate.capabilities");
    const handles = new Set<string>();
    const granted = new Set<string>();
    const capabilities = new Map<string, string>();
    const normalizedCapabilities: JsonObject[] = [];
    for (const raw of rawCapabilities) {
      const item = asObject(raw, "capability");
      exact(item, ["handle", "permissionId", "scope"], "capability");
      const handle = boundedString(item.handle, "capability.handle", 512);
      const permission = boundedString(item.permissionId, "capability.permissionId", 128);
      const scope = asObject(item.scope, "capability.scope");
      if (handles.has(handle) || granted.has(permission)) {
        throw invalid("activate capabilities must have unique handles and permissions");
      }
      handles.add(handle);
      granted.add(permission);
      capabilities.set(handle, permission);
      normalizedCapabilities.push({ handle, permissionId: permission, scope });
    }
    const missing = [...this.requiredPermissions].filter((item) => !granted.has(item)).sort();
    const allowed = new Set([...this.requiredPermissions, ...this.optionalPermissions]);
    const unexpected = [...granted].filter((item) => !allowed.has(item)).sort();
    if (missing.length || unexpected.length) {
      throw error(-32106, "CAPABILITY_GRANTS_INVALID", "Activation grants do not match the static descriptor.", {
        missing,
        unexpected,
      });
    }
    const activation: ActivationRequest = { instanceId, generation, capabilities: normalizedCapabilities };
    await this.plugin.activate(activation);
    this.capabilities.clear();
    for (const [handle, permission] of capabilities) this.capabilities.set(handle, permission);
    this.generationValue = generation;
    this.highestGeneration = generation;
    this.stateValue = "active";
    return success(request.id, { ok: true, instanceId, generation }, request.generation);
  }

  private async invoke(request: RpcRequest, eventBatch: boolean): Promise<JsonObject[]> {
    this.requireActive(request);
    if (this.stateValue === "quiescing") {
      throw error(-32103, "PLUGIN_QUIESCING", "New invocations are rejected while preparing an upgrade.");
    }
    if (this.pending.size >= this.maxInFlight) {
      throw error(-32103, "IN_FLIGHT_LIMIT", "The plugin has reached its bounded in-flight request limit.", {
        maxInFlight: this.maxInFlight,
      });
    }
    let context: RequestContext | JsonObject;
    let outcome: InvocationOutcome;
    let resultPath: string;
    if (eventBatch) {
      exact(request.params, ["events", "delivery"], "eventBatch");
      asArray(request.params.events, "eventBatch.events");
      const delivery = asObject(request.params.delivery, "eventBatch.delivery");
      context = Object.hasOwn(delivery, "requestContext")
        ? validateRequestContext(delivery.requestContext)
        : {};
      outcome = await this.plugin.eventBatch(request.params);
      resultPath = "eventBatch.result";
    } else {
      exact(request.params, ["contributionId", "input", "requestContext"], "invoke");
      const contributionId = localId(request.params.contributionId, "invoke.contributionId");
      const input = asObject(request.params.input, "invoke.input");
      const invokeContext = validateRequestContext(request.params.requestContext);
      context = invokeContext;
      if (contributionId !== invokeContext.contributionId) {
        throw invalid("invoke contribution does not match requestContext");
      }
      if (!this.contributionIds.has(contributionId)) {
        throw error(-32107, "CONTRIBUTION_NOT_DECLARED", "invoke references a contribution absent from the descriptor", {
          contributionId,
        });
      }
      const invokeRequest: InvokeRequest = {
        contributionId,
        input,
        requestContext: invokeContext,
      };
      outcome = await this.plugin.invoke(invokeRequest);
      resultPath = "invoke.result";
    }
    if (Object.keys(context).length && context.generation !== request.generation) {
      throw error(-32104, "GENERATION_MISMATCH", "requestContext generation does not match the envelope");
    }
    return this.outcome(request, context, outcome, resultPath);
  }

  private outcome(
    request: RpcRequest,
    context: RequestContext | JsonObject,
    outcome: InvocationOutcome,
    resultPath: string,
  ): JsonObject[] {
    if (outcome instanceof Deferred) {
      this.pending.set(request.id, {
        requestId: request.id,
        generation: request.generation,
        token: outcome.token,
        requestContext: context,
        resultPath,
        hostCallId: null,
      });
      return [];
    }
    if (outcome instanceof HostCall) return this.beginHostCall(request, context, outcome, resultPath);
    return [success(request.id, normalizeObject(outcome, resultPath), request.generation)];
  }

  private beginHostCall(
    request: RpcRequest,
    context: RequestContext | JsonObject,
    call: HostCall,
    resultPath: string,
  ): JsonObject[] {
    if (!this.negotiatedHostApis.has(HOST_API)) {
      throw error(-32102, "HOST_API_NOT_NEGOTIATED", `${HOST_API} was not negotiated`);
    }
    if (canonicalJson(call.requestContext) !== canonicalJson(context)) {
      throw error(-32107, "HOST_CALL_CONTEXT_MISMATCH", "host.call must retain the originating requestContext");
    }
    if (!this.capabilities.has(call.capabilityHandle)) {
      throw error(-32106, "CAPABILITY_HANDLE_INVALID", "host.call used an unknown or revoked capability handle");
    }
    const id = `plugin:${this.highestGeneration}:${this.nextHostCallId++}`;
    this.pending.set(request.id, {
      requestId: request.id,
      generation: request.generation,
      token: call.token,
      requestContext: context,
      resultPath,
      hostCallId: id,
    });
    this.hostCalls.set(id, request.id);
    return [
      outboundRequest(
        id,
        "host.call",
        {
          capabilityHandle: call.capabilityHandle,
          method: call.method,
          params: call.params,
          requestContext: call.requestContext,
        },
        request.generation,
      ),
    ];
  }

  private async handleHostResponse(response: RpcResponse): Promise<JsonObject[]> {
    const originalId = this.hostCalls.get(response.id);
    if (originalId === undefined) {
      throw error(-32103, "HOST_CALL_NOT_PENDING", "Received a response for an unknown or cancelled host.call.", {
        requestId: response.id,
      });
    }
    const pending = this.pending.get(originalId);
    if (pending === undefined || pending.hostCallId !== response.id) {
      throw error(-32103, "HOST_CALL_NOT_PENDING", "Received a response for an inconsistent host.call correlation.", {
        requestId: response.id,
      });
    }
    if (response.generation !== pending.generation || response.generation !== this.generationValue) {
      throw error(-32104, "STALE_HOST_CALL_RESPONSE", "host.call response belongs to a stale generation");
    }
    const completed = await this.plugin.completeHostCall(pending.token, {
      success: response.success,
      result: response.result,
      error: response.error,
      generation: response.generation,
    });
    if (completed instanceof HostCall) {
      if (canonicalJson(completed.requestContext) !== canonicalJson(pending.requestContext)) {
        throw error(-32107, "HOST_CALL_CONTEXT_MISMATCH", "chained host.call must retain the originating requestContext");
      }
      if (!this.capabilities.has(completed.capabilityHandle)) {
        throw error(-32106, "CAPABILITY_HANDLE_INVALID", "chained host.call used an unknown or revoked capability handle");
      }
      this.hostCalls.delete(response.id);
      const nextId = `plugin:${this.highestGeneration}:${this.nextHostCallId++}`;
      pending.token = completed.token;
      pending.hostCallId = nextId;
      this.hostCalls.set(nextId, originalId);
      return [
        outboundRequest(
          nextId,
          "host.call",
          {
            capabilityHandle: completed.capabilityHandle,
            method: completed.method,
            params: completed.params,
            requestContext: completed.requestContext,
          },
          pending.generation,
        ),
      ];
    }
    if (completed instanceof Deferred) {
      this.hostCalls.delete(response.id);
      pending.token = completed.token;
      pending.hostCallId = null;
      return [];
    }
    this.hostCalls.delete(response.id);
    this.pending.delete(originalId);
    return [success(originalId, normalizeObject(completed, pending.resultPath), pending.generation)];
  }

  private async cancel(request: RpcRequest): Promise<JsonObject[]> {
    this.requireCurrentGeneration(request);
    exact(request.params, ["requestId"], "cancel");
    const target = requestId(request.params.requestId, "cancel.requestId");
    const pending = this.pending.get(target);
    if (pending === undefined) {
      return [success(request.id, { cancelled: false, requestId: target }, request.generation)];
    }
    this.pending.delete(target);
    if (pending.hostCallId !== null) this.hostCalls.delete(pending.hostCallId);
    await this.plugin.cancel(pending.token);
    return [
      failure(
        target,
        pending.generation,
        error(-32800, "REQUEST_CANCELLED", "The invocation was cancelled by the host."),
      ),
      success(request.id, { cancelled: true, requestId: target }, request.generation),
    ];
  }

  private async prepareUpgrade(request: RpcRequest): Promise<JsonObject[]> {
    this.requireActive(request);
    exact(request.params, [], "prepareUpgrade");
    this.stateValue = "quiescing";
    const result = await this.cancelAll("Plugin is quiescing for upgrade.");
    await this.plugin.prepareUpgrade();
    result.push(success(request.id, { ok: true }, request.generation));
    return result;
  }

  private async deactivate(request: RpcRequest): Promise<JsonObject[]> {
    this.requireActive(request);
    exact(request.params, ["reason"], "deactivate");
    const reason = boundedString(request.params.reason, "deactivate.reason", 256);
    const result = await this.cancelAll("Plugin was deactivated.");
    await this.plugin.deactivate(reason);
    result.push(success(request.id, { ok: true }, request.generation));
    this.stateValue = "handshaken";
    this.generationValue = 0;
    this.capabilities.clear();
    return result;
  }

  private async shutdown(request: RpcRequest): Promise<JsonObject[]> {
    if (this.stateValue === "active" || this.stateValue === "quiescing") {
      this.requireCurrentGeneration(request);
    } else if (request.generation !== 0) {
      throw error(-32104, "GENERATION_MISMATCH", "inactive shutdown must use generation 0");
    }
    exact(request.params, [], "shutdown");
    const result = await this.cancelAll("Plugin process is shutting down.");
    await this.plugin.shutdown();
    result.push(success(request.id, { ok: true }, request.generation));
    this.stateValue = "closed";
    return result;
  }

  private async cancelAll(message: string): Promise<JsonObject[]> {
    const result: JsonObject[] = [];
    for (const pending of [...this.pending.values()]) {
      await this.plugin.cancel(pending.token);
      if (pending.hostCallId !== null) this.hostCalls.delete(pending.hostCallId);
      result.push(
        failure(pending.requestId, pending.generation, error(-32800, "REQUEST_CANCELLED", message)),
      );
    }
    this.pending.clear();
    return result;
  }

  private requireActive(request: RpcRequest): void {
    if (this.stateValue !== "active" && this.stateValue !== "quiescing") {
      throw error(-32103, "PLUGIN_NOT_ACTIVE", "This method requires an active plugin generation.");
    }
    this.requireCurrentGeneration(request);
  }

  private requireCurrentGeneration(request: RpcRequest): void {
    if (request.generation !== this.generationValue || this.generationValue < 1) {
      throw error(-32104, "GENERATION_MISMATCH", "request generation does not match the active generation");
    }
  }

  private requireControlGeneration(request: RpcRequest, allowZero: boolean): void {
    if (allowZero && request.generation === 0) return;
    if (this.stateValue === "active" || this.stateValue === "quiescing") {
      this.requireCurrentGeneration(request);
    } else if (request.generation !== 0) {
      throw error(-32104, "GENERATION_MISMATCH", "inactive control request must use generation 0");
    }
  }
}

function bestEffortIdentity(value: unknown): [RequestId | null, number] {
  if (!isObject(value)) return [null, 0];
  const rawId = value.id;
  const id =
    (typeof rawId === "string" && rawId.length > 0) ||
    (typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId >= 0)
      ? rawId
      : null;
  const rawGeneration = value.generation;
  const generation =
    typeof rawGeneration === "number" && Number.isSafeInteger(rawGeneration) && rawGeneration >= 0
      ? rawGeneration
      : 0;
  return [id, generation];
}

export class JsonLineServer {
  readonly limits: JsonLimits;
  readonly dispatcher: Dispatcher;

  constructor(
    plugin: CandleScopePlugin,
    options: { limits?: JsonLimits; maxInFlight?: number } = {},
  ) {
    this.limits = checkedLimits(options.limits ?? DEFAULT_JSON_LIMITS);
    this.dispatcher = new Dispatcher(plugin, options.maxInFlight ?? 32);
  }

  async handleValue(value: unknown): Promise<JsonObject[]> {
    const [id, generation] = bestEffortIdentity(value);
    try {
      return await this.dispatcher.handle(value);
    } catch (reason) {
      if (reason instanceof ProtocolError) return [failure(id, generation, reason)];
      if (reason instanceof ContractError) {
        return [
          failure(
            id,
            generation,
            error(-32602, reason.code, reason.message, reason.path ? { path: reason.path } : {}),
          ),
        ];
      }
      process.stderr.write(`${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
      return [
        failure(
          id,
          generation,
          error(-32603, "INTERNAL_ERROR", "Plugin raised an unexpected exception."),
        ),
      ];
    }
  }

  async handleLine(line: Uint8Array): Promise<JsonObject[]> {
    let value: JsonValue;
    try {
      value = parseStrictJson(line, this.limits);
    } catch (reason) {
      const size = reason instanceof ContractError && reason.code === "MESSAGE_TOO_LARGE";
      return [
        failure(
          null,
          0,
          error(
            size ? -32600 : -32700,
            size && reason instanceof ContractError ? reason.code : "PARSE_ERROR",
            size && reason instanceof ContractError
              ? reason.message
              : "Control line is not valid bounded JSON.",
            size ? { maxMessageBytes: this.limits.maxMessageBytes } : {},
          ),
        ),
      ];
    }
    return this.handleValue(value);
  }
}

type ProtocolWriter = (chunk: string) => boolean;

async function writeFrames(writer: ProtocolWriter, frames: readonly JsonObject[], limits: JsonLimits): Promise<void> {
  for (const frame of frames) writer(`${canonicalJson(frame, limits)}\n`);
}

async function serveInput(
  server: JsonLineServer,
  writer: ProtocolWriter,
  input: NodeJS.ReadableStream,
): Promise<number> {
  let chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;

  const emit = async (): Promise<boolean> => {
    let frames: JsonObject[];
    if (oversized) {
      frames = [
        failure(
          null,
          0,
          error(-32600, "MESSAGE_TOO_LARGE", `control message exceeds ${server.limits.maxMessageBytes} bytes`, {
            maxMessageBytes: server.limits.maxMessageBytes,
          }),
        ),
      ];
    } else {
      let line = Buffer.concat(chunks, size);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      frames = await server.handleLine(line);
    }
    await writeFrames(writer, frames, server.limits);
    chunks = [];
    size = 0;
    oversized = false;
    return server.dispatcher.shutdownRequested;
  };

  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw as unknown as Uint8Array);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      if (!oversized && index > start) {
        const part = chunk.subarray(start, index);
        if (size + part.length <= server.limits.maxMessageBytes) {
          chunks.push(part);
          size += part.length;
        } else oversized = true;
      }
      if (await emit()) return 0;
      start = index + 1;
    }
    if (start < chunk.length && !oversized) {
      const part = chunk.subarray(start);
      if (size + part.length <= server.limits.maxMessageBytes) {
        chunks.push(part);
        size += part.length;
      } else oversized = true;
    }
  }
  if (size > 0 || oversized) await emit();
  return 0;
}

export async function servePlugin(
  plugin: CandleScopePlugin,
  options: { limits?: JsonLimits; maxInFlight?: number } = {},
): Promise<number> {
  const protocolWrite = process.stdout.write.bind(process.stdout) as ProtocolWriter;
  const stderrWrite = process.stderr.write.bind(process.stderr);
  Object.defineProperty(process.stdout, "write", {
    configurable: true,
    value: stderrWrite,
    writable: true,
  });
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  const server = new JsonLineServer(plugin, options);
  return serveInput(server, protocolWrite, process.stdin);
}
