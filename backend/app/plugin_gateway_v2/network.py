"""Pinned-DNS HTTPS proxy for the Phase 9 network.connect capability."""

from __future__ import annotations

import asyncio
import base64
import binascii
import http.client
import ipaddress
import re
import socket
import ssl
import threading
import time
from collections import defaultdict, deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urljoin, urlsplit, urlunsplit

from candlescope_plugin_sdk.platform_v2 import HostCallRequest

from app.plugin_security_v2.audit import AuditLog
from app.plugin_security_v2.capabilities import CapabilityLease
from app.plugin_security_v2.errors import PlatformSecurityError, security_error


MAX_HTTP_BODY_BYTES = 128 * 1024
MAX_HTTP_HEADER_BYTES = 32 * 1024
MAX_HTTP_HEADERS = 64
_REQUEST_HEADERS = frozenset(
    {"accept", "content-type", "if-modified-since", "if-none-match"}
)
_RESPONSE_HEADERS = frozenset(
    {"cache-control", "content-type", "etag", "last-modified"}
)
_HEADER_NAME = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


@dataclass(frozen=True, slots=True)
class PinnedHttpRequest:
    method: str
    host: str
    port: int
    target: str
    headers: dict[str, str]
    body: bytes


@dataclass(frozen=True, slots=True)
class PinnedHttpResponse:
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes


