"""Stable replay domain errors without a FastAPI dependency."""

from __future__ import annotations

from enum import Enum
from types import MappingProxyType
from typing import Mapping


class ReplayErrorCode(str, Enum):
    REPLAY_DISABLED = "REPLAY_DISABLED"
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    SESSION_ENDED = "SESSION_ENDED"
    CONTROLLER_CONFLICT = "CONTROLLER_CONFLICT"
    REVISION_CONFLICT = "REVISION_CONFLICT"
    COMMAND_ID_REUSED = "COMMAND_ID_REUSED"
    INVALID_STATE_TRANSITION = "INVALID_STATE_TRANSITION"
    UNSUPPORTED_SOURCE = "UNSUPPORTED_SOURCE"
    UNSUPPORTED_INTERVAL = "UNSUPPORTED_INTERVAL"
    UNSUPPORTED_EXECUTION_MODEL = "UNSUPPORTED_EXECUTION_MODEL"
    NO_ELIGIBLE_WINDOW = "NO_ELIGIBLE_WINDOW"
    DATA_GAP = "DATA_GAP"
    DATASET_INCOMPLETE = "DATASET_INCOMPLETE"
    DATASET_MISMATCH = "DATASET_MISMATCH"
    ARCHIVE_DISABLED = "ARCHIVE_DISABLED"
    ARCHIVE_DEGRADED = "ARCHIVE_DEGRADED"
    SCAN_LIMIT_EXCEEDED = "SCAN_LIMIT_EXCEEDED"
    SEEK_REQUIRES_FORK_OR_RESET = "SEEK_REQUIRES_FORK_OR_RESET"
    ORDER_REJECTED = "ORDER_REJECTED"
    RISK_LIMIT_EXCEEDED = "RISK_LIMIT_EXCEEDED"
    PERSISTENCE_DEGRADED = "PERSISTENCE_DEGRADED"


ERROR_HTTP_STATUS: Mapping[ReplayErrorCode, int] = MappingProxyType(
    {
        ReplayErrorCode.REPLAY_DISABLED: 503,
        ReplayErrorCode.SESSION_NOT_FOUND: 404,
        ReplayErrorCode.SESSION_ENDED: 409,
        ReplayErrorCode.CONTROLLER_CONFLICT: 409,
        ReplayErrorCode.REVISION_CONFLICT: 409,
        ReplayErrorCode.COMMAND_ID_REUSED: 409,
        ReplayErrorCode.INVALID_STATE_TRANSITION: 409,
        ReplayErrorCode.UNSUPPORTED_SOURCE: 422,
        ReplayErrorCode.UNSUPPORTED_INTERVAL: 422,
        ReplayErrorCode.UNSUPPORTED_EXECUTION_MODEL: 422,
        ReplayErrorCode.NO_ELIGIBLE_WINDOW: 422,
        ReplayErrorCode.DATA_GAP: 422,
        ReplayErrorCode.DATASET_INCOMPLETE: 422,
        ReplayErrorCode.DATASET_MISMATCH: 409,
        ReplayErrorCode.ARCHIVE_DISABLED: 503,
        ReplayErrorCode.ARCHIVE_DEGRADED: 503,
        ReplayErrorCode.SCAN_LIMIT_EXCEEDED: 413,
        ReplayErrorCode.SEEK_REQUIRES_FORK_OR_RESET: 409,
        ReplayErrorCode.ORDER_REJECTED: 422,
        ReplayErrorCode.RISK_LIMIT_EXCEEDED: 422,
        ReplayErrorCode.PERSISTENCE_DEGRADED: 503,
    }
)


class ReplayDomainError(Exception):
    """Transport-neutral failure carrying a stable machine-readable code."""

    def __init__(
        self,
        code: ReplayErrorCode,
        message: str,
        *,
        details: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = MappingProxyType(dict(details or {}))

    @property
    def http_status(self) -> int:
        return ERROR_HTTP_STATUS[self.code]
