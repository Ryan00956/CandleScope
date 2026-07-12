from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.models import FetchedBar
from app.data_engine.backfill.reconciler import Reconciler
from app.data_engine.bar_aggregator import BarAggregator, BarAggregatorConfig
from app.data_engine.data_manager.cache import BarCache
from app.data_engine.data_manager.config import QueryConfig
from app.data_engine.data_manager.custom_query import (
    CustomIntervalQueryService,
    _aggregate_rows_to_interval,
    _bar_data_to_storage_rows,
)
from app.data_engine.data_manager.maintenance import _aggregate_custom_rows
from app.data_engine.data_manager.models import BarData, QueryResult, QuerySource
from app.data_engine.interval_policy import (
    aggregate_rows_by_month,
    compute_bucket_close_ms,
    compute_bucket_end_ms,
    compute_bucket_start,
    compute_bucket_start_ms,
    compute_month_bucket,
    parse_interval_ms,
)


def _ms(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> int:
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp() * 1000)


def _rows(start_ms: int, count: int, step_ms: int) -> list[dict]:
    rows: list[dict] = []
    for idx in range(count):
        open_time = start_ms + idx * step_ms
        value = float(idx + 1)
        rows.append({
            "open_time": open_time,
            "close_time": open_time + step_ms - 1,
            "open": value,
            "high": value + 0.25,
            "low": value - 0.5,
            "close": value + 0.1,
            "volume": value,
            "quote_volume": value * 10,
            "trades": idx + 1,
            "taker_buy_base": value / 2,
            "taker_buy_quote": value * 5,
        })
    return rows


def _as_ohlcv(row: dict) -> tuple[int, float, float, float, float, float]:
    return (
        int(row["open_time"]),
        round(float(row["open"]), 8),
        round(float(row["high"]), 8),
        round(float(row["low"]), 8),
        round(float(row["close"]), 8),
        round(float(row["volume"]), 8),
    )


def _state_rows(states) -> list[dict]:
    return [state.to_storage_dict() for state in states]


async def _aggregate_with_query(
    target_interval: str,
    source_interval: str,
    rows: list[dict],
) -> list[dict]:
    agg = BarAggregator(BarAggregatorConfig())
    base_bars = [BarData.from_storage_row(row) for row in rows]

    def _base_query(*args, **kwargs) -> QueryResult:
        return QueryResult(
            bars=base_bars,
            symbol="BTC-USDT",
            interval=source_interval,
            source=QuerySource.CACHE,
            total=len(base_bars),
            has_more=False,
            cache_hit=True,
        )

    service = CustomIntervalQueryService(
        cache=BarCache(),
        config=QueryConfig(default_limit=1000, max_limit=5000),
        base_query=_base_query,
        bar_aggregator=agg,
    )
    result = service.query_from_base(
        symbol="BTC-USDT",
        interval=target_interval,
        start_ms=None,
        end_ms=None,
        limit=1000,
        started_at=0.0,
        exchange="okx",
        market_type="spot",
    )
    return [{
        "open_time": bar.time_ms,
        "open": bar.open,
        "high": bar.high,
        "low": bar.low,
        "close": bar.close,
        "volume": bar.volume,
        "is_closed": bar.is_closed,
    } for bar in result.bars]


async def _aggregate_with_bar_aggregator(
    target_interval: str,
    source_interval: str,
    rows: list[dict],
) -> list[dict]:
    agg = BarAggregator(BarAggregatorConfig())
    states = await agg.aggregate_batch(
        "BTC-USDT",
        target_interval,
        source_interval,
        rows,
        exchange="okx",
        market_type="spot",
    )
    return _state_rows(states)


async def _aggregate_with_maintenance(
    target_interval: str,
    source_interval: str,
    rows: list[dict],
) -> list[dict]:
    return await _aggregate_custom_rows(
        symbol="BTC-USDT",
        custom_interval=target_interval,
        base_interval=source_interval,
        base_rows=rows,
        aggregator_config=BarAggregatorConfig().snapshot(),
        exchange="okx",
        market_type="spot",
    )


def _aggregate_with_backfill_fallback(
    target_interval: str,
    rows: list[dict],
) -> list[dict]:
    custom_ms = parse_interval_ms(target_interval)
    assert custom_ms is not None
    bars = [
        FetchedBar(
            symbol="BTC-USDT",
            interval="base",
            open_time=int(row["open_time"]),
            close_time=int(row["close_time"]),
            open=float(row["open"]),
            high=float(row["high"]),
            low=float(row["low"]),
            close=float(row["close"]),
            volume=float(row["volume"]),
            exchange="okx",
            market_type="spot",
            quote_volume=float(row.get("quote_volume", 0)),
            trades=int(row.get("trades", 0)),
            taker_buy_base=float(row.get("taker_buy_base", 0)),
            taker_buy_quote=float(row.get("taker_buy_quote", 0)),
        )
        for row in rows
    ]
    reconciler = Reconciler(BackfillConfig(), storage=None)  # type: ignore[arg-type]
    return [
        bar.to_storage_dict()
        for bar in reconciler._aggregate_to_custom(
            bars,
            "BTC-USDT",
            target_interval,
            custom_ms,
            0,
        )
    ]


