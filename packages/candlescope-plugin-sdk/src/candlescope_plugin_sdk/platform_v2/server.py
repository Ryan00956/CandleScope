"""Bounded JSON Lines server for the Plugin Platform v2 reference sidecar."""

from __future__ import annotations

import sys
import traceback
from collections.abc import Mapping
from typing import Any, TextIO

from .constants import (
    DEFAULT_MAX_IN_FLIGHT,
    RPC_INTERNAL_ERROR,
    RPC_INVALID_REQUEST,
    RPC_PARSE_ERROR,
)
from .errors import PlatformContractError, PlatformProtocolError
from .json_codec import DEFAULT_JSON_LIMITS, JsonLimits, canonical_dumps, loads_strict
from .rpc import RpcId, failure_from_exception, parse_rpc_frame
from .runtime import BasePlatformPlugin, PlatformDispatcher


def _best_effort_identity(value: Any) -> tuple[RpcId | None, int]:
    if not isinstance(value, Mapping):
        return None, 0
    raw_id = value.get("id")
    request_id = raw_id if not isinstance(raw_id, bool) and isinstance(raw_id, (str, int)) else None
    raw_generation = value.get("generation")
    generation = (
        raw_generation
        if not isinstance(raw_generation, bool)
        and isinstance(raw_generation, int)
        and raw_generation >= 0
        else 0
    )
    return request_id, generation


class PlatformJsonLineServer:
    """Synchronous reference transport with zero unbounded input queues."""

    def __init__(
        self,
        plugin: BasePlatformPlugin,
        *,
        limits: JsonLimits = DEFAULT_JSON_LIMITS,
        max_in_flight: int = DEFAULT_MAX_IN_FLIGHT,
    ) -> None:
        self.limits = limits
        self.dispatcher = PlatformDispatcher(plugin, max_in_flight=max_in_flight)

    def handle_message(self, value: Any) -> tuple[dict[str, Any], ...]:
        request_id, generation = _best_effort_identity(value)
        try:
            frame = parse_rpc_frame(value)
            responses = self.dispatcher.handle(frame)
            return tuple(item.to_wire() for item in responses)
        except PlatformContractError as exc:
            return (
                failure_from_exception(
                    request_id,
                    generation,
                    PlatformProtocolError(
                        RPC_INVALID_REQUEST,
                        exc.code,
                        exc.message,
                        {"path": exc.path} if exc.path else {},
                    ),
                ).to_wire(),
            )
        except PlatformProtocolError as exc:
            return (failure_from_exception(request_id, generation, exc).to_wire(),)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            return (
                failure_from_exception(
                    request_id,
                    generation,
                    PlatformProtocolError(
                        RPC_INTERNAL_ERROR,
                        "INTERNAL_ERROR",
                        "Plugin raised an unexpected exception.",
                    ),
                ).to_wire(),
            )

    def handle_line(self, line: str | bytes) -> tuple[dict[str, Any], ...]:
        try:
            value = loads_strict(line, limits=self.limits)
        except PlatformContractError as exc:
            is_size_error = exc.code == "MESSAGE_TOO_LARGE"
            return (
                failure_from_exception(
                    None,
                    0,
                    PlatformProtocolError(
                        RPC_INVALID_REQUEST if is_size_error else RPC_PARSE_ERROR,
                        exc.code if is_size_error else "PARSE_ERROR",
                        (
                            exc.message
                            if is_size_error
                            else "Control line is not valid bounded JSON."
                        ),
                        {"maxMessageBytes": self.limits.max_message_bytes} if is_size_error else {},
                    ),
                ).to_wire(),
            )
        return self.handle_message(value)

    def serve(self, input_stream: TextIO, output_stream: TextIO) -> int:
        for line in input_stream:
            responses = self.handle_line(line)
            for response in responses:
                output_stream.write(canonical_dumps(response, limits=self.limits))
                output_stream.write("\n")
                output_stream.flush()
            if self.dispatcher.shutdown_requested:
                break
        return 0


def serve_platform_plugin(
    plugin: BasePlatformPlugin,
    *,
    input_stream: TextIO | None = None,
    output_stream: TextIO | None = None,
    limits: JsonLimits = DEFAULT_JSON_LIMITS,
    max_in_flight: int = DEFAULT_MAX_IN_FLIGHT,
) -> int:
    server = PlatformJsonLineServer(
        plugin,
        limits=limits,
        max_in_flight=max_in_flight,
    )
    return server.serve(input_stream or sys.stdin, output_stream or sys.stdout)
