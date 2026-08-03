/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugins.ta4j.elliott;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.ta4j.core.BarSeries;
import org.ta4j.core.BaseBarSeriesBuilder;
import org.ta4j.core.indicators.elliott.ElliottConfidence;
import org.ta4j.core.indicators.elliott.ElliottDegree;
import org.ta4j.core.indicators.elliott.ElliottLogicProfile;
import org.ta4j.core.indicators.elliott.ElliottScenario;
import org.ta4j.core.indicators.elliott.ElliottSwing;
import org.ta4j.core.indicators.elliott.ElliottWaveAnalysisResult;
import org.ta4j.core.indicators.elliott.ElliottWaveAnalysisRunner;
import org.ta4j.core.num.DecimalNumFactory;
import org.ta4j.core.num.Num;

import io.candlescope.plugin.sdk.v2.Dispatcher;
import io.candlescope.plugin.sdk.v2.Json;
import io.candlescope.plugin.sdk.v2.Plugin;
import io.candlescope.plugin.sdk.v2.ProtocolException;

/** Thin Host/ta4j mapping layer; all Elliott analysis is provided by ta4j. */
public final class Ta4jElliottPlugin implements Plugin {
    public static final String ADAPTER_VERSION = "0.1.0";
    public static final String TA4J_VERSION = "0.23.0";
    public static final String TA4J_TAG = "0.23.0";
    public static final String TA4J_COMMIT = "896d7138a9d1818fe6725b89b433ba7860b8f654";
    public static final String TA4J_JAR_SHA256 =
            "sha256:5cd1765cd309f7f99a458d7078fa65e1bec9db2fd51fb2a82496e3b033d26169";
    private static final String CONTRIBUTION_ID = "analyze-ta4j-elliott";
    private static final Pattern INTERVAL = Pattern.compile("^([1-9][0-9]{0,3})([mhdw])$");
    private final Map<String, Pending> pending = new HashMap<>();
    private String barsHandle;

    @Override
    public Map<String, Object> describe() {
        return Map.of(
                "protocol", Dispatcher.PROTOCOL,
                "plugin", Map.of(
                        "id", "candlescope.ta4j-elliott",
                        "name", "ta4j Elliott Wave Reference",
                        "version", ADAPTER_VERSION,
                        "publisher", "candlescope"),
                "entrypointId", "main",
                "contributions", List.of(Map.of(
                        "id", CONTRIBUTION_ID,
                        "kind", "command/1",
                        "title", "Analyze Elliott waves with ta4j",
                        "entrypoint", "main")),
                "permissions", Map.of(
                        "required", List.of("market.bars.read"),
                        "optional", List.of()),
                "hostApis", Map.of(
                        "required", List.of(Dispatcher.HOST_API),
                        "optional", List.of()),
                "features", List.of("ta4j-0.23.0", "point-in-time", "render-ir-v2"));
    }

    @Override
    public void activate(final Map<String, Object> request) {
        barsHandle = null;
        for (Object raw : Dispatcher.list(request.get("capabilities"), "activate.capabilities")) {
            final Map<String, Object> item = Dispatcher.object(raw, "capability");
            if ("market.bars.read".equals(item.get("permissionId"))) {
                barsHandle = Dispatcher.string(item.get("handle"), "capability.handle", 512);
            }
        }
        if (barsHandle == null) {
            throw new ProtocolException(-32106, "CAPABILITY_GRANTS_INVALID",
                    "ta4j Adapter requires the market.bars.read capability");
        }
    }

    @Override
    public Object invoke(final Map<String, Object> request) {
        if (barsHandle == null) {
            throw new ProtocolException(-32103, "PLUGIN_NOT_ACTIVE", "ta4j Adapter is not active");
        }
        final Map<String, Object> input = Dispatcher.object(request.get("input"), "invoke.input");
        exact(input, Set.of("market", "settings"), "invoke.input");
        final Map<String, Object> market = validateMarketRequest(input.get("market"));
        final Settings settings = Settings.from(input.get("settings"));
        final Map<String, Object> context = Dispatcher.object(request.get("requestContext"), "requestContext");
        final String token = "ta4j:" + context.get("traceId");
        if (pending.putIfAbsent(token, new Pending(market, settings)) != null) {
            throw new ProtocolException(-32105, "REQUEST_ID_IN_USE", "ta4j analysis trace is already pending");
        }
        return new HostCall(token, barsHandle, "market.bars.read", market, context);
    }

