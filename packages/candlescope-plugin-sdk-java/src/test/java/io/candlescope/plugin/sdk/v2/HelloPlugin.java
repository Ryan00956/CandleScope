/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugin.sdk.v2;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** Transcript-compatible Java implementation of the Python SDK hello fixture. */
public final class HelloPlugin implements Plugin {
    private final Set<String> pending = new HashSet<>();

    @Override
    public Map<String, Object> describe() {
        return Map.of(
                "protocol", Dispatcher.PROTOCOL,
                "plugin", Map.of(
                        "id", "candlescope.hello-command",
                        "name", "Hello Command",
                        "version", "0.1.0",
                        "publisher", "candlescope"),
                "entrypointId", "main",
                "contributions", java.util.List.of(Map.of(
                        "id", "hello",
                        "kind", "command/1",
                        "title", "Say hello",
                        "entrypoint", "main")),
                "permissions", Map.of("required", java.util.List.of(), "optional", java.util.List.of()),
                "hostApis", Map.of("required", java.util.List.of(), "optional", java.util.List.of()),
                "features", java.util.List.of());
    }

    @Override
    public Object invoke(final Map<String, Object> request) {
        final Map<String, Object> input = Dispatcher.object(request.get("input"), "invoke.input");
        final Set<String> unknown = new HashSet<>(input.keySet());
        unknown.removeAll(Set.of("name", "defer"));
        if (!unknown.isEmpty()) {
            throw ProtocolException.invalidParams("hello input contains unknown fields: " + unknown,
                    "invoke.input");
        }
        final Object nameValue = input.getOrDefault("name", "world");
        if (!(nameValue instanceof String name) || name.trim().isEmpty() || name.length() > 80) {
            throw ProtocolException.invalidParams("hello input name must be a non-empty string of at most 80 characters",
                    "invoke.input.name");
        }
        final Object deferValue = input.getOrDefault("defer", Boolean.FALSE);
        if (!(deferValue instanceof Boolean defer)) {
            throw ProtocolException.invalidParams("hello input defer must be a boolean", "invoke.input.defer");
        }
        if (defer) {
            final Map<String, Object> context = Dispatcher.object(request.get("requestContext"), "requestContext");
            final String token = "hello:" + context.get("traceId");
            pending.add(token);
            return new Deferred(token);
        }
        return Map.of("message", "Hello, " + name.trim() + "!", "contributionId", request.get("contributionId"));
    }

    @Override
    public void cancel(final String token) {
        pending.remove(token);
    }

    @Override
    public Map<String, Object> healthCheck() {
        return Map.of("status", "ready", "pending", pending.size());
    }

    public static void main(final String[] arguments) {
        System.exit(JsonLineServer.servePlugin(new HelloPlugin()));
    }
}
