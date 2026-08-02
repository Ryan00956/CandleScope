import { parseReplayDisplayBar } from "./replayParser.js";
import type { ReplayDigest, ReplayDisplayBar } from "./replayTypes.js";


const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface ReplayDisplayProjectionIdentity {
  readonly exchange: string;
  readonly market_type: string;
  readonly symbol: string;
  readonly source_kind: "BAR" | "AGG_TRADE";
  readonly base_interval: string;
  readonly display_interval: string;
}

export interface ReplayDisplayProjectionResponse {
  readonly protocol: "replay.v2";
  readonly schema_version: "replay.display-projection.v1";
  readonly run_id: string;
  readonly session_id: string;
  readonly track_id: string;
  readonly identity: ReplayDisplayProjectionIdentity;
  readonly data_epoch: ReplayDigest;
  readonly projection_epoch: ReplayDigest;
  readonly display_interval: string;
  readonly revealed_boundary_ms: number;
  readonly bars: readonly ReplayDisplayBar[];
  readonly has_more: boolean;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} fields are incompatible`);
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function digest(value: unknown, field: string): ReplayDigest {
  const parsed = text(value, field);
  if (!DIGEST_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256 digest`);
  return parsed as ReplayDigest;
}

function timestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function parseIdentity(value: unknown): ReplayDisplayProjectionIdentity {
  const source = record(value, "display projection identity");
  exact(source, [
    "exchange",
    "market_type",
    "symbol",
    "source_kind",
    "base_interval",
    "display_interval",
  ], "display projection identity");
  const sourceKind = text(source.source_kind, "display projection identity.source_kind");
  if (sourceKind !== "BAR" && sourceKind !== "AGG_TRADE") {
    throw new TypeError("display projection identity.source_kind is unsupported");
  }
  return {
    exchange: text(source.exchange, "display projection identity.exchange"),
    market_type: text(source.market_type, "display projection identity.market_type"),
    symbol: text(source.symbol, "display projection identity.symbol"),
    source_kind: sourceKind,
    base_interval: text(source.base_interval, "display projection identity.base_interval"),
    display_interval: text(
      source.display_interval,
      "display projection identity.display_interval",
    ),
  };
}

export function parseReplayDisplayProjection(
  value: unknown,
): ReplayDisplayProjectionResponse {
  const source = record(value, "display projection");
  exact(source, [
    "protocol",
    "schema_version",
    "run_id",
    "session_id",
    "track_id",
    "identity",
    "data_epoch",
    "projection_epoch",
    "display_interval",
    "revealed_boundary_ms",
    "bars",
    "has_more",
  ], "display projection");
  if (source.protocol !== "replay.v2"
    || source.schema_version !== "replay.display-projection.v1") {
    throw new TypeError("display projection protocol is unsupported");
  }
  const boundaryMs = timestamp(
    source.revealed_boundary_ms,
    "display projection.revealed_boundary_ms",
  );
  if (!Array.isArray(source.bars)) {
    throw new TypeError("display projection.bars must be an array");
  }
  const bars = source.bars.map((bar, index) => (
    parseReplayDisplayBar(bar, `display projection.bars[${index}]`)
  ));
  let previousOpenMs = -1;
  for (const [index, bar] of bars.entries()) {
    if (bar.open_time_ms <= previousOpenMs) {
      throw new TypeError(`display projection.bars[${index}] is not strictly ordered`);
    }
    if (bar.open_time_ms > boundaryMs
      || bar.last_base_open_ms > boundaryMs
      || (bar.is_closed && bar.close_time_ms > boundaryMs)) {
      throw new TypeError(`display projection.bars[${index}] exceeds the public cursor`);
    }
    previousOpenMs = bar.open_time_ms;
  }
  if (typeof source.has_more !== "boolean") {
    throw new TypeError("display projection.has_more must be a boolean");
  }
  const identity = parseIdentity(source.identity);
  const displayInterval = text(
    source.display_interval,
    "display projection.display_interval",
  );
  if (identity.display_interval !== displayInterval) {
    throw new TypeError("display projection interval identity is inconsistent");
  }
  return {
    protocol: "replay.v2",
    schema_version: "replay.display-projection.v1",
    run_id: text(source.run_id, "display projection.run_id"),
    session_id: text(source.session_id, "display projection.session_id"),
    track_id: text(source.track_id, "display projection.track_id"),
    identity,
    data_epoch: digest(source.data_epoch, "display projection.data_epoch"),
    projection_epoch: digest(
      source.projection_epoch,
      "display projection.projection_epoch",
    ),
    display_interval: displayInterval,
    revealed_boundary_ms: boundaryMs,
    bars,
    has_more: source.has_more,
  };
}
