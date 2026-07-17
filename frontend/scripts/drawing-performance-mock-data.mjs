function roundMockPrice(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Single source of truth for the managed performance server's deterministic
 * OHLCV series. Runner fixtures that depend on derived ordinals must project
 * the exact same source rows that the browser receives.
 */
export function buildDrawingPerformanceMockBars({
  barCount,
  intervalSeconds,
  endTime,
}) {
  const count = Math.max(2, Math.min(20_000, Math.trunc(Number(barCount)) || 2));
  const interval = Math.max(1, Math.trunc(Number(intervalSeconds)) || 1);
  const end = Math.trunc(Number(endTime));
  if (!Number.isSafeInteger(end)) {
    throw new TypeError("Drawing performance mock endTime must be a safe integer");
  }
  const baseTime = end - (count - 1) * interval;
  // Keep the managed benchmark inside one stable BTC-sized price window even
  // when the requested history grows from the legacy 240/1500 bars to the
  // Phase 6 10000-bar matrix. A per-index drift would push the current
  // viewport tens of thousands of dollars away from every persisted fixture.
  const priceDriftPerBar = 1_200 / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, index) => {
    const time = baseTime + index * interval;
    const wave = Math.sin(index / 8) * 120 + Math.cos(index / 17) * 80;
    const open = 62_400 + wave + index * priceDriftPerBar;
    const close = open + Math.sin(index / 5) * 45;
    const high = Math.max(open, close) + 80 + Math.sin(index / 3) * 12;
    const low = Math.min(open, close) - 75 - Math.cos(index / 4) * 10;
    const volume = 320 + Math.round(Math.abs(Math.sin(index / 6)) * 180 + index * 0.8);
    return Object.freeze({
      time,
      open: roundMockPrice(open),
      high: roundMockPrice(high),
      low: roundMockPrice(low),
      close: roundMockPrice(close),
      volume,
    });
  });
}
