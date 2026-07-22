"""Typed Phase 9 contracts for Host-mediated external integration."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from dataclasses import dataclass, field
from typing import Any

from .errors import contract_error
from .json_codec import normalize_json


HOST_HTTP_REQUEST_METHOD = "network.http.request"
USER_FILE_READ_METHOD = "filesystem.user-selected.read"
USER_FILE_WRITE_METHOD = "filesystem.user-selected.write"
HTTP_ENDPOINT_REQUEST_V1 = "candlescope.http-endpoint-request/1"
HTTP_ENDPOINT_RESPONSE_V1 = "candlescope.http-endpoint-response/1"
DEFAULT_MAX_INTEGRATION_BODY_BYTES = 128 * 1024
_HEADER_NAME = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$")
_MEDIA_TYPE = re.compile(r"^[a-z0-9][a-z0-9.+-]{0,63}/[a-z0-9][a-z0-9.+-]{0,63}$")
_DOWNLOAD_ID = re.compile(r"^ufd_[A-Za-z0-9_-]{40,128}$")
_HTTP_REQUEST_HEADERS = frozenset({"accept", "content-type", "if-modified-since", "if-none-match"})
_HTTP_RESPONSE_HEADERS = frozenset({"cache-control", "content-type", "etag", "last-modified"})
_ENDPOINT_REQUEST_HEADERS = frozenset({"accept", "content-type", "x-candlescope-event-id"})
_ENDPOINT_RESPONSE_HEADERS = frozenset({"cache-control", "content-type"})


def _exact(value: Any, expected: set[str], path: str) -> dict[str, Any]:
    normalized = normalize_json(value, path=path)
    if not isinstance(normalized, dict) or set(normalized) != expected:
        raise contract_error(f"{path} has an invalid shape", path=path)
    return normalized


def _string(value: Any, path: str, *, maximum: int) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or len(value) > maximum:
        raise contract_error(f"{path} must be a bounded non-empty string", path=path)
    return value


def _file_name(value: Any, path: str) -> str:
    if not isinstance(value, str) or _FILE_NAME.fullmatch(value) is None or value in {".", ".."}:
        raise contract_error(f"{path} is invalid", path=path)
    return value


def _media_type(value: Any, path: str) -> str:
    if not isinstance(value, str) or value != value.lower() or _MEDIA_TYPE.fullmatch(value) is None:
        raise contract_error(f"{path} is invalid", path=path)
    return value


def _download_id(value: Any) -> str:
    if not isinstance(value, str) or _DOWNLOAD_ID.fullmatch(value) is None:
        raise contract_error(
            "file.write.response.downloadId is invalid",
            path="file.write.response.downloadId",
        )
    return value


def _headers(value: Any, path: str, *, allowed: frozenset[str]) -> dict[str, str]:
    normalized = normalize_json(value, path=path)
    if (
        not isinstance(normalized, dict)
        or len(normalized) > 32
        or not all(
            isinstance(key, str)
            and isinstance(item, str)
            and key == key.lower()
            and _HEADER_NAME.fullmatch(key) is not None
            and key in allowed
            and 0 < len(item) <= 2_048
            and "\r" not in item
            and "\n" not in item
            for key, item in normalized.items()
        )
    ):
        raise contract_error(f"{path} contains invalid headers", path=path)
    return dict(normalized)


def encode_body(value: bytes, *, maximum: int = DEFAULT_MAX_INTEGRATION_BODY_BYTES) -> str:
    if not isinstance(value, bytes) or len(value) > maximum:
        raise contract_error("integration body exceeds its byte limit", path="body")
    return base64.b64encode(value).decode("ascii")


def decode_body(
    value: Any,
    *,
    path: str,
    maximum: int = DEFAULT_MAX_INTEGRATION_BODY_BYTES,
) -> bytes:
    if not isinstance(value, str) or len(value) > ((maximum + 2) // 3) * 4:
        raise contract_error(f"{path} exceeds its encoded byte limit", path=path)
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise contract_error(f"{path} is not canonical base64", path=path) from exc
    if len(decoded) > maximum or base64.b64encode(decoded).decode("ascii") != value:
        raise contract_error(f"{path} exceeds its decoded byte limit", path=path)
    return decoded


@dataclass(frozen=True, slots=True)
class HostHttpRequest:
    method: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    def __post_init__(self) -> None:
        method = _string(self.method, "http.method", maximum=16).upper()
        if method not in {"GET", "POST"}:
            raise contract_error("http.method is unsupported", path="http.method")
        object.__setattr__(self, "method", method)
        object.__setattr__(self, "url", _string(self.url, "http.url", maximum=2_048))
        object.__setattr__(
            self,
            "headers",
            _headers(
                self.headers,
                "http.headers",
                allowed=_HTTP_REQUEST_HEADERS,
            ),
        )
        if not isinstance(self.body, bytes) or len(self.body) > DEFAULT_MAX_INTEGRATION_BODY_BYTES:
            raise contract_error("http.body exceeds its byte limit", path="http.body")
        if method == "GET" and self.body:
            raise contract_error("GET requests cannot contain a body", path="http.body")

    def to_host_params(self) -> dict[str, Any]:
        return {
            "method": self.method,
            "url": self.url,
            "headers": dict(self.headers),
            "bodyBase64": encode_body(self.body),
        }


@dataclass(frozen=True, slots=True)
class HostHttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes
    redirects: int

    @classmethod
    def from_wire(cls, value: Any) -> "HostHttpResponse":
        data = _exact(
            value,
            {"status", "headers", "bodyBase64", "redirects"},
            "http.response",
        )
        status = data["status"]
        redirects = data["redirects"]
        if (
            isinstance(status, bool)
            or not isinstance(status, int)
            or not 100 <= status <= 599
            or isinstance(redirects, bool)
            or not isinstance(redirects, int)
            or not 0 <= redirects <= 8
        ):
            raise contract_error("http.response status is invalid", path="http.response")
        return cls(
            status,
            _headers(
                data["headers"],
                "http.response.headers",
                allowed=_HTTP_RESPONSE_HEADERS,
            ),
            decode_body(data["bodyBase64"], path="http.response.bodyBase64"),
            redirects,
        )


@dataclass(frozen=True, slots=True)
class UserFileReadRequest:
    handle: str

    def to_host_params(self) -> dict[str, str]:
        return {"handle": _string(self.handle, "file.handle", maximum=256)}


@dataclass(frozen=True, slots=True)
class UserFileReadResponse:
    name: str
    media_type: str
    size: int
    sha256: str
    body: bytes

    @classmethod
    def from_wire(cls, value: Any) -> "UserFileReadResponse":
        data = _exact(
            value,
            {"name", "mediaType", "size", "sha256", "bodyBase64"},
            "file.read.response",
        )
        body = decode_body(data["bodyBase64"], path="file.read.response.bodyBase64")
        if (
            isinstance(data["size"], bool)
            or not isinstance(data["size"], int)
            or data["size"] != len(body)
            or not isinstance(data["sha256"], str)
            or _SHA256.fullmatch(data["sha256"]) is None
            or data["sha256"] != "sha256:" + hashlib.sha256(body).hexdigest()
        ):
            raise contract_error(
                "file.read.response metadata is invalid", path="file.read.response"
            )
        return cls(
            _file_name(data["name"], "file.read.response.name"),
            _media_type(data["mediaType"], "file.read.response.mediaType"),
            data["size"],
            data["sha256"],
            body,
        )


@dataclass(frozen=True, slots=True)
class UserFileWriteRequest:
    handle: str
    body: bytes

    def to_host_params(self) -> dict[str, str]:
        return {
            "handle": _string(self.handle, "file.handle", maximum=256),
            "bodyBase64": encode_body(self.body),
        }


@dataclass(frozen=True, slots=True)
class UserFileWriteReceipt:
    download_id: str
    name: str
    media_type: str
    size: int
    sha256: str

    @classmethod
    def from_wire(cls, value: Any) -> "UserFileWriteReceipt":
        data = _exact(
            value,
            {"downloadId", "name", "mediaType", "size", "sha256"},
            "file.write.response",
        )
        if (
            isinstance(data["size"], bool)
            or not isinstance(data["size"], int)
            or not 0 <= data["size"] <= DEFAULT_MAX_INTEGRATION_BODY_BYTES
            or not isinstance(data["sha256"], str)
            or _SHA256.fullmatch(data["sha256"]) is None
        ):
            raise contract_error(
                "file.write.response metadata is invalid", path="file.write.response"
            )
        return cls(
            _download_id(data["downloadId"]),
            _file_name(data["name"], "file.write.response.name"),
            _media_type(data["mediaType"], "file.write.response.mediaType"),
            data["size"],
            data["sha256"],
        )


@dataclass(frozen=True, slots=True)
class HttpEndpointRequest:
    method: str
    headers: dict[str, str]
    query: dict[str, tuple[str, ...]]
    body: bytes

    @classmethod
    def from_invoke(cls, value: Any) -> "HttpEndpointRequest":
        data = _exact(
            value,
            {"schemaVersion", "method", "headers", "query", "bodyBase64"},
            "endpoint.request",
        )
        if data["schemaVersion"] != HTTP_ENDPOINT_REQUEST_V1:
            raise contract_error("endpoint request schema is unsupported", path="endpoint.request")
        method = _string(data["method"], "endpoint.request.method", maximum=16).upper()
        if method not in {"GET", "POST"}:
            raise contract_error(
                "endpoint request method is unsupported",
                path="endpoint.request.method",
            )
        raw_query = normalize_json(data["query"], path="endpoint.request.query")
        if not isinstance(raw_query, dict) or len(raw_query) > 32:
            raise contract_error("endpoint request query is invalid", path="endpoint.request.query")
        query: dict[str, tuple[str, ...]] = {}
        for key, items in raw_query.items():
            if (
                not isinstance(key, str)
                or not key
                or len(key) > 128
                or not isinstance(items, list)
                or len(items) > 16
                or not all(isinstance(item, str) and len(item) <= 2_048 for item in items)
            ):
                raise contract_error(
                    "endpoint request query is invalid", path="endpoint.request.query"
                )
            query[key] = tuple(items)
        return cls(
            method,
            _headers(
                data["headers"],
                "endpoint.request.headers",
                allowed=_ENDPOINT_REQUEST_HEADERS,
            ),
            query,
            decode_body(data["bodyBase64"], path="endpoint.request.bodyBase64"),
        )


@dataclass(frozen=True, slots=True)
class HttpEndpointResponse:
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    def to_wire(self) -> dict[str, Any]:
        if (
            isinstance(self.status, bool)
            or not isinstance(self.status, int)
            or not 200 <= self.status <= 599
        ):
            raise contract_error(
                "endpoint response status is invalid", path="endpoint.response.status"
            )
        return {
            "schemaVersion": HTTP_ENDPOINT_RESPONSE_V1,
            "mode": "buffered",
            "status": self.status,
            "headers": _headers(
                self.headers,
                "endpoint.response.headers",
                allowed=_ENDPOINT_RESPONSE_HEADERS,
            ),
            "bodyBase64": encode_body(self.body),
        }