def test_interval_policy_weekly_and_monthly_calendar_alignment() -> None:
    one_week_ms = parse_interval_ms("1w")
    two_month_ms = parse_interval_ms("2M")
    assert one_week_ms is not None
    assert two_month_ms is not None

    monday = _ms(2024, 1, 1)
    sunday = _ms(2024, 1, 7, 12)
    next_monday = _ms(2024, 1, 8)
    assert compute_bucket_start_ms(sunday, one_week_ms, interval="1w") == monday
    assert compute_bucket_start(sunday // 1000, one_week_ms // 1000, interval="1w") == monday // 1000
    assert compute_bucket_start_ms(next_monday, one_week_ms, interval="1w") == next_monday

    april = _ms(2024, 4, 30, 12)
    march_bucket = _ms(2024, 3, 1)
    may_bucket = _ms(2024, 5, 1)
    assert compute_bucket_start_ms(april, two_month_ms, interval="2M") == march_bucket
    assert compute_bucket_start(april // 1000, two_month_ms // 1000, interval="2M") == (
        march_bucket // 1000
    )
    assert compute_month_bucket(april // 1000, 2) == march_bucket // 1000
    assert compute_bucket_end_ms(march_bucket, two_month_ms, interval="2M") == may_bucket
    assert compute_bucket_close_ms(march_bucket, two_month_ms, interval="2M") == may_bucket - 1


def test_custom_interval_aggregation_preserves_forming_state() -> None:
    bars = [
        BarData(time=0, open=1, high=2, low=1, close=2, volume=10, is_closed=True),
        BarData(time=60, open=2, high=3, low=2, close=3, volume=20, is_closed=False),
    ]
    rows = [bar.to_dict() for bar in bars]

    fixed = _aggregate_rows_to_interval(
        rows,
        120,
        interval="2m",
        source_interval_seconds=60,
    )
    monthly = aggregate_rows_by_month(
        rows,
        months=1,
        source_interval_seconds=60,
    )
    read_only = CustomIntervalQueryService._aggregate_read_only(
        bars,
        "2m",
        120,
        source_interval="1m",
    )
    storage_rows = _bar_data_to_storage_rows(bars, "1m")

    assert fixed[0]["is_closed"] is False
    assert monthly[0]["is_closed"] is False
    assert read_only[0].is_closed is False
    assert storage_rows[-1]["is_closed"] is False

    recovered_rows = [
        {**rows[0], "is_closed": False},
        {**rows[1], "is_closed": True},
    ]
    recovered_bars = [BarData.from_dict(item) for item in recovered_rows]
    assert _aggregate_rows_to_interval(
        recovered_rows,
        120,
        interval="2m",
        source_interval_seconds=60,
    )[0]["is_closed"] is True
    assert CustomIntervalQueryService._aggregate_read_only(
        recovered_bars,
        "2m",
        120,
        source_interval="1m",
    )[0].is_closed is True

    end_of_month_rows = [
        {**rows[0], "time": _ms(2024, 1, 30) // 1000, "is_closed": False},
        {**rows[1], "time": _ms(2024, 1, 31) // 1000, "is_closed": True},
    ]
    assert aggregate_rows_by_month(
        end_of_month_rows,
        months=1,
        source_interval_seconds=86_400,
    )[0]["is_closed"] is True


def test_custom_query_bar_aggregator_preserves_forming_state() -> None:
    async def _run() -> None:
        now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        bucket_start_ms = (
            compute_bucket_start_ms(now_ms, 120_000, interval="2m") + 120_000
        )
        rows = _rows(bucket_start_ms, 2, 60_000)
        rows[0]["is_closed"] = True
        rows[1]["is_closed"] = False

        aggregated = await _aggregate_with_query("2m", "1m", rows)

        assert aggregated[0]["is_closed"] is False

    asyncio.run(_run())


def test_custom_query_paths_agree_when_a_newer_component_implies_close() -> None:
    async def _run() -> None:
        now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        bucket_start_ms = (
            compute_bucket_start_ms(now_ms, 120_000, interval="2m") + 120_000
        )
        rows = _rows(bucket_start_ms, 2, 60_000)
        rows[0]["is_closed"] = False
        rows[1]["is_closed"] = True

        aggregated = await _aggregate_with_query("2m", "1m", rows)

        assert aggregated[0]["is_closed"] is True

    asyncio.run(_run())


def test_custom_query_keeps_a_partial_target_bucket_forming() -> None:
    async def _run() -> None:
        now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
        bucket_start_ms = (
            compute_bucket_start_ms(now_ms, 120_000, interval="2m") + 120_000
        )
        rows = _rows(bucket_start_ms, 1, 60_000)
        rows[0]["is_closed"] = True

        aggregated = await _aggregate_with_query("2m", "1m", rows)

        assert aggregated[0]["is_closed"] is False

    asyncio.run(_run())


def test_custom_interval_paths_match_for_45m_91m_and_2m() -> None:
    async def _run_case(target_interval: str, source_interval: str, rows: list[dict]) -> None:
        via_agg = await _aggregate_with_bar_aggregator(target_interval, source_interval, rows)
        via_query = await _aggregate_with_query(target_interval, source_interval, rows)
        via_maintenance = await _aggregate_with_maintenance(target_interval, source_interval, rows)
        via_backfill = _aggregate_with_backfill_fallback(target_interval, rows)

        expected = [_as_ohlcv(row) for row in via_agg]
        assert [_as_ohlcv(row) for row in via_query] == expected
        assert [_as_ohlcv(row) for row in via_maintenance] == expected
        assert [_as_ohlcv(row) for row in via_backfill] == expected

        if target_interval == "2M":
            assert via_agg[0]["open_time"] == _ms(2024, 3, 1)
            assert via_agg[0]["close_time"] == _ms(2024, 5, 1) - 1
            assert via_backfill[0]["close_time"] == _ms(2024, 5, 1) - 1

    async def _run() -> None:
        await _run_case("45m", "15m", _rows(0, 3, 15 * 60_000))
        await _run_case("91m", "1m", _rows(0, 91, 60_000))
        await _run_case("2M", "1d", _rows(_ms(2024, 3, 1), 61, 86_400_000))

    asyncio.run(_run())
