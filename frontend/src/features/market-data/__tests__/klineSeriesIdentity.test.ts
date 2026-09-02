import assert from "node:assert/strict";
import test from "node:test";

import { seriesKeyFor } from "../feed/fetchPlanner.js";
import { buildChartDatasetKey } from "../../chart-session/chartDatasetKey.js";
import {
  isLegacyKlineSeriesIdentity,
  klineSeriesIdentityQuery,
  resolveKlineSeriesIdentity,
} from "../klineSeriesIdentity.js";
import { isSameSeries } from "../rangeRuntime.js";
import { buildSeriesWindowKey } from "../window/windowRegistry.js";

const base = {
  exchange: "binance",
  marketType: "spot",
  symbol: "AAPL",
  interval: "1m",
} as const;

test("legacy identity keeps the existing physical cache key", () => {
  assert.equal(seriesKeyFor(base), "binance:spot:AAPL:1m");
  assert.equal(
    seriesKeyFor({
      ...base,
      providerId: "binance",
      venue: "binance",
      assetClass: "crypto",
      seriesVariant: "native",
      priceAdjustment: "raw",
      sessionVariant: "continuous",
      volumeSemantics: "base_asset",
    }),
    "binance:spot:AAPL:1m",
  );
  assert.equal(isLegacyKlineSeriesIdentity("binance", undefined), true);
  assert.deepEqual(klineSeriesIdentityQuery("binance", undefined), {});
});

test("provider, adjustment, session, and volume semantics isolate cache keys", () => {
  const raw = {
    ...base,
    providerId: "polygon",
    venue: "XNYS",
    assetClass: "equity",
    seriesVariant: "official",
    priceAdjustment: "raw",
    sessionVariant: "regular",
    volumeSemantics: "shares",
  };
  const adjusted = { ...raw, priceAdjustment: "split_adjusted" };

  assert.notEqual(seriesKeyFor(raw), seriesKeyFor(adjusted));
  assert.equal(isSameSeries(raw, adjusted), false);
  assert.deepEqual(resolveKlineSeriesIdentity("binance", raw), {
    providerId: "polygon",
    venue: "xnys",
    assetClass: "equity",
    seriesVariant: "official",
    priceAdjustment: "raw",
    sessionVariant: "regular",
    volumeSemantics: "shares",
  });
  assert.deepEqual(klineSeriesIdentityQuery("binance", adjusted), {
    provider_id: "polygon",
    venue: "xnys",
    asset_class: "equity",
    series_variant: "official",
    price_adjustment: "split_adjusted",
    session_variant: "regular",
    volume_semantics: "shares",
  });
  assert.notEqual(buildChartDatasetKey(raw), buildChartDatasetKey(adjusted));
  assert.notEqual(buildSeriesWindowKey(raw), buildSeriesWindowKey(adjusted));
});

test("Twelve Data identity reaches API query and every chart cache boundary", () => {
  const twelveData = {
    exchange: "twelvedata",
    marketType: "stock",
    symbol: "AAPL:NASDAQ",
    interval: "1d",
    providerId: "twelvedata",
    venue: "XNGS",
    assetClass: "stock",
    seriesVariant: "ohlcv",
    priceAdjustment: "raw",
    sessionVariant: "regular",
    volumeSemantics: "shares",
  } as const;

  assert.deepEqual(klineSeriesIdentityQuery(twelveData.exchange, twelveData), {
    provider_id: "twelvedata",
    venue: "xngs",
    asset_class: "stock",
    series_variant: "ohlcv",
    price_adjustment: "raw",
    session_variant: "regular",
    volume_semantics: "shares",
  });
  assert.match(seriesKeyFor(twelveData), /^twelvedata:xngs:stock:ohlcv:raw:regular:shares:/);
  assert.match(buildChartDatasetKey(twelveData), /^twelvedata:xngs:stock:ohlcv:raw:regular:shares::/);
  assert.match(buildSeriesWindowKey(twelveData), /^twelvedata:xngs:stock:ohlcv:raw:regular:shares::/);
});
