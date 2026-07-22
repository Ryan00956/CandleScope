"""Stable, business-neutral failures for the Plugin Platform process Host."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class PlatformHostError(RuntimeError):
    """A Host-owned failure safe to expose through diagnostics."""

    code: str
    message: str
    plugin_id: str | None = None
    entrypoint_id: str | None = None
    details: dict[str, Any] = field(default_factory=dict)
    fatal: bool = False

    def __post_init__(self) -> None:
        RuntimeError.__init__(self, self.message)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            **({"pluginId": self.plugin_id} if self.plugin_id is not None else {}),
            **(
                {"entrypointId": self.entrypoint_id}
                if self.entrypoint_id is not None
                else {}
            ),
            **({"details": dict(self.details)} if self.details else {}),
        }


class PlatformHostRequestError(PlatformHostError):
    """The caller supplied a request that was rejected before transport."""


class PlatformHostRemoteError(PlatformHostError):
    """The sidecar returned a well-formed JSON-RPC failure."""


class PlatformHostTransportError(PlatformHostError):
    """The process or wire session is no longer trustworthy."""


class PlatformHostStateError(PlatformHostError):
    """The requested lifecycle transition is not currently valid."""
