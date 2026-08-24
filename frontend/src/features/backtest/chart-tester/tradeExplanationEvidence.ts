import type {
  BacktestChartData,
  BacktestFillRecord,
  BacktestReport,
  BacktestTradeRecord,
  TradeExplanationV1,
} from "../backtestTypes.js";

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_CONDITIONS = 64;
const MAX_VARIABLES = 128;
const MAX_KEY_BYTES = 128;
const MAX_STRING_BYTES = 2 * 1024;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_SAFE_INTEGER) {
      throw new TypeError("evidence number must be a safe integer");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  throw new TypeError("unsupported evidence value");
}

export function tradeExplanationCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function tradeExplanationSha256(value: unknown): Promise<string> {
  const bytes = encoder.encode(tradeExplanationCanonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function safeIntegerOrNull(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

function validVariable(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["kind", "value"])) return false;
  if (value.kind === "null") return value.value === null;
  if (value.kind === "boolean") return typeof value.value === "boolean";
  if (value.kind === "decimal") {
    return typeof value.value === "string"
      && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.value)
      && value.value !== "-0";
  }
  return value.kind === "string"
    && typeof value.value === "string"
    && encoder.encode(value.value).length <= MAX_STRING_BYTES;
}

function structurallyValid(value: unknown): value is TradeExplanationV1 {
  if (!isRecord(value) || !exactKeys(value, [
    "schema", "canonicalization", "runId", "tradeId", "orderId", "fillId",
    "decisionId", "decisionTraceOrdinal", "decisionTimeMs", "action", "reasonCode",
    "reasonLabel", "source", "conditions", "variables", "execution", "completeness",
    "omissions", "evidenceHash",
  ])) return false;
  if (value.schema !== "TRADE_EXPLANATION_V1" || value.canonicalization !== "JCS_SHA256_V1") return false;
  if (typeof value.runId !== "string" || typeof value.decisionId !== "string") return false;
  if (![value.tradeId, value.orderId, value.fillId, value.reasonCode, value.reasonLabel]
    .every((item) => item === null || typeof item === "string")) return false;
  if (!safeIntegerOrNull(value.decisionTraceOrdinal)
    || !Number.isSafeInteger(value.decisionTimeMs)
    || Number(value.decisionTimeMs) < 0) return false;
  if (!["ENTER", "EXIT", "REVERSE", "REJECT"].includes(String(value.action))) return false;
  if (!["COMPLETE", "PARTIAL", "UNAVAILABLE"].includes(String(value.completeness))) return false;
  if (typeof value.evidenceHash !== "string" || !/^[0-9a-f]{64}$/.test(value.evidenceHash)) return false;
  if (!isRecord(value.source) || !exactKeys(value.source, [
    "strategyRevisionId", "line", "column", "conditionId",
  ])) return false;
  if (typeof value.source.strategyRevisionId !== "string"
    || !safeIntegerOrNull(value.source.line)
    || !safeIntegerOrNull(value.source.column)
    || !(value.source.conditionId === null || typeof value.source.conditionId === "string")) return false;
  if (!Array.isArray(value.conditions) || value.conditions.length > MAX_CONDITIONS) return false;
  if (!value.conditions.every((item) => isRecord(item)
    && exactKeys(item, ["id", "label", "result"])
    && typeof item.id === "string"
    && typeof item.label === "string"
    && encoder.encode(item.id).length <= MAX_STRING_BYTES
    && encoder.encode(item.label).length <= MAX_STRING_BYTES
    && (item.result === null || typeof item.result === "boolean"))) return false;
  if (!isRecord(value.variables) || Object.keys(value.variables).length > MAX_VARIABLES) return false;
  if (!Object.entries(value.variables).every(([key, variable]) => (
    encoder.encode(key).length <= MAX_KEY_BYTES && validVariable(variable)
  ))) return false;
  if (!isRecord(value.execution) || !exactKeys(value.execution, ["state", "reasonCode"])) return false;
  if (!["ACCEPTED", "FILLED", "REJECTED", "CANCELLED"].includes(String(value.execution.state))
    || !(value.execution.reasonCode === null || typeof value.execution.reasonCode === "string")) return false;
  if (!isRecord(value.omissions) || !exactKeys(value.omissions, [
    "conditionsDropped", "variablesDropped", "valuesTruncated",
  ])) return false;
  if (![value.omissions.conditionsDropped, value.omissions.variablesDropped, value.omissions.valuesTruncated]
    .every((item) => Number.isSafeInteger(item) && Number(item) >= 0)) return false;
  return true;
}

