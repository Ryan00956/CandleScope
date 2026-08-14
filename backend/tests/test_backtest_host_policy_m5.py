from __future__ import annotations

from decimal import Decimal
import json
from pathlib import Path

import pytest

from app.backtest.errors import BacktestError
from app.backtest.reports import build_report
from app.backtest.service import BacktestService
from app.backtest.strategy.host_policy import HOST_POLICY_REVISION, PlanningContext
from app.backtest.strategy.pyne_adapter import HostPlan, PyneHostPlanner
from app.backtest.strategy.protocol import DeterministicFakeProvider
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent
from app.simulation.kernel import SimulationKernel


def config(policy: str, **values: object) -> dict[str, object]:
    result: dict[str, object] = {
        "sizing_policy": policy,
        "fixed_qty": "1",
        "fixed_notional": "200",
        "equity_percent": "30",
        "risk_per_stop_percent": "10",
        "stop_distance": "5",
        "max_abs_position_qty": "1000",
        "max_notional": "1000000",
        "max_leverage": "20",
        "max_order_risk": "1000000",
        "max_active_orders": 100,
        "max_cumulative_fees": "1000000",
        "max_drawdown_percent": "50",
        "cooldown_events": 0,
    }
    result.update(values)
    return result


def context(**values: object) -> PlanningContext:
    base: dict[str, object] = {
        "sequence": 1,
        "event_time_ms": 86_400_000,
        "actual_position": Decimal("0"),
        "projected_position": Decimal("0"),
        "reference_price": Decimal("100"),
        "equity": Decimal("1000"),
        "initial_balance": Decimal("1000"),
        "cumulative_fees": Decimal("0"),
        "leverage": Decimal("10"),
        "active_order_count": 0,
        "quantity_step": Decimal("0.1"),
        "min_notional": Decimal("5"),
        "contract_multiplier": Decimal("1"),
        "rule_revision": "rules-1",
        "taker_fee_bps": Decimal("5"),
        "maker_fee_bps": Decimal("2"),
    }
    base.update(values)
    return PlanningContext(**base)  # type: ignore[arg-type]


SIGNAL = {
    "schemaVersion": "candlescope.strategy-output/1",
    "sequence": 1,
    "kind": "SIGNAL",
    "payload": {"direction": "LONG", "reasonCode": "same-decision"},
    "stateHash": "sha256:state",
    "outputHash": "sha256:output",
}


def test_four_sizing_policies_preserve_provider_decision_and_change_quantity() -> None:
    quantities: dict[str, str] = {}
    decisions: list[dict[str, object]] = []
    for policy in (
        "FIXED_QTY_V1",
        "FIXED_NOTIONAL_V1",
        "EQUITY_PERCENT_V1",
        "RISK_PER_STOP_V1",
    ):
        plan = PyneHostPlanner(config(policy)).plan(SIGNAL, context=context())
        assert isinstance(plan, HostPlan)
        quantities[policy] = plan[0]["qty"]
        decisions.append(plan.decision)
    assert quantities == {
        "FIXED_QTY_V1": "1",
        "FIXED_NOTIONAL_V1": "2",
        "EQUITY_PERCENT_V1": "3",
        "RISK_PER_STOP_V1": "20",
    }
    assert all(item == decisions[0] for item in decisions)


def test_fixed_notional_quantizes_down_and_equity_percent_uses_visible_equity() -> None:
    fixed = PyneHostPlanner(config("FIXED_NOTIONAL_V1", fixed_notional="100"))
    assert (
        fixed.plan(
            SIGNAL,
            context=context(
                reference_price=Decimal("33"), quantity_step=Decimal("0.1")
            ),
        )[0]["qty"]
        == "3.0"
    )
    equity = PyneHostPlanner(config("EQUITY_PERCENT_V1", equity_percent="10"))
    first = equity.plan(SIGNAL, context=context(equity=Decimal("1000")))
    second = PyneHostPlanner(config("EQUITY_PERCENT_V1", equity_percent="10")).plan(
        SIGNAL, context=context(equity=Decimal("500"))
    )
    assert first[0]["qty"] == "1"
    assert second[0]["qty"] == "0.5"


