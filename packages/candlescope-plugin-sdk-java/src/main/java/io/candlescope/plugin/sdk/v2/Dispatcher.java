/*
 * SPDX-License-Identifier: GPL-3.0-only
 */
package io.candlescope.plugin.sdk.v2;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Stateful Plugin Platform v2 lifecycle and bidirectional RPC dispatcher. */
public final class Dispatcher {
    public static final String PROTOCOL = "candlescope.plugin/2";
    public static final String HOST_API = "candlescope.host-api/1";
    public static final String TRANSPORT = "jsonl/1";
    private static final Pattern LOCAL_ID = Pattern.compile("^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$");

    private final Plugin plugin;
    private final int maxInFlight;
    private final Map<String, Object> descriptor;
    private final Set<String> contributionIds;
    private final Set<String> requiredPermissions;
    private final Set<String> optionalPermissions;
    private final Set<String> requiredHostApis;
    private final Set<String> optionalHostApis;
    private final Map<Object, Pending> pending = new LinkedHashMap<>();
    private final Map<Object, Object> hostCalls = new HashMap<>();
    private final Map<String, String> capabilityPermissions = new HashMap<>();
    private final Set<String> negotiatedHostApis = new LinkedHashSet<>();
    private String state = "created";
    private long generation;
    private long highestGeneration;
    private long nextHostCallId = 1;

    public Dispatcher(final Plugin plugin) {
        this(plugin, 32);
    }

    public Dispatcher(final Plugin plugin, final int maxInFlight) {
        if (plugin == null) {
            throw new IllegalArgumentException("plugin is required");
        }
        if (maxInFlight < 1) {
            throw new IllegalArgumentException("maxInFlight must be positive");
        }
        this.plugin = plugin;
        this.maxInFlight = maxInFlight;
        this.descriptor = validatedDescriptor(plugin.describe());
        this.contributionIds = descriptorContributions(descriptor);
        final Map<String, Object> permissions = object(descriptor.get("permissions"), "descriptor.permissions");
        this.requiredPermissions = new LinkedHashSet<>(stringList(permissions.get("required"),
                "descriptor.permissions.required", true));
        this.optionalPermissions = new LinkedHashSet<>(stringList(permissions.get("optional"),
                "descriptor.permissions.optional", true));
        final Map<String, Object> hostApis = object(descriptor.get("hostApis"), "descriptor.hostApis");
        this.requiredHostApis = new LinkedHashSet<>(stringList(hostApis.get("required"),
                "descriptor.hostApis.required", true));
        this.optionalHostApis = new LinkedHashSet<>(stringList(hostApis.get("optional"),
                "descriptor.hostApis.optional", true));
    }

    public boolean shutdownRequested() {
        return state.equals("closed");
    }

    public String state() {
        return state;
    }

    public long generation() {
        return generation;
    }

    /** Accept one parsed request or Host response and return zero or more frames. */
    public List<Map<String, Object>> handle(final Object rawFrame) {
        final Map<String, Object> frame = object(rawFrame, "frame");
        final boolean request = frame.containsKey("method");
        final boolean success = frame.containsKey("result");
        final boolean failure = frame.containsKey("error");
        if ((request ? 1 : 0) + (success ? 1 : 0) + (failure ? 1 : 0) != 1) {
            throw ProtocolException.invalidParams(
                    "JSON-RPC frame must contain exactly one of method, result, or error", "frame");
        }
        if (request) {
            return handleRequest(parseRequest(frame));
        }
        return handleHostResponse(parseResponse(frame, success));
    }

