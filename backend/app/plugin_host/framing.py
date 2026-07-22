"""Shared bounded JSON Lines primitives for v1 and v2 sidecar sessions."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class JsonLineError(ValueError):
    code: str
    message: str

    def __post_init__(self) -> None:
        ValueError.__init__(self, self.message)


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant is not allowed: {value}")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def compact_json_bytes(value: Any, *, max_message_bytes: int) -> bytes:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise JsonLineError("NOT_JSON", "control message is not strict JSON") from exc
    if len(encoded) > max_message_bytes:
        raise JsonLineError(
            "MESSAGE_TOO_LARGE",
            f"control message exceeds {max_message_bytes} bytes",
        )
    return encoded


def strict_json_loads(payload: bytes, *, max_message_bytes: int) -> Any:
    if len(payload) > max_message_bytes:
        raise JsonLineError(
            "MESSAGE_TOO_LARGE",
            f"control message exceeds {max_message_bytes} bytes",
        )
    try:
        return json.loads(
            payload.decode("utf-8", errors="strict"),
            parse_constant=_reject_json_constant,
            object_pairs_hook=_unique_json_object,
        )
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise JsonLineError(
            "INVALID_JSON", "control line is not strict UTF-8 JSON"
        ) from exc


async def read_json_line(
    reader: asyncio.StreamReader,
    *,
    max_message_bytes: int,
) -> bytes:
    try:
        line = await reader.readline()
    except ValueError as exc:
        raise JsonLineError(
            "MESSAGE_TOO_LARGE",
            f"control line exceeds {max_message_bytes} bytes",
        ) from exc
    except (ConnectionResetError, OSError) as exc:
        raise JsonLineError("IO_FAILED", "control stream read failed") from exc
    if not line:
        raise JsonLineError("EOF", "control stream closed")
    if not line.endswith(b"\n"):
        raise JsonLineError(
            "NOT_TERMINATED", "control message is not newline terminated"
        )
    message = line[:-1]
    if message.endswith(b"\r"):
        message = message[:-1]
    if len(message) > max_message_bytes:
        raise JsonLineError(
            "MESSAGE_TOO_LARGE",
            f"control line exceeds {max_message_bytes} bytes",
        )
    return message


async def write_json_line(
    writer: asyncio.StreamWriter,
    payload: bytes,
    *,
    max_message_bytes: int,
) -> None:
    if len(payload) > max_message_bytes:
        raise JsonLineError(
            "MESSAGE_TOO_LARGE",
            f"control message exceeds {max_message_bytes} bytes",
        )
    try:
        writer.write(payload + b"\n")
        await writer.drain()
    except (BrokenPipeError, ConnectionResetError, OSError) as exc:
        raise JsonLineError("IO_FAILED", "control stream write failed") from exc


class AsyncJsonLineConnection:
    """One-reader/many-writer bounded connection used by both protocol generations."""

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        *,
        max_message_bytes: int,
    ) -> None:
        if max_message_bytes < 1:
            raise ValueError("max_message_bytes must be positive")
        self.reader = reader
        self.writer = writer
        self.max_message_bytes = max_message_bytes
        self._write_lock = asyncio.Lock()

    async def read(self) -> bytes:
        return await read_json_line(
            self.reader,
            max_message_bytes=self.max_message_bytes,
        )

    async def write(self, payload: bytes) -> None:
        async with self._write_lock:
            await write_json_line(
                self.writer,
                payload,
                max_message_bytes=self.max_message_bytes,
            )
