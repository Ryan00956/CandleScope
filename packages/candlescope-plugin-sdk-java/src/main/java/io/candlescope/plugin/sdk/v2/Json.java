/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugin.sdk.v2;

import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Strict bounded JSON and CandleScope canonical JSON. */
public final class Json {
    public static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

    public record Limits(int maxMessageBytes, int maxDepth, int maxContainerItems, int maxStringBytes) {
        public static final Limits DEFAULT = new Limits(1024 * 1024, 32, 10_000, 256 * 1024);

        public Limits {
            if (maxMessageBytes < 1 || maxDepth < 1 || maxContainerItems < 1 || maxStringBytes < 1) {
                throw new IllegalArgumentException("JSON limits must be positive");
            }
        }
    }

    public static final class JsonException extends RuntimeException {
        private final String code;
        private final String path;

        public JsonException(final String code, final String message) {
            this(code, message, null);
        }

        public JsonException(final String code, final String message, final String path) {
            super(message);
            this.code = Objects.requireNonNull(code, "code");
            this.path = path;
        }

        public String code() {
            return code;
        }

        public String path() {
            return path;
        }
    }

    private Json() {
    }

    public static Object parse(final byte[] payload) {
        return parse(payload, Limits.DEFAULT);
    }

    public static Object parse(final byte[] payload, final Limits limits) {
        Objects.requireNonNull(payload, "payload");
        Objects.requireNonNull(limits, "limits");
        if (payload.length > limits.maxMessageBytes()) {
            throw new JsonException("MESSAGE_TOO_LARGE",
                    "control message exceeds " + limits.maxMessageBytes() + " bytes");
        }
        final String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(payload)).toString();
        } catch (CharacterCodingException exception) {
            throw new JsonException("INVALID_UTF8", "control messages must be valid UTF-8");
        }
        final Parser parser = new Parser(text, limits);
        final Object value = parser.value(0, "$");
        parser.space();
        if (!parser.end()) {
            throw new JsonException("INVALID_JSON", "invalid JSON document");
        }
        return normalize(value, limits, "$", 0);
    }

    public static Object normalize(final Object value) {
        return normalize(value, Limits.DEFAULT, "$", 0);
    }

    @SuppressWarnings("unchecked")
    private static Object normalize(final Object value, final Limits limits, final String path, final int depth) {
        if (depth > limits.maxDepth()) {
            throw new JsonException("JSON_TOO_DEEP", "JSON nesting exceeds depth " + limits.maxDepth(), path);
        }
        if (value == null || value instanceof Boolean || value instanceof String) {
            if (value instanceof String text) {
                validateString(text, limits, path);
            }
            return value;
        }
        if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long) {
            final long number = ((Number) value).longValue();
            if (number < -MAX_SAFE_INTEGER || number > MAX_SAFE_INTEGER) {
                throw new JsonException("UNSAFE_INTEGER",
                        "JSON integers must stay within the interoperable 53-bit range", path);
            }
            return number;
        }
        if (value instanceof Float || value instanceof Double || value instanceof BigDecimal) {
            final double number = ((Number) value).doubleValue();
            if (!Double.isFinite(number)) {
                throw new JsonException("NON_FINITE_NUMBER", "JSON numbers must be finite", path);
            }
            if (number == Math.rint(number) && Math.abs(number) > MAX_SAFE_INTEGER) {
                throw new JsonException("UNSAFE_INTEGER",
                        "integral JSON numbers must stay within the interoperable 53-bit range", path);
            }
            return number;
        }
        if (value instanceof Map<?, ?> raw) {
            if (raw.size() > limits.maxContainerItems()) {
                throw new JsonException("CONTAINER_TOO_LARGE",
                        "JSON object exceeds " + limits.maxContainerItems() + " members", path);
            }
            final Map<String, Object> output = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : raw.entrySet()) {
                if (!(entry.getKey() instanceof String key)) {
                    throw new JsonException("NON_STRING_JSON_KEY", "JSON object keys must be strings", path);
                }
                validateString(key, limits, path + ".<key>");
                if (output.containsKey(key)) {
                    throw new JsonException("DUPLICATE_JSON_KEY", "duplicate JSON object key: " + key, key);
                }
                output.put(key, normalize(entry.getValue(), limits, path + "." + key, depth + 1));
            }
            return output;
        }
        if (value instanceof List<?> raw) {
            if (raw.size() > limits.maxContainerItems()) {
                throw new JsonException("CONTAINER_TOO_LARGE",
                        "JSON array exceeds " + limits.maxContainerItems() + " items", path);
            }
            final List<Object> output = new ArrayList<>(raw.size());
            for (int index = 0; index < raw.size(); index++) {
                output.add(normalize(raw.get(index), limits, path + "[" + index + "]", depth + 1));
            }
            return Collections.unmodifiableList(output);
        }
        throw new JsonException("NOT_JSON", "unsupported JSON value type: " + value.getClass().getName(), path);
    }

    private static void validateString(final String value, final Limits limits, final String path) {
        for (int index = 0; index < value.length(); index++) {
            final char current = value.charAt(index);
            if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    throw new JsonException("INVALID_UNICODE",
                            "JSON strings must contain valid Unicode scalar values", path);
                }
                index++;
            } else if (Character.isLowSurrogate(current)) {
                throw new JsonException("INVALID_UNICODE",
                        "JSON strings must contain valid Unicode scalar values", path);
            }
        }
        if (value.getBytes(StandardCharsets.UTF_8).length > limits.maxStringBytes()) {
            throw new JsonException("STRING_TOO_LARGE",
                    "JSON string exceeds " + limits.maxStringBytes() + " UTF-8 bytes", path);
        }
    }

    public static String canonical(final Object value) {
        return canonical(value, Limits.DEFAULT);
    }

    public static String canonical(final Object value, final Limits limits) {
        final Object normalized = normalize(value, limits, "$", 0);
        final StringBuilder output = new StringBuilder();
        write(normalized, output);
        if (output.toString().getBytes(StandardCharsets.UTF_8).length > limits.maxMessageBytes()) {
            throw new JsonException("MESSAGE_TOO_LARGE",
                    "canonical JSON exceeds " + limits.maxMessageBytes() + " bytes");
        }
        return output.toString();
    }

    public static String canonicalSha256(final Object value) {
        try {
            final byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(canonical(value).getBytes(StandardCharsets.UTF_8));
            final StringBuilder hex = new StringBuilder(64);
            for (byte item : digest) {
                hex.append(String.format("%02x", item & 0xff));
            }
            return "sha256:" + hex;
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    @SuppressWarnings("unchecked")
    private static void write(final Object value, final StringBuilder output) {
        if (value == null) {
            output.append("null");
        } else if (value instanceof Boolean bool) {
            output.append(bool ? "true" : "false");
        } else if (value instanceof String text) {
            quote(text, output);
        } else if (value instanceof Long number) {
            output.append(number);
        } else if (value instanceof Double number) {
            output.append(canonicalNumber(number));
        } else if (value instanceof List<?> list) {
            output.append('[');
            for (int index = 0; index < list.size(); index++) {
                if (index > 0) {
                    output.append(',');
                }
                write(list.get(index), output);
            }
            output.append(']');
        } else if (value instanceof Map<?, ?> map) {
            output.append('{');
            final List<String> keys = new ArrayList<>((java.util.Set<String>) map.keySet());
            keys.sort(CODE_POINT_ORDER);
            for (int index = 0; index < keys.size(); index++) {
                if (index > 0) {
                    output.append(',');
                }
                final String key = keys.get(index);
                quote(key, output);
                output.append(':');
                write(map.get(key), output);
            }
            output.append('}');
        } else {
            throw new AssertionError("normalize returned an unsupported value");
        }
    }

    private static final Comparator<String> CODE_POINT_ORDER = (left, right) -> {
        int leftIndex = 0;
        int rightIndex = 0;
        while (leftIndex < left.length() && rightIndex < right.length()) {
            final int leftPoint = left.codePointAt(leftIndex);
            final int rightPoint = right.codePointAt(rightIndex);
            if (leftPoint != rightPoint) {
                return Integer.compare(leftPoint, rightPoint);
            }
            leftIndex += Character.charCount(leftPoint);
            rightIndex += Character.charCount(rightPoint);
        }
        return Integer.compare(left.length() - leftIndex, right.length() - rightIndex);
    };

    private static String canonicalNumber(final double value) {
        if (value == 0.0d) {
            return "0";
        }
        final double absolute = Math.abs(value);
        final BigDecimal decimal = BigDecimal.valueOf(value).stripTrailingZeros();
        if (absolute >= 1e-6d && absolute < 1e21d) {
            return decimal.toPlainString();
        }
        String raw = decimal.toString().toLowerCase(java.util.Locale.ROOT);
        final int exponentIndex = raw.indexOf('e');
        if (exponentIndex < 0) {
            raw = String.format(java.util.Locale.ROOT, "%.15e", value);
        }
        final String[] parts = raw.split("e", 2);
        String mantissa = parts[0];
        if (mantissa.indexOf('.') >= 0) {
            mantissa = mantissa.replaceFirst("0+$", "").replaceFirst("\\.$", "");
        }
        final int exponent = Integer.parseInt(parts[1]);
        return mantissa + "e" + (exponent >= 0 ? "+" : "-") + Math.abs(exponent);
    }

    private static void quote(final String value, final StringBuilder output) {
        output.append('"');
        for (int index = 0; index < value.length(); index++) {
            final char current = value.charAt(index);
            switch (current) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (current < 0x20) {
                        output.append(String.format("\\u%04x", (int) current));
                    } else {
                        output.append(current);
                    }
                }
            }
        }
        output.append('"');
    }

    private static final class Parser {
        private final String text;
        private final Limits limits;
        private int index;

        private Parser(final String text, final Limits limits) {
            this.text = text;
            this.limits = limits;
        }

        private boolean end() {
            return index == text.length();
        }

        private void space() {
            while (index < text.length()) {
                final char value = text.charAt(index);
                if (value != ' ' && value != '\t' && value != '\r' && value != '\n') {
                    break;
                }
                index++;
            }
        }

        private Object value(final int depth, final String path) {
            if (depth > limits.maxDepth()) {
                throw new JsonException("JSON_TOO_DEEP", "JSON nesting exceeds depth " + limits.maxDepth(), path);
            }
            space();
            if (index >= text.length()) {
                throw invalid();
            }
            return switch (text.charAt(index)) {
                case '{' -> object(depth, path);
                case '[' -> array(depth, path);
                case '"' -> string(path);
                case 't' -> literal("true", Boolean.TRUE);
                case 'f' -> literal("false", Boolean.FALSE);
                case 'n' -> literal("null", null);
                default -> number();
            };
        }

        private Map<String, Object> object(final int depth, final String path) {
            index++;
            space();
            final Map<String, Object> result = new LinkedHashMap<>();
            if (consume('}')) {
                return result;
            }
            while (true) {
                space();
                if (index >= text.length() || text.charAt(index) != '"') {
                    throw invalid();
                }
                final String key = string(path + ".<key>");
                if (result.containsKey(key)) {
                    throw new JsonException("DUPLICATE_JSON_KEY", "duplicate JSON object key: " + key, key);
                }
                if (result.size() >= limits.maxContainerItems()) {
                    throw new JsonException("CONTAINER_TOO_LARGE",
                            "JSON object exceeds " + limits.maxContainerItems() + " members", path);
                }
                space();
                expect(':');
                result.put(key, value(depth + 1, path + "." + key));
                space();
                if (consume('}')) {
                    return result;
                }
                expect(',');
            }
        }

        private List<Object> array(final int depth, final String path) {
            index++;
            space();
            final List<Object> result = new ArrayList<>();
            if (consume(']')) {
                return result;
            }
            while (true) {
                if (result.size() >= limits.maxContainerItems()) {
                    throw new JsonException("CONTAINER_TOO_LARGE",
                            "JSON array exceeds " + limits.maxContainerItems() + " items", path);
                }
                result.add(value(depth + 1, path + "[" + result.size() + "]"));
                space();
                if (consume(']')) {
                    return result;
                }
                expect(',');
            }
        }

        private String string(final String path) {
            expect('"');
            final StringBuilder result = new StringBuilder();
            while (index < text.length()) {
                final char current = text.charAt(index++);
                if (current == '"') {
                    final String output = result.toString();
                    validateString(output, limits, path);
                    return output;
                }
                if (current < 0x20) {
                    throw invalid();
                }
                if (current != '\\') {
                    if (Character.isHighSurrogate(current)) {
                        if (index >= text.length() || !Character.isLowSurrogate(text.charAt(index))) {
                            throw new JsonException("INVALID_UNICODE",
                                    "JSON strings must contain valid Unicode scalar values", path);
                        }
                        result.append(current).append(text.charAt(index++));
                    } else if (Character.isLowSurrogate(current)) {
                        throw new JsonException("INVALID_UNICODE",
                                "JSON strings must contain valid Unicode scalar values", path);
                    } else {
                        result.append(current);
                    }
                    continue;
                }
                if (index >= text.length()) {
                    throw invalid();
                }
                final char escaped = text.charAt(index++);
                switch (escaped) {
                    case '"', '\\', '/' -> result.append(escaped);
                    case 'b' -> result.append('\b');
                    case 'f' -> result.append('\f');
                    case 'n' -> result.append('\n');
                    case 'r' -> result.append('\r');
                    case 't' -> result.append('\t');
                    case 'u' -> appendUnicodeEscape(result, path);
                    default -> throw invalid();
                }
            }
            throw invalid();
        }

        private void appendUnicodeEscape(final StringBuilder result, final String path) {
            final char first = hexCharacter();
            if (Character.isHighSurrogate(first)) {
                if (index + 2 > text.length() || text.charAt(index) != '\\' || text.charAt(index + 1) != 'u') {
                    throw new JsonException("INVALID_UNICODE",
                            "JSON strings must contain valid Unicode scalar values", path);
                }
                index += 2;
                final char second = hexCharacter();
                if (!Character.isLowSurrogate(second)) {
                    throw new JsonException("INVALID_UNICODE",
                            "JSON strings must contain valid Unicode scalar values", path);
                }
                result.append(first).append(second);
            } else if (Character.isLowSurrogate(first)) {
                throw new JsonException("INVALID_UNICODE",
                        "JSON strings must contain valid Unicode scalar values", path);
            } else {
                result.append(first);
            }
        }

        private char hexCharacter() {
            if (index + 4 > text.length()) {
                throw invalid();
            }
            int value = 0;
            for (int offset = 0; offset < 4; offset++) {
                final int digit = Character.digit(text.charAt(index++), 16);
                if (digit < 0) {
                    throw invalid();
                }
                value = value * 16 + digit;
            }
            return (char) value;
        }

        private Object literal(final String expected, final Object value) {
            if (!text.startsWith(expected, index)) {
                throw invalid();
            }
            index += expected.length();
            return value;
        }

        private Number number() {
            final int start = index;
            if (consume('-') && index >= text.length()) {
                throw invalid();
            }
            if (consume('0')) {
                if (index < text.length() && Character.isDigit(text.charAt(index))) {
                    throw invalid();
                }
            } else {
                digits(true);
            }
            boolean fractional = false;
            if (consume('.')) {
                fractional = true;
                digits(true);
            }
            if (index < text.length() && (text.charAt(index) == 'e' || text.charAt(index) == 'E')) {
                fractional = true;
                index++;
                if (index < text.length() && (text.charAt(index) == '+' || text.charAt(index) == '-')) {
                    index++;
                }
                digits(true);
            }
            final String raw = text.substring(start, index);
            try {
                if (!fractional) {
                    final long value = Long.parseLong(raw);
                    if (value < -MAX_SAFE_INTEGER || value > MAX_SAFE_INTEGER) {
                        throw new JsonException("UNSAFE_INTEGER",
                                "JSON integers must stay within the interoperable 53-bit range");
                    }
                    return value;
                }
                final double value = Double.parseDouble(raw);
                if (!Double.isFinite(value)) {
                    throw new JsonException("NON_FINITE_NUMBER", "JSON numbers must be finite");
                }
                if (value == Math.rint(value) && Math.abs(value) > MAX_SAFE_INTEGER) {
                    throw new JsonException("UNSAFE_INTEGER",
                            "integral JSON numbers must stay within the interoperable 53-bit range");
                }
                return value;
            } catch (NumberFormatException exception) {
                throw invalid();
            }
        }

        private void digits(final boolean required) {
            final int start = index;
            while (index < text.length() && Character.isDigit(text.charAt(index))) {
                index++;
            }
            if (required && start == index) {
                throw invalid();
            }
        }

        private boolean consume(final char expected) {
            if (index < text.length() && text.charAt(index) == expected) {
                index++;
                return true;
            }
            return false;
        }

        private void expect(final char expected) {
            if (!consume(expected)) {
                throw invalid();
            }
        }

        private JsonException invalid() {
            return new JsonException("INVALID_JSON", "invalid JSON document");
        }
    }
}
