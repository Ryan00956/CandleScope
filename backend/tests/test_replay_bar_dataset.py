from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.data_engine.storage import klines_repo
from app.replay.canonical import canonical_sha256
from app.replay.catalog import ReplayCatalog, ReplaySeriesIdentity
from app.replay.dataset import BarDatasetBuilder, BarDatasetPool
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.sources.bar_source import BarReplaySource
from tests.fixtures.replay.fakes import FakeKlinesRepo, FixtureIdentity, make_bar


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "replay" / "catalog_case_v1.json"


def _case() -> dict[str, object]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _repo_entry_window() -> tuple[
    FakeKlinesRepo,
    ReplayCatalog,
    object,
    object,
    dict[str, object],
]:
    case = _case()
    identity_payload = case["identity"]
    assert isinstance(identity_payload, dict)
    fixture_identity = FixtureIdentity(**identity_payload)
    start_ms = int(case["start_ms"])
    interval_ms = int(case["interval_ms"])
    gap_offsets = set(case["gap_offsets"])
    rows = [
        make_bar(start_ms + offset * interval_ms, price=str(100 + offset))
        for offset in range(int(case["bar_count"]))
        if offset not in gap_offsets
    ]
    repo = FakeKlinesRepo()
    repo.add_rows(fixture_identity, "1m", rows)
    repo.add_rows(
        fixture_identity,
        "2m",
        [{**row, "interval": "2m"} for row in rows[::2]],
    )
    catalog = ReplayCatalog(
        repo,
        native_intervals=lambda identity: ("1m", "5m"),
        now_ms=lambda: int(case["now_ms"]),
        max_scan_rows=4,
    )
    catalog_snapshot = catalog.build(
        warmup_bars=int(case["warmup_bars"]),
        horizon_ms=int(case["horizon_ms"]),
    )
    identity = ReplaySeriesIdentity(
        fixture_identity.exchange,
        fixture_identity.market_type,
        fixture_identity.symbol,
    )
    entry = catalog_snapshot.require_entry(identity)
    window = catalog.select_manual(
        entry,
        start_ms=start_ms + int(case["manual_start_offset"]) * interval_ms,
    )
    return repo, catalog, entry, window, case


def test_bar_dataset_is_immutable_normalized_and_matches_golden_hash() -> None:
    repo, _, entry, window, case = _repo_entry_window()
    builder = BarDatasetBuilder(repo, now_ms=lambda: int(case["now_ms"]))
    snapshot = builder.create(entry, window)
    expected = case["expected"]
    assert isinstance(expected, dict)

    assert snapshot.data_epoch == expected["dataset_epoch"]
    assert snapshot.row_count == 5
    assert snapshot.warmup_bars == 2
    assert snapshot.replay_rows[0].open_time_ms == window.replay_start_ms
    assert snapshot.rows[0].open == "106"
    assert snapshot.rows[0].close == "106.5"
    assert snapshot.rows[0].volume == "10"
    assert snapshot.provenance.gap_count == 0
    assert snapshot.provenance.first_open_ms == snapshot.rows[0].open_time_ms
    assert snapshot.provenance.last_open_ms == snapshot.rows[-1].open_time_ms
    assert snapshot.snapshot_ref().data_epoch == snapshot.data_epoch
    assert snapshot.data_epoch == canonical_sha256(snapshot.hash_payload())


def test_source_mutation_after_creation_does_not_change_snapshot() -> None:
    repo, _, entry, window, case = _repo_entry_window()
    builder = BarDatasetBuilder(repo, now_ms=lambda: int(case["now_ms"]))
    snapshot = builder.create(entry, window)
    original_rows = snapshot.rows
    original_epoch = snapshot.data_epoch
    key = (entry.identity.exchange, entry.identity.market_type, entry.identity.symbol, "1m")
    for row in repo.rows[key]:
        if int(row["open_time"]) == window.replay_start_ms:
            row["close"] = 999.0
            row["high"] = 1_000.0

    assert snapshot.rows is original_rows
    assert snapshot.data_epoch == original_epoch
    assert snapshot.replay_rows[0].close != "999"
    changed = builder.create(entry, window)
    assert changed.data_epoch != original_epoch
    assert changed.replay_rows[0].close == "999"


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda rows: list(reversed(rows)), "strictly increasing"),
        (lambda rows: rows[:2] + [dict(rows[1])] + rows[2:], "row count"),
        (lambda rows: rows[:1] + rows[2:], "row count"),
        (lambda rows: [{**rows[0], "high": 1.0}] + rows[1:], "OHLC"),
        (lambda rows: [{**rows[0], "volume": -1.0}] + rows[1:], "volume"),
        (lambda rows: [{**rows[0], "close": float("nan")}] + rows[1:], "close"),
        (lambda rows: [{**rows[0], "open_time": "invalid"}] + rows[1:], "open_time"),
        (lambda rows: [{**rows[0], "close_time": rows[0]["open_time"]}] + rows[1:], "close_time"),
    ],
)
def test_bar_dataset_rejects_malformed_or_incomplete_rows(mutate, message: str) -> None:
    repo, _, entry, window, case = _repo_entry_window()
    repo.query_transform = mutate
    builder = BarDatasetBuilder(repo, now_ms=lambda: int(case["now_ms"]))
    with pytest.raises(ReplayDomainError, match=message):
        builder.create(entry, window)


