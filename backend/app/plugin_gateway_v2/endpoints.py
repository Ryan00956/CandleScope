"""Loopback-only, namespace-owned HTTP endpoint gateway for Phase 9 plugins."""

from __future__ import annotations

import asyncio
import base64
import binascii
import ipaddress
import re
import threading
import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from candlescope_plugin_sdk.platform_v2 import normalize_json

from app.plugin_core_v2.contracts import CoreContribution
from app.plugin_security_v2.audit import AuditLog
from app.plugin_security_v2.errors import security_error
from app.plugin_security_v2.grants import EffectiveGrant


HTTP_ENDPOINT_REQUEST_V1 = "candlescope.http-endpoint-request/1"
HTTP_ENDPOINT_RESPONSE_V1 = "candlescope.http-endpoint-response/1"
_REQUEST_HEADERS = frozenset({"accept", "content-type", "x-candlescope-event-id"})
_RESPONSE_HEADERS = frozenset({"cache-control", "content-type"})
_HEADER_NAME = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_EVENT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_BUFFERED_CONTENT_TYPES = frozenset(
    {
        "application/json",
        "application/json; charset=utf-8",
        "application/octet-stream",
        "text/plain",
        "text/plain; charset=utf-8",
    }
)


EndpointInvoker = Callable[
    [CoreContribution, dict[str, Any], bool, str], Awaitable[dict[str, Any]]
]


@dataclass(frozen=True, slots=True)
class PluginEndpointResponse:
    status: int
    headers: dict[str, str]
    body: bytes | None = None
    event_chunks: tuple[bytes, ...] = ()


@dataclass(frozen=True, slots=True)
class _Registration:
    contribution: CoreContribution
    methods: frozenset[str]
    response_mode: str
    max_request_bytes: int
    max_response_bytes: int
    max_concurrent: int
    rate_per_minute: int