    private List<Map<String, Object>> handleRequest(final Request request) {
        if (state.equals("closed")) {
            throw error(-32103, "SESSION_CLOSED", "The plugin session is already closed.");
        }
        if (pending.containsKey(request.id())) {
            throw error(-32105, "REQUEST_ID_IN_USE", "A request with this id is still in flight.",
                    Map.of("requestId", request.id()));
        }
        if (request.method().equals("handshake")) {
            return List.of(handshake(request));
        }
        if (state.equals("created")) {
            throw error(-32101, "HANDSHAKE_REQUIRED", "handshake must complete before other methods");
        }
        return switch (request.method()) {
            case "describe" -> {
                requireControlGeneration(request, true);
                yield List.of(success(request.id(), descriptor, request.generation()));
            }
            case "activate" -> List.of(activate(request));
            case "invoke" -> invoke(request, false);
            case "eventBatch" -> invoke(request, true);
            case "healthCheck" -> {
                requireCurrentGeneration(request);
                exact(request.params(), Set.of(), "healthCheck");
                yield List.of(success(request.id(), object(Json.normalize(plugin.healthCheck()),
                        "healthCheck.result"), request.generation()));
            }
            case "cancel" -> cancel(request);
            case "prepareUpgrade" -> prepareUpgrade(request);
            case "deactivate" -> deactivate(request);
            case "shutdown" -> shutdown(request);
            default -> throw error(-32601, "METHOD_NOT_FOUND",
                    "Unknown Plugin Platform method: " + request.method(), Map.of("method", request.method()));
        };
    }

    private Map<String, Object> handshake(final Request request) {
        if (!state.equals("created")) {
            throw error(-32103, "HANDSHAKE_ALREADY_COMPLETED",
                    "handshake may only be completed once per process session");
        }
        if (request.generation() != 0) {
            throw error(-32104, "GENERATION_MISMATCH", "handshake must use generation 0");
        }
        final Map<String, Object> params = request.params();
        exact(params, Set.of("protocols", "host", "entrypointId", "hostApis", "transports"), "handshake");
        final List<String> protocols = stringList(params.get("protocols"), "handshake.protocols", false);
        final List<String> transports = stringList(params.get("transports"), "handshake.transports", false);
        final List<String> offeredApis = stringList(params.get("hostApis"), "handshake.hostApis", true);
        final Map<String, Object> host = object(params.get("host"), "handshake.host");
        exact(host, Set.of("name", "version"), "handshake.host");
        string(host.get("name"), "handshake.host.name", 256);
        string(host.get("version"), "handshake.host.version", 64);
        if (!protocols.contains(PROTOCOL)) {
            throw error(-32102, "PROTOCOL_UNSUPPORTED", "Host did not offer required protocol " + PROTOCOL + ".",
                    Map.of("supportedProtocols", List.of(PROTOCOL)));
        }
        if (!transports.contains(TRANSPORT)) {
            throw error(-32102, "TRANSPORT_UNSUPPORTED", "Host did not offer required transport " + TRANSPORT + ".",
                    Map.of("supportedTransports", List.of(TRANSPORT)));
        }
        final String entrypoint = localId(params.get("entrypointId"), "handshake.entrypointId");
        if (!entrypoint.equals(descriptor.get("entrypointId"))) {
            throw error(-32107, "ENTRYPOINT_MISMATCH", "Host requested an entrypoint not owned by this process.",
                    Map.of("entrypointId", entrypoint));
        }
        final List<String> missing = requiredHostApis.stream().filter(item -> !offeredApis.contains(item)).sorted()
                .toList();
        if (!missing.isEmpty()) {
            throw error(-32102, "HOST_API_UNSUPPORTED", "Host is missing APIs required by this entrypoint.",
                    Map.of("missingHostApis", missing));
        }
        negotiatedHostApis.clear();
        for (String item : requiredHostApis) {
            if (offeredApis.contains(item)) {
                negotiatedHostApis.add(item);
            }
        }
        for (String item : optionalHostApis) {
            if (offeredApis.contains(item)) {
                negotiatedHostApis.add(item);
            }
        }
        state = "handshaken";
        return success(request.id(), Map.of(
                "protocol", PROTOCOL,
                "transport", TRANSPORT,
                "descriptor", descriptor,
                "negotiatedHostApis", List.copyOf(negotiatedHostApis)), 0);
    }