    @Override
    public Object completeHostCall(final String token, final HostResponse response) {
        final Pending operation = pending.remove(token);
        if (operation == null) {
            throw new ProtocolException(-32103, "HOST_CALL_NOT_PENDING", "ta4j Host call token is stale");
        }
        if (!response.success()) {
            throw new ProtocolException(-32107, "HOST_CALL_FAILED", "Host rejected the point-in-time bars read");
        }
        return analyzePage(operation.market(), operation.settings(), response.result());
    }

    @Override
    public void cancel(final String token) {
        pending.remove(token);
    }

    @Override
    public void deactivate(final String reason) {
        pending.clear();
        barsHandle = null;
    }

    @Override
    public void shutdown() {
        pending.clear();
        barsHandle = null;
    }

    @Override
    public Map<String, Object> healthCheck() {
        return Map.of(
                "status", barsHandle == null ? "inactive" : "ready",
                "pending", (long) pending.size(),
                "adapterVersion", ADAPTER_VERSION,
                "ta4jVersion", TA4J_VERSION);
    }

    /** Public for the independent golden-corpus test; not exposed as a plugin command. */
    public static Map<String, Object> analyzePage(final Map<String, Object> market, final Object rawSettings,
            final Object rawPage) {
        return analyzePage(validateMarketRequest(market), Settings.from(rawSettings), rawPage);
    }

    private static Map<String, Object> analyzePage(final Map<String, Object> market, final Settings settings,
            final Object rawPage) {
        final MarketPage page = MarketPage.from(market, rawPage);
        final List<String> warnings = new ArrayList<>(page.warnings());
        final List<Map<String, Object>> scenarios;
        final List<String> upstreamNotes;
        if (page.bars().getBarCount() < 8) {
            scenarios = List.of();
            upstreamNotes = List.of("Insufficient history: at least 8 bars are required by the reference adapter");
            warnings.add(page.bars().isEmpty() ? "EMPTY_SERIES" : "INSUFFICIENT_HISTORY");
        } else {
            final ElliottWaveAnalysisRunner.Builder builder = ElliottWaveAnalysisRunner.builder()
                    .degree(settings.degree())
                    .logicProfile(settings.logicProfile())
                    .minConfidence(settings.minConfidence())
                    .maxScenarios(settings.maxScenarios())
                    .scenarioSwingWindow(settings.scenarioSwingWindow());
            if (settings.higherDegrees() != null) {
                builder.higherDegrees(settings.higherDegrees());
            }
            if (settings.lowerDegrees() != null) {
                builder.lowerDegrees(settings.lowerDegrees());
            }
            final ElliottWaveAnalysisResult result = builder.build().analyze(page.bars());
            scenarios = projectScenarios(result, page);
            upstreamNotes = result.notes();
            if (scenarios.isEmpty()) {
                warnings.add("NO_QUALIFYING_SCENARIO");
            }
        }
        warnings.addAll(upstreamNotes.stream().map(note -> "TA4J_NOTE: " + bounded(note, 512)).toList());
        final Map<String, Object> output = new LinkedHashMap<>();
        output.put("schemaVersion", "candlescope.elliott-wave-analysis/1");
        output.put("engine", Map.of(
                "adapter", "candlescope-ta4j-elliott-adapter",
                "adapterVersion", ADAPTER_VERSION,
                "numericType", "DecimalNum",
                "upstream", Map.of(
                        "name", "ta4j",
                        "version", TA4J_VERSION,
                        "repository", "https://github.com/ta4j/ta4j",
                        "tag", TA4J_TAG,
                        "commit", TA4J_COMMIT,
                        "artifactSha256", TA4J_JAR_SHA256)));
        output.put("input", page.provenance());
        output.put("settings", settings.toWire());
        output.put("settingsSha256", Json.canonicalSha256(settings.toWire()));
        output.put("scenarios", scenarios);
        output.put("warnings", List.copyOf(new LinkedHashSet<>(warnings)));
        output.put("render", render(scenarios));
        output.put("provenance", Map.of(
                "pointInTime", true,
                "hostOwnedMarketData", true,
                "directNetwork", false,
                "directDatabase", false,
                "upstreamAlgorithmCopied", false));
        return output;
    }

