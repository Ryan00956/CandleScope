from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from app.backtest.service import BacktestService
from app.backtest.strategy.builtin import (
    BUILTIN_RSI_WILDER_LONG_SHORT_REVISION,
    BuiltinRsiReversionProvider,
    BuiltinRsiWilderLongShortProvider,
)
from app.backtest.strategy.protocol import ObservationFrame
from app.backtest.strategy.pyne_adapter import PyneHostPlanner
from app.backtest.strategy.registry import build_default_strategy_registry
from app.backtest.strategy.isolated import IsolatedStrategyProvider
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent

FIXTURE = Path(__file__).parent / "fixtures" / "backtest" / "rsi24_wilder_long_short_golden.json"


def _frame(sequence: int, close: str, *, phase: str = "EVALUATION") -> ObservationFrame:
    return ObservationFrame(
        run_id="bt-rsi",
        sequence=sequence,
        event_time_ms=sequence * 60_000,
        watermark_ms=sequence * 60_000,
        phase=phase,
        market={"venue": "local", "symbol": "BTC-USDT"},
        input_hash=f"fixture-{sequence}",
        bar={"close": close},
    )


def _independent_pine_rsi(closes: list[str], length: int) -> list[str | None]:
    """Independent Wilder recurrence matching Pine ta.rsi seeding semantics."""

    values = [Decimal(value) for value in closes]
    result: list[str | None] = [None]
    seed_gains: list[Decimal] = []
    seed_losses: list[Decimal] = []
    average_gain: Decimal | None = None
    average_loss: Decimal | None = None
    for left, right in zip(values, values[1:]):
        change = right - left
        gain = change if change > 0 else Decimal("0")
        loss = -change if change < 0 else Decimal("0")
        if average_gain is None or average_loss is None:
            seed_gains.append(gain)
            seed_losses.append(loss)
            if len(seed_gains) < length:
                result.append(None)
                continue
            average_gain = sum(seed_gains, Decimal("0")) / Decimal(length)
            average_loss = sum(seed_losses, Decimal("0")) / Decimal(length)
        else:
            period = Decimal(length)
            average_gain = (average_gain * (period - 1) + gain) / period
            average_loss = (average_loss * (period - 1) + loss) / period
        if average_gain == 0 and average_loss == 0:
            rsi = Decimal("50")
        elif average_loss == 0:
            rsi = Decimal("100")
        elif average_gain == 0:
            rsi = Decimal("0")
        else:
            rs = average_gain / average_loss
            rsi = Decimal("100") - Decimal("100") / (Decimal("1") + rs)
        result.append(str(rsi))
    return result


def _provider_outputs(closes: list[str], *, warmup: int = 0, debug: bool = False):
    provider = BuiltinRsiWilderLongShortProvider()
    provider.prepare(
        {
            "parameters": {
                "length": 24,
                "oversold": 30,
                "overbought": 70,
                "trigger_mode": "LEVEL_TARGET_V1",
                "debug_trace": debug,
            }
        }
    )
    outputs = []
    rsi_values: list[str | None] = []
    for sequence, close in enumerate(closes, start=1):
        frame = _frame(
            sequence,
            close,
            phase="WARMUP" if sequence <= warmup else "EVALUATION",
        )
        output = provider.warmup(frame) if sequence <= warmup else provider.step(frame)
        rsi_values.append(provider.snapshot()["last_rsi"])
        outputs.append(None if output is None else output.to_wire())
    return provider, outputs, rsi_values


def _events(closes: list[str]) -> tuple[MarketEvent, ...]:
    return tuple(
        MarketEvent(
            sequence=sequence,
            event_time_ms=sequence * 60_000,
            role="BARS",
            payload={
                "open": close,
                "high": close,
                "low": close,
                "close": close,
                "volume": "1",
            },
        )
        for sequence, close in enumerate(closes, start=1)
    )


def _settings(tmp_path: Path):
    return load_backtest_settings(
        {
            "BACKTEST_ENABLED": "1",
            "BACKTEST_BAR_ENABLED": "1",
            "BACKTEST_CHECKPOINT_EVENT_INTERVAL": "8",
        },
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )


def _payload() -> dict[str, object]:
    return {
        "strategy_revision_id": BUILTIN_RSI_WILDER_LONG_SHORT_REVISION,
        "dataset_id": "local-rsi24-golden",
        "data_epoch": "sha256:" + "ab" * 32,
        "snapshot_hash": "sha256:" + "cd" * 32,
        "fidelity_mode": "BAR_APPROX",
        "source_event_kind": "BAR",
        "start_time_ms": 1,
        "end_time_ms": 60 * 60_000,
        "warmup_bars": 0,
        "parameters": {
            "length": 24,
            "oversold": 30,
            "overbought": 70,
            "trigger_mode": "LEVEL_TARGET_V1",
            "debug_trace": False,
        },
        "output_mode": "SIGNAL",
        "slippage_bps": "0",
    }