    private Map<String, Object> activate(final Request request) {
        if (!state.equals("handshaken")) {
            throw error(-32103, "ACTIVATION_STATE_INVALID", "activate requires a handshaken inactive session");
        }
        final Map<String, Object> params = request.params();
        exact(params, Set.of("instanceId", "generation", "capabilities"), "activate");
        final String instanceId = string(params.get("instanceId"), "activate.instanceId", 128);
        final long paramsGeneration = integer(params.get("generation"), "activate.generation", 1);
        if (request.generation() != paramsGeneration) {
            throw error(-32104, "GENERATION_MISMATCH", "activate envelope and params generations differ");
        }
        if (paramsGeneration <= highestGeneration) {
            throw error(-32104, "STALE_GENERATION", "activation generation must increase monotonically",
                    Map.of("highestGeneration", highestGeneration));
        }
        final List<Object> capabilities = list(params.get("capabilities"), "activate.capabilities");
        final Set<String> handles = new HashSet<>();
        final Set<String> granted = new HashSet<>();
        final Map<String, String> grants = new HashMap<>();
        for (int index = 0; index < capabilities.size(); index++) {
            final Map<String, Object> item = object(capabilities.get(index), "activate.capabilities[" + index + "]");
            exact(item, Set.of("handle", "permissionId", "scope"), "capability");
            final String handle = string(item.get("handle"), "capability.handle", 512);
            final String permission = string(item.get("permissionId"), "capability.permissionId", 128);
            object(item.get("scope"), "capability.scope");
            if (!handles.add(handle) || !granted.add(permission)) {
                throw ProtocolException.invalidParams("activate capabilities must have unique handles and permissions");
            }
            grants.put(handle, permission);
        }
        final List<String> missing = requiredPermissions.stream().filter(item -> !granted.contains(item)).sorted()
                .toList();
        final Set<String> allowed = new HashSet<>(requiredPermissions);
        allowed.addAll(optionalPermissions);
        final List<String> unexpected = granted.stream().filter(item -> !allowed.contains(item)).sorted().toList();
        if (!missing.isEmpty() || !unexpected.isEmpty()) {
            throw error(-32106, "CAPABILITY_GRANTS_INVALID", "Activation grants do not match the static descriptor.",
                    Map.of("missing", missing, "unexpected", unexpected));
        }
        plugin.activate(params);
        capabilityPermissions.clear();
        capabilityPermissions.putAll(grants);
        generation = paramsGeneration;
        highestGeneration = paramsGeneration;
        state = "active";
        return success(request.id(), Map.of("ok", true, "instanceId", instanceId, "generation", paramsGeneration),
                request.generation());
    }

    private List<Map<String, Object>> invoke(final Request request, final boolean eventBatch) {
        requireActive(request);
        if (state.equals("quiescing")) {
            throw error(-32103, "PLUGIN_QUIESCING", "New invocations are rejected while preparing an upgrade.");
        }
        if (pending.size() >= maxInFlight) {
            throw error(-32103, "IN_FLIGHT_LIMIT", "The plugin has reached its bounded in-flight request limit.",
                    Map.of("maxInFlight", maxInFlight));
        }
        final Map<String, Object> requestContext;
        final Object outcome;
        final String resultPath;
        if (eventBatch) {
            exact(request.params(), Set.of("events", "delivery"), "eventBatch");
            list(request.params().get("events"), "eventBatch.events");
            final Map<String, Object> delivery = object(request.params().get("delivery"), "eventBatch.delivery");
            requestContext = delivery.containsKey("requestContext")
                    ? validatedRequestContext(delivery.get("requestContext"))
                    : Map.of();
            outcome = plugin.eventBatch(request.params());
            resultPath = "eventBatch.result";
        } else {
            exact(request.params(), Set.of("contributionId", "input", "requestContext"), "invoke");
            final String contributionId = localId(request.params().get("contributionId"), "invoke.contributionId");
            object(request.params().get("input"), "invoke.input");
            requestContext = validatedRequestContext(request.params().get("requestContext"));
            if (!contributionId.equals(requestContext.get("contributionId"))) {
                throw ProtocolException.invalidParams("invoke contribution does not match requestContext");
            }
            if (!contributionIds.contains(contributionId)) {
                throw error(-32107, "CONTRIBUTION_NOT_DECLARED",
                        "invoke references a contribution absent from the descriptor",
                        Map.of("contributionId", contributionId));
            }
            outcome = plugin.invoke(request.params());
            resultPath = "invoke.result";
        }
        if (!requestContext.isEmpty() && integer(requestContext.get("generation"),
                "requestContext.generation", 1) != request.generation()) {
            throw error(-32104, "GENERATION_MISMATCH", "requestContext generation does not match the envelope");
        }
        return outcome(request, requestContext, outcome, resultPath);
    }