def _bounded_int(value: Any, *, minimum: int, maximum: int, label: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise security_error("PLUGIN_ENDPOINT_SCOPE_INVALID", f"{label} is invalid")
    return value


def _safe_headers(
    value: Mapping[str, str], *, allowed: frozenset[str], label: str
) -> dict[str, str]:
    if len(value) > 32:
        raise security_error(
            "PLUGIN_ENDPOINT_HEADERS_INVALID", f"{label} contains too many headers"
        )
    result: dict[str, str] = {}
    for raw_name, raw_value in value.items():
        if not isinstance(raw_name, str) or not isinstance(raw_value, str):
            raise security_error(
                "PLUGIN_ENDPOINT_HEADERS_INVALID", f"{label} is invalid"
            )
        name = raw_name.lower()
        if (
            name not in allowed
            or _HEADER_NAME.fullmatch(name) is None
            or not raw_value
            or len(raw_value) > 2_048
            or "\r" in raw_value
            or "\n" in raw_value
            or name in result
        ):
            raise security_error(
                "PLUGIN_ENDPOINT_HEADER_DENIED", f"{label} is not allowed"
            )
        result[name] = raw_value
    return result


class PluginHttpEndpointGateway:
    def __init__(
        self,
        audit_log: AuditLog,
        invoke: EndpointInvoker,
        *,
        clock=time.monotonic,
    ) -> None:
        self.audit_log = audit_log
        self.invoke = invoke
        self.clock = clock
        self._lock = threading.RLock()
        self._registrations: dict[str, _Registration] = {}
        self._recent: dict[str, deque[float]] = defaultdict(deque)
        self._active: dict[str, set[asyncio.Task[Any]]] = defaultdict(set)

    @staticmethod
    def _from_grant(
        contribution: CoreContribution, grant: EffectiveGrant
    ) -> _Registration:
        config = contribution.configuration
        scope = grant.scope
        endpoints = scope.get("endpoints")
        methods = scope.get("methods")
        if (
            grant.permission_id != "http.endpoint.serve"
            or not isinstance(endpoints, list)
            or contribution.id not in endpoints
            or not isinstance(methods, list)
            or not set(config["methods"]) <= set(methods)
        ):
            raise security_error(
                "PLUGIN_ENDPOINT_SCOPE_DENIED",
                "HTTP endpoint exceeds its granted namespace scope",
                plugin_id=contribution.plugin_id,
            )
        return _Registration(
            contribution,
            frozenset(config["methods"]),
            config["responseMode"],
            min(
                config["maxRequestBytes"],
                _bounded_int(
                    scope.get("maxRequestBytes"),
                    minimum=0,
                    maximum=128 * 1024,
                    label="maxRequestBytes",
                ),
            ),
            min(
                config["maxResponseBytes"],
                _bounded_int(
                    scope.get("maxResponseBytes"),
                    minimum=1,
                    maximum=128 * 1024,
                    label="maxResponseBytes",
                ),
            ),
            min(
                config["maxConcurrent"],
                _bounded_int(
                    scope.get("maxConcurrent"),
                    minimum=1,
                    maximum=16,
                    label="maxConcurrent",
                ),
            ),
            min(
                config["ratePerMinute"],
                _bounded_int(
                    scope.get("ratePerMinute"),
                    minimum=1,
                    maximum=10_000,
                    label="ratePerMinute",
                ),
            ),
        )

    def register(self, contribution: CoreContribution, grant: EffectiveGrant) -> None:
        registration = self._from_grant(contribution, grant)
        with self._lock:
            self._registrations[contribution.full_id] = registration

    def limits(self, plugin_id: str, endpoint_id: str) -> tuple[int, frozenset[str]]:
        full_id = f"{plugin_id}.{endpoint_id}"
        with self._lock:
            registration = self._registrations.get(full_id)
        if registration is None:
            raise security_error(
                "PLUGIN_ENDPOINT_NOT_FOUND", "plugin HTTP endpoint is unavailable"
            )
        return registration.max_request_bytes, registration.methods

    @staticmethod
    def _loopback(value: str) -> bool:
        try:
            return ipaddress.ip_address(value).is_loopback
        except ValueError:
            return False

    def _reserve(self, registration: _Registration) -> asyncio.Task[Any]:
        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("endpoint invocation requires an asyncio task")
        key = registration.contribution.full_id
        now = self.clock()
        with self._lock:
            recent = self._recent[key]
            while recent and recent[0] <= now - 60.0:
                recent.popleft()
            if len(recent) >= registration.rate_per_minute:
                raise security_error(
                    "PLUGIN_ENDPOINT_RATE_LIMITED",
                    "plugin HTTP endpoint rate limit is exhausted",
                    plugin_id=registration.contribution.plugin_id,
                )
            if len(self._active[key]) >= registration.max_concurrent:
                raise security_error(
                    "PLUGIN_ENDPOINT_CONCURRENCY_EXCEEDED",
                    "plugin HTTP endpoint connection quota is exhausted",
                    plugin_id=registration.contribution.plugin_id,
                )
            recent.append(now)
            self._active[key].add(task)
        return task

    def _release(self, registration: _Registration, task: asyncio.Task[Any]) -> None:
        key = registration.contribution.full_id
        with self._lock:
            self._active[key].discard(task)
            if not self._active[key]:
                self._active.pop(key, None)

    @staticmethod
    def _query(value: Sequence[tuple[str, str]]) -> dict[str, list[str]]:
        result: dict[str, list[str]] = {}
        if len(value) > 64:
            raise security_error(
                "PLUGIN_ENDPOINT_QUERY_INVALID",
                "plugin HTTP endpoint query is too large",
            )
        for key, item in value:
            if not key or len(key) > 128 or len(item) > 2_048:
                raise security_error(
                    "PLUGIN_ENDPOINT_QUERY_INVALID",
                    "plugin HTTP endpoint query is invalid",
                )
            if key not in result and len(result) >= 32:
                raise security_error(
                    "PLUGIN_ENDPOINT_QUERY_INVALID",
                    "plugin HTTP endpoint query is too large",
                )
            values = result.setdefault(key, [])
            if len(values) >= 16:
                raise security_error(
                    "PLUGIN_ENDPOINT_QUERY_INVALID",
                    "plugin HTTP endpoint query is too large",
                )
            values.append(item)
        return result

    @staticmethod
    def _response(value: Any, registration: _Registration) -> PluginEndpointResponse:
        normalized = normalize_json(value, path="endpoint.response")
        if not isinstance(normalized, dict):
            raise security_error(
                "PLUGIN_ENDPOINT_RESPONSE_INVALID",
                "plugin HTTP endpoint response is invalid",
            )
        common = {"schemaVersion", "mode", "status", "headers"}
        mode = normalized.get("mode")
        expected = common | ({"bodyBase64"} if mode == "buffered" else {"events"})
        if (
            set(normalized) != expected
            or normalized.get("schemaVersion") != HTTP_ENDPOINT_RESPONSE_V1
            or mode != registration.response_mode
        ):
            raise security_error(
                "PLUGIN_ENDPOINT_RESPONSE_INVALID",
                "plugin HTTP endpoint response shape is invalid",
            )
        status = normalized["status"]
        if (
            isinstance(status, bool)
            or not isinstance(status, int)
            or not 200 <= status <= 599
        ):
            raise security_error(
                "PLUGIN_ENDPOINT_RESPONSE_INVALID",
                "plugin HTTP endpoint status is invalid",
            )
        raw_headers = normalized["headers"]
        if not isinstance(raw_headers, dict):
            raise security_error(
                "PLUGIN_ENDPOINT_HEADERS_INVALID",
                "plugin HTTP endpoint response headers are invalid",
            )
        headers = _safe_headers(
            raw_headers, allowed=_RESPONSE_HEADERS, label="response headers"
        )
        if mode == "buffered":
            content_type = headers.get("content-type", "application/octet-stream")
            content_type = content_type.strip().lower()
            if content_type not in _BUFFERED_CONTENT_TYPES:
                raise security_error(
                    "PLUGIN_ENDPOINT_CONTENT_TYPE_DENIED",
                    "plugin HTTP endpoint content type is not inert",
                )
            headers["content-type"] = content_type
            encoded = normalized["bodyBase64"]
            if (
                not isinstance(encoded, str)
                or len(encoded) > ((registration.max_response_bytes + 2) // 3) * 4
            ):
                raise security_error(
                    "PLUGIN_ENDPOINT_RESPONSE_TOO_LARGE",
                    "plugin HTTP endpoint response exceeds its byte limit",
                )
            try:
                body = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise security_error(
                    "PLUGIN_ENDPOINT_RESPONSE_INVALID",
                    "plugin HTTP endpoint response body is not canonical base64",
                ) from exc
            if (
                len(body) > registration.max_response_bytes
                or base64.b64encode(body).decode("ascii") != encoded
            ):
                raise security_error(
                    "PLUGIN_ENDPOINT_RESPONSE_TOO_LARGE",
                    "plugin HTTP endpoint response exceeds its byte limit",
                )
            return PluginEndpointResponse(status, headers, body=body)
        if status != 200:
            raise security_error(
                "PLUGIN_ENDPOINT_RESPONSE_INVALID", "event streams must use status 200"
            )
        events = normalized["events"]
        if not isinstance(events, list) or not 1 <= len(events) <= 256:
            raise security_error(
                "PLUGIN_ENDPOINT_RESPONSE_INVALID", "plugin event stream is invalid"
            )
        chunks: list[bytes] = []
        total = 0
        for raw in events:
            if not isinstance(raw, dict) or not {"event", "data"} <= set(raw) <= {
                "event",
                "data",
                "id",
            }:
                raise security_error(
                    "PLUGIN_ENDPOINT_RESPONSE_INVALID",
                    "plugin event stream item is invalid",
                )
            event = raw["event"]
            data = raw["data"]
            event_id = raw.get("id")
            if (
                not isinstance(event, str)
                or _EVENT_NAME.fullmatch(event) is None
                or not isinstance(data, str)
                or len(data) > 8_192
                or "\r" in data
                or (
                    event_id is not None
                    and (
                        not isinstance(event_id, str)
                        or "\n" in event_id
                        or "\r" in event_id
                        or len(event_id) > 128
                    )
                )
            ):
                raise security_error(
                    "PLUGIN_ENDPOINT_RESPONSE_INVALID",
                    "plugin event stream item is invalid",
                )
            lines = [f"event: {event}\n"]
            if event_id is not None:
                lines.append(f"id: {event_id}\n")
            for line in data.split("\n"):
                lines.append(f"data: {line}\n")
            lines.append("\n")
            chunk = "".join(lines).encode("utf-8")
            total += len(chunk)
            if total > registration.max_response_bytes:
                raise security_error(
                    "PLUGIN_ENDPOINT_RESPONSE_TOO_LARGE",
                    "plugin event stream exceeds its byte limit",
                )
            chunks.append(chunk)
        return PluginEndpointResponse(
            200,
            {"content-type": "text/event-stream; charset=utf-8"},
            event_chunks=tuple(chunks),
        )

    async def handle(
        self,
        *,
        plugin_id: str,
        endpoint_id: str,
        remote_host: str,
        method: str,
        headers: Mapping[str, str],
        query: Sequence[tuple[str, str]],
        body: bytes,
        trace_id: str,
    ) -> PluginEndpointResponse:
        full_id = f"{plugin_id}.{endpoint_id}"
        with self._lock:
            registration = self._registrations.get(full_id)
        if registration is None or not self._loopback(remote_host):
            raise security_error(
                "PLUGIN_ENDPOINT_NOT_FOUND", "plugin HTTP endpoint is unavailable"
            )
        method = method.upper()
        if method not in registration.methods:
            raise security_error(
                "PLUGIN_ENDPOINT_METHOD_DENIED",
                "plugin HTTP endpoint method is not allowed",
                plugin_id=plugin_id,
            )
        if len(body) > registration.max_request_bytes:
            raise security_error(
                "PLUGIN_ENDPOINT_REQUEST_TOO_LARGE",
                "plugin HTTP endpoint request exceeds its byte limit",
                plugin_id=plugin_id,
            )
        task = self._reserve(registration)
        started = self.clock()
        outcome = "error"
        status = 0
        response_bytes = 0
        try:
            safe_headers = _safe_headers(
                headers, allowed=_REQUEST_HEADERS, label="request headers"
            )
            payload = {
                "schemaVersion": HTTP_ENDPOINT_REQUEST_V1,
                "method": method,
                "headers": safe_headers,
                "query": self._query(query),
                "bodyBase64": base64.b64encode(body).decode("ascii"),
            }
            result = await self.invoke(
                registration.contribution, payload, False, trace_id
            )
            response = self._response(result, registration)
            status = response.status
            response_bytes = (
                len(response.body)
                if response.body is not None
                else sum(len(item) for item in response.event_chunks)
            )
            outcome = "allowed"
            return response
        except asyncio.CancelledError:
            outcome = "denied"
            raise security_error(
                "PLUGIN_ENDPOINT_REVOKED",
                "plugin HTTP endpoint closed after disable or permission revocation",
                plugin_id=plugin_id,
            )
        finally:
            self._release(registration, task)
            self.audit_log.append(
                category="gateway",
                action="http.endpoint",
                outcome=outcome,
                trace_id=trace_id,
                plugin_id=plugin_id,
                data={
                    "contributionId": endpoint_id,
                    "method": method,
                    "status": status,
                    "requestBytes": len(body),
                    "responseBytes": response_bytes,
                    "durationMicros": max(0, int((self.clock() - started) * 1_000_000)),
                },
            )

    async def clear_plugin(self, plugin_id: str) -> None:
        tasks: set[asyncio.Task[Any]] = set()
        with self._lock:
            for key in tuple(self._registrations):
                if self._registrations[key].contribution.plugin_id == plugin_id:
                    self._registrations.pop(key, None)
                    self._recent.pop(key, None)
                    tasks.update(self._active.get(key, ()))
        current = asyncio.current_task()
        targets = [task for task in tasks if task is not current and not task.done()]
        for task in targets:
            task.cancel()
        if targets:
            await asyncio.gather(*targets, return_exceptions=True)

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {
                "registrations": len(self._registrations),
                "activeRequests": sum(len(items) for items in self._active.values()),
                "rateBuckets": len(self._recent),
            }

    async def close(self) -> None:
        plugin_ids = {
            item.contribution.plugin_id for item in self._registrations.values()
        }
        for plugin_id in sorted(plugin_ids):
            await self.clear_plugin(plugin_id)
