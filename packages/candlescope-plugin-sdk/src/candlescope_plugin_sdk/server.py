"""JSON-RPC 2.0 JSON Lines sidecar server."""

from __future__ import annotations

import json
import sys
import traceback
from collections.abc import Mapping
from typing import Any, TextIO

from .constants import (
    DEFAULT_MAX_MESSAGE_BYTES,
    JSONRPC_VERSION,
    RPC_INTERNAL_ERROR,
    RPC_INVALID_REQUEST,
    RPC_PARSE_ERROR,
)
from .errors import ProtocolError, invalid_params
from .runtime import BaseRuntimePlugin, RuntimeDispatcher


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is not allowed: {value}")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON object key: {key}")
        value[key] = item
    return value


def _error_response(request_id: str | int | None, error: ProtocolError) -> dict[str, Any]:
    return {
        "jsonrpc": JSONRPC_VERSION,
        "id": request_id,
        "error": error.to_wire(),
    }


class JsonLineRuntimeServer:
    """Bounded synchronous server suitable for an isolated sidecar process."""

    def __init__(
        self,
        plugin: BaseRuntimePlugin,
        *,
        max_message_bytes: int = DEFAULT_MAX_MESSAGE_BYTES,
    ) -> None:
        self.dispatcher = RuntimeDispatcher(plugin)
        self.max_message_bytes = max(1, int(max_message_bytes))

    def handle_message(self, value: Any) -> dict[str, Any]:
        request_id: str | int | None = None
        try:
            if not isinstance(value, Mapping):
                raise ProtocolError(
                    RPC_INVALID_REQUEST,
                    "INVALID_REQUEST",
                    "JSON-RPC request must be an object.",
                )
            request_id = self._request_id(value)
            if value.get("jsonrpc") != JSONRPC_VERSION:
                raise ProtocolError(
                    RPC_INVALID_REQUEST,
                    "INVALID_REQUEST",
                    f"jsonrpc must be {JSONRPC_VERSION}.",
                )
            method = value.get("method")
            if not isinstance(method, str) or not method:
                raise ProtocolError(
                    RPC_INVALID_REQUEST,
                    "INVALID_REQUEST",
                    "method must be a non-empty string.",
                )
            params = value.get("params", {})
            if not isinstance(params, Mapping):
                raise invalid_params("params must be an object", field_name="params")
            result = self.dispatcher.dispatch(method, dict(params))
            return {
                "jsonrpc": JSONRPC_VERSION,
                "id": request_id,
                "result": result,
            }
        except ProtocolError as exc:
            return _error_response(request_id, exc)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            return _error_response(
                request_id,
                ProtocolError(
                    RPC_INTERNAL_ERROR,
                    "INTERNAL_ERROR",
                    "Runtime plugin raised an unexpected exception.",
                ),
            )

    def handle_line(self, line: str) -> dict[str, Any]:
        if len(line.encode("utf-8")) > self.max_message_bytes:
            return _error_response(
                None,
                ProtocolError(
                    RPC_INVALID_REQUEST,
                    "MESSAGE_TOO_LARGE",
                    "JSON-RPC request exceeds the configured message limit.",
                    {"maxMessageBytes": self.max_message_bytes},
                ),
            )
        try:
            value = json.loads(
                line,
                parse_constant=_reject_json_constant,
                object_pairs_hook=_unique_json_object,
            )
        except (json.JSONDecodeError, UnicodeError, ValueError):
            return _error_response(
                None,
                ProtocolError(
                    RPC_PARSE_ERROR,
                    "PARSE_ERROR",
                    "Request line is not valid JSON.",
                ),
            )
        return self.handle_message(value)

    def serve(self, input_stream: TextIO, output_stream: TextIO) -> int:
        for line in input_stream:
            response = self.handle_line(line)
            try:
                encoded = self._encode_response(response)
            except (TypeError, ValueError):
                traceback.print_exc(file=sys.stderr)
                encoded = self._encode_response(
                    _error_response(
                        response.get("id"),
                        ProtocolError(
                            RPC_INTERNAL_ERROR,
                            "PLUGIN_RESULT_NOT_JSON",
                            "Runtime plugin returned a non-JSON-compatible result.",
                        ),
                    )
                )
            output_stream.write(encoded)
            output_stream.write("\n")
            output_stream.flush()
            if self.dispatcher.shutdown_requested:
                break
        return 0

    @staticmethod
    def _encode_response(response: dict[str, Any]) -> str:
        return json.dumps(
            response,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )

    @staticmethod
    def _request_id(value: Mapping[str, Any]) -> str | int:
        if "id" not in value:
            raise ProtocolError(
                RPC_INVALID_REQUEST,
                "REQUEST_ID_REQUIRED",
                "JSON-RPC notifications are not supported; id is required.",
            )
        request_id = value["id"]
        if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
            raise ProtocolError(
                RPC_INVALID_REQUEST,
                "INVALID_REQUEST_ID",
                "id must be a string or integer.",
            )
        return request_id


def serve_runtime(
    plugin: BaseRuntimePlugin,
    *,
    input_stream: TextIO | None = None,
    output_stream: TextIO | None = None,
    max_message_bytes: int = DEFAULT_MAX_MESSAGE_BYTES,
) -> int:
    """Serve one plugin session using stdin/stdout unless streams are supplied."""

    server = JsonLineRuntimeServer(plugin, max_message_bytes=max_message_bytes)
    return server.serve(input_stream or sys.stdin, output_stream or sys.stdout)