    private List<Map<String, Object>> outcome(final Request request, final Map<String, Object> requestContext,
            final Object rawOutcome, final String resultPath) {
        if (rawOutcome instanceof Plugin.Deferred deferred) {
            pending.put(request.id(), new Pending(request.id(), request.generation(), deferred.token(),
                    requestContext, resultPath, null));
            return List.of();
        }
        if (rawOutcome instanceof Plugin.HostCall hostCall) {
            return beginHostCall(request, requestContext, hostCall, resultPath);
        }
        return List.of(success(request.id(), object(Json.normalize(rawOutcome), resultPath), request.generation()));
    }

    private List<Map<String, Object>> beginHostCall(final Request request, final Map<String, Object> requestContext,
            final Plugin.HostCall hostCall, final String resultPath) {
        if (!negotiatedHostApis.contains(HOST_API)) {
            throw error(-32102, "HOST_API_NOT_NEGOTIATED", HOST_API + " was not negotiated");
        }
        if (!hostCall.requestContext().equals(requestContext)) {
            throw error(-32107, "HOST_CALL_CONTEXT_MISMATCH",
                    "host.call must retain the originating requestContext");
        }
        if (!capabilityPermissions.containsKey(hostCall.capabilityHandle())) {
            throw error(-32106, "CAPABILITY_HANDLE_INVALID",
                    "host.call used an unknown or revoked capability handle");
        }
        final String hostCallId = "plugin:" + highestGeneration + ":" + nextHostCallId++;
        pending.put(request.id(), new Pending(request.id(), request.generation(), hostCall.token(), requestContext,
                resultPath, hostCallId));
        hostCalls.put(hostCallId, request.id());
        return List.of(request(hostCallId, "host.call", Map.of(
                "capabilityHandle", hostCall.capabilityHandle(),
                "method", hostCall.method(),
                "params", hostCall.params(),
                "requestContext", hostCall.requestContext()), request.generation()));
    }

    private List<Map<String, Object>> handleHostResponse(final Response response) {
        final Object originalId = hostCalls.get(response.id());
        if (originalId == null) {
            throw error(-32103, "HOST_CALL_NOT_PENDING", "Received a response for an unknown or cancelled host.call.",
                    Map.of("requestId", response.id()));
        }
        final Pending original = pending.get(originalId);
        if (original == null || !response.id().equals(original.hostCallId())) {
            throw error(-32103, "HOST_CALL_NOT_PENDING",
                    "Received a response for an inconsistent host.call correlation.",
                    Map.of("requestId", response.id()));
        }
        if (response.generation() != original.generation() || response.generation() != generation) {
            throw error(-32104, "STALE_HOST_CALL_RESPONSE", "host.call response belongs to a stale generation");
        }
        final Object completed = plugin.completeHostCall(original.token(), new Plugin.HostResponse(
                response.success(), response.result(), response.error(), response.generation()));
        if (completed instanceof Plugin.HostCall next) {
            if (!next.requestContext().equals(original.requestContext())) {
                throw error(-32107, "HOST_CALL_CONTEXT_MISMATCH",
                        "chained host.call must retain the originating requestContext");
            }
            if (!capabilityPermissions.containsKey(next.capabilityHandle())) {
                throw error(-32106, "CAPABILITY_HANDLE_INVALID",
                        "chained host.call used an unknown or revoked capability handle");
            }
            hostCalls.remove(response.id());
            final String nextId = "plugin:" + highestGeneration + ":" + nextHostCallId++;
            pending.put(originalId, original.withHostCall(nextId));
            hostCalls.put(nextId, originalId);
            return List.of(request(nextId, "host.call", Map.of(
                    "capabilityHandle", next.capabilityHandle(),
                    "method", next.method(),
                    "params", next.params(),
                    "requestContext", next.requestContext()), original.generation()));
        }
        if (completed instanceof Plugin.Deferred deferred) {
            hostCalls.remove(response.id());
            pending.put(originalId, new Pending(originalId, original.generation(), deferred.token(),
                    original.requestContext(), original.resultPath(), null));
            return List.of();
        }
        hostCalls.remove(response.id());
        pending.remove(originalId);
        return List.of(success(originalId, object(Json.normalize(completed), original.resultPath()),
                original.generation()));
    }