export async function verifyTradeExplanation(value: unknown): Promise<boolean> {
  if (!structurallyValid(value)) return false;
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.evidenceHash;
  try {
    if (encoder.encode(tradeExplanationCanonicalJson(unsigned)).length > MAX_PAYLOAD_BYTES) return false;
    return await tradeExplanationSha256(unsigned) === value.evidenceHash;
  } catch {
    return false;
  }
}

async function unavailableExplanation(value: unknown): Promise<TradeExplanationV1> {
  const source = isRecord(value) ? value : {};
  const sourceSpan = isRecord(source.source) ? source.source : {};
  const action = ["ENTER", "EXIT", "REVERSE", "REJECT"].includes(String(source.action))
    ? source.action as TradeExplanationV1["action"]
    : "REJECT";
  const unsigned: Omit<TradeExplanationV1, "evidenceHash"> = {
    schema: "TRADE_EXPLANATION_V1",
    canonicalization: "JCS_SHA256_V1",
    runId: typeof source.runId === "string" ? source.runId : "",
    tradeId: typeof source.tradeId === "string" ? source.tradeId : null,
    orderId: typeof source.orderId === "string" ? source.orderId : null,
    fillId: typeof source.fillId === "string" ? source.fillId : null,
    decisionId: typeof source.decisionId === "string" ? source.decisionId : "decision-unavailable",
    decisionTraceOrdinal: safeIntegerOrNull(source.decisionTraceOrdinal)
      ? source.decisionTraceOrdinal : null,
    decisionTimeMs: Number.isSafeInteger(source.decisionTimeMs)
      && Number(source.decisionTimeMs) >= 0 ? Number(source.decisionTimeMs) : 0,
    action,
    reasonCode: null,
    reasonLabel: null,
    source: {
      strategyRevisionId: typeof sourceSpan.strategyRevisionId === "string"
        ? sourceSpan.strategyRevisionId : "",
      line: safeIntegerOrNull(sourceSpan.line) ? sourceSpan.line : null,
      column: safeIntegerOrNull(sourceSpan.column) ? sourceSpan.column : null,
      conditionId: null,
    },
    conditions: [],
    variables: {},
    execution: { state: "REJECTED", reasonCode: null },
    completeness: "UNAVAILABLE",
    omissions: { conditionsDropped: 0, variablesDropped: 0, valuesTruncated: 0 },
  };
  return { ...unsigned, evidenceHash: await tradeExplanationSha256(unsigned) };
}

export async function sanitizeTradeExplanation(value: unknown): Promise<TradeExplanationV1> {
  if (await verifyTradeExplanation(value)) return value as TradeExplanationV1;
  return unavailableExplanation(value);
}

async function sanitizeFill(fill: BacktestFillRecord): Promise<BacktestFillRecord> {
  if (!("explanation" in fill)) return { ...fill };
  return { ...fill, explanation: await sanitizeTradeExplanation(fill.explanation) };
}

async function sanitizeTrade(trade: BacktestTradeRecord): Promise<BacktestTradeRecord> {
  return {
    ...trade,
    ...(trade.entry_explanation === undefined
      ? {}
      : { entry_explanation: await sanitizeTradeExplanation(trade.entry_explanation) }),
    ...(trade.exit_explanation === undefined
      ? {}
      : { exit_explanation: await sanitizeTradeExplanation(trade.exit_explanation) }),
  };
}

export async function sanitizeBacktestEvidence(
  report: BacktestReport,
  chart: BacktestChartData,
): Promise<{ report: BacktestReport; chart: BacktestChartData }> {
  const reportFills = await Promise.all(report.fills.map(sanitizeFill));
  const chartFills = await Promise.all(chart.fills.map(sanitizeFill));
  const trades = await Promise.all(report.trades.map(sanitizeTrade));
  const rejectedOrders = await Promise.all((report.rejected_orders ?? []).map(async (item) => (
    "explanation" in item
      ? { ...item, explanation: await sanitizeTradeExplanation(item.explanation) }
      : { ...item }
  )));
  const chartRejectedOrders = await Promise.all((chart.rejected_orders ?? []).map(async (item) => (
    "explanation" in item
      ? { ...item, explanation: await sanitizeTradeExplanation(item.explanation) }
      : { ...item }
  )));
  return {
    report: {
      ...report,
      fills: reportFills,
      trades,
      ...(report.rejected_orders === undefined ? {} : { rejected_orders: rejectedOrders }),
    },
    chart: {
      ...chart,
      fills: chartFills,
      ...(chart.rejected_orders === undefined ? {} : { rejected_orders: chartRejectedOrders }),
    },
  };
}