def test_risk_per_stop_missing_distance_fails_closed_without_fallback() -> None:
    planner = PyneHostPlanner(config("RISK_PER_STOP_V1", stop_distance=None))
    plan = planner.plan(SIGNAL, context=context())
    assert plan == []
    assert planner.rejections[0]["reason"] == "ORDER_REJECTED_RISK"
    assert planner.rejections[0]["reason_code"] == "RISK_STOP_DISTANCE_REQUIRED"


@pytest.mark.parametrize(
    "provider_output",
    [
        {
            **SIGNAL,
            "payload": {
                "direction": "LONG",
                "balance": "999999999",
                "bypass_risk": True,
            },
        },
        {
            "kind": "ORDER_INTENT",
            "payload": {
                "side": "BUY",
                "type": "MARKET",
                "qty": "1",
                "account_balance": "999999999",
                "bypass_risk": True,
            },
        },
    ],
)
def test_provider_cannot_mutate_balance_or_bypass_host_risk(
    provider_output: dict[str, object],
) -> None:
    visible = context(equity=Decimal("1000"))
    planner = PyneHostPlanner(config("FIXED_QTY_V1", max_notional="50"))
    assert planner.plan(provider_output, context=visible) == []
    assert planner.rejections[-1]["reason_code"] == "RISK_MAX_NOTIONAL"
    assert visible.equity == Decimal("1000")


@pytest.mark.parametrize(
    ("override", "reason_code"),
    [
        ({"max_abs_position_qty": "0.5"}, "RISK_MAX_POSITION_QTY"),
        ({"max_notional": "50"}, "RISK_MAX_NOTIONAL"),
        ({"max_leverage": "0.5"}, "RISK_MAX_LEVERAGE"),
        ({"max_order_risk": "4"}, "RISK_MAX_ORDER_RISK"),
        ({"max_active_orders": 1}, "RISK_MAX_ACTIVE_ORDERS"),
        ({"max_cumulative_fees": "0.01"}, "RISK_MAX_CUMULATIVE_FEES"),
        ({"max_drawdown_percent": "10"}, "RISK_MAX_DRAWDOWN"),
    ],
)
def test_each_host_risk_limit_rejects_with_structured_snapshot(
    override: dict[str, object], reason_code: str
) -> None:
    ctx_values: dict[str, object] = {}
    if reason_code == "RISK_MAX_ACTIVE_ORDERS":
        ctx_values["active_order_count"] = 1
    if reason_code == "RISK_MAX_CUMULATIVE_FEES":
        ctx_values["cumulative_fees"] = Decimal("0.009")
    planner = PyneHostPlanner(config("FIXED_QTY_V1", **override))
    if reason_code == "RISK_MAX_DRAWDOWN":
        planner.plan(None, context=context(equity=Decimal("1000"), sequence=1))
        ctx_values.update(equity=Decimal("800"), sequence=2)
    plan = planner.plan(SIGNAL, context=context(**ctx_values))
    assert plan == []
    rejected = planner.rejections[-1]
    assert rejected["reason"] == "ORDER_REJECTED_RISK"
    assert rejected["reason_code"] == reason_code
    assert rejected["policy_revision"] == HOST_POLICY_REVISION
    assert rejected["rule_revision"] == "rules-1"
    assert rejected["input_snapshot"]["reference_price"] == "100"


def test_daily_loss_enters_versioned_cooldown_and_survives_checkpoint() -> None:
    planner = PyneHostPlanner(
        config(
            "FIXED_QTY_V1",
            daily_loss_limit="100",
            cooldown_events=2,
        )
    )
    planner.plan(None, context=context(sequence=1, equity=Decimal("1000")))
    assert (
        planner.plan(SIGNAL, context=context(sequence=2, equity=Decimal("850"))) == []
    )
    assert planner.rejections[-1]["reason_code"] == "RISK_DAILY_LOSS"

    restored = PyneHostPlanner(
        config(
            "FIXED_QTY_V1",
            daily_loss_limit="100",
            cooldown_events=2,
        )
    )
    restored.restore(planner.snapshot())
    assert (
        restored.plan(SIGNAL, context=context(sequence=3, equity=Decimal("1000"))) == []
    )
    assert restored.rejections[-1]["reason_code"] == "RISK_COOLDOWN"
    assert restored.report()["cooldown_until_sequence"] == 4