def test_descriptor_freezes_clock_features_warmup_and_schema() -> None:
    descriptor = build_default_strategy_registry().require(
        BUILTIN_RSI_WILDER_LONG_SHORT_REVISION
    ).to_wire()
    assert descriptor["signal_clock"] == "BAR_CLOSE"
    assert descriptor["required_features"] == ["close"]
    assert descriptor["warmup_requirement"] == {
        "kind": "PARAMETER_PLUS_ROWS",
        "parameter": "length",
        "offset": 1,
        "minimum": 3,
    }
    fields = {item["name"]: item for item in descriptor["parameter_schema"]}
    assert fields["length"]["default"] == 24
    assert fields["trigger_mode"]["options"] == ["LEVEL_TARGET_V1"]
    assert fields["debug_trace"]["default"] is False
    assert descriptor["output_modes"] == ["SIGNAL"]


def test_rsi24_matches_independent_pine_reference_and_golden_targets() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    closes = fixture["closes"]
    provider, outputs, actual_rsi = _provider_outputs(closes)
    reference = _independent_pine_rsi(closes, 24)
    assert actual_rsi == reference == fixture["rsi"]
    actual_targets = [
        None if output is None else output["payload"]["normalizedTarget"]
        for output in outputs
    ]
    assert actual_targets == fixture["target_signals"]
    assert provider.report_metadata()["reasonCodes"] == fixture["reason_codes"]


def test_warmup_never_orders_and_flat_segment_is_rsi_50() -> None:
    flat = ["100"] * 30
    provider, outputs, values = _provider_outputs(flat, warmup=25)
    assert outputs[:25] == [None] * 25
    assert values[23] is None
    assert values[24:] == ["50"] * 6
    assert all(output is None for output in outputs)
    assert provider.report_metadata()["warmupRowsObserved"] == 25


def test_missing_or_non_positive_close_and_cross_mode_fail_closed() -> None:
    provider = BuiltinRsiWilderLongShortProvider()
    with pytest.raises(Exception, match="only LEVEL_TARGET_V1"):
        provider.prepare({"parameters": {"trigger_mode": "CROSS_TARGET"}})
    provider.prepare({"parameters": {}})
    missing = _frame(1, "100")
    missing = ObservationFrame(
        run_id=missing.run_id,
        sequence=missing.sequence,
        event_time_ms=missing.event_time_ms,
        watermark_ms=missing.watermark_ms,
        phase=missing.phase,
        market=missing.market,
        input_hash=missing.input_hash,
        bar={},
    )
    with pytest.raises(Exception, match="completed BAR close"):
        provider.step(missing)
    with pytest.raises(Exception, match="finite and positive"):
        provider.step(_frame(2, "0"))
    with pytest.raises(Exception, match="dual-clock execution is not M1"):
        provider.prepare({"roles": ["TRADES"], "parameters": {}})


def test_level_targets_reverse_and_authoritative_position_retries_after_rejection() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    _, outputs, _ = _provider_outputs(fixture["closes"])
    planner = PyneHostPlanner()
    long_output = outputs[24]
    short_output = outputs[53]
    assert planner.plan(long_output, current_position="0") == [
        {
            "side": "BUY",
            "type": "MARKET",
            "qty": "1",
        }
    ]
    # A rejected intent leaves the Host account FLAT, so the next LEVEL signal retries.
    assert planner.plan(outputs[25], current_position="0")[0]["qty"] == "1"
    # Once filled, the same target is a no-op; reversal is the full +1 -> -1 delta.
    assert planner.plan(outputs[25], current_position="1") == []
    assert planner.plan(short_output, current_position="1") == [
        {
            "side": "SELL",
            "type": "MARKET",
            "qty": "2",
        }
    ]


def test_snapshot_restore_and_optional_debug_trace_are_deterministic() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    closes = fixture["closes"]
    full, full_outputs, _ = _provider_outputs(closes, debug=True)

    first, first_outputs, _ = _provider_outputs(closes[:37], debug=True)
    restored = BuiltinRsiWilderLongShortProvider()
    restored.restore(first.snapshot())
    tail_outputs = []
    for sequence, close in enumerate(closes[37:], start=38):
        output = restored.step(_frame(sequence, close))
        tail_outputs.append(None if output is None else output.to_wire())

    assert first_outputs + tail_outputs == full_outputs
    assert restored.close() == full.close()
    metadata = restored.report_metadata()
    assert len(metadata["decisionDebugTrace"]) == len(closes) - 24
    assert "decisionDebugTrace" not in _provider_outputs(closes)[0].report_metadata()


