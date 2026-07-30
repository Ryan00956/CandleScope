"""Strict JSON-RPC envelopes shared by Plugin Platform v2 transports."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, TypeAlias

from .constants import JSONRPC_VERSION
from .errors import PlatformContractError, PlatformProtocolError, contract_error
from .json_codec import normalize_json


RpcId: TypeAlias = str | int


def _mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise contract_error(f"{path} must be an object", path=path)
    return value


def _exact_keys(
    value: Mapping[str, Any],
    *,
    required: frozenset[str],
    path: str,
) -> None:
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required)
    if missing:
        raise contract_error(
            f"{path} is missing required fields: {', '.join(missing)}",
            path=path,
        )
    if unknown:
        raise contract_error(
            f"{path} contains unknown fields: {', '.join(unknown)}",
            path=path,
        )


def _request_id(value: Any, path: str = "id") -> RpcId:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise contract_error(f"{path} must be a string or integer", path=path)
    if isinstance(value, str) and not value:
        raise contract_error(f"{path} must not be empty", path=path)
    if isinstance(value, int) and value < 0:
        raise contract_error(f"{path} integer must be non-negative", path=path)
    return value


def _generation(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise contract_error("generation must be a non-negative integer", path="generation")
    return value


def _json_object(value: Any, path: str) -> dict[str, Any]:
    normalized = normalize_json(value, path=path)
    if not isinstance(normalized, dict):
        raise contract_error(f"{path} must be an object", path=path)
    return normalized


@dataclass(frozen=True, slots=True)
class RpcRequest:
    id: RpcId
    method: str
    params: dict[str, Any]
    generation: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "id", _request_id(self.id))
        if not isinstance(self.method, str) or not self.method or len(self.method) > 128:
            raise contract_error("method must be a non-empty string", path="method")
        object.__setattr__(self, "params", _json_object(self.params, "params"))
        object.__setattr__(self, "generation", _generation(self.generation))

    def to_wire(self) -> dict[str, Any]:
        return {
            "jsonrpc": JSONRPC_VERSION,
            "id": self.id,
            "method": self.method,
            "params": dict(self.params),
            "generation": self.generation,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "RpcRequest":
        data = _mapping(value, "request")
        _exact_keys(
            data,
            required=frozenset({"jsonrpc", "id", "method", "params", "generation"}),
            path="request",
        )
        if data["jsonrpc"] != JSONRPC_VERSION:
            raise contract_error(f"jsonrpc must be {JSONRPC_VERSION}", path="jsonrpc")
        return cls(
            id=data["id"],
            method=data["method"],
            params=_json_object(data["params"], "params"),
            generation=data["generation"],
        )


@dataclass(frozen=True, slots=True)
class RpcError:
    rpc_code: int
    message: str
    code: str
    data: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if isinstance(self.rpc_code, bool) or not isinstance(self.rpc_code, int):
            raise contract_error("error.code must be an integer", path="error.code")
        if not isinstance(self.message, str) or not self.message:
            raise contract_error("error.message must be a non-empty string", path="error.message")
        if not isinstance(self.code, str) or not self.code:
            raise contract_error(
                "error.data.code must be a non-empty string", path="error.data.code"
            )
        data = _json_object(self.data, "error.data")
        if "code" in data:
            raise contract_error(
                "error.data must not redefine symbolic code", path="error.data.code"
            )
        object.__setattr__(self, "data", data)

    def to_wire(self) -> dict[str, Any]:
        return {
            "code": self.rpc_code,
            "message": self.message,
            "data": {**self.data, "code": self.code},
        }

    @classmethod
    def from_wire(cls, value: Any) -> "RpcError":
        data = _mapping(value, "error")
        _exact_keys(
            data,
            required=frozenset({"code", "message", "data"}),
            path="error",
        )
        error_data = _json_object(data["data"], "error.data")
        symbolic = error_data.pop("code", None)
        return cls(
            rpc_code=data["code"],
            message=data["message"],
            code=symbolic,
            data=error_data,
        )

    @classmethod
    def from_exception(cls, error: PlatformProtocolError) -> "RpcError":
        return cls(
            rpc_code=error.rpc_code,
            message=error.message,
            code=error.code,
            data=error.data,
        )


@dataclass(frozen=True, slots=True)
class RpcSuccess:
    id: RpcId | None
    result: Any
    generation: int

    def __post_init__(self) -> None:
        if self.id is not None:
            object.__setattr__(self, "id", _request_id(self.id))
        object.__setattr__(self, "result", normalize_json(self.result, path="result"))
        object.__setattr__(self, "generation", _generation(self.generation))

    def to_wire(self) -> dict[str, Any]:
        return {
            "jsonrpc": JSONRPC_VERSION,
            "id": self.id,
            "result": self.result,
            "generation": self.generation,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "RpcSuccess":
        data = _mapping(value, "response")
        _exact_keys(
            data,
            required=frozenset({"jsonrpc", "id", "result", "generation"}),
            path="response",
        )
        if data["jsonrpc"] != JSONRPC_VERSION:
            raise contract_error(f"jsonrpc must be {JSONRPC_VERSION}", path="jsonrpc")
        return cls(id=data["id"], result=data["result"], generation=data["generation"])


@dataclass(frozen=True, slots=True)
class RpcFailure:
    id: RpcId | None
    error: RpcError
    generation: int

    def __post_init__(self) -> None:
        if self.id is not None:
            object.__setattr__(self, "id", _request_id(self.id))
        if not isinstance(self.error, RpcError):
            raise contract_error("error is invalid", path="error")
        object.__setattr__(self, "generation", _generation(self.generation))

    def to_wire(self) -> dict[str, Any]:
        return {
            "jsonrpc": JSONRPC_VERSION,
            "id": self.id,
            "error": self.error.to_wire(),
            "generation": self.generation,
        }

    @classmethod
    def from_wire(cls, value: Any) -> "RpcFailure":
        data = _mapping(value, "response")
        _exact_keys(
            data,
            required=frozenset({"jsonrpc", "id", "error", "generation"}),
            path="response",
        )
        if data["jsonrpc"] != JSONRPC_VERSION:
            raise contract_error(f"jsonrpc must be {JSONRPC_VERSION}", path="jsonrpc")
        return cls(
            id=data["id"],
            error=RpcError.from_wire(data["error"]),
            generation=data["generation"],
        )


RpcFrame: TypeAlias = RpcRequest | RpcSuccess | RpcFailure


def parse_rpc_frame(value: Any) -> RpcFrame:
    data = _mapping(value, "frame")
    has_method = "method" in data
    has_result = "result" in data
    has_error = "error" in data
    if sum((has_method, has_result, has_error)) != 1:
        raise PlatformContractError(
            "INVALID_CONTRACT",
            "JSON-RPC frame must contain exactly one of method, result, or error",
            "frame",
        )
    if has_method:
        return RpcRequest.from_wire(data)
    if has_result:
        return RpcSuccess.from_wire(data)
    return RpcFailure.from_wire(data)


def failure_from_exception(
    request_id: RpcId | None,
    generation: int,
    error: PlatformProtocolError,
) -> RpcFailure:
    return RpcFailure(
        id=request_id,
        generation=generation,
        error=RpcError.from_exception(error),
    )
