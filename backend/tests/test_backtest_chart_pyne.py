from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import app.backtest.strategy.chart_pyne as chart_pyne_module
from app.api.v1.backtests import RunCreateRequest
from app.backtest.service import BacktestService
from app.backtest.strategy.chart_pyne import (
    CHART_PYNE_REVISION,
    ChartPyneStrategyProvider,
    compile_chart_pyne,
)
from app.backtest.strategy.protocol import ObservationFrame, StrategyProviderError
from app.backtest.trade_explanation import verify_explanation
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent


SMA = """strategy("SMA Cross")
fast = sma(close, 3)
slow = sma(close, 5)

if crossover(fast, slow)
  target_position(1)
else if crossunder(fast, slow)
  target_position(0)
"""

RSI = """strategy("RSI Reversal")
value = rsi(close, 14)

if value < 30
  target_position(1)
else if value > 70
  target_position(0)
"""

DONCHIAN = """strategy("Donchian Breakout")
upper = highest(high, 20)
lower = lowest(low, 20)

if close > upper[1]
  target_position(1)
else if close < lower[1]
  target_position(0)
"""


def _frame(sequence: int, close: int) -> ObservationFrame:
    return ObservationFrame(
        run_id="chart-pyne",
        sequence=sequence,
        event_time_ms=sequence * 60_000,
        watermark_ms=sequence * 60_000,
        phase="RUNNING",
        market={"symbol": "BTCUSDT"},
        input_hash=f"sha256:{sequence}",
        bar={"open": close, "high": close, "low": close, "close": close},
    )


@pytest.mark.parametrize("source", [SMA, RSI, DONCHIAN])
def test_all_chart_templates_compile_without_indicator_runtime(source: str) -> None:
    program = compile_chart_pyne(source)
    assert program.branches
    assert program.max_lookback <= 22


@pytest.mark.parametrize(
    ("source", "closes", "expected"),
    [
        (SMA, [10, 10, 10, 10, 10, 20], "1"),
        (RSI, list(range(30, 14, -1)), "1"),
        (DONCHIAN, [10] * 20 + [20], "1"),
    ],
)
def test_chart_templates_execute_deterministically(
    source: str, closes: list[int], expected: str
) -> None:
    provider = ChartPyneStrategyProvider()
    provider.prepare({"source": source})
    outputs = [
        provider.step(_frame(index, close)) for index, close in enumerate(closes, 1)
    ]
    terminal = [output for output in outputs if output is not None][-1]
    assert terminal.kind == "TARGET_POSITION"
    assert terminal.payload["targetExposure"] == expected
    snapshot = provider.snapshot()
    restored = ChartPyneStrategyProvider()
    restored.restore(snapshot)
    assert restored.close() == provider.close()


def test_chart_pyne_named_constant_participates_in_conditions_and_trace() -> None:
    provider = ChartPyneStrategyProvider()
    provider.prepare(
        {
            "source": """strategy(\"constant\")
threshold = 10
if close > threshold
  target_position(1)
else
  target_position(0)
""",
            "tradeExplanationEnabled": True,
        }
    )
    output = provider.step(_frame(1, 20))
    assert output is not None
    assert output.payload["targetExposure"] == "1"
    trace = provider.report_metadata()["tradeExplanationTrace"]
    assert trace[-1]["reasonCode"] == "chart_pyne_line_3"
    assert trace[-1]["variables"]["threshold"] == {
        "kind": "decimal",
        "value": "10",
    }


def test_chart_pyne_decision_evidence_is_checkpoint_deterministic() -> None:
    provider = ChartPyneStrategyProvider()
    provider.prepare({"source": SMA, "tradeExplanationEnabled": True})
    for index, close in enumerate([10, 10, 10, 10, 10, 20], 1):
        provider.step(_frame(index, close))
    restored = ChartPyneStrategyProvider()
    restored.restore(provider.snapshot())
    assert restored.report_metadata() == provider.report_metadata()
    trace = provider.report_metadata()["tradeExplanationTrace"]
    assert trace[-1]["reasonCode"] == "chart_pyne_line_5"
    assert trace[-1]["conditions"][-1] == {
        "id": "condition-5-1",
        "label": "crossover(fast, slow)",
        "result": True,
    }
    assert trace[-1]["variables"]["fast"]["kind"] == "decimal"