def test_bar_dataset_revalidates_gap_scan_and_closed_boundary() -> None:
    repo, _, entry, window, case = _repo_entry_window()
    key = (entry.identity.exchange, entry.identity.market_type, entry.identity.symbol, "1m")
    repo.rows[key] = [
        row for row in repo.rows[key] if int(row["open_time"]) != window.warmup_start_ms
    ]
    builder = BarDatasetBuilder(repo, now_ms=lambda: int(case["now_ms"]))
    with pytest.raises(ReplayDomainError) as gap:
        builder.create(entry, window)
    assert gap.value.code in {ReplayErrorCode.DATA_GAP, ReplayErrorCode.DATASET_INCOMPLETE}

    repo, _, entry, window, case = _repo_entry_window()
    forming_builder = BarDatasetBuilder(
        repo,
        now_ms=lambda: window.replay_end_open_ms,
    )
    with pytest.raises(ReplayDomainError, match="closed"):
        forming_builder.create(entry, window)


def test_bar_dataset_freezes_one_validated_clock_read() -> None:
    repo, _, entry, window, case = _repo_entry_window()
    calls = 0

    def now_ms() -> int:
        nonlocal calls
        calls += 1
        return int(case["now_ms"])

    snapshot = BarDatasetBuilder(repo, now_ms=now_ms).create(entry, window)
    assert snapshot.row_count == window.total_rows
    assert calls == 1

    with pytest.raises(ReplayDomainError, match="clock"):
        BarDatasetBuilder(repo, now_ms=lambda: "invalid").create(entry, window)


def test_dataset_limits_and_pool_reject_without_evicting_active_snapshots() -> None:
    repo, _, entry, window, case = _repo_entry_window()
    too_small = BarDatasetBuilder(
        repo,
        now_ms=lambda: int(case["now_ms"]),
        max_rows=4,
    )
    with pytest.raises(ReplayDomainError) as rows_error:
        too_small.create(entry, window)
    assert rows_error.value.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED

    snapshot = BarDatasetBuilder(repo, now_ms=lambda: int(case["now_ms"])).create(
        entry, window
    )
    pool = BarDatasetPool(max_active_snapshots=1, max_total_bytes=snapshot.estimated_size_bytes * 2)
    pool.pin("session-a", snapshot)
    with pytest.raises(ReplayDomainError):
        pool.pin("session-b", snapshot)
    assert pool.diagnostics()["active_sessions"] == 1
    assert pool.get("session-a") is snapshot
    pool.release("session-a")
    pool.pin("session-b", snapshot)
    assert pool.get("session-b") is snapshot

    memory_pool = BarDatasetPool(
        max_active_snapshots=2,
        max_total_bytes=snapshot.estimated_size_bytes - 1,
    )
    with pytest.raises(ReplayDomainError, match="memory"):
        memory_pool.pin("session-c", snapshot)
    assert memory_pool.diagnostics()["active_sessions"] == 0


def test_bar_replay_source_implements_cursor_peek_next_and_advance_until() -> None:
    repo, _, entry, window, case = _repo_entry_window()
    snapshot = BarDatasetBuilder(repo, now_ms=lambda: int(case["now_ms"])).create(
        entry, window
    )
    source = BarReplaySource(snapshot)

    assert source.cursor().source_sequence == 0
    assert source.peek() is snapshot.replay_rows[0]
    assert source.peek().open_time_ms == window.replay_start_ms
    first = source.next()
    assert first is snapshot.replay_rows[0]
    assert source.cursor().source_sequence == 1
    second = snapshot.replay_rows[1]
    advanced = source.advance_until(second.close_time_ms)
    assert advanced == (second,)
    while not source.exhausted():
        source.next()
    assert source.peek() is None
    assert source.next() is None
    assert source.cursor().at_end is True
    assert source.snapshot_ref() == snapshot.snapshot_ref()


def test_real_sqlite_adapter_snapshot_stays_detached_from_later_upsert(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "klines.db"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", db_path)
    klines_repo.init_klines_storage()
    start_ms = 1_710_000_000_000
    rows = [make_bar(start_ms + offset * 60_000, price=str(100 + offset)) for offset in range(6)]
    klines_repo.upsert_klines("BTCUSDT", "1m", rows)
    adapter = klines_repo.KlinesRepoAdapter()
    catalog = ReplayCatalog(
        adapter,
        native_intervals=lambda identity: ("1m",),
        now_ms=lambda: start_ms + 7 * 60_000,
    )
    catalog_snapshot = catalog.build(warmup_bars=1, horizon_ms=3 * 60_000)
    entry = catalog_snapshot.require_entry(ReplaySeriesIdentity("binance", "spot", "BTCUSDT"))
    window = catalog.select_manual(entry, start_ms=start_ms + 2 * 60_000)
    builder = BarDatasetBuilder(adapter, now_ms=lambda: start_ms + 7 * 60_000)
    snapshot = builder.create(entry, window)

    changed = make_bar(start_ms + 2 * 60_000, price="900")
    klines_repo.upsert_klines("BTCUSDT", "1m", [changed])

    assert snapshot.replay_rows[0].open == "102"
    assert builder.create(entry, window).replay_rows[0].open == "900"
    assert snapshot.data_epoch != builder.create(entry, window).data_epoch