def test_old_rsi_revision_output_and_close_hash_remain_frozen() -> None:
    provider = BuiltinRsiReversionProvider()
    provider.prepare({"parameters": {"length": 2, "oversold": 30, "overbought": 70}})
    outputs = []
    for sequence, close in enumerate(["100", "99", "98", "99", "100"], start=1):
        output = provider.step(_frame(sequence, close))
        if output is not None:
            outputs.append(output.output_hash)
    assert outputs == [
        "sha256:665879f17872ed70383efa412d166684f4e40ddb012c5e3607312a63ba6c5fb5",
        "sha256:41bc4ede32613b1a1e1409a1c37d3aff893301dc497521c0875347bd7ad92a9e",
    ]
    assert provider.close() == (
        "sha256:cf7858713ccf79023e3cffd8d627e2a74db2d67ca078daca7d86ad81908c970b"
    )


def test_product_run_report_and_checkpoint_resume_match_golden(tmp_path: Path) -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    events = _events(fixture["closes"])
    service = BacktestService.start(_settings(tmp_path), now_ms=1)

    class CrashAfterCheckpoint(BuiltinRsiWilderLongShortProvider):
        def __init__(self, *, crash: bool) -> None:
            super().__init__()
            self._crash = crash

        def step(self, frame: ObservationFrame):
            if self._crash and frame.sequence == 41:
                raise KeyboardInterrupt("simulated worker death")
            return super().step(frame)

    crashed = service.create_run(_payload(), idempotency_key="rsi-crashed", now_ms=2)
    with pytest.raises(KeyboardInterrupt, match="simulated worker death"):
        service.execute_bar_run(
            str(crashed["run_id"]),
            events=events,
            provider=CrashAfterCheckpoint(crash=True),
            now_ms=3,
        )
    checkpoint = service.repository.latest_checkpoint(str(crashed["run_id"]))
    assert checkpoint is not None and checkpoint["sequence"] == 40
    record = service.get_run(str(crashed["run_id"]))
    assert service.repository.compare_and_set_run_state(
        str(crashed["run_id"]),
        expected_state="RUNNING",
        state="QUEUED",
        updated_at_ms=4,
        generation=int(record["generation"]) + 1,
    )
    resumed = service.execute_bar_run(
        str(crashed["run_id"]),
        events=events,
        provider=CrashAfterCheckpoint(crash=False),
        now_ms=5,
    )

    clean = service.create_run(_payload(), idempotency_key="rsi-clean", now_ms=6)
    completed = service.execute_bar_run(
        str(clean["run_id"]),
        events=events,
        provider=CrashAfterCheckpoint(crash=False),
        now_ms=7,
    )
    for name in ("decision_hash", "fill_hash", "ledger_hash", "report_hash"):
        assert resumed["result"][name] == completed["result"][name]
        assert completed["result"][name] == fixture["hashes"][name]
    report = service.get_report(str(clean["run_id"]))
    assert report["strategy"] == fixture["strategy_report"]
    assert report["orders"] == fixture["orders"]
    assert report["fills"] == fixture["fills"]
    assert report["trades"] == fixture["trades"]
    assert report["equity_curve"] == fixture["equity_curve"]

    isolated = service.create_run(_payload(), idempotency_key="rsi-isolated", now_ms=8)
    isolated_completed = service.execute_bar_run(
        str(isolated["run_id"]),
        events=events,
        provider=IsolatedStrategyProvider(
            BUILTIN_RSI_WILDER_LONG_SHORT_REVISION,
            step_timeout_s=2,
        ),
        now_ms=9,
    )
    assert isolated_completed["result"]["report_hash"] == fixture["hashes"]["report_hash"]
    assert service.get_report(str(isolated["run_id"]))["strategy"] == fixture["strategy_report"]
    service.shutdown()


def test_debug_trace_is_opt_in_report_content(tmp_path: Path) -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    payload = _payload()
    payload["parameters"] = {**dict(payload["parameters"]), "debug_trace": True}
    service = BacktestService.start(_settings(tmp_path), now_ms=1)
    run = service.create_run(payload, idempotency_key="rsi-debug", now_ms=2)
    service.execute_bar_run(
        str(run["run_id"]),
        events=_events(fixture["closes"]),
        provider=BuiltinRsiWilderLongShortProvider(),
        now_ms=3,
    )
    strategy = service.get_report(str(run["run_id"]))["strategy"]
    assert strategy["debugTrace"] is True
    assert len(strategy["decisionDebugTrace"]) == len(fixture["closes"]) - 24
    assert strategy["decisionDebugTrace"][0]["rsi"] == "0"
    service.shutdown()
