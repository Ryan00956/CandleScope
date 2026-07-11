const DEFAULT_ATR_LENGTH = 14;
const MAX_PRICE_DECIMALS = 8;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function decimalPlaces(value) {
  const number = positiveNumber(value);
  if (number == null) return 0;
  const [coefficient, exponentText] = String(number).toLowerCase().split("e");
  const fractionLength = coefficient.split(".")[1]?.length || 0;
  const exponent = Number(exponentText || 0);
  return Math.min(MAX_PRICE_DECIMALS, Math.max(0, fractionLength - exponent));
}

export function inferRenkoMinimumTick(rows = [], preferredBoxSize = null) {
  let precision = decimalPlaces(preferredBoxSize);
  for (const row of rows || []) {
    for (const field of ["open", "high", "low", "close"]) {
      precision = Math.max(precision, decimalPlaces(row?.[field]));
    }
  }
  return 10 ** -Math.min(MAX_PRICE_DECIMALS, precision);
}

export function calculateRenkoAtr(rows = [], length = DEFAULT_ATR_LENGTH) {
  const period = Math.max(2, Math.min(500, Math.trunc(Number(length)) || DEFAULT_ATR_LENGTH));
  const trueRanges = [];
  let previousClose = null;
  for (const row of rows || []) {
    if (row?.__whitespace) continue;
    const close = finiteNumber(row?.close);
    if (close == null) continue;
    const high = finiteNumber(row?.high) ?? close;
    const low = finiteNumber(row?.low) ?? close;
    const range = previousClose == null
      ? Math.abs(high - low)
      : Math.max(
        Math.abs(high - low),
        Math.abs(high - previousClose),
        Math.abs(low - previousClose),
      );
    if (Number.isFinite(range)) trueRanges.push(range);
    previousClose = close;
  }
  if (trueRanges.length === 0) return null;
  const seedLength = Math.min(period, trueRanges.length);
  let atr = trueRanges.slice(0, seedLength).reduce((sum, value) => sum + value, 0) / seedLength;
  for (let index = seedLength; index < trueRanges.length; index += 1) {
    atr = ((atr * (period - 1)) + trueRanges[index]) / period;
  }
  return positiveNumber(atr);
}

function lastFiniteClose(rows = []) {
  for (let index = (rows?.length || 0) - 1; index >= 0; index -= 1) {
    const close = positiveNumber(rows[index]?.close);
    if (close != null) return close;
  }
  return null;
}

function alignToTick(value, minTick) {
  const ticks = Math.max(1, Math.round(value / minTick));
  return Number((ticks * minTick).toFixed(MAX_PRICE_DECIMALS));
}

export function resolveRenkoProjectorOptions(rows = [], {
  atrLength = DEFAULT_ATR_LENGTH,
  boxSize = 1,
  mode = "atr",
} = {}) {
  const normalizedMode = mode === "traditional" ? "traditional" : "atr";
  const requestedBoxSize = positiveNumber(boxSize) ?? 1;
  const minTick = inferRenkoMinimumTick(rows, requestedBoxSize);
  const atr = normalizedMode === "atr" ? calculateRenkoAtr(rows, atrLength) : null;
  const fallback = Math.max(minTick, (lastFiniteClose(rows) ?? requestedBoxSize) * 0.005);
  const resolvedBoxSize = alignToTick(
    normalizedMode === "traditional" ? requestedBoxSize : (atr ?? fallback),
    minTick,
  );
  const resolvedAtrLength = Math.max(
    2,
    Math.min(500, Math.trunc(Number(atrLength)) || DEFAULT_ATR_LENGTH),
  );
  return Object.freeze({
    boxSize: resolvedBoxSize,
    minTick,
    mode: normalizedMode,
    atrLength: resolvedAtrLength,
    configKey: `renko:${normalizedMode}:${resolvedAtrLength}:${resolvedBoxSize}:${minTick}`,
  });
}