class ConnectionControl:
    """Allow revocation to abort one blocking socket operation."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._socket: socket.socket | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task[Any] | None = None
        self._cancelled = False

    @property
    def cancelled(self) -> bool:
        with self._lock:
            return self._cancelled

    def attach(self, value: socket.socket) -> None:
        with self._lock:
            if self._cancelled:
                value.close()
                raise OSError("network request was revoked")
            self._socket = value

    def bind_current_task(self) -> None:
        loop = asyncio.get_running_loop()
        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("network request requires an asyncio task")
        with self._lock:
            if self._cancelled:
                task.cancel()
            self._loop = loop
            self._task = task

    def detach(self) -> None:
        with self._lock:
            self._socket = None

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True
            value = self._socket
            self._socket = None
            loop = self._loop
            task = self._task
        if value is not None:
            try:
                value.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            value.close()
        if loop is not None and task is not None and not task.done():
            loop.call_soon_threadsafe(task.cancel)


class HttpTransport(Protocol):
    def request(
        self,
        request: PinnedHttpRequest,
        *,
        resolved_ip: str,
        timeout_seconds: float,
        max_response_bytes: int,
        control: ConnectionControl,
    ) -> PinnedHttpResponse: ...


class _PinnedHttpsConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        host: str,
        port: int,
        *,
        resolved_ip: str,
        timeout: float,
        control: ConnectionControl,
    ) -> None:
        super().__init__(
            host, port, timeout=timeout, context=ssl.create_default_context()
        )
        self._resolved_ip = resolved_ip
        self._control = control

    def connect(self) -> None:
        raw = socket.create_connection((self._resolved_ip, self.port), self.timeout)
        self._control.attach(raw)
        try:
            tls = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            self._control.detach()
            raise
        self._control.attach(tls)
        self.sock = tls


class PinnedHttpsTransport:
    """HTTP/1.1 transport that never resolves the validated hostname again."""

    def request(
        self,
        request: PinnedHttpRequest,
        *,
        resolved_ip: str,
        timeout_seconds: float,
        max_response_bytes: int,
        control: ConnectionControl,
    ) -> PinnedHttpResponse:
        connection = _PinnedHttpsConnection(
            request.host,
            request.port,
            resolved_ip=resolved_ip,
            timeout=timeout_seconds,
            control=control,
        )
        try:
            headers = {
                **request.headers,
                "accept-encoding": "identity",
                "connection": "close",
                "user-agent": "CandleScope-Plugin-Gateway/1",
            }
            connection.request(
                request.method,
                request.target,
                body=request.body if request.body else None,
                headers=headers,
            )
            response = connection.getresponse()
            raw_headers = tuple(
                (key.lower(), value) for key, value in response.getheaders()
            )
            header_bytes = sum(
                len(key.encode("ascii", "ignore")) + len(value.encode("utf-8")) + 4
                for key, value in raw_headers
            )
            if (
                len(raw_headers) > MAX_HTTP_HEADERS
                or header_bytes > MAX_HTTP_HEADER_BYTES
            ):
                raise security_error(
                    "PLUGIN_NETWORK_RESPONSE_HEADERS_EXCEEDED",
                    "network response headers exceed the Host limit",
                )
            encoding = response.getheader("content-encoding")
            if encoding is not None and encoding.lower().strip() not in {
                "",
                "identity",
            }:
                raise security_error(
                    "PLUGIN_NETWORK_CONTENT_ENCODING_DENIED",
                    "compressed network responses are not accepted by this gateway",
                )
            content_length = response.getheader("content-length")
            if content_length is not None:
                try:
                    length = int(content_length)
                    if length < 0:
                        raise ValueError
                    if length > max_response_bytes:
                        raise security_error(
                            "PLUGIN_NETWORK_RESPONSE_TOO_LARGE",
                            "network response exceeds the granted byte limit",
                        )
                except ValueError as exc:
                    raise security_error(
                        "PLUGIN_NETWORK_RESPONSE_INVALID",
                        "network response Content-Length is invalid",
                    ) from exc
            body = response.read(max_response_bytes + 1)
            if len(body) > max_response_bytes:
                raise security_error(
                    "PLUGIN_NETWORK_RESPONSE_TOO_LARGE",
                    "network response exceeds the granted byte limit",
                )
            return PinnedHttpResponse(response.status, raw_headers, body)
        finally:
            connection.close()
            control.detach()


Resolver = Callable[[str, int], tuple[str, ...]]


def resolve_public_addresses(host: str, port: int) -> tuple[str, ...]:
    try:
        values = {
            item[4][0]
            for item in socket.getaddrinfo(
                host,
                port,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
                proto=socket.IPPROTO_TCP,
            )
        }
    except OSError as exc:
        raise security_error(
            "PLUGIN_NETWORK_DNS_FAILED", "network hostname could not be resolved"
        ) from exc
    if not values:
        raise security_error(
            "PLUGIN_NETWORK_DNS_FAILED", "network hostname resolved to no addresses"
        )
    addresses: list[str] = []
    for value in sorted(values):
        try:
            address = ipaddress.ip_address(value)
        except ValueError as exc:
            raise security_error(
                "PLUGIN_NETWORK_DNS_INVALID",
                "network hostname returned an invalid address",
            ) from exc
        if not address.is_global:
            raise security_error(
                "PLUGIN_NETWORK_PRIVATE_ADDRESS_DENIED",
                "network hostname resolved to a non-public address",
            )
        addresses.append(address.compressed)
    return tuple(addresses)


@dataclass(frozen=True, slots=True)
class _Target:
    url: str
    host: str
    port: int
    target: str


def _target(value: Any) -> _Target:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 2_048
        or any(ord(char) < 0x20 or char.isspace() for char in value)
    ):
        raise security_error("PLUGIN_NETWORK_URL_INVALID", "network URL is invalid")
    try:
        parsed = urlsplit(value)
        port = parsed.port or 443
    except ValueError as exc:
        raise security_error(
            "PLUGIN_NETWORK_URL_INVALID", "network URL is invalid"
        ) from exc
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or not 1 <= port <= 65535
    ):
        raise security_error(
            "PLUGIN_NETWORK_URL_DENIED", "only credential-free HTTPS URLs are supported"
        )
    try:
        host = parsed.hostname.encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise security_error(
            "PLUGIN_NETWORK_URL_INVALID", "network hostname is invalid"
        ) from exc
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise security_error(
            "PLUGIN_NETWORK_BARE_IP_DENIED", "network URLs cannot use a bare IP address"
        )
    path = parsed.path or "/"
    target = urlunsplit(("", "", path, parsed.query, ""))
    canonical_port = "" if port == 443 else f":{port}"
    canonical = urlunsplit(("https", f"{host}{canonical_port}", path, parsed.query, ""))
    return _Target(canonical, host, port, target)


def _params(call: HostCallRequest) -> tuple[str, _Target, dict[str, str], bytes]:
    value = dict(call.params)
    if set(value) != {"method", "url", "headers", "bodyBase64"}:
        raise security_error(
            "PLUGIN_NETWORK_PARAMS_INVALID",
            "network request parameters have an invalid shape",
        )
    method = value["method"]
    if not isinstance(method, str) or method.upper() not in {"GET", "POST"}:
        raise security_error(
            "PLUGIN_NETWORK_METHOD_DENIED", "network method is unsupported"
        )
    method = method.upper()
    target = _target(value["url"])
    raw_headers = value["headers"]
    if not isinstance(raw_headers, Mapping) or len(raw_headers) > 16:
        raise security_error(
            "PLUGIN_NETWORK_HEADERS_INVALID", "network request headers are invalid"
        )
    headers: dict[str, str] = {}
    for raw_name, raw_value in raw_headers.items():
        if not isinstance(raw_name, str) or not isinstance(raw_value, str):
            raise security_error(
                "PLUGIN_NETWORK_HEADERS_INVALID", "network request headers are invalid"
            )
        name = raw_name.lower()
        if (
            name not in _REQUEST_HEADERS
            or _HEADER_NAME.fullmatch(name) is None
            or not raw_value
            or len(raw_value) > 2_048
            or "\r" in raw_value
            or "\n" in raw_value
            or name in headers
        ):
            raise security_error(
                "PLUGIN_NETWORK_HEADER_DENIED", "network request header is not allowed"
            )
        headers[name] = raw_value
    encoded = value["bodyBase64"]
    if (
        not isinstance(encoded, str)
        or len(encoded) > ((MAX_HTTP_BODY_BYTES + 2) // 3) * 4
    ):
        raise security_error(
            "PLUGIN_NETWORK_BODY_INVALID",
            "network request body exceeds its encoded limit",
        )
    try:
        body = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise security_error(
            "PLUGIN_NETWORK_BODY_INVALID",
            "network request body is not canonical base64",
        ) from exc
    if (
        len(body) > MAX_HTTP_BODY_BYTES
        or base64.b64encode(body).decode("ascii") != encoded
    ):
        raise security_error(
            "PLUGIN_NETWORK_BODY_INVALID", "network request body exceeds its byte limit"
        )
    if method == "GET" and body:
        raise security_error(
            "PLUGIN_NETWORK_BODY_DENIED", "GET requests cannot contain a body"
        )
    return method, target, headers, body


def network_required_scope(params: dict[str, Any]) -> dict[str, Any]:
    call = HostCallRequest(
        "scope-only", "network.http.request", params, _scope_context()
    )
    method, target, _headers_value, _body = _params(call)
    return {
        "schemes": ["https"],
        "domains": [target.host],
        "ports": [target.port],
        "methods": [method],
    }


def _scope_context():
    from candlescope_plugin_sdk.platform_v2 import RequestContext

    return RequestContext("scope", True, 1, "scope-extractor")


class HostHttpGateway:
    def __init__(
        self,
        audit_log: AuditLog,
        *,
        resolver: Resolver = resolve_public_addresses,
        transport: HttpTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        timeout_seconds: float = 10.0,
        max_global_concurrent: int = 32,
    ) -> None:
        self.audit_log = audit_log
        self.resolver = resolver
        self.transport = transport or PinnedHttpsTransport()
        self.clock = clock
        self.timeout_seconds = timeout_seconds
        self.max_global_concurrent = max_global_concurrent
        self._lock = threading.RLock()
        self._recent: dict[str, deque[float]] = defaultdict(deque)
        self._active: dict[str, int] = defaultdict(int)
        self._controls: dict[str, set[ConnectionControl]] = defaultdict(set)

    @staticmethod
    def _scope_limits(lease: CapabilityLease) -> tuple[int, int, int, int, int]:
        values = []
        for key, default, minimum, maximum in (
            ("maxRequestBytes", 0, 0, MAX_HTTP_BODY_BYTES),
            ("maxResponseBytes", MAX_HTTP_BODY_BYTES, 1, MAX_HTTP_BODY_BYTES),
            ("maxRedirects", 0, 0, 8),
            ("maxConcurrent", 1, 1, 16),
            ("ratePerMinute", 60, 1, 10_000),
        ):
            value = lease.scope.get(key, default)
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not minimum <= value <= maximum
            ):
                raise security_error(
                    "PLUGIN_NETWORK_SCOPE_INVALID",
                    "network capability scope contains an invalid limit",
                    plugin_id=lease.plugin_id,
                )
            values.append(value)
        return values[0], values[1], values[2], values[3], values[4]

    @staticmethod
    def _scope_allows(lease: CapabilityLease, method: str, target: _Target) -> bool:
        return (
            lease.scope.get("schemes") == ["https"]
            and isinstance(lease.scope.get("domains"), list)
            and target.host in lease.scope["domains"]
            and isinstance(lease.scope.get("ports"), list)
            and target.port in lease.scope["ports"]
            and isinstance(lease.scope.get("methods"), list)
            and method in lease.scope["methods"]
        )

    @staticmethod
    def _validated_response(
        response: Any, *, maximum: int, plugin_id: str
    ) -> PinnedHttpResponse:
        if (
            not isinstance(response, PinnedHttpResponse)
            or isinstance(response.status, bool)
            or not isinstance(response.status, int)
            or not 100 <= response.status <= 599
            or not isinstance(response.headers, tuple)
            or len(response.headers) > MAX_HTTP_HEADERS
            or not isinstance(response.body, bytes)
            or len(response.body) > maximum
        ):
            raise security_error(
                "PLUGIN_NETWORK_RESPONSE_INVALID",
                "network transport returned an invalid bounded response",
                plugin_id=plugin_id,
            )
        header_bytes = 0
        headers: list[tuple[str, str]] = []
        for item in response.headers:
            if (
                not isinstance(item, tuple)
                or len(item) != 2
                or not all(isinstance(value, str) for value in item)
            ):
                raise security_error(
                    "PLUGIN_NETWORK_RESPONSE_INVALID",
                    "network transport returned invalid response headers",
                    plugin_id=plugin_id,
                )
            name, value = item
            if (
                name != name.lower()
                or _HEADER_NAME.fullmatch(name) is None
                or not value
                or len(value) > 8_192
                or "\r" in value
                or "\n" in value
            ):
                raise security_error(
                    "PLUGIN_NETWORK_RESPONSE_INVALID",
                    "network transport returned invalid response headers",
                    plugin_id=plugin_id,
                )
            header_bytes += len(name.encode("ascii")) + len(value.encode("utf-8")) + 4
            headers.append((name, value))
        if header_bytes > MAX_HTTP_HEADER_BYTES:
            raise security_error(
                "PLUGIN_NETWORK_RESPONSE_HEADERS_EXCEEDED",
                "network response headers exceed the Host limit",
                plugin_id=plugin_id,
            )
        return PinnedHttpResponse(response.status, tuple(headers), response.body)

    def _reserve(
        self, lease: CapabilityLease, maximum: int, rate: int
    ) -> ConnectionControl:
        now = self.clock()
        fingerprint = lease.handle_fingerprint
        with self._lock:
            recent = self._recent[fingerprint]
            while recent and recent[0] <= now - 60.0:
                recent.popleft()
            if len(recent) >= rate:
                raise security_error(
                    "PLUGIN_NETWORK_RATE_LIMITED",
                    "network capability rate limit is exhausted",
                    plugin_id=lease.plugin_id,
                )
            if (
                self._active[fingerprint] >= maximum
                or sum(self._active.values()) >= self.max_global_concurrent
            ):
                raise security_error(
                    "PLUGIN_NETWORK_CONCURRENCY_EXCEEDED",
                    "network connection quota is exhausted",
                    plugin_id=lease.plugin_id,
                )
            control = ConnectionControl()
            recent.append(now)
            self._active[fingerprint] += 1
            self._controls[fingerprint].add(control)
            return control

    def _release(self, lease: CapabilityLease, control: ConnectionControl) -> None:
        fingerprint = lease.handle_fingerprint
        with self._lock:
            self._controls[fingerprint].discard(control)
            if not self._controls[fingerprint]:
                self._controls.pop(fingerprint, None)
            if self._active[fingerprint] > 0:
                self._active[fingerprint] -= 1
            if self._active[fingerprint] == 0:
                self._active.pop(fingerprint, None)

    async def request(
        self, call: HostCallRequest, lease: CapabilityLease
    ) -> dict[str, Any]:
        method, first_target, headers, body = _params(call)
        max_request, max_response, max_redirects, max_concurrent, rate = (
            self._scope_limits(lease)
        )
        if len(body) > max_request:
            raise security_error(
                "PLUGIN_NETWORK_REQUEST_TOO_LARGE",
                "network request exceeds the granted byte limit",
                plugin_id=lease.plugin_id,
            )
        control = self._reserve(lease, max_concurrent, rate)
        control.bind_current_task()
        started = self.clock()
        target = first_target
        redirects = 0
        request_bytes = len(body)
        outcome = "error"
        status = 0
        response_bytes = 0
        try:
            while True:
                if not self._scope_allows(lease, method, target):
                    raise security_error(
                        "PLUGIN_NETWORK_SCOPE_DENIED",
                        "network target exceeds the granted origin scope",
                        plugin_id=lease.plugin_id,
                    )
                addresses = await asyncio.to_thread(
                    self.resolver, target.host, target.port
                )
                if not addresses:
                    raise security_error(
                        "PLUGIN_NETWORK_DNS_FAILED",
                        "network hostname resolved to no addresses",
                        plugin_id=lease.plugin_id,
                    )
                try:
                    parsed_addresses = tuple(
                        ipaddress.ip_address(item) for item in addresses
                    )
                except (TypeError, ValueError) as exc:
                    raise security_error(
                        "PLUGIN_NETWORK_DNS_INVALID",
                        "network hostname returned an invalid address",
                        plugin_id=lease.plugin_id,
                    ) from exc
                if any(not item.is_global for item in parsed_addresses):
                    raise security_error(
                        "PLUGIN_NETWORK_PRIVATE_ADDRESS_DENIED",
                        "network hostname resolved to a non-public address",
                        plugin_id=lease.plugin_id,
                    )
                raw_response = await asyncio.to_thread(
                    self.transport.request,
                    PinnedHttpRequest(
                        method, target.host, target.port, target.target, headers, body
                    ),
                    resolved_ip=parsed_addresses[0].compressed,
                    timeout_seconds=self.timeout_seconds,
                    max_response_bytes=max_response,
                    control=control,
                )
                if control.cancelled:
                    raise security_error(
                        "PLUGIN_NETWORK_REVOKED",
                        "network request was closed after capability revocation",
                        plugin_id=lease.plugin_id,
                    )
                response = self._validated_response(
                    raw_response,
                    maximum=max_response,
                    plugin_id=lease.plugin_id,
                )
                status = response.status
                location = next(
                    (value for key, value in response.headers if key == "location"),
                    None,
                )
                if status not in {301, 302, 303, 307, 308} or location is None:
                    filtered = {
                        key: value
                        for key, value in response.headers
                        if key in _RESPONSE_HEADERS
                    }
                    outcome = "allowed"
                    response_bytes = len(response.body)
                    return {
                        "status": status,
                        "headers": filtered,
                        "bodyBase64": base64.b64encode(response.body).decode("ascii"),
                        "redirects": redirects,
                    }
                if redirects >= max_redirects:
                    raise security_error(
                        "PLUGIN_NETWORK_REDIRECT_DENIED",
                        "network redirect limit is exhausted",
                        plugin_id=lease.plugin_id,
                    )
                target = _target(urljoin(target.url, location))
                redirects += 1
                if status == 303 or (status in {301, 302} and method == "POST"):
                    method = "GET"
                    body = b""
                    headers.pop("content-type", None)
        except asyncio.CancelledError as exc:
            revoked = control.cancelled
            if not revoked:
                control.cancel()
            if revoked:
                outcome = "denied"
                raise security_error(
                    "PLUGIN_NETWORK_REVOKED",
                    "network request was closed after capability revocation",
                    plugin_id=lease.plugin_id,
                ) from exc
            raise
        except PlatformSecurityError:
            outcome = "denied"
            raise
        except Exception as exc:
            if control.cancelled:
                outcome = "denied"
                raise security_error(
                    "PLUGIN_NETWORK_REVOKED",
                    "network request was closed after capability revocation",
                    plugin_id=lease.plugin_id,
                ) from exc
            raise security_error(
                "PLUGIN_NETWORK_FAILED",
                "network request failed without exposing transport details",
                plugin_id=lease.plugin_id,
            ) from exc
        finally:
            self._release(lease, control)
            self.audit_log.append(
                category="gateway",
                action="network.http",
                outcome=outcome,
                trace_id=call.request_context.trace_id,
                plugin_id=lease.plugin_id,
                data={
                    "method": method,
                    "origin": f"https://{first_target.host}:{first_target.port}",
                    "status": status,
                    "requestBytes": request_bytes,
                    "responseBytes": response_bytes,
                    "redirects": redirects,
                    "durationMicros": max(0, int((self.clock() - started) * 1_000_000)),
                },
            )

    def revoke_leases(self, leases: tuple[CapabilityLease, ...], reason: str) -> None:
        del reason
        controls: list[ConnectionControl] = []
        with self._lock:
            for lease in leases:
                controls.extend(self._controls.pop(lease.handle_fingerprint, ()))
                self._recent.pop(lease.handle_fingerprint, None)
        for control in controls:
            control.cancel()

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {
                "activeConnections": sum(self._active.values()),
                "activeLeases": len(self._controls),
                "rateBuckets": len(self._recent),
            }

    def close(self) -> None:
        controls: list[ConnectionControl] = []
        with self._lock:
            for values in self._controls.values():
                controls.extend(values)
            self._controls.clear()
            self._recent.clear()
        for control in controls:
            control.cancel()