def test_min_notional_conflict_and_reduce_only_cross_zero_are_distinct() -> None:
    too_small = PyneHostPlanner(config("FIXED_QTY_V1", fixed_qty="0.1"))
    assert too_small.plan(SIGNAL, context=context(min_notional=Decimal("50"))) == []
    assert too_small.rejections[0]["reason"] == "ORDER_REJECTED_RULES"
    assert too_small.rejections[0]["reason_code"] == "MIN_NOTIONAL"

    close = {
        "kind": "ORDER_INTENT",
        "payload": {
            "side": "SELL",
            "type": "MARKET",
            "qty": "2",
            "reduce_only": True,
        },
    }
    crossing = PyneHostPlanner(config("FIXED_QTY_V1"))
    assert (
        crossing.plan(
            close,
            context=context(
                actual_position=Decimal("1"), projected_position=Decimal("1")
            ),
        )
        == []
    )
    assert crossing.rejections[0]["reason_code"] == "RISK_REDUCE_ONLY_CROSSES_ZERO"


def test_reduce_only_can_close_below_minimum_and_ignores_opening_limits() -> None:
    close = {
        "kind": "ORDER_INTENT",
        "payload": {
            "side": "SELL",
            "type": "MARKET",
            "qty": "0.1",
            "reduce_only": True,
        },
    }
    planner = PyneHostPlanner(
        config(
            "FIXED_QTY_V1",
            max_abs_position_qty="0.01",
            max_notional="1",
            max_active_orders=1,
        )
    )
    plan = planner.plan(
        close,
        context=context(
            actual_position=Decimal("0.1"),
            projected_position=Decimal("0.1"),
            active_order_count=10,
            min_notional=Decimal("100"),
        ),
    )
    assert plan[0]["reduce_only"] is True


def test_reversal_risk_counts_only_new_exposure_after_closing_old_position() -> None:
    short_signal = {**SIGNAL, "payload": {"direction": "SHORT"}}
    planner = PyneHostPlanner(
        config("FIXED_QTY_V1", fixed_qty="1", max_order_risk="11")
    )
    plan = planner.plan(
        short_signal,
        context=context(actual_position=Decimal("1"), projected_position=Decimal("1")),
    )
    assert plan[0]["qty"] == "2"


def test_v2_reversal_reserves_only_net_incremental_exposure() -> None:
    events = (
        MarketEvent(
            sequence=1,
            event_time_ms=1,
            role="INSTRUMENT_RULES",
            payload={
                "rule_version": "rules-1",
                "contract_multiplier": "1",
                "price_tick": "0.1",
                "quantity_step": "0.001",
                "min_notional": "5",
                "maintenance_tiers": [
                    {
                        "notional_floor": "0",
                        "notional_cap": "1000000",
                        "maintenance_rate": "0.005",
                        "maintenance_deduction": "0",
                    }
                ],
            },
        ),
        MarketEvent(
            sequence=2,
            event_time_ms=2,
            role="MARK_INDEX",
            payload={"mark_price": "65000", "index_price": "65000"},
        ),
        *tuple(
            MarketEvent(
                sequence=2 + sequence,
                event_time_ms=sequence * 60_000,
                role="BARS",
                payload={
                    "open": "65000",
                    "high": "65010",
                    "low": "64990",
                    "close": "65000",
                    "volume": "10",
                },
            )
            for sequence in (1, 2, 3)
        ),
    )
    kernel = SimulationKernel(
        account_model="LINEAR_PERP_ONE_WAY_V2",
        funding_mode="OFF",
        leverage=Decimal("10"),
        host_policy_revision=HOST_POLICY_REVISION,
    )

    def reverse(_visible, event):
        if event.sequence == 1:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        if event.sequence == 2:
            return [{"side": "SELL", "type": "MARKET", "qty": "2"}]
        return []

    result = kernel.run(events, reverse, finalize=True)
    assert [fill["action"] for fill in result.fills] == [
        "OPEN_LONG",
        "REVERSE_TO_SHORT",
    ]
    assert kernel.account.position_qty == -1
    assert kernel.account.frozen_order_margin == 0