def test_chart_pyne_trace_byte_budget_keeps_a_deterministic_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(chart_pyne_module, "MAX_TRADE_EXPLANATION_TRACE_BYTES", 700)
    provider = ChartPyneStrategyProvider()
    provider.prepare(
        {
            "source": """strategy(\"bounded\")
threshold = 10
if close > threshold
  target_position(1)
else
  target_position(0)
""",
            "tradeExplanationEnabled": True,
        }
    )
    for sequence in range(1, 12):
        provider.step(_frame(sequence, sequence))
    metadata = provider.report_metadata()
    trace_meta = metadata["tradeExplanationTraceMeta"]
    assert trace_meta["captured"] >= 1
    assert trace_meta["capturedBytes"] <= 700
    assert trace_meta["dropped"] > 0
    assert trace_meta["complete"] is False
    snapshot = provider.snapshot()
    restored = ChartPyneStrategyProvider()
    restored.restore(snapshot)
    assert restored.report_metadata() == metadata


def test_chart_pyne_rejects_unknown_code_with_line_diagnostic() -> None:
    with pytest.raises(StrategyProviderError) as caught:
        compile_chart_pyne(
            'strategy("bad")\nimport os\nif close > 1\n  target_position(1)'
        )
    assert caught.value.code == "PROVIDER_PROTOCOL_VIOLATION"
    diagnostics = json.loads(str(caught.value).split(": ", 1)[1])
    assert diagnostics[0]["line"] == 2
    assert "unsupported statement" in diagnostics[0]["message"]


