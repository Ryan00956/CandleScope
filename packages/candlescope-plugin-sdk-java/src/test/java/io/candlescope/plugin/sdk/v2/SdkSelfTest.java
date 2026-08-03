/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugin.sdk.v2;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Dependency-free SDK contract suite, executable with plain javac/java. */
public final class SdkSelfTest {
    private SdkSelfTest() {
    }

    public static void main(final String[] arguments) throws Exception {
        if (arguments.length != 1) {
            throw new IllegalArgumentException("expected the frozen Python transcript fixture path");
        }
        jsonContract();
        transcript(Path.of(arguments[0]));
        hostCallContract();
        System.out.println("candlescope-plugin-sdk-java self-test: PASS");
    }

    private static void jsonContract() {
        equal(Json.canonical(Json.parse("{\"emoji\":\"波浪🌊\",\"n\":-0.0}".getBytes(StandardCharsets.UTF_8))),
                "{\"emoji\":\"波浪🌊\",\"n\":0}", "Unicode/-0 canonicalization");
        equal(Json.canonical(List.of(1e-6d, 1e-7d, 1.25e15d)),
                "[0.000001,1e-7,1250000000000000]", "number canonicalization");
        rejects("{\"x\":1,\"x\":2}", "DUPLICATE_JSON_KEY");
        rejects("9007199254740992", "UNSAFE_INTEGER");
        rejects("-9223372036854775808", "UNSAFE_INTEGER");
        rejects("1e21", "UNSAFE_INTEGER");
        rejects("\"\\ud800\"", "INVALID_UNICODE");
        try {
            Json.parse(new byte[] { (byte) 0xc3, 0x28 });
            fail("invalid UTF-8 was accepted");
        } catch (Json.JsonException exception) {
            equal(exception.code(), "INVALID_UTF8", "invalid UTF-8 code");
        }
        try {
            Json.normalize(Long.MIN_VALUE);
            fail("programmatic Long.MIN_VALUE was accepted");
        } catch (Json.JsonException exception) {
            equal(exception.code(), "UNSAFE_INTEGER", "Long.MIN_VALUE boundary");
        }
        final Json.Limits tiny = new Json.Limits(64, 2, 2, 4);
        try {
            Json.parse("{\"abcde\":1}".getBytes(StandardCharsets.UTF_8), tiny);
            fail("oversized string was accepted");
        } catch (Json.JsonException exception) {
            equal(exception.code(), "STRING_TOO_LARGE", "string boundary");
        }
        try {
            Json.parse("[[[0]]]".getBytes(StandardCharsets.UTF_8), tiny);
            fail("deep JSON was accepted");
        } catch (Json.JsonException exception) {
            equal(exception.code(), "JSON_TOO_DEEP", "depth boundary");
        }
        try {
            Json.parse("[1,2,3]".getBytes(StandardCharsets.UTF_8), tiny);
            fail("large container was accepted");
        } catch (Json.JsonException exception) {
            equal(exception.code(), "CONTAINER_TOO_LARGE", "container boundary");
        }
    }

    private static void transcript(final Path fixturePath) throws Exception {
        final Map<String, Object> fixture = Dispatcher.object(Json.parse(Files.readAllBytes(fixturePath)), "fixture");
        final List<Object> requests = Dispatcher.list(fixture.get("requests"), "fixture.requests");
        final Map<String, Object> expected = Dispatcher.object(fixture.get("expected"), "fixture.expected");
        final JsonLineServer server = new JsonLineServer(new HelloPlugin());
        final List<Map<String, Object>> responses = new ArrayList<>();
        for (Object request : requests) {
            responses.addAll(server.handleValue(request));
        }
        final List<Object> expectedDigests = Dispatcher.list(expected.get("responseSha256"),
                "fixture.expected.responseSha256");
        final List<String> actualDigests = responses.stream().map(Json::canonicalSha256).toList();
        equal(actualDigests, expectedDigests, "per-frame Python/Java parity");
        equal(Json.canonicalSha256(responses), expected.get("transcriptSha256"), "transcript Python/Java parity");
    }