def test_planner_checkpoint_and_kernel_projected_position_do_not_drift() -> None:
    bars = (
        MarketEvent(
            sequence=1,
            event_time_ms=60_000,
            role="BARS",
            payload={
                "open": "100",
                "high": "101",
                "low": "99",
                "close": "100",
                "volume": "10",
            },
        ),
    )
    kernel = SimulationKernel(host_policy_revision=HOST_POLICY_REVISION)
    planner = PyneHostPlanner(config("FIXED_QTY_V1"))

    def strategy(_visible, event):
        return planner.plan(
            SIGNAL,
            context=context(
                sequence=event.sequence,
                event_time_ms=event.event_time_ms,
                actual_position=kernel.account.position_qty,
                projected_position=kernel.projected_position_qty,
            ),
        )

    kernel.run(bars, strategy)
    assert kernel.projected_position_qty == 1
    restored_kernel = SimulationKernel(host_policy_revision=HOST_POLICY_REVISION)
    restored_kernel.restore(kernel.snapshot())
    restored_planner = PyneHostPlanner(config("FIXED_QTY_V1"))
    restored_planner.restore(planner.snapshot())
    assert restored_kernel.projected_position_qty == kernel.projected_position_qty
    assert restored_planner.snapshot() == planner.snapshot()


def test_report_records_risk_policy_rejection_and_maximum_exposure() -> None:
    planner = PyneHostPlanner(config("FIXED_QTY_V1", max_notional="50"))
    planner.plan(SIGNAL, context=context())
    report = build_report(
        {
            "run_id": "bt-risk",
            "state": "COMPLETED",
            "fidelity_mode": "BAR_APPROX",
            "source_event_kind": "BAR",
            "config_json": (
                '{"host_policy_revision":"HOST_SIZING_RISK_V1",'
                '"sizing_policy":"FIXED_QTY_V1",'
                '"risk_policy":"HOST_RISK_LIMITS_V1"}'
            ),
        },
        {
            "rejected": planner.rejections,
            "risk_policy": planner.report(),
        },
    )
    assert report["metrics"]["risk_rejection_count"] == 1
    assert report["rejected_orders"][0]["reason_code"] == "RISK_MAX_NOTIONAL"
    assert report["risk_policy"]["max_actual_notional"] == "0"


def settings(tmp_path: Path):
    return load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def test_service_freezes_policy_identity_and_legacy_request_stays_legacy(
    tmp_path: Path,
) -> None:
    service = BacktestService.start(settings(tmp_path), now_ms=1)
    base = {
        "strategy_revision_id": "builtin-rsi-wilder-long-short-v1",
        "dataset_id": "local-policy",
        "data_epoch": "sha256:" + "11" * 32,
        "snapshot_hash": "sha256:" + "22" * 32,
        "fidelity_mode": "BAR_APPROX",
        "source_event_kind": "BAR",
        "start_time_ms": 0,
        "end_time_ms": 120_000,
        "interval": "1m",
        "output_mode": "SIGNAL",
        "parameters": {
            "length": 2,
            "oversold": 30,
            "overbought": 70,
            "trigger_mode": "LEVEL_TARGET_V1",
            "debug_trace": False,
        },
    }
    legacy = service.create_run(base, idempotency_key="legacy", now_ms=2)
    legacy_config = json.loads(str(legacy["config_json"]))
    assert "host_policy_revision" not in legacy_config
    versioned = service.create_run(
        {**base, **config("FIXED_QTY_V1")},
        idempotency_key="versioned",
        now_ms=3,
    )
    versioned_config = json.loads(str(versioned["config_json"]))
    assert versioned_config["host_policy_revision"] == HOST_POLICY_REVISION
    assert versioned_config["sizing_policy"] == "FIXED_QTY_V1"
    assert versioned["config_hash"] != legacy["config_hash"]
    with pytest.raises(BacktestError, match="SCHEMA_UNKNOWN_FIELD"):
        service.validate_run({**base, **config("RISK_PER_STOP_V1", stop_distance="0")})