    private static List<Map<String, Object>> projectScenarios(final ElliottWaveAnalysisResult result,
            final MarketPage page) {
        final List<Map<String, Object>> output = new ArrayList<>();
        int rank = 1;
        for (ElliottWaveAnalysisResult.BaseScenarioAssessment assessment : result.rankedBaseScenarios()) {
            final ElliottScenario scenario = assessment.scenario();
            final List<Map<String, Object>> pivots = projectPivots(scenario, page);
            final Map<String, Object> item = new LinkedHashMap<>();
            item.put("rank", (long) rank++);
            item.put("scenarioId", bounded(scenario.id(), 256));
            item.put("waveDegree", scenario.degree().name());
            item.put("pattern", scenario.type().name());
            item.put("phase", scenario.currentPhase().name());
            item.put("direction", scenario.hasKnownDirection()
                    ? (scenario.isBullish() ? "bullish" : "bearish")
                    : "unknown");
            item.put("pivots", pivots);
            item.put("invalidation", optionalNum(scenario.invalidationPrice()));
            item.put("primaryTarget", optionalNum(scenario.primaryTarget()));
            final List<Double> targets = scenario.fibonacciTargets().stream()
                    .map(Ta4jElliottPlugin::optionalNum)
                    .filter(java.util.Objects::nonNull)
                    .toList();
            item.put("targets", targets);
            item.put("confidence", confidence(scenario.confidence(), assessment));
            item.put("startIndex", (long) scenario.startIndex());
            item.put("waveCount", (long) scenario.waveCount());
            output.add(item);
        }
        return List.copyOf(output);
    }

    private static Map<String, Object> confidence(final ElliottConfidence value,
            final ElliottWaveAnalysisResult.BaseScenarioAssessment assessment) {
        final Map<String, Object> result = new LinkedHashMap<>();
        result.put("overall", assessment.confidenceScore());
        result.put("crossDegree", assessment.crossDegreeScore());
        result.put("composite", assessment.compositeScore());
        result.put("fibonacci", optionalNum(value.fibonacciScore()));
        result.put("timeProportion", optionalNum(value.timeProportionScore()));
        result.put("alternation", optionalNum(value.alternationScore()));
        result.put("channel", optionalNum(value.channelScore()));
        result.put("completeness", optionalNum(value.completenessScore()));
        result.put("primaryReason", bounded(value.primaryReason() == null ? "unspecified" : value.primaryReason(), 512));
        return result;
    }

    private static List<Map<String, Object>> projectPivots(final ElliottScenario scenario, final MarketPage page) {
        final LinkedHashMap<Integer, Num> points = new LinkedHashMap<>();
        for (ElliottSwing swing : scenario.swings()) {
            points.putIfAbsent(swing.fromIndex(), swing.fromPrice());
            points.put(swing.toIndex(), swing.toPrice());
        }
        final List<Map<String, Object>> result = new ArrayList<>();
        int sequence = 0;
        for (Map.Entry<Integer, Num> point : points.entrySet()) {
            final int index = point.getKey();
            if (index < page.bars().getBeginIndex() || index > page.bars().getEndIndex()) {
                throw new IllegalStateException("ta4j returned a pivot outside the point-in-time series");
            }
            final long time = page.bars().getBar(index).getBeginTime().getEpochSecond();
            result.add(Map.of(
                    "index", (long) index,
                    "time", time,
                    "timeMs", Math.multiplyExact(time, 1000L),
                    "price", requiredNum(point.getValue()),
                    "label", "P" + sequence++));
        }
        return List.copyOf(result);
    }

