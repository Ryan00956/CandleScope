from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.api.v1.settings import (
    AutoGcRunRequest,
    CacheLimitsRequest,
    StorageGcRunRequest,
)


@pytest.mark.parametrize("ephemeral_bars", [-1, 0, 1_000_001])
def test_cache_limits_reject_invalid_ephemeral_capacity(ephemeral_bars: int) -> None:
    with pytest.raises(ValidationError):
        CacheLimitsRequest(ephemeral_bars=ephemeral_bars)


def test_cache_limits_reject_unknown_or_negative_db_limits() -> None:
    with pytest.raises(ValidationError):
        CacheLimitsRequest(db_limits={"seconds": 10})
    with pytest.raises(ValidationError):
        CacheLimitsRequest(db_limits={"minutes": -1})


def test_cache_limits_preserve_explicit_null_and_false() -> None:
    request = CacheLimitsRequest(
        sqlite_budget_bytes=None,
        storage_row_limits_enabled=False,
    )
    assert request.sqlite_budget_bytes is None
    assert request.storage_row_limits_enabled is False
    assert request.model_fields_set == {"sqlite_budget_bytes", "storage_row_limits_enabled"}


def test_storage_and_auto_gc_limits_are_bounded() -> None:
    with pytest.raises(ValidationError):
        StorageGcRunRequest(confirm=True, batch_size=0)
    with pytest.raises(ValidationError):
        AutoGcRunRequest(max_bytes_per_run=0)
    with pytest.raises(ValidationError):
        StorageGcRunRequest(confirm=True, batch_size=1_001)
    with pytest.raises(ValidationError):
        AutoGcRunRequest(storage_batch_size=1_001)
    with pytest.raises(ValidationError, match="automatic SQLite VACUUM is unsupported"):
        AutoGcRunRequest(sqlite_auto_vacuum=True)


def test_auto_gc_rejects_removed_recent_active_grace_override() -> None:
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        AutoGcRunRequest.model_validate({
            "never_evict_active_within_ms": 10 * 60_000,
        })