def test_service_routes_signal_through_sizing_risk_and_report(tmp_path: Path) -> None:
    service = BacktestService.start(settings(tmp_path), now_ms=1)
    base = {
        "strategy_revision_id": "fake-signal-v1",
        "dataset_id": "local-policy",
        "data_epoch": "sha256:" + "33" * 32,
        "snapshot_hash": "sha256:" + "44" * 32,
        "fidelity_mode": "BAR_APPROX",
        "source_event_kind": "BAR",
        "start_time_ms": 0,
        "end_time_ms": 180_000,
        "interval": "1m",
        "output_mode": "SIGNAL",
        "qty_step": "0.1",
        "min_notional": "5",
        **config("FIXED_NOTIONAL_V1", fixed_notional="200"),
    }
    events = tuple(
        MarketEvent(
            sequence=sequence,
            event_time_ms=sequence * 60_000,
            role="BARS",
            payload={
                "open": "100",
                "high": "101",
                "low": "99",
                "close": "100",
                "volume": "10",
            },
        )
        for sequence in (1, 2, 3)
    )
    accepted = service.create_run(base, idempotency_key="accepted", now_ms=2)
    completed = service.execute_bar_run(
        str(accepted["run_id"]),
        events=events,
        provider=DeterministicFakeProvider(),
        now_ms=3,
    )
    assert completed["result"]["fills"][0]["qty"] == Decimal("2.0")
    accepted_report = service.get_report(str(accepted["run_id"]))
    assert accepted_report["identity"]["sizing_policy"] == "FIXED_NOTIONAL_V1"
    assert accepted_report["risk_policy"]["max_actual_abs_position"] == "2"

    fixed_qty_run = service.create_run(
        {**base, **config("FIXED_QTY_V1", fixed_qty="1")},
        idempotency_key="fixed-qty",
        now_ms=4,
    )
    fixed_qty_completed = service.execute_bar_run(
        str(fixed_qty_run["run_id"]),
        events=events,
        provider=DeterministicFakeProvider(),
        now_ms=5,
    )
    assert fixed_qty_completed["result"]["fills"][0]["qty"] == Decimal("1")
    assert (
        fixed_qty_completed["result"]["decision_hash"]
        == completed["result"]["decision_hash"]
    )
    assert (
        fixed_qty_completed["result"]["fill_hash"] != completed["result"]["fill_hash"]
    )

    rejected = service.create_run(
        {**base, "max_notional": "50"},
        idempotency_key="rejected",
        now_ms=6,
    )
    service.execute_bar_run(
        str(rejected["run_id"]),
        events=events,
        provider=DeterministicFakeProvider(),
        now_ms=7,
    )
    rejected_report = service.get_report(str(rejected["run_id"]))
    assert rejected_report["metrics"]["risk_rejection_count"] == 3
    assert {item["reason_code"] for item in rejected_report["rejected_orders"]} == {
        "RISK_MAX_NOTIONAL"
    }


def test_host_policy_contract_golden_is_exact() -> None:
    golden = json.loads(
        (
            Path(__file__).parent
            / "fixtures"
            / "backtest"
            / "host_policy_contract_golden.json"
        ).read_text(encoding="utf-8")
    )
    assert golden == {
        "host_policy_revision": HOST_POLICY_REVISION,
        "sizing_policies": [
            "FIXED_QTY_V1",
            "FIXED_NOTIONAL_V1",
            "EQUITY_PERCENT_V1",
            "RISK_PER_STOP_V1",
        ],
        "risk_policy_revision": "HOST_RISK_LIMITS_V1",
        "output_semantics": {
            "SIGNAL": "HOST_SIZED_ABSOLUTE_TARGET",
            "TARGET_POSITION": "ABSOLUTE_TARGET_QUANTITY",
            "ORDER_INTENT": "EXPLICIT_ORDER_QUANTITY",
        },
        "rejection_categories": ["ORDER_REJECTED_RULES", "ORDER_REJECTED_RISK"],
        "decision_identity_excludes_sizing": True,
        "reduce_only_crosses_zero": False,
    }
