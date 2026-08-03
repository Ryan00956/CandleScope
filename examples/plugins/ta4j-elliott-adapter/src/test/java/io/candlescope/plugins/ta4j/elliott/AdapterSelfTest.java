/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugins.ta4j.elliott;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import io.candlescope.plugin.sdk.v2.Dispatcher;
import io.candlescope.plugin.sdk.v2.Json;
import io.candlescope.plugin.sdk.v2.ProtocolException;

/** Real ta4j adapter semantic suite without JUnit or copied upstream logic. */
public final class AdapterSelfTest {
    private static final Map<String, Object> MARKET = Map.of(
            "context", Map.of("mode", "replay", "exchange", "binance", "marketType", "spot"),
            "series", Map.of("symbol", "BTCUSDT", "interval", "1h"),
            "limit", 500L);
    private static final Map<String, Object> SETTINGS = Map.of(
            "degree", "MINUTE",
            "logicProfile", "ORTHODOX_CLASSICAL",
            "higherDegrees", 0L,
            "lowerDegrees", 0L,
            "minConfidence", 0.0d,
            "maxScenarios", 5L,
            "scenarioSwingWindow", 0L);

    private AdapterSelfTest() {
    }

    public static void main(final String[] arguments) {
        final List<Map<String, Object>> records = new ArrayList<>();
        records.add(runCase("empty", page(List.of(), true, true)));
        records.add(runCase("sine-trend-120", page(sineTrend(120), true, true)));
        records.add(runCase("sine-trend-240-prefix", page(sineTrend(240), true, true)));
        records.add(runCase("impulse-profile-180", page(impulseProfile(180), true, true)));
        records.add(runCase("non-final-last-120", page(nonFinalLast(sineTrend(120)), false, true)));
        invalidInputsFailClosed();
        final Map<String, Object> report = new LinkedHashMap<>();
        report.put("schemaVersion", "candlescope.ta4j-adapter-self-test/1");
        report.put("adapterVersion", Ta4jElliottPlugin.ADAPTER_VERSION);
        report.put("ta4jVersion", Ta4jElliottPlugin.TA4J_VERSION);
        report.put("cases", records);
        report.put("casesSha256", Json.canonicalSha256(records));
        report.put("boundaries", boundaryInputs());
        System.out.println(Json.canonical(report));
    }

    private static Map<String, Object> runCase(final String id, final Map<String, Object> page) {
        final Map<String, Object> first = Ta4jElliottPlugin.analyzePage(MARKET, SETTINGS, page);
        final Map<String, Object> second = Ta4jElliottPlugin.analyzePage(MARKET, SETTINGS, page);
        final String firstDigest = Json.canonicalSha256(first);
        equal(firstDigest, Json.canonicalSha256(second), id + " deterministic output");
        equal(first.get("schemaVersion"), "candlescope.elliott-wave-analysis/1", id + " result schema");
        final Map<String, Object> provenance = Dispatcher.object(first.get("provenance"), "provenance");
        equal(provenance.get("pointInTime"), true, id + " point-in-time provenance");
        equal(provenance.get("directNetwork"), false, id + " network boundary");
        equal(provenance.get("upstreamAlgorithmCopied"), false, id + " upstream boundary");
        final List<Object> scenarios = Dispatcher.list(first.get("scenarios"), "scenarios");
        final int barCount = Dispatcher.list(page.get("data"), "data").size();
        for (Object raw : scenarios) {
            final Map<String, Object> scenario = Dispatcher.object(raw, "scenario");
            for (Object pivotRaw : Dispatcher.list(scenario.get("pivots"), "scenario.pivots")) {
                final Map<String, Object> pivot = Dispatcher.object(pivotRaw, "pivot");
                final long index = Dispatcher.integer(pivot.get("index"), "pivot.index", 0);
                if (index >= barCount) {
                    fail(id + " returned a future pivot index " + index);
                }
            }
        }
        final Map<String, Object> render = Dispatcher.object(first.get("render"), "render");
        equal(render.get("schemaVersion"), "candlescope.render/2", id + " Render IR schema");
        return Map.of(
                "id", id,
                "barCount", (long) barCount,
                "inputSha256", Json.canonicalSha256(page),
                "outputSha256", firstDigest,
                "scenarioCount", (long) scenarios.size(),
                "renderItemCount", (long) Dispatcher.list(render.get("items"), "render.items").size(),
                "warnings", first.get("warnings"));
    }

