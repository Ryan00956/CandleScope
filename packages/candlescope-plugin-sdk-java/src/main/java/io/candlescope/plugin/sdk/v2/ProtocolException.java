/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugin.sdk.v2;

import java.util.LinkedHashMap;
import java.util.Map;

/** A stable protocol error that is safe to return to the Host. */
public final class ProtocolException extends RuntimeException {
    private final int rpcCode;
    private final String symbolicCode;
    private final Map<String, Object> data;

    public ProtocolException(final int rpcCode, final String symbolicCode, final String message) {
        this(rpcCode, symbolicCode, message, Map.of());
    }

    public ProtocolException(final int rpcCode, final String symbolicCode, final String message,
            final Map<String, Object> data) {
        super(message);
        this.rpcCode = rpcCode;
        this.symbolicCode = symbolicCode;
        this.data = Map.copyOf(data);
    }

    public static ProtocolException invalidParams(final String message) {
        return new ProtocolException(-32602, "INVALID_CONTRACT", message);
    }

    public static ProtocolException invalidParams(final String message, final String path) {
        return new ProtocolException(-32602, "INVALID_CONTRACT", message,
                path == null ? Map.of() : Map.of("path", path));
    }

    public int rpcCode() {
        return rpcCode;
    }

    public String symbolicCode() {
        return symbolicCode;
    }

    public Map<String, Object> data() {
        return data;
    }

    public Map<String, Object> toWire() {
        final Map<String, Object> errorData = new LinkedHashMap<>(data);
        errorData.put("code", symbolicCode);
        return Map.of("code", rpcCode, "message", getMessage(), "data", errorData);
    }
}