    private static Map<String, Object> render(final List<Map<String, Object>> scenarios) {
        final List<Map<String, Object>> items = new ArrayList<>();
        final String[] colors = { "#38BDF8", "#A855F7AA", "#F59E0BAA", "#14B8A6AA", "#F97316AA" };
        for (int index = 0; index < scenarios.size(); index++) {
            final Map<String, Object> scenario = scenarios.get(index);
            final List<Object> pivots = Dispatcher.list(scenario.get("pivots"), "scenario.pivots");
            final List<Map<String, Object>> points = pivots.stream().map(raw -> {
                final Map<String, Object> pivot = Dispatcher.object(raw, "pivot");
                return Map.of("time", pivot.get("time"), "price", pivot.get("price"));
            }).toList();
            if (points.size() >= 2) {
                items.add(Map.of(
                        "id", "ta4j-scenario-" + (index + 1) + "-path",
                        "type", "polyline",
                        "points", points,
                        "color", colors[index % colors.length],
                        "width", index == 0 ? 3L : 2L,
                        "style", index == 0 ? "solid" : "dotted"));
            }
            for (int pivotIndex = 0; pivotIndex < pivots.size(); pivotIndex++) {
                final Map<String, Object> pivot = Dispatcher.object(pivots.get(pivotIndex), "pivot");
                items.add(Map.of(
                        "id", "ta4j-scenario-" + (index + 1) + "-label-" + pivotIndex,
                        "type", "label",
                        "time", pivot.get("time"),
                        "price", pivot.get("price"),
                        "text", pivot.get("label"),
                        "color", "#FFFFFF",
                        "backgroundColor", index == 0 ? "#075985DD" : "#334155CC",
                        "position", "above"));
            }
            if (index == 0 && scenario.get("invalidation") != null) {
                items.add(Map.of(
                        "id", "ta4j-primary-invalidation",
                        "type", "price-line",
                        "price", scenario.get("invalidation"),
                        "color", "#EF4444",
                        "width", 1L,
                        "style", "dashed",
                        "text", "ta4j invalidation"));
            }
            if (index == 0 && scenario.get("primaryTarget") != null) {
                items.add(Map.of(
                        "id", "ta4j-primary-target",
                        "type", "price-line",
                        "price", scenario.get("primaryTarget"),
                        "color", "#22C55E",
                        "width", 1L,
                        "style", "dotted",
                        "text", "ta4j primary target"));
            }
        }
        return Map.of("schemaVersion", "candlescope.render/2", "items", List.copyOf(items));
    }

    private static Double optionalNum(final Num value) {
        if (Num.isNaNOrNull(value)) {
            return null;
        }
        final double result = value.doubleValue();
        return Double.isFinite(result) ? result : null;
    }

    private static double requiredNum(final Num value) {
        final Double result = optionalNum(value);
        if (result == null) {
            throw new IllegalStateException("ta4j returned a non-finite required pivot price");
        }
        return result;
    }

    private static Map<String, Object> validateMarketRequest(final Object raw) {
        final Map<String, Object> market = Dispatcher.object(Json.normalize(raw), "market");
        final Set<String> allowed = Set.of("context", "series", "startMs", "endMs", "limit");
        if (!market.keySet().containsAll(Set.of("context", "series")) || !allowed.containsAll(market.keySet())) {
            throw ProtocolException.invalidParams("market request has invalid fields", "market");
        }
        final Map<String, Object> context = Dispatcher.object(market.get("context"), "market.context");
        exact(context, Set.of("mode", "exchange", "marketType"), "market.context");
        oneOf(context.get("mode"), "market.context.mode", Set.of("live", "replay"));
        boundedString(context.get("exchange"), "market.context.exchange", 64);
        boundedString(context.get("marketType"), "market.context.marketType", 64);
        final Map<String, Object> series = Dispatcher.object(market.get("series"), "market.series");
        exact(series, Set.of("symbol", "interval"), "market.series");
        boundedString(series.get("symbol"), "market.series.symbol", 64);
        duration(boundedString(series.get("interval"), "market.series.interval", 32));
        if (market.containsKey("limit")) {
            boundedInteger(market.get("limit"), "market.limit", 1, 5000);
        }
        if (market.containsKey("startMs")) {
            optionalTime(market.get("startMs"), "market.startMs");
        }
        if (market.containsKey("endMs")) {
            optionalTime(market.get("endMs"), "market.endMs");
        }
        if (market.get("startMs") instanceof Long start && market.get("endMs") instanceof Long end && start > end) {
            throw ProtocolException.invalidParams("market.startMs must not exceed market.endMs", "market.startMs");
        }
        return market;
    }