    private List<Map<String, Object>> cancel(final Request request) {
        requireCurrentGeneration(request);
        exact(request.params(), Set.of("requestId"), "cancel");
        final Object target = requestId(request.params().get("requestId"), "cancel.requestId");
        final Pending item = pending.remove(target);
        if (item == null) {
            return List.of(success(request.id(), Map.of("cancelled", false, "requestId", target),
                    request.generation()));
        }
        if (item.hostCallId() != null) {
            hostCalls.remove(item.hostCallId());
        }
        plugin.cancel(item.token());
        return List.of(
                failure(target, item.generation(), new ProtocolException(-32800, "REQUEST_CANCELLED",
                        "The invocation was cancelled by the host.")),
                success(request.id(), Map.of("cancelled", true, "requestId", target), request.generation()));
    }

    private List<Map<String, Object>> prepareUpgrade(final Request request) {
        requireActive(request);
        exact(request.params(), Set.of(), "prepareUpgrade");
        state = "quiescing";
        final List<Map<String, Object>> result = cancelAll("Plugin is quiescing for upgrade.");
        plugin.prepareUpgrade();
        result.add(success(request.id(), Map.of("ok", true), request.generation()));
        return List.copyOf(result);
    }

    private List<Map<String, Object>> deactivate(final Request request) {
        requireActive(request);
        exact(request.params(), Set.of("reason"), "deactivate");
        final String reason = string(request.params().get("reason"), "deactivate.reason", 256);
        final List<Map<String, Object>> result = cancelAll("Plugin was deactivated.");
        plugin.deactivate(reason);
        result.add(success(request.id(), Map.of("ok", true), request.generation()));
        state = "handshaken";
        generation = 0;
        capabilityPermissions.clear();
        return List.copyOf(result);
    }

    private List<Map<String, Object>> shutdown(final Request request) {
        if (state.equals("active") || state.equals("quiescing")) {
            requireCurrentGeneration(request);
        } else if (request.generation() != 0) {
            throw error(-32104, "GENERATION_MISMATCH", "inactive shutdown must use generation 0");
        }
        exact(request.params(), Set.of(), "shutdown");
        final List<Map<String, Object>> result = cancelAll("Plugin process is shutting down.");
        plugin.shutdown();
        result.add(success(request.id(), Map.of("ok", true), request.generation()));
        state = "closed";
        return List.copyOf(result);
    }

    private List<Map<String, Object>> cancelAll(final String message) {
        final List<Map<String, Object>> result = new ArrayList<>();
        for (Pending item : List.copyOf(pending.values())) {
            plugin.cancel(item.token());
            if (item.hostCallId() != null) {
                hostCalls.remove(item.hostCallId());
            }
            result.add(failure(item.requestId(), item.generation(),
                    new ProtocolException(-32800, "REQUEST_CANCELLED", message)));
        }
        pending.clear();
        return result;
    }

    private void requireActive(final Request request) {
        if (!state.equals("active") && !state.equals("quiescing")) {
            throw error(-32103, "PLUGIN_NOT_ACTIVE", "This method requires an active plugin generation.");
        }
        requireCurrentGeneration(request);
    }

    private void requireCurrentGeneration(final Request request) {
        if (request.generation() != generation || generation < 1) {
            throw error(-32104, "GENERATION_MISMATCH", "request generation does not match the active generation");
        }
    }

    private void requireControlGeneration(final Request request, final boolean allowZero) {
        if (allowZero && request.generation() == 0) {
            return;
        }
        if (state.equals("active") || state.equals("quiescing")) {
            requireCurrentGeneration(request);
        } else if (request.generation() != 0) {
            throw error(-32104, "GENERATION_MISMATCH", "inactive control request must use generation 0");
        }
    }

    private static Request parseRequest(final Map<String, Object> frame) {
        exact(frame, Set.of("jsonrpc", "id", "method", "params", "generation"), "request");
        if (!"2.0".equals(frame.get("jsonrpc"))) {
            throw ProtocolException.invalidParams("jsonrpc must be 2.0", "jsonrpc");
        }
        return new Request(requestId(frame.get("id"), "id"), string(frame.get("method"), "method", 128),
                object(frame.get("params"), "params"), integer(frame.get("generation"), "generation", 0));
    }

