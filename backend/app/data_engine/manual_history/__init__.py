"""Durable manual-history collections, jobs, and GC protection metadata."""

from .models import (
    CollectionStatus,
    JobState,
    JobTargetState,
    ManualHistoryIdempotencyConflict,
    ManualHistoryIllegalTransition,
    ManualHistoryNotFound,
    ProtectionKind,
    ProtectionOwnerKind,
    ProtectionState,
    RouteKind,
    TargetStatus,
)
from .repository import ManualHistoryRepository, init_manual_history_storage

__all__ = [
    "CollectionStatus",
    "JobState",
    "JobTargetState",
    "ManualHistoryIdempotencyConflict",
    "ManualHistoryIllegalTransition",
    "ManualHistoryNotFound",
    "ManualHistoryRepository",
    "ProtectionKind",
    "ProtectionOwnerKind",
    "ProtectionState",
    "RouteKind",
    "TargetStatus",
    "init_manual_history_storage",
]
