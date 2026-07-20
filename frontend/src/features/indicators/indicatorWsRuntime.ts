import {
  buildIndicatorComputeParams,
  INDICATOR_HISTORY_LIMIT,
} from "./indicatorComputeRuntime.js";
import {
  normalizeIndicatorRange,
  normalizeIndicatorRevision,
} from "./indicatorRangeCoverage.js";
import {
  getBuiltinIndicatorName,
  isBuiltinIndicator,
  isWsHostedIndicator,
  stringSignature,
} from "./indicatorPayloadRuntime.js";
import {
  expectIndicatorFiniteNumber,
  expectIndicatorNonEmptyString,
  expectIndicatorRecord,
  isIndicatorRecord,
  optionalIndicatorString,
  parseIndicatorPayloadEnvelope,
  parseIndicatorRange,
  parseIndicatorRevision,
} from "./indicatorContracts.js";
import type {
  IndicatorDefinition,
  IndicatorErrorMessage,
  IndicatorRecomputedMessage,
  IndicatorSubscribedMessage,
  IndicatorSubscriptionContext,
  IndicatorSubscribeMessage,
  IndicatorValuesMessage,
  IndicatorWsHandlers,
  IndicatorWsMessage,
  IndicatorWsParseResult,
  IndicatorWsSequenceState,
} from "./indicatorTypes.js";

export function getVisibleHostedIndicators(
  indicators: IndicatorDefinition[] = [],
): IndicatorDefinition[] {
  return indicators.filter(
    (indicator) =>
      isWsHostedIndicator(indicator) && indicator.visible !== false,
  );
}

export function buildIndicatorWsSignature(
  indicators: IndicatorDefinition[] = [],
): string {
  return getVisibleHostedIndicators(indicators)
    .map((indicator) =>
      [
        indicator.id,
        getBuiltinIndicatorName(indicator),
        getBuiltinIndicatorName(indicator),
        isBuiltinIndicator(indicator) ? "builtin" : "script",
        stringSignature(indicator.script || ""),
        indicator.securityMode || "",
        JSON.stringify(indicator.params || {}),
      ].join(":"),
    )
    .join("|");
}

export function buildHostedSubscriptionMessage(
  indicator: IndicatorDefinition,
  context: IndicatorSubscriptionContext,
): IndicatorSubscribeMessage {
  const {
    candleDownColor,
    candleUpColor,
    chartDataLength = 0,
    exchange,
    interval,
    marketType,
    resumeFrom,
    serverEpoch,
    correctionRevision,
    symbol,
  } = context;
  const builtin = isBuiltinIndicator(indicator);
  const historyLimit = Math.min(
    Math.max(chartDataLength, 1),
    INDICATOR_HISTORY_LIMIT,
  );

  const message: IndicatorSubscribeMessage = {
    action: "subscribe",
    clientId: indicator.id,
    kind: builtin ? "builtin" : "script",
    exchange,
    marketType,
    symbol,
    interval,
    displayName: indicator.name || indicator.id,
    params: buildIndicatorComputeParams(indicator, {
      ...(candleUpColor !== undefined ? { candleUpColor } : {}),
      ...(candleDownColor !== undefined ? { candleDownColor } : {}),
    }),
    historyLimit,
  };
  if (builtin) {
    message.name = getBuiltinIndicatorName(indicator);
  } else {
    message.customId = indicator.id;
    if (indicator.script !== undefined) message.script = indicator.script;
    if (indicator.securityMode !== undefined) {
      message.securityMode = indicator.securityMode;
    }
  }
  if (Number.isFinite(Number(resumeFrom)) && Number(resumeFrom) > 0) {
    message.resumeFrom = Math.floor(Number(resumeFrom));
  }
  if (serverEpoch !== undefined && serverEpoch !== null && serverEpoch !== "") {
    message.serverEpoch = String(serverEpoch);
  }
  if (
    correctionRevision !== undefined &&
    correctionRevision !== null &&
    correctionRevision !== ""
  ) {
    message.correctionRevision = String(correctionRevision);
  }
  return message;
}

export function buildHostedSubscriptionSignature(
  indicator: IndicatorDefinition,
  context: IndicatorSubscriptionContext,
): string {
  const message = buildHostedSubscriptionMessage(indicator, {
    ...context,
    chartDataLength: context?.chartData?.length || 0,
  });

  return JSON.stringify({
    kind: message.kind,
    exchange: message.exchange,
    marketType: message.marketType,
    symbol: message.symbol,
    interval: message.interval,
    name: message.name || "",
    scriptHash: stringSignature(message.script || ""),
    securityMode: message.securityMode || "",
    params: message.params || {},
  });
}