    private static Duration duration(final String interval) {
        final Matcher match = INTERVAL.matcher(interval);
        if (!match.matches()) {
            throw ProtocolException.invalidParams("series.interval is unsupported", "series.interval");
        }
        final long value = Long.parseLong(match.group(1));
        return switch (match.group(2)) {
            case "m" -> Duration.ofMinutes(value);
            case "h" -> Duration.ofHours(value);
            case "d" -> Duration.ofDays(value);
            case "w" -> Duration.ofDays(Math.multiplyExact(value, 7));
            default -> throw new AssertionError("validated interval unit");
        };
    }

    private static void optionalTime(final Object raw, final String path) {
        if (raw != null) {
            boundedInteger(raw, path, 0, Json.MAX_SAFE_INTEGER);
        }
    }

    private static long boundedInteger(final Object raw, final String path, final long minimum, final long maximum) {
        final long value = Dispatcher.integer(raw, path, minimum);
        if (value > maximum) {
            throw ProtocolException.invalidParams(path + " is outside its maximum", path);
        }
        return value;
    }

    private static String boundedString(final Object raw, final String path, final int maximum) {
        final String value = Dispatcher.string(raw, path, maximum);
        if (!value.equals(value.trim())) {
            throw ProtocolException.invalidParams(path + " must not have surrounding whitespace", path);
        }
        return value;
    }

    private static String oneOf(final Object raw, final String path, final Set<String> allowed) {
        final String value = boundedString(raw, path, 64);
        if (!allowed.contains(value)) {
            throw ProtocolException.invalidParams(path + " is unsupported", path);
        }
        return value;
    }

    private static double number(final Object raw, final String path, final double minimum, final double maximum) {
        if (!(raw instanceof Number value)) {
            throw ProtocolException.invalidParams(path + " must be numeric", path);
        }
        final double result = value.doubleValue();
        if (!Double.isFinite(result) || result < minimum || result > maximum) {
            throw ProtocolException.invalidParams(path + " is outside its finite range", path);
        }
        return result;
    }

    private static String decimal(final Object raw, final String path, final boolean positive) {
        if (!(raw instanceof Number) && !(raw instanceof String)) {
            throw ProtocolException.invalidParams(path + " must be a decimal number or string", path);
        }
        final String text = raw.toString();
        try {
            final java.math.BigDecimal value = new java.math.BigDecimal(text);
            if (positive ? value.signum() <= 0 : value.signum() < 0) {
                throw ProtocolException.invalidParams(path + " has an invalid sign", path);
            }
            return value.toPlainString();
        } catch (NumberFormatException exception) {
            throw ProtocolException.invalidParams(path + " must be a finite decimal", path);
        }
    }

    private static void exact(final Map<String, Object> value, final Set<String> fields, final String path) {
        Dispatcher.exact(value, fields, path);
    }

    private static String bounded(final String value, final int maximum) {
        if (value.length() <= maximum) {
            return value;
        }
        return value.substring(0, maximum - 1) + "…";
    }

    private record Pending(Map<String, Object> market, Settings settings) {
    }

