/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugin.sdk.v2;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Zero-queue, bounded JSON Lines transport for one Java plugin process. */
public final class JsonLineServer {
    private final Dispatcher dispatcher;
    private final Json.Limits limits;

    public JsonLineServer(final Plugin plugin) {
        this(plugin, Json.Limits.DEFAULT, 32);
    }

    public JsonLineServer(final Plugin plugin, final Json.Limits limits, final int maxInFlight) {
        this.dispatcher = new Dispatcher(plugin, maxInFlight);
        this.limits = limits;
    }

    public List<Map<String, Object>> handleLine(final byte[] line) {
        final Object value;
        try {
            value = Json.parse(line, limits);
        } catch (Json.JsonException exception) {
            final boolean size = exception.code().equals("MESSAGE_TOO_LARGE");
            return List.of(failure(null, 0, new ProtocolException(
                    size ? -32600 : -32700,
                    size ? exception.code() : "PARSE_ERROR",
                    size ? exception.getMessage() : "Control line is not valid bounded JSON.",
                    size ? Map.of("maxMessageBytes", limits.maxMessageBytes()) : Map.of())));
        }
        return handleValue(value);
    }

    public List<Map<String, Object>> handleValue(final Object value) {
        final Identity identity = bestEffortIdentity(value);
        try {
            return dispatcher.handle(value);
        } catch (ProtocolException exception) {
            return List.of(failure(identity.id(), identity.generation(), exception));
        } catch (Json.JsonException exception) {
            return List.of(failure(identity.id(), identity.generation(),
                    new ProtocolException(-32602, exception.code(), exception.getMessage(),
                            exception.path() == null ? Map.of() : Map.of("path", exception.path()))));
        } catch (RuntimeException exception) {
            exception.printStackTrace(System.err);
            return List.of(failure(identity.id(), identity.generation(),
                    new ProtocolException(-32603, "INTERNAL_ERROR", "Plugin raised an unexpected exception.")));
        }
    }

    public int serve(final InputStream input, final PrintStream protocolOutput) throws IOException {
        while (true) {
            final Line line = readLine(input, limits.maxMessageBytes());
            if (line == null) {
                return 0;
            }
            final List<Map<String, Object>> responses = line.tooLarge()
                    ? List.of(failure(null, 0,
                            new ProtocolException(-32600, "MESSAGE_TOO_LARGE",
                                    "control message exceeds " + limits.maxMessageBytes() + " bytes",
                                    Map.of("maxMessageBytes", limits.maxMessageBytes()))))
                    : handleLine(line.bytes());
            for (Map<String, Object> response : responses) {
                protocolOutput.print(Json.canonical(response, limits));
                protocolOutput.print('\n');
                protocolOutput.flush();
            }
            if (dispatcher.shutdownRequested()) {
                return 0;
            }
        }
    }

    /** Preserve the original stdout for protocol and redirect plugin prints to stderr. */
    public static int servePlugin(final Plugin plugin) {
        final PrintStream protocolOutput = System.out;
        System.setOut(System.err);
        try {
            return new JsonLineServer(plugin).serve(System.in, protocolOutput);
        } catch (IOException exception) {
            exception.printStackTrace(System.err);
            return 2;
        }
    }

    private static Line readLine(final InputStream input, final int maximum) throws IOException {
        final ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maximum, 8192));
        boolean oversized = false;
        boolean observed = false;
        while (true) {
            final int current = input.read();
            if (current < 0) {
                if (!observed) {
                    return null;
                }
                break;
            }
            observed = true;
            if (current == '\n') {
                break;
            }
            if (output.size() < maximum) {
                output.write(current);
            } else {
                oversized = true;
            }
        }
        return new Line(output.toByteArray(), oversized);
    }

    private static Identity bestEffortIdentity(final Object raw) {
        if (!(raw instanceof Map<?, ?> map)) {
            return new Identity(null, 0);
        }
        final Object rawId = map.get("id");
        final Object id = rawId instanceof String || rawId instanceof Long ? rawId : null;
        final Object rawGeneration = map.get("generation");
        final long generation = rawGeneration instanceof Long number && number >= 0 ? number : 0;
        return new Identity(id, generation);
    }

    private static Map<String, Object> failure(final Object id, final long generation,
            final ProtocolException exception) {
        final Map<String, Object> result = new LinkedHashMap<>();
        result.put("jsonrpc", "2.0");
        result.put("id", id);
        result.put("error", exception.toWire());
        result.put("generation", generation);
        return result;
    }

    private record Identity(Object id, long generation) {
    }

    private record Line(byte[] bytes, boolean tooLarge) {
    }
}
