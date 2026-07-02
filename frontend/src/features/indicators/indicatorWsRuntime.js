import { buildIndicatorComputeParams } from "./indicatorComputeRuntime.js";
import {
  getBuiltinIndicatorName,
  isBuiltinIndicator,
  isWsHostedIndicator,
  stringSignature,
} from "./indicatorPayloadRuntime.js";

const INDICATOR_WS_SEED_HISTORY_LIMIT = 50_000;

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
    INDICATOR_WS_SEED_HISTORY_LIMIT,
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

  if (message.type === "indicator.replace_range") {
    handlers.onReplaceRange?.(message.clientId, message);
    return true;
  }

  if (message.type === "indicator.recomputed") {
    handlers.onRecomputed?.(message.clientId, message);
    return true;
  }

  if (message.type === "indicator.subscribed") {
    return true;
  }

  if (message.type === "indicator.preview" || message.type === "indicator.update") {
    handlers.onValues?.(
      message.clientId,
      message.values || {},
      message.barTime,
      message.type === "indicator.update",
    );
    return true;
  }

  if (message.type === "indicator.error" || message.type === "error") {
    handlers.onError?.(message.clientId, message);
    return true;
  }

  return false;
}
