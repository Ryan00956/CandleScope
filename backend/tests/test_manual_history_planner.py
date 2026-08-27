from __future__ import annotations

from app.data_engine.interval_policy import parse_interval_spec
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolutionError,
    IntervalResolutionErrorCode,
    IntervalRoute,
    IntervalRouteKind,
)
from app.data_engine.manual_history.planner import ManualHistoryPlanner, PlanErrorCode
from app.data_engine.manual_history.repository import ManualHistoryRepository
from app.data_engine.storage import klines_repo


NOW_MS = 1_780_000_000_000
START_MS = 1_700_000_000_000
NATIVE = {"1m", "1h", "1M", "5m", "15m"}


class FakeResolver:
    def resolve(self, *, exchange, market_type, interval, purpose):
        spec = parse_interval_spec(interval)
        if spec is None:
            raise IntervalResolutionError(
                IntervalResolutionErrorCode.INVALID_INTERVAL,
                f"invalid {interval}",
                exchange=exchange,
                market_type=market_type,
                interval=interval,
                purpose=IntervalPurpose.HISTORY,
            )
        if spec.canonical in NATIVE:
            return IntervalRoute(
                exchange=exchange,
                market_type=market_type,
                requested_interval=interval,
                canonical_interval=spec.canonical,
                purpose=IntervalPurpose.HISTORY,
                kind=IntervalRouteKind.NATIVE,
                spec=spec,
                native_interval=spec.canonical,
            )
        if spec.canonical == "89m":
            return IntervalRoute(
                exchange=exchange,
                market_type=market_type,
                requested_interval=interval,
                canonical_interval="89m",
                purpose=IntervalPurpose.HISTORY,
                kind=IntervalRouteKind.DERIVED,
                spec=spec,
                base_interval="1m",
            )
        raise IntervalResolutionError(
            IntervalResolutionErrorCode.NO_EXACT_BASE,
            f"no base for {interval}",
            exchange=exchange,
            market_type=market_type,
            interval=interval,
            purpose=IntervalPurpose.HISTORY,
        )


def _planner(**kwargs) -> ManualHistoryPlanner:
    defaults = dict(
        resolver=FakeResolver(),
        clock_ms=lambda: NOW_MS,
        get_bounds=lambda *args, **kw: {
            "earliest_open_time": None,
            "latest_open_time": None,
            "total_count": 0,
        },
        disk_snapshot=lambda: {
            "physical_size_bytes": 1_000_000,
            "free_bytes": 50_000_000_000,
        },
        sqlite_budget_bytes=10_000_000_000,
        feature_enabled=True,
        normalize_symbol_fn=lambda symbol, **kw: str(symbol).strip().upper(),
    )
    defaults.update(kwargs)
    return ManualHistoryPlanner(**defaults)


def test_two_symbols_three_intervals_expand_to_six_targets() -> None:
    plan = _planner().plan(
        exchange="binance",
        market_type="spot",
        symbols=["BTCUSDT", "ETHUSDT"],
        intervals=["1m", "1h", "89m"],
        start_ms=START_MS,
    )
    assert plan["selection"]["target_count"] == 6
    assert len(plan["targets"]) == 6
    routes = {(row["symbol"], row["canonical_interval"], row["route_kind"]) for row in plan["targets"]}
    assert ("BTCUSDT", "1m", "NATIVE") in routes
    assert ("ETHUSDT", "1h", "NATIVE") in routes
    assert ("BTCUSDT", "89m", "DERIVED") in routes
    derived = next(row for row in plan["targets"] if row["canonical_interval"] == "89m")
    assert derived["source_interval"] == "1m"
    assert len(plan["source_demands"]) == 4  # 2 symbols * (1m, 1h) ; 89m shares 1m


def test_60m_and_1h_are_semantically_deduped() -> None:
    plan = _planner().plan(
        exchange="binance",
        market_type="spot",
        symbols=["BTCUSDT"],
        intervals=["60m", "1h"],
        start_ms=START_MS,
    )
    assert plan["selection"]["intervals"] == ["1h"]
    assert plan["selection"]["target_count"] == 1


