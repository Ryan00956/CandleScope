"""Deterministic execution-cost sensitivity from frozen Host decisions."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping

from app.market_dataset.snapshot import MarketEvent, sha256_hex

from .dual_clock_kernel import DualClockSimulationKernel
from .execution_realism import EXECUTION_REALISM_V2
from .kernel import SimulationKernel, SimulationResult
from .trade_kernel import TradeSimulationKernel


def build_cost_sensitivity_matrix(
    kernel: SimulationKernel | TradeSimulationKernel | DualClockSimulationKernel,
    events: tuple[MarketEvent, ...],
    primary: SimulationResult,
) -> dict[str, object]:
    """Replay immutable accepted decision intents without invoking the Provider."""

    if getattr(kernel, "execution_model_revision", None) != EXECUTION_REALISM_V2:
        return {}
    frozen = list(getattr(kernel, "frozen_intents", []))
    by_sequence = {
        int(item["sequence"]): [dict(intent) for intent in item.get("intents") or []]
        for item in frozen
    }

    def strategy(_visible: tuple[MarketEvent, ...], event: MarketEvent) -> list[dict]:
        return [dict(intent) for intent in by_sequence.get(event.sequence, [])]

    base_rate = Decimal(str(getattr(kernel, "participation_rate")))
    scenarios: list[dict[str, object]] = [
        _scenario_wire(
            "BASELINE",
            {
                "fee_multiplier": "1",
                "slippage_multiplier": "1",
                "latency_ms_delta": 0,
                "latency_events_delta": 0,
                "participation_rate": str(base_rate),
            },
            primary,
        )
    ]
    for name, multiplier in (
        ("COSTS_PLUS_25_PERCENT", Decimal("1.25")),
        ("COSTS_PLUS_50_PERCENT", Decimal("1.5")),
    ):
        replay = _clone_kernel(
            kernel,
            taker_fee_bps=getattr(kernel, "taker_fee_bps") * multiplier,
            maker_fee_bps=getattr(kernel, "maker_fee_bps") * multiplier,
            slippage_bps=getattr(kernel, "slippage_bps") * multiplier,
        )
        result = replay.run(events, strategy, warmup_events=0, finalize=True)
        scenarios.append(
            _scenario_wire(
                name,
                {
                    "fee_multiplier": str(multiplier),
                    "slippage_multiplier": str(multiplier),
                    "latency_ms_delta": 0,
                    "latency_events_delta": 0,
                    "participation_rate": str(base_rate),
                },
                result,
            )
        )
    if isinstance(kernel, SimulationKernel):
        scenarios.append(
            {
                **_scenario_wire(
                    "LATENCY_PLUS_ONE_TIER",
                    {
                        "fee_multiplier": "1",
                        "slippage_multiplier": "1",
                        "latency_ms_delta": 0,
                        "latency_events_delta": 0,
                        "participation_rate": str(base_rate),
                    },
                    primary,
                ),
                "status": "NOT_APPLICABLE_BAR_CLOCK",
            }
        )
    else:
        replay = _clone_kernel(
            kernel,
            latency_ms=getattr(kernel, "latency_ms") + 100,
            latency_events=getattr(kernel, "latency_events") + 1,
        )
        result = replay.run(events, strategy, warmup_events=0, finalize=True)
        scenarios.append(
            _scenario_wire(
                "LATENCY_PLUS_ONE_TIER",
                {
                    "fee_multiplier": "1",
                    "slippage_multiplier": "1",
                    "latency_ms_delta": 100,
                    "latency_events_delta": 1,
                    "participation_rate": str(base_rate),
                },
                result,
            )
        )
    lower_rate = base_rate / Decimal("2")
    replay = _clone_kernel(kernel, participation_rate=lower_rate)
    result = replay.run(events, strategy, warmup_events=0, finalize=True)
    scenarios.append(
        _scenario_wire(
            "PARTICIPATION_DOWN_ONE_TIER",
            {
                "fee_multiplier": "1",
                "slippage_multiplier": "1",
                "latency_ms_delta": 0,
                "latency_events_delta": 0,
                "participation_rate": str(lower_rate),
            },
            result,
        )
    )
    payload = {
        "schemaVersion": "candlescope.cost-sensitivity/1",
        "purpose": "ROBUSTNESS_CHECK_NOT_PARAMETER_TUNING",
        "decision_source": "FROZEN_PRIMARY_HOST_INTENTS",
        "included_in_primary_config_hash": False,
        "scenarios": scenarios,
    }
    return {**payload, "matrix_hash": "sha256:" + sha256_hex(payload)}


def _scenario_wire(
    name: str, assumptions: Mapping[str, object], result: SimulationResult
) -> dict[str, object]:
    account = dict(result.ledger.get("account") or {})
    wire = {
        "name": name,
        "status": "COMPLETED",
        "assumptions": dict(assumptions),
        "metrics": {
            "fill_count": len(result.fills),
            "fee_total": str(result.ledger.get("fee_total") or "0"),
            "ending_equity": str(account.get("equity") or "0"),
            "open_order_count": int(result.ledger.get("open_order_count") or 0),
        },
        "hashes": {
            "fill": result.fill_hash,
            "ledger": result.ledger_hash,
        },
    }
    return {**wire, "scenario_hash": "sha256:" + sha256_hex(wire)}


def _clone_kernel(kernel: Any, **overrides: object) -> Any:
    common = {
        "account_model": kernel.account_model,
        "funding_mode": kernel.funding_mode,
        "leverage": kernel.leverage,
        "host_policy_revision": kernel.host_policy_revision,
        "slippage_bps": kernel.slippage_bps,
        "taker_fee_bps": kernel.taker_fee_bps,
        "maker_fee_bps": kernel.maker_fee_bps,
        "funding_rate": kernel.funding_rate,
        "funding_interval_ms": kernel.funding_interval_ms,
        "initial_balance": kernel.initial_balance,
        "execution_model_revision": kernel.execution_model_revision,
        "participation_rate": kernel.participation_rate,
        "latency_ms": kernel.latency_ms,
        "latency_events": kernel.latency_events,
        "order_end_policy": kernel.order_end_policy,
        "equity_curve_event_interval": kernel.equity_curve_event_interval,
    }
    common.update(overrides)
    if isinstance(kernel, DualClockSimulationKernel):
        return DualClockSimulationKernel(
            signal_interval=kernel.signal_interval,
            gap_policy=kernel.gap_policy,
            max_events=kernel.max_events,
            checkpoint_event_interval=0,
            **common,
        )
    if isinstance(kernel, TradeSimulationKernel):
        return TradeSimulationKernel(
            max_events=kernel.max_events,
            checkpoint_event_interval=0,
            **common,
        )
    return SimulationKernel(
        price_tick=kernel.price_tick,
        qty_step=kernel.qty_step,
        min_notional=kernel.min_notional,
        gap_policy=kernel.gap_policy,
        fill_policy=kernel.fill_policy,
        bar_path_scenario=kernel.bar_path_scenario,
        **common,
    )
