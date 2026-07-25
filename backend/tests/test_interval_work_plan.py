from __future__ import annotations

from app.data_engine.interval_resolution import IntervalPurpose, IntervalResolver
from app.data_engine.interval_work_plan import (
    build_interval_work_plan,
    resolve_interval_work_plan,
)


def test_89m_work_plan_matches_frontend_source_budgets() -> None:
    resolver = IntervalResolver()

    initial = resolve_interval_work_plan(
        resolver,
        exchange="binance",
        market_type="spot",
        interval="89m",
        requested_target_bars=1_500,
        source_row_budget=20_000,
    )
    before = resolve_interval_work_plan(
        resolver,
        exchange="binance",
        market_type="spot",
        interval="89m",
        requested_target_bars=500,
        source_row_budget=10_000,
    )

    assert initial.base_interval == "1m"
    assert initial.source_factor == 89
    assert initial.effective_target_bars == 221
    assert initial.planned_source_rows == 19_936
    assert initial.provider_pages(1_000) == 20
    assert initial.budget_limited is True
    assert before.effective_target_bars == 109
    assert before.planned_source_rows == 9_968
    assert before.provider_pages(1_000) == 10


def test_native_route_has_no_derived_padding() -> None:
    resolver = IntervalResolver()
    plan = resolve_interval_work_plan(
        resolver,
        exchange="binance",
        market_type="spot",
        interval="60m",
        requested_target_bars=1_500,
        source_row_budget=20_000,
    )

    assert plan.derived is False
    assert plan.base_interval == "1h"
    assert plan.source_factor == 1
    assert plan.source_padding_bars == 0
    assert plan.effective_target_bars == 1_500
    assert plan.planned_source_rows == 1_500
    assert plan.budget_limited is False


def test_budget_that_cannot_fit_one_padded_target_fails_closed() -> None:
    resolver = IntervalResolver()
    route = resolver.resolve(
        exchange="binance",
        market_type="spot",
        interval="10001m",
        purpose=IntervalPurpose.HISTORY,
    )
    plan = build_interval_work_plan(route, 1_500, 10_000)

    assert plan.source_factor == 10_001
    assert plan.effective_target_bars == 0
    assert plan.planned_source_rows == 0
    assert plan.budget_limited is True


def test_work_plan_metadata_contract_is_stable() -> None:
    resolver = IntervalResolver()
    plan = resolve_interval_work_plan(
        resolver,
        exchange="binance",
        market_type="spot",
        interval="89m",
        requested_target_bars=500,
        source_row_budget=10_000,
    )

    assert plan.to_metadata() == {
        "interval_work_plan": {
            "requested_target_bars": 500,
            "effective_target_bars": 109,
            "base_interval": "1m",
            "source_factor": 89,
            "source_padding_bars": 3,
            "planned_source_rows": 9_968,
            "source_row_budget": 10_000,
            "budget_limited": True,
            "derived": True,
        },
    }