    private record Settings(ElliottDegree degree, ElliottLogicProfile logicProfile, Integer higherDegrees,
            Integer lowerDegrees, double minConfidence, int maxScenarios, int scenarioSwingWindow) {
        private static Settings from(final Object raw) {
            final Map<String, Object> data = Dispatcher.object(Json.normalize(raw), "settings");
            final Set<String> allowed = Set.of("degree", "logicProfile", "higherDegrees", "lowerDegrees",
                    "minConfidence", "maxScenarios", "scenarioSwingWindow");
            if (!allowed.containsAll(data.keySet())) {
                throw ProtocolException.invalidParams("settings contain unknown fields", "settings");
            }
            try {
                final ElliottDegree degree = ElliottDegree.valueOf(
                        (String) data.getOrDefault("degree", "MINUTE"));
                final ElliottLogicProfile profile = ElliottLogicProfile.valueOf(
                        (String) data.getOrDefault("logicProfile", "ORTHODOX_CLASSICAL"));
                final Integer higher = optionalBoundedInt(data.get("higherDegrees"), "settings.higherDegrees", 0, 4);
                final Integer lower = optionalBoundedInt(data.get("lowerDegrees"), "settings.lowerDegrees", 0, 4);
                final double minConfidence = data.containsKey("minConfidence")
                        ? number(data.get("minConfidence"), "settings.minConfidence", 0, 1)
                        : 0.15;
                final int maxScenarios = (int) (data.containsKey("maxScenarios")
                        ? boundedInteger(data.get("maxScenarios"), "settings.maxScenarios", 1, 5)
                        : 5);
                final int swingWindow = (int) (data.containsKey("scenarioSwingWindow")
                        ? boundedInteger(data.get("scenarioSwingWindow"), "settings.scenarioSwingWindow", 0, 64)
                        : 0);
                return new Settings(degree, profile, higher, lower, minConfidence, maxScenarios, swingWindow);
            } catch (ClassCastException | IllegalArgumentException exception) {
                if (exception instanceof ProtocolException protocol) {
                    throw protocol;
                }
                throw ProtocolException.invalidParams("settings select an unsupported ta4j enum", "settings");
            }
        }

        private static Integer optionalBoundedInt(final Object raw, final String path, final int minimum,
                final int maximum) {
            return raw == null ? null : (int) boundedInteger(raw, path, minimum, maximum);
        }

        private Map<String, Object> toWire() {
            final Map<String, Object> result = new LinkedHashMap<>();
            result.put("degree", degree.name());
            result.put("logicProfile", logicProfile.name());
            result.put("minConfidence", minConfidence);
            result.put("maxScenarios", (long) maxScenarios);
            result.put("scenarioSwingWindow", (long) scenarioSwingWindow);
            if (higherDegrees != null) {
                result.put("higherDegrees", (long) higherDegrees);
            }
            if (lowerDegrees != null) {
                result.put("lowerDegrees", (long) lowerDegrees);
            }
            return result;
        }
    }

