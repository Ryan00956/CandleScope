import { buildIndicatorComputeParams } from "./indicatorComputeRuntime";
import {
  getBuiltinIndicatorName,
  isBuiltinIndicator,
  isWsHostedIndicator,
  stringSignature,
} from "./indicatorPayloadRuntime";

const INDICATOR_WS_INITIAL_HISTORY_LIMIT = 5000;

export function getVisibleHostedIndicators(indicators = []) {
  return indicators.filter((indicator) => (
    isWsHostedIndicator(indicator) && indicator.visible !== false
  ));
}

export function buildIndicatorWsSignature(indicators = []) {
  return getVisibleHostedIndicators(indicators)
    .map((indicator) => [
      indicator.id,
      getBuiltinIndicatorName(indicator),
      getBuiltinIndicatorName(indicator),
      isBuiltinIndicator(indicator) ? "builtin" : "script",
      stringSignature(indicator.script || ""),
      indicator.securityMode || "",
      JSON.stringify(indicator.params || {}),
    ].join(":"))
    .join("|");
}

export function buildHostedSubscriptionMessage(indicator, context) {
  const {
    candleDownColor,
    candleUpColor,
    chartDataLength = 0,
    exchange,
    interval,
    marketType,
    symbol,
  } = context;
  const builtin = isBuiltinIndicator(indicator);
  const historyLimit = Math.min(
    Math.max(chartDataLength, 1),
    INDICATOR_WS_INITIAL_HISTORY_LIMIT,
  );

  return {
    action: "subscribe",
    clientId: indicator.id,
    kind: builtin ? "builtin" : "script",
    exchange,
    marketType,
    symbol,
    interval,
    name: builtin ? getBuiltinIndicatorName(indicator) : undefined,
    displayName: indicator.name || indicator.id,
    customId: !builtin ? indicator.id : undefined,
    script: builtin ? undefined : indicator.script,
    securityMode: builtin ? undefined : indicator.securityMode,
    params: buildIndicatorComputeParams(indicator, { candleUpColor, candleDownColor }),
    historyLimit,
  };
}

export function buildHostedSubscriptionSignature(indicator, context) {
  const { chartData = [], chartDataMeta = {} } = context;
  const message = buildHostedSubscriptionMessage(indicator, {
    ...context,
    chartDataLength: chartData.length,
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
    historyLimit: message.historyLimit,
    historyFirstTime: chartDataMeta.firstTime ?? chartData[0]?.time ?? null,
    historyLastTime: chartDataMeta.lastTime ?? chartData[chartData.length - 1]?.time ?? null,
    chartDataStatus: chartDataMeta.status || "idle",
  });
}

export function buildIndicatorRangeRequest(start, end) {
  const startSec = Math.floor(Number(start));
  const endSec = Math.floor(Number(end));
  if (
    !Number.isFinite(startSec)
    || !Number.isFinite(endSec)
    || startSec <= 0
    || endSec <= 0
    || startSec > endSec
  ) {
    return null;
  }
  return { start: startSec, end: endSec };
}

export function buildHostedRangeMessage(clientId, range) {
  return {
    action: "load_range",
    clientId,
    start: range.start,
    end: range.end,
  };
}

export function parseIndicatorWsMessage(rawData) {
  return JSON.parse(rawData);
}

export function resolveIndicatorWsSequenceState(message, lastSeq) {
  if (!Number.isFinite(message?.seq)) {
    return {
      hasGap: false,
      nextSeq: lastSeq,
      expectedSeq: null,
      actualSeq: null,
    };
  }

  const expectedSeq = lastSeq + 1;
  return {
    hasGap: lastSeq > 0 && message.seq !== expectedSeq,
    nextSeq: message.seq,
    expectedSeq,
    actualSeq: message.seq,
  };
}

export function dispatchIndicatorWsMessage(message, handlers) {
  if (message.type === "heartbeat" || message.type === "connected") return false;
  if (!message.clientId) return false;

  if (message.type === "indicator.snapshot") {
    handlers.onSnapshot?.(message.clientId, message);
    return true;
  }

  if (message.type === "indicator.patch") {
    handlers.onPatch?.(message.clientId, message);
    return true;
  }

  if (message.type === "indicator.preview" || message.type === "indicator.update") {
    handlers.onValues?.(message.clientId, message.values || {}, message.barTime);
    return true;
  }

  if (message.type === "indicator.error" || message.type === "error") {
    handlers.onError?.(message.clientId, message);
    return true;
  }

  return false;
}