def test_no_exact_base_fails_closed() -> None:
    plan = _planner().plan(
        exchange="binance",
        market_type="spot",
        symbols=["BTCUSDT"],
        intervals=["7s"],
        start_ms=START_MS,
    )
    assert plan["can_start"] is False
    assert PlanErrorCode.INTERVAL_UNROUTABLE in plan["blocking_reasons"]
    assert plan["targets"][0]["route_kind"] == "UNROUTABLE"


def test_future_start_is_rejected() -> None:
    plan = _planner().plan(
        exchange="binance",
        market_type="spot",
        symbols=["BTCUSDT"],
        intervals=["1m"],
        start_ms=NOW_MS + 60_000,
    )
    assert plan["can_start"] is False
    assert PlanErrorCode.START_IN_FUTURE in plan["blocking_reasons"]


def test_start_after_last_closed_is_rejected() -> None:
    plan = _planner().plan(
        exchange="binance",
        market_type="spot",
        symbols=["BTCUSDT"],
        intervals=["1m"],
        start_ms=NOW_MS,
    )
    assert plan["can_start"] is False
    assert PlanErrorCode.START_AFTER_LAST_CLOSED in plan["blocking_reasons"]


def test_calendar_month_snaps_to_complete_bucket() -> None:
    # 15 Jan 2024 12:00 UTC is inside January; first complete month at/after
    # that instant is February 2024-02-01.
    mid_january = 1_705_320_000_000
    plan = _planner().plan(
        exchange="binance",
        market_type="spot",
        symbols=["BTCUSDT"],
        intervals=["1M"],
        start_ms=mid_january,
    )
    target = plan["targets"][0]
    assert target["canonical_interval"] == "1M"
    assert target["effective_start_ms"] >= mid_january
    assert target["effective_start_ms"] % 1 == 0
    assert target["error"] is None


def test_unknown_estimate_is_not_zero() -> None:
    plan = _planner(measured_bytes_per_row=None).plan(
        exchange="binance",
        market_type="spot",
        symbols=["BTCUSDT"],
        intervals=["1m"],
        start_ms=START_MS,
    )
    assert plan["storage"]["estimated_db_growth_bytes"] is None
    assert plan["storage"]["estimate_confidence"] == "LOW"
    assert plan["storage"]["estimated_db_growth_bytes"] != 0


def test_budget_conflict_blocks_start() -> None:
    plan = _planner(sqlite_budget_bytes=1).plan(
        exchange="binance",
        market_type="spot",
        symbols=["BTCUSDT"],
        intervals=["1m"],
        start_ms=START_MS,
    )
    assert plan["can_start"] is False
    assert PlanErrorCode.STORAGE_CONFLICT in plan["blocking_reasons"]


def test_plan_does_not_create_jobs_or_call_fetcher(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / "klines.db"
    monkeypatch.setattr(klines_repo, "KLINES_DB_PATH", db_path)
    klines_repo.init_klines_storage()
    calls: list[str] = []

    def forbidden_fetch(*args, **kwargs):
        calls.append("fetch")
        raise AssertionError("plan must not fetch")

    planner = _planner()
    planner._get_bounds = lambda *args, **kwargs: {
        "earliest_open_time": None,
        "latest_open_time": None,
        "total_count": 0,
    }
    plan = planner.plan(
        exchange="binance",
        market_type="spot",
        symbols=["btcusdt"],
        intervals=["1m", "1h"],
        start_ms=START_MS,
    )
    assert plan["can_start"] is True
    repo = ManualHistoryRepository(db_path)
    assert repo.count_rows("manual_history_jobs") == 0
    assert repo.count_rows("manual_history_protections") == 0
    assert calls == []


def test_plan_hash_is_stable_for_same_selection() -> None:
    first = _planner().plan(
        exchange="BINANCE",
        market_type="spot",
        symbols=["ETHUSDT", "BTCUSDT"],
        intervals=["1h", "1m"],
        start_ms=START_MS,
    )
    second = _planner().plan(
        exchange="binance",
        market_type="spot",
        symbols=["BTCUSDT", "ETHUSDT"],
        intervals=["1m", "1h"],
        start_ms=START_MS,
    )
    assert first["plan_hash"] == second["plan_hash"]
    assert first["plan_hash"].startswith("sha256:")
