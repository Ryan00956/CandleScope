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
from .protection import DurableProtectionRegistry
from .repository import ManualHistoryRepository, init_manual_history_storage

__all__ = [
    "DurableProtectionRegistry",
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