def _service(tmp_path: Path) -> BacktestService:
    return BacktestService.start(
        load_backtest_settings(
            {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
        enforce_registered_revisions=True,
    )


def _explanation_service(tmp_path: Path) -> BacktestService:
    return BacktestService.start(
        load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_BAR_ENABLED": "1",
                "BACKTEST_TRADE_EXPLANATION_ENABLED": "1",
            },
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
        enforce_registered_revisions=True,
    )


def test_completed_chart_run_links_decision_fill_and_recent_compatible_baseline(
    tmp_path: Path,
) -> None:
    service = _explanation_service(tmp_path)
    revision = service.create_strategy_revision(
        {
            "name": "SMA evidence",
            "language": "PYNE_CHART_V1",
            "source_text": SMA,
            "parameter_schema": [],
        }
    )
    payload = {
        "strategy_revision_id": revision["revision_id"],
        "dataset_id": "local-chart",
        "data_epoch": "epoch-20260824",
        "snapshot_hash": "sha256:snapshot",
        "fidelity_mode": "BAR_APPROX",
        "source_event_kind": "BAR",
        "start_time_ms": 0,
        "end_time_ms": 600_000,
        "symbol": "BTCUSDT",
        "interval": "1m",
        "parameters": {},
        "output_mode": "TARGET_POSITION",
        "initial_balance": "10000",
        "account_model": "LINEAR_PERP_ONE_WAY_V1",
        "slippage_bps": "1",
        "taker_fee_bps": "4",
        "maker_fee_bps": "4",
        "exchange": "binance",
        "market_type": "usdm",
    }
    service.smoke_strategy_revision(str(revision["revision_id"]), payload, now_ms=2)
    events = tuple(
        MarketEvent(
            sequence=index,
            event_time_ms=index * 60_000,
            role="BARS",
            payload={
                "open": str(close),
                "high": str(close),
                "low": str(close),
                "close": str(close),
                "volume": "100",
            },
        )
        for index, close in enumerate([10, 10, 10, 10, 10, 20, 20], 1)
    )
    first = service.create_run(payload, idempotency_key="phase7-first", now_ms=3)
    completed = service.execute_bar_run(
        str(first["run_id"]),
        events=events,
        provider=ChartPyneStrategyProvider(),
        now_ms=4,
    )
    explanation = completed["report"]["fills"][0]["explanation"]
    assert explanation["decisionTimeMs"] == 360_000
    assert explanation["execution"] == {
        "state": "FILLED",
        "reasonCode": "NEXT_BAR_OPEN",
    }
    assert verify_explanation(explanation) is True
    assert completed["report"]["comparison_context"]["context"]["market"] == {
        "exchange": "binance",
        "marketType": "usdm",
        "symbol": "BTCUSDT",
        "interval": "1m",
    }
    assert completed["report"]["comparison_context"]["complete"] is True

    second = service.create_run(payload, idempotency_key="phase7-second", now_ms=5)
    service.execute_bar_run(
        str(second["run_id"]),
        events=events,
        provider=ChartPyneStrategyProvider(),
        now_ms=6,
    )
    recent = service.compare_recent_compatible_run(str(second["run_id"]))
    assert recent["baselineRunId"] == first["run_id"]
    assert recent["comparison"]["schema"] == "RUN_COMPARE_V3"
    assert recent["comparison"]["directComparisonAllowed"] is True


def test_recent_compatible_compare_does_not_borrow_another_cell(
    tmp_path: Path,
) -> None:
    service = _explanation_service(tmp_path)
    revision = service.create_strategy_revision(
        {
            "name": "SMA evidence",
            "language": "PYNE_CHART_V1",
            "source_text": SMA,
            "parameter_schema": [],
        }
    )
    payload = {
        "strategy_revision_id": revision["revision_id"],
        "dataset_id": "local-chart",
        "data_epoch": "epoch-20260824",
        "snapshot_hash": "sha256:snapshot",
        "fidelity_mode": "BAR_APPROX",
        "source_event_kind": "BAR",
        "start_time_ms": 0,
        "end_time_ms": 600_000,
        "symbol": "BTCUSDT",
        "interval": "1m",
        "parameters": {},
        "output_mode": "TARGET_POSITION",
        "initial_balance": "10000",
        "account_model": "LINEAR_PERP_ONE_WAY_V1",
        "slippage_bps": "1",
        "taker_fee_bps": "4",
        "maker_fee_bps": "4",
        "exchange": "binance",
        "market_type": "usdm",
    }
    service.smoke_strategy_revision(str(revision["revision_id"]), payload, now_ms=2)
    events = tuple(
        MarketEvent(
            sequence=index,
            event_time_ms=index * 60_000,
            role="BARS",
            payload={
                "open": str(close),
                "high": str(close),
                "low": str(close),
                "close": str(close),
                "volume": "100",
            },
        )
        for index, close in enumerate([10, 10, 10, 10, 10, 20, 20], 1)
    )

    def complete(scope: str, draft: str, key: str, now_ms: int) -> dict[str, object]:
        created = service.create_run(
            {
                **payload,
                "chart_cell_scope": scope,
                "strategy_draft_id": draft,
            },
            idempotency_key=key,
            now_ms=now_ms,
        )
        return service.execute_bar_run(
            str(created["run_id"]),
            events=events,
            provider=ChartPyneStrategyProvider(),
            now_ms=now_ms + 1,
        )

    first = complete("workspace\x00cell-1", "draft-cell1aaa", "cell-1-first", 3)
    second = complete("workspace\x00cell-2", "draft-cell2bbb", "cell-2-first", 5)
    third = complete("workspace\x00cell-1", "draft-cell1aaa", "cell-1-second", 7)
    leaked = service.compare_recent_compatible_run(str(second["run_id"]))
    assert leaked["baselineRunId"] is None
    isolated = service.compare_recent_compatible_run(str(third["run_id"]))
    assert isolated["baselineRunId"] == first["run_id"]


def test_chart_revision_reuses_compile_identity_and_changes_with_source(
    tmp_path: Path,
) -> None:
    service = _service(tmp_path)
    payload = {
        "name": "SMA",
        "language": "PYNE_CHART_V1",
        "source_text": SMA,
        "parameter_schema": [],
    }
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = list(
            pool.map(lambda _: service.create_strategy_revision(payload), range(2))
        )
    assert first["revision_id"] == second["revision_id"]
    assert {bool(first["reused"]), bool(second["reused"])} == {False, True}
    assert first["base_revision_id"] == CHART_PYNE_REVISION
    changed = service.create_strategy_revision(
        {**payload, "source_text": SMA.replace("sma(close, 3)", "sma(close, 4)")}
    )
    assert changed["revision_id"] != first["revision_id"]
    assert changed["reused"] is False


def test_quick_run_fee_identity_fails_closed(tmp_path: Path) -> None:
    service = _service(tmp_path)
    revision = service.create_strategy_revision(
        {
            "name": "SMA",
            "language": "PYNE_CHART_V1",
            "source_text": SMA,
            "parameter_schema": [],
        }
    )
    payload = {
        "strategy_revision_id": revision["revision_id"],
        "dataset_id": "local-chart",
        "data_epoch": "epoch-20260824",
        "snapshot_hash": "sha256:snapshot",
        "fidelity_mode": "BAR_APPROX",
        "source_event_kind": "BAR",
        "start_time_ms": 0,
        "end_time_ms": 60_000,
        "interval": "1m",
        "parameters": {},
        "output_mode": "TARGET_POSITION",
        "quick_preset_id": "CRYPTO_PERP_STANDARD_V1",
        "quick_preset_revision": "1",
    }
    with pytest.raises(Exception) as caught:
        service.validate_run(payload)
    assert getattr(caught.value, "code", None) == "FEE_PRESET_UNKNOWN"
    with pytest.raises(ValueError, match="confirmed fee preset"):
        RunCreateRequest(**payload)

    with pytest.raises(Exception) as caught_missing_rates:
        service.validate_run(
            {
                **payload,
                "fee_source": "exchange-market-preset",
                "quick_preset_revision": "1",
            }
        )
    assert getattr(caught_missing_rates.value, "code", None) == "FEE_PRESET_UNKNOWN"
    assert set(caught_missing_rates.value.details["missing_fields"]) == {
        "maker_fee_bps",
        "slippage_bps",
        "taker_fee_bps",
    }

    valid = {
        **payload,
        "symbol": "BTCUSDT",
        "fee_source": "exchange-market-preset",
        "taker_fee_bps": "4",
        "maker_fee_bps": "4",
        "slippage_bps": "1",
        "initial_balance": "10000",
        "account_model": "LINEAR_PERP_ONE_WAY_V1",
        "sizing_policy": "EQUITY_PERCENT_V1",
        "equity_percent": "10",
        "leverage": "1",
        "execution_model_revision": "EXECUTION_REALISM_V2",
        "participation_rate": "0.1",
        "order_end_policy": "CANCEL_AT_END",
        "quick_preset_revision": "1",
    }
    dumped = RunCreateRequest(**valid).model_dump()
    assert dumped["symbol"] == "BTCUSDT"
    assert dumped["taker_fee_bps"] == "4"
    first_smoke = service.smoke_strategy_revision(
        str(revision["revision_id"]), valid, now_ms=2
    )
    second_smoke = service.smoke_strategy_revision(
        str(revision["revision_id"]), valid, now_ms=5
    )
    assert second_smoke["receiptHash"] == first_smoke["receiptHash"]
    stored_smokes = service.repository.connection.execute(
        "SELECT COUNT(*) FROM backtest_strategy_smokes WHERE receipt_hash = ?",
        (first_smoke["receiptHash"],),
    ).fetchone()
    assert stored_smokes[0] == 1
    assert service.validate_run(valid)["ok"] is True
    run = service.create_run(valid, idempotency_key="chart-quick-run", now_ms=3)
    events = tuple(
        MarketEvent(
            sequence=index,
            event_time_ms=index * 60_000,
            role="BARS",
            payload={
                "open": str(close),
                "high": str(close),
                "low": str(close),
                "close": str(close),
                "volume": "100",
            },
        )
        for index, close in enumerate([10, 10, 10, 10, 10, 20, 20], 1)
    )
    completed = service.execute_bar_run(
        str(run["run_id"]),
        events=events,
        provider=ChartPyneStrategyProvider(),
        now_ms=4,
    )
    assert completed["state"] == "COMPLETED"
    config = json.loads(str(completed["config_json"]))
    assert config["quick_preset_id"] == "CRYPTO_PERP_STANDARD_V1"
    assert config["quick_preset_revision"] == "1"
    assert config["fee_source"] == "exchange-market-preset"