    private static void hostCallContract() {
        final JsonLineServer server = new JsonLineServer(new HostCallPlugin());
        final Map<String, Object> context = Map.of(
                "contributionId", "analyze",
                "userAction", true,
                "generation", 1L,
                "traceId", "trace-host-call");
        one(server.handleValue(request("h", "handshake", Map.of(
                "protocols", List.of(Dispatcher.PROTOCOL),
                "host", Map.of("name", "CandleScope", "version", "0.4.0"),
                "entrypointId", "main",
                "hostApis", List.of(Dispatcher.HOST_API),
                "transports", List.of(Dispatcher.TRANSPORT)), 0)));
        one(server.handleValue(request("a", "activate", Map.of(
                "instanceId", "instance",
                "generation", 1L,
                "capabilities", List.of(Map.of(
                        "handle", "cap-bars",
                        "permissionId", "market.bars.read",
                        "scope", Map.of()))), 1)));
        final Map<String, Object> hostCall = one(server.handleValue(request("i", "invoke", Map.of(
                "contributionId", "analyze",
                "input", Map.of(),
                "requestContext", context), 1)));
        equal(hostCall.get("method"), "host.call", "Host call method");
        final Map<String, Object> completion = one(server.handleValue(Map.of(
                "jsonrpc", "2.0",
                "id", hostCall.get("id"),
                "result", Map.of("bars", List.of()),
                "generation", 1L)));
        equal(Dispatcher.object(completion.get("result"), "result").get("barCount"), 0L,
                "Host call correlation");
        final Map<String, Object> late = one(server.handleValue(Map.of(
                "jsonrpc", "2.0",
                "id", hostCall.get("id"),
                "result", Map.of("bars", List.of()),
                "generation", 1L)));
        final Map<String, Object> error = Dispatcher.object(late.get("error"), "error");
        final Map<String, Object> data = Dispatcher.object(error.get("data"), "error.data");
        equal(data.get("code"), "HOST_CALL_NOT_PENDING", "late Host response rejection");
    }

    private static Map<String, Object> request(final Object id, final String method, final Map<String, Object> params,
            final long generation) {
        return Map.of("jsonrpc", "2.0", "id", id, "method", method, "params", params,
                "generation", generation);
    }

    private static Map<String, Object> one(final List<Map<String, Object>> values) {
        if (values.size() != 1) {
            fail("expected one frame, got " + values.size());
        }
        return values.get(0);
    }

    private static void rejects(final String input, final String code) {
        try {
            Json.parse(input.getBytes(StandardCharsets.UTF_8));
            fail(code + " input was accepted");
        } catch (Json.JsonException exception) {
            equal(exception.code(), code, "rejection code");
        }
    }

    private static void equal(final Object actual, final Object expected, final String label) {
        if (!java.util.Objects.equals(actual, expected)) {
            fail(label + ": expected=" + expected + ", actual=" + actual);
        }
    }

    private static void fail(final String message) {
        throw new AssertionError(message);
    }

    private static final class HostCallPlugin implements Plugin {
        @Override
        public Map<String, Object> describe() {
            return Map.of(
                    "protocol", Dispatcher.PROTOCOL,
                    "plugin", Map.of("id", "candlescope.host-call-test", "name", "Host Call Test",
                            "version", "0.1.0", "publisher", "candlescope"),
                    "entrypointId", "main",
                    "contributions", List.of(Map.of("id", "analyze", "kind", "command/1",
                            "title", "Analyze", "entrypoint", "main")),
                    "permissions", Map.of("required", List.of("market.bars.read"), "optional", List.of()),
                    "hostApis", Map.of("required", List.of(Dispatcher.HOST_API), "optional", List.of()),
                    "features", List.of("host-call-correlation"));
        }

        @Override
        public Object invoke(final Map<String, Object> request) {
            return new HostCall("pending", "cap-bars", "market.bars.read", Map.of("limit", 10L),
                    Dispatcher.object(request.get("requestContext"), "requestContext"));
        }

        @Override
        public Object completeHostCall(final String token, final HostResponse response) {
            if (!token.equals("pending") || !response.success()) {
                throw new AssertionError("unexpected Host response");
            }
            final Map<String, Object> result = Dispatcher.object(response.result(), "host result");
            return Map.of("barCount", (long) Dispatcher.list(result.get("bars"), "bars").size());
        }
    }
}
