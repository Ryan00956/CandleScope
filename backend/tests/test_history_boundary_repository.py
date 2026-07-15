from __future__ import annotations

import pytest

from app.data_engine.history import (
    BoundaryReason,
    BoundarySide,
    BoundaryState,
    HistoryAvailability,
    HistoryAvailabilityService,
    HistoryBoundaryRepository,
    HistorySeriesKey,
    TimeBound,
)


def _key(*, variant: str = "1m", params: dict | None = None) -> HistorySeriesKey:
    return HistorySeriesKey.from_params(
        exchange="Binance",
        market_type="future",
        symbol="btcusdt",
        channel="open_interest",
        variant=variant,
        params=params,
    )


def test_series_key_is_normalised_and_parameter_hash_is_deterministic() -> None:
    first = _key(params={"period": "5m", "limit": 10})
    second = _key(params={"limit": 10, "period": "5m"})
    assert first == second
    assert first.exchange == "binance"
    assert first.symbol == "BTCUSDT"
    assert len(first.params_hash) == 64


def test_repository_records_candidate_evidence_and_confirmation(tmp_path) -> None:
    repository = HistoryBoundaryRepository(tmp_path / "history.sqlite3")
    key = _key()
    candidate = TimeBound(
        1_000,
        BoundaryReason.SOURCE_EXHAUSTED,
        state=BoundaryState.CANDIDATE,
        revision="v1",
    )
    first = repository.upsert(key, BoundarySide.LEFT, candidate, observed_at_ms=10)
    second = repository.upsert(key, BoundarySide.LEFT, candidate, observed_at_ms=20)
    assert first.evidence_count == 1
    assert second.evidence_count == 2
    assert second.last_seen_at_ms == 20
    confirmed = repository.confirm(key, BoundarySide.LEFT, observed_at_ms=30)
    assert confirmed is not None
    assert confirmed.bound.state is BoundaryState.CONFIRMED
    assert confirmed.evidence_count == 3

    with pytest.raises(ValueError, match="candidate boundary"):
        repository.upsert(
            key,
            BoundarySide.LEFT,
            TimeBound(2_000, BoundaryReason.SOURCE_EXHAUSTED, state=BoundaryState.CANDIDATE),
        )


def test_repository_filters_revision_and_revalidation_and_separates_variants(tmp_path) -> None:
    repository = HistoryBoundaryRepository(tmp_path / "history.sqlite3")
    first_key = _key(variant="5m")
    second_key = _key(variant="1h")
    bound = TimeBound(
        1_000,
        BoundaryReason.SOURCE_EXHAUSTED,
        revision="cap-v1",
        revalidate_at_ms=5_000,
    )
    repository.upsert(first_key, "left", bound, observed_at_ms=100)
    repository.upsert(second_key, "left", TimeBound(2_000, BoundaryReason.MANUAL))
    assert repository.get(first_key, "left", now_ms=4_999, revision="cap-v1") is not None
    assert repository.get(first_key, "left", now_ms=5_000, revision="cap-v1") is None
    assert repository.get(first_key, "left", now_ms=4_000, revision="cap-v2") is None
    assert repository.get(first_key, "left", include_stale=True) is not None
    assert repository.get(second_key, "left", include_stale=True).bound.value_ms == 2_000
    assert repository.delete_stale(now_ms=5_000) == 1


def test_dynamic_rolling_bound_cannot_be_persisted(tmp_path) -> None:
    repository = HistoryBoundaryRepository(tmp_path / "history.sqlite3")
    with pytest.raises(ValueError, match="rolling-retention"):
        repository.upsert(
            _key(),
            "left",
            TimeBound(
                1_000,
                BoundaryReason.PROVIDER_RETENTION,
                dynamic=True,
            ),
        )


def test_load_availability_uses_only_confirmed_nonretryable_boundaries(tmp_path) -> None:
    repository = HistoryBoundaryRepository(tmp_path / "history.sqlite3")
    key = _key()
    repository.upsert(
        key,
        "left",
        TimeBound(2_000, BoundaryReason.SOURCE_EXHAUSTED, revision="v1"),
    )
    repository.upsert(
        key,
        "right",
        TimeBound(
            8_000,
            BoundaryReason.TEMPORARY_UNAVAILABLE,
            retryable=True,
            revision="v1",
        ),
    )
    resolved = repository.load_availability(
        key,
        HistoryAvailability(
            upstream_start=TimeBound(1_000, BoundaryReason.UPSTREAM_START, revision="v1"),
            rolling_retention_ms=30_000,
            revision="v1",
        ),
        now_ms=5_000,
    )
    assert resolved.upstream_start.value_ms == 2_000
    assert resolved.upstream_end is None
    assert resolved.rolling_retention_ms == 30_000


def test_service_requires_repeated_evidence_before_promotion(tmp_path) -> None:
    service = HistoryAvailabilityService(
        boundaries=HistoryBoundaryRepository(tmp_path / "history.sqlite3")
    )
    key = _key()
    first = service.record_boundary(
        key,
        "left",
        value_ms=1_000,
        reason=BoundaryReason.SOURCE_EXHAUSTED,
        promote_after=2,
    )
    second = service.record_boundary(
        key,
        "left",
        value_ms=1_000,
        reason=BoundaryReason.SOURCE_EXHAUSTED,
        promote_after=2,
    )
    assert first.bound.state is BoundaryState.CANDIDATE
    assert second.bound.state is BoundaryState.CONFIRMED
