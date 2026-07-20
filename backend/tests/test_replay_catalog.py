from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.replay.catalog import ReplayCatalog, ReplaySeriesIdentity
from app.replay.constants import QualityMode
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import MAX_RANDOM_SEED
from tests.fixtures.replay.fakes import FakeKlinesRepo, FixtureIdentity, make_bar


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "replay" / "catalog_case_v1.json"


def _case() -> dict[str, object]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _fixture_repo() -> tuple[FakeKlinesRepo, FixtureIdentity, dict[str, object]]:
    case = _case()
    identity_payload = case["identity"]
    assert isinstance(identity_payload, dict)
    identity = FixtureIdentity(**identity_payload)
    start_ms = int(case["start_ms"])
    interval_ms = int(case["interval_ms"])
    gap_offsets = set(case["gap_offsets"])
    assert all(isinstance(value, int) for value in gap_offsets)
    rows = [
        make_bar(start_ms + offset * interval_ms, interval_ms=interval_ms, price=str(100 + offset))
        for offset in range(int(case["bar_count"]))
        if offset not in gap_offsets
    ]
    repo = FakeKlinesRepo()
    repo.add_rows(identity, str(case["interval"]), rows)
    # A local custom/non-native interval must not become a replay base.
    repo.add_rows(identity, "2m", [{**row, "interval": "2m"} for row in rows[::2]])
    return repo, identity, case


def _catalog(repo: FakeKlinesRepo, case: dict[str, object]) -> ReplayCatalog:
    return ReplayCatalog(
        repo,
        native_intervals=lambda identity: ("1m", "5m"),
        now_ms=lambda: int(case["now_ms"]),
        max_scan_rows=4,
        cache_ttl_seconds=60.0,
    )


def test_catalog_selects_smallest_native_local_interval_and_compacts_windows() -> None:
    repo, identity, case = _fixture_repo()
    catalog = _catalog(repo, case)

    snapshot = catalog.build(
        warmup_bars=int(case["warmup_bars"]),
        horizon_ms=int(case["horizon_ms"]),
        quality_mode=QualityMode.EXACT,
    )
    entry = snapshot.require_entry(
        ReplaySeriesIdentity(identity.exchange, identity.market_type, identity.symbol)
    )

    start_ms = int(case["start_ms"])
    interval_ms = int(case["interval_ms"])
    assert entry.base_intervals == ("1m",)
    assert entry.selected_base_interval == "1m"
    assert entry.eligible_window_count == 3
    assert [(item.first_start_ms, item.last_start_ms, item.count) for item in entry.eligible_ranges] == [
        (start_ms + 2 * interval_ms, start_ms + 2 * interval_ms, 1),
        (start_ms + 8 * interval_ms, start_ms + 9 * interval_ms, 2),
    ]
    assert entry.bounds.latest_closed_open_ms == start_ms + 11 * interval_ms
    assert entry.bounds.latest_source_open_ms == start_ms + 12 * interval_ms
    assert entry.gap_summary.gap_count == 1
    assert all(
        window.last_start_ms + 2 * interval_ms <= entry.bounds.latest_closed_open_ms
        for window in entry.eligible_ranges
    )
    assert catalog.diagnostics()["scan_calls"] >= 3
    assert catalog.diagnostics()["last_build_ms"] >= 0
    assert catalog.diagnostics()["last_build_scan_calls"] >= 3
    assert max(
        int(details["limit"])
        for name, details in repo.calls
        if name == "scan_gaps"
    ) == 4
    assert not any(name.startswith("upsert") or name.startswith("delete") for name, _ in repo.calls)


def test_catalog_random_selection_is_seeded_and_matches_golden() -> None:
    repo, identity, case = _fixture_repo()
    catalog = _catalog(repo, case)
    snapshot = catalog.build(
        warmup_bars=int(case["warmup_bars"]),
        horizon_ms=int(case["horizon_ms"]),
    )
    entry = snapshot.require_entry(
        ReplaySeriesIdentity(identity.exchange, identity.market_type, identity.symbol)
    )
    selected_a = catalog.select_random(entry, seed=int(case["random_seed"]))
    selected_b = catalog.select_random(entry, seed=int(case["random_seed"]))
    expected = case["expected"]
    assert isinstance(expected, dict)

    assert snapshot.catalog_epoch == expected["catalog_epoch"]
    assert selected_a == selected_b
    assert selected_a.replay_start_ms == expected["random_start_ms"]
    with pytest.raises(ValueError, match="random seed"):
        catalog.select_random(entry, seed=MAX_RANDOM_SEED + 1)