    private static Response parseResponse(final Map<String, Object> frame, final boolean success) {
        exact(frame, success ? Set.of("jsonrpc", "id", "result", "generation")
                : Set.of("jsonrpc", "id", "error", "generation"), "response");
        if (!"2.0".equals(frame.get("jsonrpc"))) {
            throw ProtocolException.invalidParams("jsonrpc must be 2.0", "jsonrpc");
        }
        final Object id = requestId(frame.get("id"), "id");
        final long generation = integer(frame.get("generation"), "generation", 0);
        if (success) {
            return new Response(id, true, frame.get("result"), Map.of(), generation);
        }
        return new Response(id, false, null, object(frame.get("error"), "error"), generation);
    }

    private static Map<String, Object> validatedDescriptor(final Map<String, Object> raw) {
        final Map<String, Object> descriptor = object(Json.normalize(raw), "descriptor");
        exact(descriptor, Set.of("protocol", "plugin", "entrypointId", "contributions", "permissions", "hostApis",
                "features"), "descriptor");
        if (!PROTOCOL.equals(descriptor.get("protocol"))) {
            throw ProtocolException.invalidParams("descriptor.protocol must be " + PROTOCOL);
        }
        final Map<String, Object> identity = object(descriptor.get("plugin"), "descriptor.plugin");
        exact(identity, Set.of("id", "name", "version", "publisher"), "descriptor.plugin");
        localId(identity.get("id"), "descriptor.plugin.id");
        string(identity.get("name"), "descriptor.plugin.name", 256);
        string(identity.get("version"), "descriptor.plugin.version", 64);
        localId(identity.get("publisher"), "descriptor.plugin.publisher");
        localId(descriptor.get("entrypointId"), "descriptor.entrypointId");
        final List<Object> contributions = list(descriptor.get("contributions"), "descriptor.contributions");
        if (contributions.isEmpty()) {
            throw ProtocolException.invalidParams("descriptor.contributions must not be empty");
        }
        final Set<String> contributionIds = new HashSet<>();
        for (Object value : contributions) {
            final Map<String, Object> item = object(value, "descriptor.contribution");
            exact(item, Set.of("id", "kind", "title", "entrypoint"), "descriptor.contribution");
            if (!contributionIds.add(localId(item.get("id"), "descriptor.contribution.id"))) {
                throw ProtocolException.invalidParams("descriptor contribution ids must be unique");
            }
            string(item.get("kind"), "descriptor.contribution.kind", 64);
            string(item.get("title"), "descriptor.contribution.title", 256);
            if (!descriptor.get("entrypointId").equals(item.get("entrypoint"))) {
                throw ProtocolException.invalidParams("descriptor contribution belongs to another entrypoint");
            }
        }
        final Map<String, Object> permissions = object(descriptor.get("permissions"), "descriptor.permissions");
        exact(permissions, Set.of("required", "optional"), "descriptor.permissions");
        uniqueStrings(permissions.get("required"), "descriptor.permissions.required");
        uniqueStrings(permissions.get("optional"), "descriptor.permissions.optional");
        final Map<String, Object> hostApis = object(descriptor.get("hostApis"), "descriptor.hostApis");
        exact(hostApis, Set.of("required", "optional"), "descriptor.hostApis");
        uniqueStrings(hostApis.get("required"), "descriptor.hostApis.required");
        uniqueStrings(hostApis.get("optional"), "descriptor.hostApis.optional");
        uniqueStrings(descriptor.get("features"), "descriptor.features");
        return descriptor;
    }

    private static Set<String> descriptorContributions(final Map<String, Object> descriptor) {
        final Set<String> result = new LinkedHashSet<>();
        for (Object value : list(descriptor.get("contributions"), "descriptor.contributions")) {
            result.add((String) object(value, "descriptor.contribution").get("id"));
        }
        return result;
    }