export function resolveIndicatorSubscriptionCachePolicy(payload: unknown = {}) {
  const record = isIndicatorRecord(payload) ? payload : {};
  const revision = normalizeIndicatorRevision(payload);
  const dirtyRange = normalizeIndicatorRange(
    revision?.dirtyRange || record.dirtyRange || record.dirty_range,
  );
  const historyInvalid = Boolean(
    revision?.historyInvalid || record.historyInvalid || record.history_invalid,
  );
  return {
    dirtyRange,
    historyInvalid,
    invalidate: historyInvalid || Boolean(dirtyRange),
    revision,
  };
}

function optionalWsSequence(
  record: Record<string, unknown>,
  path: string,
): number | undefined {
  if (record.seq === undefined || record.seq === null) return undefined;
  const seq = expectIndicatorFiniteNumber(record.seq, `${path}.seq`);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new TypeError(
      `Invalid indicator payload at ${path}.seq: expected a non-negative integer`,
    );
  }
  return seq;
}

function parseIndicatorWsRecord(value: unknown): IndicatorWsMessage {
  const path = "indicator.ws";
  const record = expectIndicatorRecord(value, path);
  const type = expectIndicatorNonEmptyString(record.type, `${path}.type`);
  const seq = optionalWsSequence(record, path);

  if (type === "heartbeat" || type === "connected") {
    return { type, ...(seq !== undefined ? { seq } : {}) };
  }

  const clientId = expectIndicatorNonEmptyString(
    record.clientId,
    `${path}.clientId`,
  );
  if (
    type === "indicator.snapshot" ||
    type === "indicator.patch" ||
    type === "indicator.replace_range"
  ) {
    const payload = parseIndicatorPayloadEnvelope(record, path);
    const indicatorId = optionalIndicatorString(
      record.indicatorId,
      `${path}.indicatorId`,
    );
    const barTime =
      record.barTime === undefined
        ? undefined
        : expectIndicatorFiniteNumber(record.barTime, `${path}.barTime`);
    if (type === "indicator.snapshot") {
      return {
        ...payload,
        type,
        clientId,
        ...(seq !== undefined ? { seq } : {}),
        ...(indicatorId !== undefined ? { indicatorId } : {}),
        ...(barTime !== undefined ? { barTime } : {}),
      };
    }
    const range = parseIndicatorRange(record.range, `${path}.range`);
    const reason = optionalIndicatorString(record.reason, `${path}.reason`);
    return {
      ...payload,
      type,
      clientId,
      range,
      ...(seq !== undefined ? { seq } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  if (type === "indicator.recomputed") {
    const revisionValue =
      record.dataRevision ?? record.data_revision ?? record.revision;
    const dirtyRangeValue = record.dirtyRange ?? record.dirty_range;
    const message: IndicatorRecomputedMessage = {
      type,
      clientId,
      range: parseIndicatorRange(record.range, `${path}.range`),
    };
    if (seq !== undefined) message.seq = seq;
    if (dirtyRangeValue !== undefined && dirtyRangeValue !== null) {
      message.dirtyRange = parseIndicatorRange(
        dirtyRangeValue,
        `${path}.dirtyRange`,
      );
    }
    if (revisionValue !== undefined && revisionValue !== null) {
      message.dataRevision = parseIndicatorRevision(
        revisionValue,
        `${path}.dataRevision`,
      );
    }
    if (record.timestampMs !== undefined) {
      message.timestampMs = expectIndicatorFiniteNumber(
        record.timestampMs,
        `${path}.timestampMs`,
      );
    }
    return message;
  }

  if (type === "indicator.subscribed") {
    const revisionValue =
      record.dataRevision ?? record.data_revision ?? record.revision;
    const message: IndicatorSubscribedMessage = { type, clientId };
    if (seq !== undefined) message.seq = seq;
    const indicatorId = optionalIndicatorString(
      record.indicatorId,
      `${path}.indicatorId`,
    );
    const resumeStatus = optionalIndicatorString(
      record.resumeStatus ?? record.resume_status,
      `${path}.resumeStatus`,
    );
    const resumeReasonValue = record.resumeReason ?? record.resume_reason;
    const interval = optionalIndicatorString(
      record.interval,
      `${path}.interval`,
    );
    if (indicatorId !== undefined) message.indicatorId = indicatorId;
    if (resumeStatus !== undefined) message.resumeStatus = resumeStatus;
    if (resumeReasonValue === null) message.resumeReason = null;
    else {
      const resumeReason = optionalIndicatorString(
        resumeReasonValue,
        `${path}.resumeReason`,
      );
      if (resumeReason !== undefined) message.resumeReason = resumeReason;
    }
    if (revisionValue !== undefined && revisionValue !== null) {
      message.dataRevision = parseIndicatorRevision(
        revisionValue,
        `${path}.dataRevision`,
      );
    }
    if (interval !== undefined) message.interval = interval;
    return message;
  }

  if (type === "indicator.preview" || type === "indicator.update") {
    const message: IndicatorValuesMessage = {
      type,
      clientId,
      values: expectIndicatorRecord(record.values, `${path}.values`),
      barTime: expectIndicatorFiniteNumber(record.barTime, `${path}.barTime`),
    };
    if (record.bar !== undefined && record.bar !== null) {
      const barRecord = expectIndicatorRecord(record.bar, `${path}.bar`);
      const bar = {
        time: expectIndicatorFiniteNumber(barRecord.time, `${path}.bar.time`),
        open: expectIndicatorFiniteNumber(barRecord.open, `${path}.bar.open`),
        high: expectIndicatorFiniteNumber(barRecord.high, `${path}.bar.high`),
        low: expectIndicatorFiniteNumber(barRecord.low, `${path}.bar.low`),
        close: expectIndicatorFiniteNumber(barRecord.close, `${path}.bar.close`),
        volume: expectIndicatorFiniteNumber(barRecord.volume, `${path}.bar.volume`),
      };
      message.bar = bar as NonNullable<IndicatorValuesMessage["bar"]>;
    }
    if (seq !== undefined) message.seq = seq;
    return message;
  }

  if (type === "indicator.error" || type === "error") {
    const payload = parseIndicatorPayloadEnvelope(record, path);
    const message: IndicatorErrorMessage = {
      type,
      clientId,
    };
    if (payload.error !== null && payload.error !== undefined) {
      message.error = payload.error;
    }
    if (payload.detail !== undefined) message.detail = payload.detail;
    if (payload.code !== undefined) message.code = payload.code;
    if (payload.errorDetail !== undefined) {
      message.errorDetail = payload.errorDetail;
    }
    if (seq !== undefined) message.seq = seq;
    return message;
  }

  throw new TypeError(
    `Invalid indicator payload at ${path}.type: unsupported message type ${JSON.stringify(type)}`,
  );
}

export function parseIndicatorWsMessage(
  rawData: unknown,
): IndicatorWsParseResult {
  try {
    const decoded: unknown =
      typeof rawData === "string" ? JSON.parse(rawData) : rawData;
    return { ok: true, message: parseIndicatorWsRecord(decoded) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function resolveIndicatorWsSequenceState(
  message: IndicatorWsMessage,
  lastSeq: number,
): IndicatorWsSequenceState {
  const seq = message.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq)) {
    return {
      hasGap: false,
      nextSeq: lastSeq,
      expectedSeq: null,
      actualSeq: null,
    };
  }

  const expectedSeq = lastSeq + 1;
  return {
    hasGap: lastSeq > 0 && seq !== expectedSeq,
    nextSeq: seq,
    expectedSeq,
    actualSeq: seq,
  };
}

export function dispatchIndicatorWsMessage(
  message: IndicatorWsMessage,
  handlers: IndicatorWsHandlers,
  sourceSubscriptionSignature?: string,
): boolean {
  switch (message.type) {
    case "heartbeat":
    case "connected":
      return false;
    case "indicator.snapshot":
      handlers.onSnapshot?.(message.clientId, message);
      return true;
    case "indicator.patch":
      handlers.onPatch?.(message.clientId, message);
      return true;
    case "indicator.replace_range":
      handlers.onReplaceRange?.(message.clientId, message);
      return true;
    case "indicator.recomputed":
      handlers.onRecomputed?.(message.clientId, message);
      return true;
    case "indicator.subscribed":
      handlers.onSubscribed?.(message.clientId, message);
      return true;
    case "indicator.preview":
    case "indicator.update":
      handlers.onValues?.(
        message.clientId,
        message.values,
        message.barTime,
        message.type === "indicator.update",
        message,
        sourceSubscriptionSignature,
      );
      return true;
    case "indicator.error":
    case "error":
      handlers.onError?.(message.clientId, message);
      return true;
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
}