    private static List<Map<String, Object>> sineTrend(final int count) {
        final List<Map<String, Object>> rows = new ArrayList<>();
        double previous = 100.0;
        for (int index = 0; index < count; index++) {
            final double close = 100.0 + index * 0.025 + Math.sin(index / 17.0) * 8.0
                    + Math.sin(index / 5.0) * 3.0;
            rows.add(bar(index, previous, close, Math.max(previous, close) + 0.8,
                    Math.min(previous, close) - 0.8, 1000.0 + (index % 23) * 17.0, true));
            previous = close;
        }
        return rows;
    }

    private static List<Map<String, Object>> impulseProfile(final int count) {
        final double[] anchors = { 100, 122, 109, 145, 118, 162, 132, 174, 146 };
        final List<Map<String, Object>> rows = new ArrayList<>();
        double previous = anchors[0];
        for (int index = 0; index < count; index++) {
            final double position = index * (anchors.length - 1.0) / Math.max(1, count - 1);
            final int left = Math.min(anchors.length - 2, (int) Math.floor(position));
            final double fraction = position - left;
            final double close = anchors[left] + (anchors[left + 1] - anchors[left]) * fraction
                    + Math.sin(index * 0.73) * 0.25;
            rows.add(bar(index, previous, close, Math.max(previous, close) + 0.6,
                    Math.min(previous, close) - 0.6, 800.0 + index * 2.0, true));
            previous = close;
        }
        return rows;
    }

    private static List<Map<String, Object>> nonFinalLast(final List<Map<String, Object>> source) {
        final List<Map<String, Object>> copy = new ArrayList<>(source);
        final Map<String, Object> last = new LinkedHashMap<>(copy.get(copy.size() - 1));
        last.put("is_closed", false);
        copy.set(copy.size() - 1, last);
        return copy;
    }

    private static Map<String, Object> bar(final int index, final double open, final double close, final double high,
            final double low, final double volume, final boolean closed) {
        final Map<String, Object> result = new LinkedHashMap<>();
        result.put("time", 1_704_067_200L + index * 3600L);
        result.put("open", open);
        result.put("high", high);
        result.put("low", low);
        result.put("close", close);
        result.put("volume", volume);
        result.put("is_closed", closed);
        return result;
    }

    private static Map<String, Object> page(final List<Map<String, Object>> rows, final boolean allFinal,
            final boolean complete) {
        final Map<String, Object> coverage = new LinkedHashMap<>();
        coverage.put("requestedStartMs", null);
        coverage.put("requestedEndMs", null);
        coverage.put("requestedLimit", 500L);
        coverage.put("returnedStartMs", rows.isEmpty() ? null : ((Long) rows.get(0).get("time")) * 1000L);
        coverage.put("returnedEndMs",
                rows.isEmpty() ? null : ((Long) rows.get(rows.size() - 1).get("time")) * 1000L);
        coverage.put("returnedCount", (long) rows.size());
        coverage.put("verifiedContiguous", true);
        coverage.put("allRowsFinal", allFinal);
        coverage.put("missingRanges", List.of());
        coverage.put("excludedRanges", List.of());
        final Map<String, Object> pagination = new LinkedHashMap<>();
        pagination.put("hasMore", false);
        pagination.put("historyState", "ready");
        pagination.put("complete", complete);
        pagination.put("retryable", false);
        pagination.put("terminalReason", null);
        pagination.put("earliestAvailableMs", null);
        pagination.put("nextBeforeMs", null);
        pagination.put("availabilityRevision", "phase5-golden-v1");
        return Map.of(
                "schemaVersion", "candlescope.market-bars-page/1",
                "context", MARKET.get("context"),
                "series", MARKET.get("series"),
                "data", rows,
                "coverage", coverage,
                "sourceQuality", Map.of(
                        "source", "phase5-golden-corpus",
                        "barSources", List.of("synthetic-frozen"),
                        "qualities", List.of("verified"),
                        "trustedFinal", allFinal,
                        "cacheHit", true,
                        "backfillTriggered", false,
                        "hasTailGap", false),
                "pagination", pagination);
    }