def test_catalog_manual_start_fails_with_specific_alignment_gap_and_boundary_reasons() -> None:
    repo, identity, case = _fixture_repo()
    catalog = _catalog(repo, case)
    snapshot = catalog.build(
        warmup_bars=int(case["warmup_bars"]),
        horizon_ms=int(case["horizon_ms"]),
    )
    entry = snapshot.require_entry(
        ReplaySeriesIdentity(identity.exchange, identity.market_type, identity.symbol)
    )
    start_ms = int(case["start_ms"])
    interval_ms = int(case["interval_ms"])

    with pytest.raises(ReplayDomainError) as misaligned:
        catalog.select_manual(entry, start_ms=start_ms + 1)
    assert misaligned.value.code is ReplayErrorCode.NO_ELIGIBLE_WINDOW
    assert misaligned.value.details["reason"] == "start_not_aligned"

    with pytest.raises(ReplayDomainError) as gap:
        catalog.select_manual(entry, start_ms=start_ms + 5 * interval_ms)
    assert gap.value.details["reason"] == "intersects_gap_or_insufficient_context"

    with pytest.raises(ReplayDomainError) as boundary:
        catalog.select_manual(entry, start_ms=start_ms + 12 * interval_ms)
    assert boundary.value.details["reason"] == "future_or_forming_horizon"


def test_catalog_cache_is_bound_to_source_fingerprint_and_closed_boundary() -> None:
    repo, identity, case = _fixture_repo()
    catalog = _catalog(repo, case)
    kwargs = {
        "warmup_bars": int(case["warmup_bars"]),
        "horizon_ms": int(case["horizon_ms"]),
    }
    first = catalog.build(**kwargs)
    second = catalog.build(**kwargs)
    assert second is first
    assert catalog.diagnostics()["cache_hits"] == 1

    interval_ms = int(case["interval_ms"])
    repo.rows[(identity.exchange, identity.market_type, identity.symbol, "1m")].append(
        make_bar(int(case["start_ms"]) + 13 * interval_ms, interval_ms=interval_ms)
    )
    third = catalog.build(**kwargs)
    assert third is not first
    assert third.source_fingerprint != first.source_fingerprint
    assert catalog.diagnostics()["cache_misses"] == 2


def test_catalog_rejects_non_native_misaligned_and_insufficient_series() -> None:
    case = _case()
    identity_payload = case["identity"]
    assert isinstance(identity_payload, dict)
    identity = FixtureIdentity(**identity_payload)
    start_ms = int(case["start_ms"])
    interval_ms = int(case["interval_ms"])

    repo = FakeKlinesRepo()
    repo.add_rows(identity, "2m", [make_bar(start_ms, interval_ms=120_000)])
    non_native = _catalog(repo, case).build(warmup_bars=0, horizon_ms=60_000)
    entry = non_native.require_entry(
        ReplaySeriesIdentity(identity.exchange, identity.market_type, identity.symbol)
    )
    assert entry.selected_base_interval is None
    assert "no_native_local_interval" in entry.limitations

    repo = FakeKlinesRepo()
    repo.add_rows(
        identity,
        "1m",
        [make_bar(start_ms + 1 + offset * interval_ms) for offset in range(4)],
    )
    misaligned = _catalog(repo, case).build(warmup_bars=0, horizon_ms=60_000)
    entry = misaligned.require_entry(
        ReplaySeriesIdentity(identity.exchange, identity.market_type, identity.symbol)
    )
    assert entry.selected_base_interval is None
    assert any("interval_alignment_invalid" in item for item in entry.limitations)

    repo = FakeKlinesRepo()
    repo.add_rows(identity, "1m", [make_bar(start_ms), make_bar(start_ms + interval_ms)])
    insufficient = _catalog(repo, case).build(warmup_bars=2, horizon_ms=180_000)
    entry = insufficient.require_entry(
        ReplaySeriesIdentity(identity.exchange, identity.market_type, identity.symbol)
    )
    assert entry.eligible_window_count == 0
    with pytest.raises(ReplayDomainError) as error:
        _catalog(repo, case).select_random(entry, seed=1)
    assert error.value.code is ReplayErrorCode.NO_ELIGIBLE_WINDOW


def test_catalog_validates_phase_limits_before_scanning() -> None:
    repo, _, case = _fixture_repo()
    catalog = _catalog(repo, case)
    with pytest.raises(ReplayDomainError, match="warmup"):
        catalog.build(warmup_bars=5_001, horizon_ms=60_000)
    with pytest.raises(ReplayDomainError, match="horizon"):
        catalog.build(warmup_bars=0, horizon_ms=31 * 86_400_000)
    assert not any(name == "scan_gaps" for name, _ in repo.calls)