    private static Map<String, Object> validatedRequestContext(final Object raw) {
        final Map<String, Object> context = object(raw, "requestContext");
        exact(context, Set.of("contributionId", "userAction", "generation", "traceId"), "requestContext");
        localId(context.get("contributionId"), "requestContext.contributionId");
        if (!(context.get("userAction") instanceof Boolean)) {
            throw ProtocolException.invalidParams("requestContext.userAction must be a boolean");
        }
        integer(context.get("generation"), "requestContext.generation", 1);
        string(context.get("traceId"), "requestContext.traceId", 128);
        return context;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> object(final Object raw, final String path) {
        if (!(raw instanceof Map<?, ?> map)) {
            throw ProtocolException.invalidParams(path + " must be an object", path);
        }
        for (Object key : map.keySet()) {
            if (!(key instanceof String)) {
                throw ProtocolException.invalidParams(path + " keys must be strings", path);
            }
        }
        return (Map<String, Object>) map;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> list(final Object raw, final String path) {
        if (!(raw instanceof List<?> list)) {
            throw ProtocolException.invalidParams(path + " must be an array", path);
        }
        return (List<Object>) list;
    }

    private static List<String> stringList(final Object raw, final String path, final boolean allowEmpty) {
        final List<Object> values = list(raw, path);
        if (!allowEmpty && values.isEmpty()) {
            throw ProtocolException.invalidParams(path + " must not be empty", path);
        }
        final List<String> result = new ArrayList<>();
        for (Object value : values) {
            result.add(string(value, path + "[]", 256));
        }
        return List.copyOf(result);
    }

    private static void uniqueStrings(final Object raw, final String path) {
        final List<String> values = stringList(raw, path, true);
        if (new HashSet<>(values).size() != values.size()) {
            throw ProtocolException.invalidParams(path + " must be unique", path);
        }
    }

    public static String string(final Object raw, final String path, final int maximum) {
        if (!(raw instanceof String value) || value.isEmpty() || value.length() > maximum) {
            throw ProtocolException.invalidParams(path + " must be a non-empty bounded string", path);
        }
        return value;
    }

    private static String localId(final Object raw, final String path) {
        final String value = string(raw, path, 128);
        if (!LOCAL_ID.matcher(value).matches()) {
            throw ProtocolException.invalidParams(path + " is invalid", path);
        }
        return value;
    }

    public static long integer(final Object raw, final String path, final long minimum) {
        if (!(raw instanceof Long value) || value < minimum) {
            throw ProtocolException.invalidParams(path + " must be an integer >= " + minimum, path);
        }
        return value;
    }

    private static Object requestId(final Object raw, final String path) {
        if (raw instanceof String value && !value.isEmpty()) {
            return value;
        }
        if (raw instanceof Long value && value >= 0) {
            return value;
        }
        throw ProtocolException.invalidParams(path + " must be a non-negative integer or non-empty string", path);
    }

    public static void exact(final Map<String, Object> value, final Set<String> fields, final String path) {
        if (!value.keySet().equals(fields)) {
            final Set<String> missing = new java.util.TreeSet<>(fields);
            missing.removeAll(value.keySet());
            final Set<String> unknown = new java.util.TreeSet<>(value.keySet());
            unknown.removeAll(fields);
            throw ProtocolException.invalidParams(path + " has invalid fields; missing=" + missing + ", unknown="
                    + unknown, path);
        }
    }

    private static ProtocolException error(final int code, final String symbolic, final String message) {
        return new ProtocolException(code, symbolic, message);
    }

    private static ProtocolException error(final int code, final String symbolic, final String message,
            final Map<String, Object> data) {
        return new ProtocolException(code, symbolic, message, data);
    }

    private static Map<String, Object> success(final Object id, final Object result, final long generation) {
        final Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("jsonrpc", "2.0");
        frame.put("id", id);
        frame.put("result", Json.normalize(result));
        frame.put("generation", generation);
        return frame;
    }

    private static Map<String, Object> failure(final Object id, final long generation,
            final ProtocolException exception) {
        final Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("jsonrpc", "2.0");
        frame.put("id", id);
        frame.put("error", exception.toWire());
        frame.put("generation", generation);
        return frame;
    }

    private static Map<String, Object> request(final Object id, final String method, final Map<String, Object> params,
            final long generation) {
        return Map.of("jsonrpc", "2.0", "id", id, "method", method, "params", params, "generation", generation);
    }

    private record Request(Object id, String method, Map<String, Object> params, long generation) {
    }

    private record Response(Object id, boolean success, Object result, Map<String, Object> error, long generation) {
    }

    private record Pending(Object requestId, long generation, String token, Map<String, Object> requestContext,
            String resultPath, Object hostCallId) {
        private Pending withHostCall(final Object next) {
            return new Pending(requestId, generation, token, requestContext, resultPath, next);
        }
    }
}
