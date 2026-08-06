export type ReplayTradeFlowState =
  | "UNSUPPORTED_SOURCE_MODE"
  | "LOADING"
  | "CONTIGUOUS"
  | "DEGRADED";

export interface ReplayTradeFlowTapeItem {
  readonly source_sequence: number;
  readonly agg_trade_id: number;
  readonly trade_time_ms: number;
  readonly price: string;
  readonly quantity: string;
  readonly quote_quantity: string;
  readonly raw_trade_count: number;
  readonly aggressor_side: "BUY" | "SELL";
  readonly cvd_delta: string;
  readonly fidelity: "AGGREGATE_TRADE_NOT_RAW_TRADE";
}

export interface ReplayTradeFlowPage {
  readonly protocol: "replay.v3";
  readonly schema_version: "replay.trade-flow.v1";
  readonly run_id: string;
  readonly track_id: string;
  readonly source_kind: "AGG_TRADE";
  readonly capabilities: {
    readonly tape: "AVAILABLE_EXACT";
    readonly order_flow: "AVAILABLE_APPROX";
  };
  readonly fidelity: "AGGREGATE_TRADE_NOT_RAW_TRADE";
  readonly continuity: {
    readonly state: "CONTIGUOUS";
    readonly data_epoch: string;
    readonly after_sequence: number;
    readonly next_sequence: number;
    readonly revealed_sequence: number;
    readonly resync_token: string;
  };
  readonly tape: readonly ReplayTradeFlowTapeItem[];
  readonly page_flow: {
    readonly buy_quantity: string;
    readonly sell_quantity: string;
    readonly delta: string;
    readonly quote_quantity: string;
    readonly trade_count: number;
    readonly cvd_contract: "CLIENT_PREFIX_SUM_OF_CONTIGUOUS_PAGE_DELTAS";
  };
  readonly next_cursor: {
    readonly source_sequence: number;
    readonly data_epoch: string;
  };
  readonly has_more: boolean;
  readonly streaming: Readonly<Record<string, unknown>>;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  const candidate = object(value, field);
  const actual = Object.keys(candidate).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) throw new TypeError(`${field} fields are incompatible`);
  return candidate;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be text`);
  return value;
}

const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

function decimal(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!CANONICAL_DECIMAL.test(parsed) || parsed === "-0") {
    throw new TypeError(`${field} must be a canonical Decimal string`);
  }
  return parsed;
}

function positiveDecimal(value: unknown, field: string): string {
  const parsed = decimal(value, field);
  if (scaledDecimal(parsed).coefficient <= 0n) {
    throw new TypeError(`${field} must be positive`);
  }
  return parsed;
}

function scaledDecimal(value: string): { readonly coefficient: bigint; readonly scale: number } {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const coefficient = BigInt(`${whole}${fraction}`);
  return {
    coefficient: negative ? -coefficient : coefficient,
    scale: fraction.length,
  };
}

export function addReplayTradeFlowDecimals(left: string, right: string): string {
  const leftValue = scaledDecimal(decimal(left, "left Decimal"));
  const rightValue = scaledDecimal(decimal(right, "right Decimal"));
  const scale = Math.max(leftValue.scale, rightValue.scale);
  const coefficient = leftValue.coefficient * (10n ** BigInt(scale - leftValue.scale))
    + rightValue.coefficient * (10n ** BigInt(scale - rightValue.scale));
  if (coefficient === 0n) return "0";
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function counter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function literal<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new TypeError(`${field} must be ${expected}`);
  return expected;
}

export function parseReplayTradeFlowPage(value: unknown): ReplayTradeFlowPage {
  const page = exact(value, "replay trade flow", [
    "protocol", "schema_version", "run_id", "track_id", "source_kind",
    "capabilities", "fidelity", "continuity", "tape", "page_flow",
    "next_cursor", "has_more", "streaming",
  ]);
  const capabilities = exact(page.capabilities, "trade flow capabilities", ["tape", "order_flow"]);
  const continuity = exact(page.continuity, "trade flow continuity", [
    "state", "data_epoch", "after_sequence", "next_sequence", "revealed_sequence", "resync_token",
  ]);
  const flow = exact(page.page_flow, "trade flow page summary", [
    "buy_quantity", "sell_quantity", "delta", "quote_quantity", "trade_count", "cvd_contract",
  ]);
  const cursor = exact(page.next_cursor, "trade flow cursor", ["source_sequence", "data_epoch"]);
  const afterSequence = counter(continuity.after_sequence, "trade flow after_sequence");
  const nextSequence = counter(continuity.next_sequence, "trade flow next_sequence");
  const revealedSequence = counter(continuity.revealed_sequence, "trade flow revealed_sequence");
  const dataEpoch = text(continuity.data_epoch, "trade flow data_epoch");
  if (!(afterSequence <= nextSequence && nextSequence <= revealedSequence)) {
    throw new TypeError("trade flow sequence bounds are incompatible");
  }
  if (!Array.isArray(page.tape)) throw new TypeError("trade flow tape must be an array");
  let previousAggTradeId: number | null = null;
  let previousTradeTimeMs: number | null = null;
  const tape = page.tape.map((raw, index): ReplayTradeFlowTapeItem => {
    const item = exact(raw, `trade flow tape[${index}]`, [
      "source_sequence", "agg_trade_id", "trade_time_ms", "price", "quantity",
      "quote_quantity", "raw_trade_count", "aggressor_side", "cvd_delta", "fidelity",
    ]);
    if (item.aggressor_side !== "BUY" && item.aggressor_side !== "SELL") {
      throw new TypeError(`trade flow tape[${index}].aggressor_side is invalid`);
    }
    const sourceSequence = counter(item.source_sequence, `trade flow tape[${index}].source_sequence`);
    const aggTradeId = counter(item.agg_trade_id, `trade flow tape[${index}].agg_trade_id`);
    const tradeTimeMs = counter(item.trade_time_ms, `trade flow tape[${index}].trade_time_ms`);
    if (sourceSequence !== afterSequence + index + 1) {
      throw new TypeError(`trade flow tape[${index}] is not source-contiguous`);
    }
    if (previousAggTradeId !== null && aggTradeId !== previousAggTradeId + 1) {
      throw new TypeError(`trade flow tape[${index}] has an aggregate-trade gap`);
    }
    if (previousTradeTimeMs !== null && tradeTimeMs < previousTradeTimeMs) {
      throw new TypeError(`trade flow tape[${index}] moved backward in time`);
    }
    previousAggTradeId = aggTradeId;
    previousTradeTimeMs = tradeTimeMs;
    const price = positiveDecimal(item.price, `trade flow tape[${index}].price`);
    const quantity = positiveDecimal(item.quantity, `trade flow tape[${index}].quantity`);
    const quoteQuantity = positiveDecimal(
      item.quote_quantity,
      `trade flow tape[${index}].quote_quantity`,
    );
    const rawTradeCount = counter(
      item.raw_trade_count,
      `trade flow tape[${index}].raw_trade_count`,
    );
    if (rawTradeCount < 1) {
      throw new TypeError(`trade flow tape[${index}].raw_trade_count must be positive`);
    }
    const cvdDelta = decimal(item.cvd_delta, `trade flow tape[${index}].cvd_delta`);
    const expectedDelta = item.aggressor_side === "BUY" ? quantity : `-${quantity}`;
    if (cvdDelta !== expectedDelta) {
      throw new TypeError(`trade flow tape[${index}].cvd_delta is incompatible`);
    }
    return {
      source_sequence: sourceSequence,
      agg_trade_id: aggTradeId,
      trade_time_ms: tradeTimeMs,
      price,
      quantity,
      quote_quantity: quoteQuantity,
      raw_trade_count: rawTradeCount,
      aggressor_side: item.aggressor_side,
      cvd_delta: cvdDelta,
      fidelity: literal(item.fidelity, "AGGREGATE_TRADE_NOT_RAW_TRADE", `trade flow tape[${index}].fidelity`),
    };
  });
  if (typeof page.has_more !== "boolean") throw new TypeError("trade flow has_more must be boolean");
  if (nextSequence !== afterSequence + tape.length) {
    throw new TypeError("trade flow cursor does not match its tape");
  }
  if (page.has_more !== (nextSequence < revealedSequence)) {
    throw new TypeError("trade flow continuation marker is incompatible");
  }
  const cursorSequence = counter(cursor.source_sequence, "trade flow cursor sequence");
  const cursorEpoch = text(cursor.data_epoch, "trade flow cursor epoch");
  if (cursorSequence !== nextSequence || cursorEpoch !== dataEpoch) {
    throw new TypeError("trade flow next cursor does not match continuity");
  }
  const buyQuantity = decimal(flow.buy_quantity, "trade flow buy_quantity");
  const sellQuantity = decimal(flow.sell_quantity, "trade flow sell_quantity");
  const delta = decimal(flow.delta, "trade flow delta");
  const quoteQuantity = decimal(flow.quote_quantity, "trade flow quote_quantity");
  const tradeCount = counter(flow.trade_count, "trade flow trade_count");
  const computed = tape.reduce(
    (totals, item) => ({
      buy: item.aggressor_side === "BUY"
        ? addReplayTradeFlowDecimals(totals.buy, item.quantity)
        : totals.buy,
      sell: item.aggressor_side === "SELL"
        ? addReplayTradeFlowDecimals(totals.sell, item.quantity)
        : totals.sell,
      delta: addReplayTradeFlowDecimals(totals.delta, item.cvd_delta),
      quote: addReplayTradeFlowDecimals(totals.quote, item.quote_quantity),
    }),
    { buy: "0", sell: "0", delta: "0", quote: "0" },
  );
  if (
    tradeCount !== tape.length
    || buyQuantity !== computed.buy
    || sellQuantity !== computed.sell
    || delta !== computed.delta
    || quoteQuantity !== computed.quote
  ) {
    throw new TypeError("trade flow page summary does not match its tape");
  }
  return {
    protocol: literal(page.protocol, "replay.v3", "trade flow protocol"),
    schema_version: literal(page.schema_version, "replay.trade-flow.v1", "trade flow schema"),
    run_id: text(page.run_id, "trade flow run_id"),
    track_id: text(page.track_id, "trade flow track_id"),
    source_kind: literal(page.source_kind, "AGG_TRADE", "trade flow source_kind"),
    capabilities: {
      tape: literal(capabilities.tape, "AVAILABLE_EXACT", "trade flow tape capability"),
      order_flow: literal(capabilities.order_flow, "AVAILABLE_APPROX", "trade flow order-flow capability"),
    },
    fidelity: literal(page.fidelity, "AGGREGATE_TRADE_NOT_RAW_TRADE", "trade flow fidelity"),
    continuity: {
      state: literal(continuity.state, "CONTIGUOUS", "trade flow continuity state"),
      data_epoch: dataEpoch,
      after_sequence: afterSequence,
      next_sequence: nextSequence,
      revealed_sequence: revealedSequence,
      resync_token: text(continuity.resync_token, "trade flow resync_token"),
    },
    tape,
    page_flow: {
      buy_quantity: buyQuantity,
      sell_quantity: sellQuantity,
      delta,
      quote_quantity: quoteQuantity,
      trade_count: tradeCount,
      cvd_contract: literal(flow.cvd_contract, "CLIENT_PREFIX_SUM_OF_CONTIGUOUS_PAGE_DELTAS", "trade flow CVD contract"),
    },
    next_cursor: {
      source_sequence: cursorSequence,
      data_epoch: cursorEpoch,
    },
    has_more: page.has_more,
    streaming: object(page.streaming, "trade flow streaming"),
  };
}