    private record MarketPage(BarSeries bars, Map<String, Object> provenance, List<String> warnings) {
        private static MarketPage from(final Map<String, Object> request, final Object raw) {
            final Map<String, Object> page = Dispatcher.object(Json.normalize(raw), "marketBarsPage");
            exact(page, Set.of("schemaVersion", "context", "series", "data", "coverage", "sourceQuality",
                    "pagination"), "marketBarsPage");
            if (!"candlescope.market-bars-page/1".equals(page.get("schemaVersion"))) {
                throw ProtocolException.invalidParams("marketBarsPage.schemaVersion is unsupported",
                        "marketBarsPage.schemaVersion");
            }
            if (!page.get("context").equals(request.get("context")) || !page.get("series").equals(request.get("series"))) {
                throw ProtocolException.invalidParams("Host bars page identity does not match the requested series");
            }
            final Map<String, Object> seriesIdentity = Dispatcher.object(page.get("series"), "marketBarsPage.series");
            final String interval = boundedString(seriesIdentity.get("interval"), "marketBarsPage.series.interval", 32);
            final Duration period = duration(interval);
            final List<Object> rows = Dispatcher.list(page.get("data"), "marketBarsPage.data");
            if (rows.size() > 5000) {
                throw ProtocolException.invalidParams("marketBarsPage.data exceeds 5000 bars", "marketBarsPage.data");
            }
            final BarSeries bars = new BaseBarSeriesBuilder()
                    .withName("candlescope-point-in-time")
                    .withNumFactory(DecimalNumFactory.getInstance())
                    .build();
            final List<String> warnings = new ArrayList<>();
            long previousTime = -1;
            for (int index = 0; index < rows.size(); index++) {
                final Map<String, Object> row = Dispatcher.object(rows.get(index), "marketBarsPage.data[" + index + "]");
                final Set<String> required = Set.of("time", "open", "high", "low", "close", "volume", "is_closed");
                if (!row.keySet().containsAll(required)) {
                    throw ProtocolException.invalidParams("market bar is missing required OHLCV fields");
                }
                final long time = boundedInteger(row.get("time"), "bar.time", 0, 253_402_300_799L);
                if (time <= previousTime) {
                    throw ProtocolException.invalidParams("market bars must be strictly time ordered", "bar.time");
                }
                if (previousTime >= 0 && time != Math.addExact(previousTime, period.toSeconds())) {
                    warnings.add("BAR_GAPS_PRESENT");
                }
                previousTime = time;
                final String open = decimal(row.get("open"), "bar.open", true);
                final String high = decimal(row.get("high"), "bar.high", true);
                final String low = decimal(row.get("low"), "bar.low", true);
                final String close = decimal(row.get("close"), "bar.close", true);
                final String volume = decimal(row.get("volume"), "bar.volume", false);
                final java.math.BigDecimal openNumber = new java.math.BigDecimal(open);
                final java.math.BigDecimal highNumber = new java.math.BigDecimal(high);
                final java.math.BigDecimal lowNumber = new java.math.BigDecimal(low);
                final java.math.BigDecimal closeNumber = new java.math.BigDecimal(close);
                if (highNumber.compareTo(lowNumber) < 0 || highNumber.compareTo(openNumber) < 0
                        || highNumber.compareTo(closeNumber) < 0 || lowNumber.compareTo(openNumber) > 0
                        || lowNumber.compareTo(closeNumber) > 0) {
                    throw ProtocolException.invalidParams("market bar OHLC bounds are invalid");
                }
                if (!(row.get("is_closed") instanceof Boolean closed)) {
                    throw ProtocolException.invalidParams("bar.is_closed must be boolean", "bar.is_closed");
                }
                if (!closed && index != rows.size() - 1) {
                    throw ProtocolException.invalidParams("only the last point-in-time bar may be non-final");
                }
                if (!closed) {
                    warnings.add("NON_FINAL_LAST_BAR");
                }
                bars.barBuilder()
                        .timePeriod(period)
                        .endTime(Instant.ofEpochSecond(time).plus(period))
                        .openPrice(open)
                        .highPrice(high)
                        .lowPrice(low)
                        .closePrice(close)
                        .volume(volume)
                        .add();
            }
            final Map<String, Object> coverage = Dispatcher.object(page.get("coverage"), "marketBarsPage.coverage");
            final Map<String, Object> pagination = Dispatcher.object(page.get("pagination"), "marketBarsPage.pagination");
            if (!Boolean.TRUE.equals(coverage.get("verifiedContiguous"))) {
                warnings.add("COVERAGE_NOT_VERIFIED_CONTIGUOUS");
            }
            if (!Boolean.TRUE.equals(coverage.get("allRowsFinal"))) {
                warnings.add("COVERAGE_CONTAINS_NON_FINAL_OR_UNKNOWN_ROWS");
            }
            if (!Boolean.TRUE.equals(pagination.get("complete"))) {
                warnings.add("HISTORY_PAGE_INCOMPLETE");
            }
            final Map<String, Object> provenance = new LinkedHashMap<>();
            provenance.put("context", page.get("context"));
            provenance.put("series", page.get("series"));
            provenance.put("barCount", (long) bars.getBarCount());
            provenance.put("lastVisibleTimeMs",
                    bars.isEmpty() ? null : Math.multiplyExact(bars.getLastBar().getBeginTime().getEpochSecond(), 1000L));
            provenance.put("coverage", coverage);
            provenance.put("sourceQuality", page.get("sourceQuality"));
            provenance.put("pagination", pagination);
            return new MarketPage(bars, provenance, List.copyOf(warnings));
        }
    }
}