    private static void invalidInputsFailClosed() {
        final Map<String, Object> invalidPage = new LinkedHashMap<>(page(sineTrend(16), true, true));
        final List<Map<String, Object>> rows = new ArrayList<>(sineTrend(16));
        final Map<String, Object> duplicate = new LinkedHashMap<>(rows.get(15));
        duplicate.put("time", rows.get(14).get("time"));
        rows.set(15, duplicate);
        invalidPage.put("data", rows);
        try {
            Ta4jElliottPlugin.analyzePage(MARKET, SETTINGS, invalidPage);
            fail("duplicate timestamps were accepted");
        } catch (ProtocolException expected) {
            // Expected fail-closed validation.
        }
        try {
            Ta4jElliottPlugin.analyzePage(MARKET, Map.of("logicProfile", "INTRADAY_LIVE"),
                    page(sineTrend(16), true, true));
            fail("default-branch-only ta4j profile was accepted");
        } catch (ProtocolException expected) {
            // 0.23.0 does not have the default-branch-only profile.
        }
    }

    private static Map<String, Object> boundaryInputs() {
        final Map<String, Object> longMarket = new LinkedHashMap<>(MARKET);
        longMarket.put("limit", 5000L);
        final Map<String, Object> longSettings = new LinkedHashMap<>(SETTINGS);
        longSettings.put("maxScenarios", 1L);
        longSettings.put("scenarioSwingWindow", 2L);
        final Map<String, Object> longResult = Ta4jElliottPlugin.analyzePage(
                longMarket, longSettings, page(sineTrend(5000), true, true));
        final Map<String, Object> longInput = Dispatcher.object(longResult.get("input"), "long.input");
        equal(longInput.get("barCount"), 5000L, "maximum history boundary");

        final List<Map<String, Object>> preciseRows = new ArrayList<>();
        for (int index = 0; index < 16; index++) {
            final Map<String, Object> row = new LinkedHashMap<>();
            row.put("time", 1_704_067_200L + index * 3600L);
            row.put("open", "100.0000000000000001");
            row.put("high", "101.0000000000000001");
            row.put("low", "99.0000000000000001");
            row.put("close", index % 2 == 0 ? "100.1250000000000001" : "99.8750000000000001");
            row.put("volume", "0.0000000000000001");
            row.put("is_closed", true);
            preciseRows.add(row);
        }
        final Map<String, Object> precise = Ta4jElliottPlugin.analyzePage(
                MARKET, SETTINGS, page(preciseRows, true, true));
        equal(Dispatcher.object(precise.get("engine"), "engine").get("numericType"),
                "DecimalNum", "decimal implementation");

        final Map<String, Object> upperRow = new LinkedHashMap<>(bar(
                0, 100.0, 100.5, 101.0, 99.5, 1.0, true));
        final long upperTimestamp = 253_402_297_199L;
        upperRow.put("time", upperTimestamp);
        final Map<String, Object> upper = Ta4jElliottPlugin.analyzePage(
                MARKET, SETTINGS, page(List.of(upperRow), true, true));
        equal(Dispatcher.object(upper.get("input"), "upper.input").get("lastVisibleTimeMs"),
                upperTimestamp * 1000L, "timestamp upper boundary");

        boolean oversizedRejected = false;
        try {
            Ta4jElliottPlugin.analyzePage(
                    longMarket, longSettings, page(sineTrend(5001), true, true));
        } catch (ProtocolException expected) {
            oversizedRejected = true;
        }
        equal(oversizedRejected, true, "over-maximum history rejection");
        return Map.of(
                "maxBarsAnalyzed", 5000L,
                "overMaxBarsRejected", true,
                "numericType", "DecimalNum",
                "maxTimestampSeconds", upperTimestamp);
    }

    private static void equal(final Object actual, final Object expected, final String label) {
        if (!java.util.Objects.equals(actual, expected)) {
            fail(label + ": expected=" + expected + ", actual=" + actual);
        }
    }

    private static void fail(final String message) {
        throw new AssertionError(message);
    }
}
