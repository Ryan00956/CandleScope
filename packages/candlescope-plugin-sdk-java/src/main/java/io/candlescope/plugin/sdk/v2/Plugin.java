/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugin.sdk.v2;

import java.util.Map;

/** Minimal implementation surface for a Plugin Platform v2 Java entrypoint. */
public interface Plugin {
    /** Static, manifest-equivalent runtime descriptor. */
    Map<String, Object> describe();

    default void activate(final Map<String, Object> request) {
    }

    /** Return a JSON object, {@link Deferred}, or {@link HostCall}. */
    Object invoke(Map<String, Object> request);

    default Object eventBatch(final Map<String, Object> request) {
        return Map.of("accepted", ((java.util.List<?>) request.get("events")).size());
    }

    default Map<String, Object> healthCheck() {
        return Map.of("status", "ready");
    }

    default void cancel(final String token) {
    }

    default Object completeHostCall(final String token, final HostResponse response) {
        throw new ProtocolException(-32107, "HOST_CALL_COMPLETION_UNSUPPORTED",
                "Plugin initiated a Host API call but cannot consume its response.");
    }

    default void prepareUpgrade() {
    }

    default void deactivate(final String reason) {
    }

    default void shutdown() {
    }

    record Deferred(String token) {
        public Deferred {
            if (token == null || token.isEmpty() || token.length() > 128) {
                throw ProtocolException.invalidParams("deferred invocation token must be a non-empty string");
            }
        }
    }

    record HostCall(String token, String capabilityHandle, String method, Map<String, Object> params,
            Map<String, Object> requestContext) {
        public HostCall {
            if (token == null || token.isEmpty() || token.length() > 128) {
                throw ProtocolException.invalidParams("host call token must be a non-empty string");
            }
            if (capabilityHandle == null || capabilityHandle.isEmpty() || capabilityHandle.length() > 512) {
                throw ProtocolException.invalidParams("host.call capabilityHandle is invalid");
            }
            if (method == null || method.isEmpty() || method.length() > 128) {
                throw ProtocolException.invalidParams("host.call method is invalid");
            }
            params = Dispatcher.object(Json.normalize(params), "host.call.params");
            requestContext = Dispatcher.object(Json.normalize(requestContext), "host.call.requestContext");
        }
    }

    record HostResponse(boolean success, Object result, Map<String, Object> error, long generation) {
        public HostResponse {
            if (generation < 0) {
                throw new IllegalArgumentException("generation must be non-negative");
            }
            if (success) {
                result = Json.normalize(result);
                error = Map.of();
            } else {
                error = Dispatcher.object(Json.normalize(error), "host response error");
                result = null;
            }
        }
    }
}
