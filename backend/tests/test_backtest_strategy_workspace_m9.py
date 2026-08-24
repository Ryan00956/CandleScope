from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.backtest.errors import BacktestError
from app.backtest.service import BacktestService
from app.backtest.strategy.builtin import BuiltinRsiWilderLongShortProvider
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent


def _service(tmp_path: Path, *, bridge: bool = False) -> BacktestService:
    return BacktestService.start(
        load_backtest_settings(
            {
                "BACKTEST_ENABLED": "1",
                "BACKTEST_BAR_ENABLED": "1",
                "BACKTEST_REPLAY_REVIEW_BRIDGE_ENABLED": "1" if bridge else "0",
            },
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
        enforce_registered_revisions=True,
    )


def _revision(service: BacktestService) -> dict[str, object]:
    return service.create_strategy_revision(
        {
            "name": "RSI24 research",
            "language": "BUILTIN_TEMPLATE",
            "base_revision_id": "builtin-rsi-wilder-long-short-v1",
            "source_text": "",
            "parameter_schema": [
                {"name": "length", "type": "integer", "default": 24},
                {"name": "oversold", "type": "number", "default": 30},
                {"name": "overbought", "type": "number", "default": 70},
            ],
        },
        now_ms=2,
    )


def _payload(revision_id: str) -> dict[str, object]:
    return {
        "strategy_revision_id": revision_id,
        "dataset_id": "local-rsi",
        "data_epoch": "epoch-20260815",
        "snapshot_hash": "sha256:snapshot",
        "fidelity_mode": "BAR_APPROX",
        "start_time_ms": 0,
        "end_time_ms": 3_600_000,
        "warmup_bars": 0,
        "parameters": {
            "length": 2,
            "oversold": 30,
            "overbought": 70,
            "trigger_mode": "LEVEL_TARGET_V1",
            "debug_trace": True,
        },
        "output_mode": "SIGNAL",
        "signal_trace_mode": "PAGED_V1",
        "initial_balance": "10000",
        "fixed_qty": "1",
    }


def _events() -> tuple[MarketEvent, ...]:
    closes = ["100", "90", "80", "120", "130", "70", "60"]
    return tuple(
        MarketEvent(
            sequence=i,
            event_time_ms=i * 60_000,
            role="BARS",
            payload={"open": c, "high": c, "low": c, "close": c, "volume": "1"},
        )
        for i, c in enumerate(closes, 1)
    )


def test_revision_is_immutable_copyable_archivable_and_smoke_gated(
    tmp_path: Path,
) -> None:
    service = _service(tmp_path)
    revision = _revision(service)
    payload = _payload(str(revision["revision_id"]))
    with pytest.raises(BacktestError, match="SMOKE_REQUIRED"):
        service.create_run(payload, idempotency_key="before-smoke", now_ms=3)
    receipt = service.smoke_strategy_revision(
        str(revision["revision_id"]), payload, now_ms=4
    )
    assert receipt["schema"] == "STRATEGY_SMOKE_V1"
    with pytest.raises(BacktestError, match="selected immutable dataset snapshot"):
        service.create_run(
            {**payload, "snapshot_hash": "sha256:other-snapshot"},
            idempotency_key="wrong-snapshot",
            now_ms=4,
        )
    run = service.create_run(payload, idempotency_key="after-smoke", now_ms=5)
    assert (
        json.loads(str(run["config_json"]))["strategy_execution_revision"]
        == "builtin-rsi-wilder-long-short-v1"
    )
    copied = service.copy_strategy_revision(
        str(revision["revision_id"]), name="copy", now_ms=6
    )
    assert copied["revision_id"] != revision["revision_id"]
    service.archive_strategy_revision(str(revision["revision_id"]), now_ms=7)
    with pytest.raises(BacktestError, match="archived"):
        service.create_run({**payload}, idempotency_key="archived", now_ms=8)
    service.shutdown()


def test_paged_trace_never_enters_main_report(tmp_path: Path) -> None:
    service = _service(tmp_path)
    revision = _revision(service)
    payload = _payload(str(revision["revision_id"]))
    service.smoke_strategy_revision(str(revision["revision_id"]), payload, now_ms=3)
    run = service.create_run(payload, idempotency_key="trace", now_ms=4)
    completed = service.execute_bar_run(
        str(run["run_id"]),
        events=_events(),
        provider=BuiltinRsiWilderLongShortProvider(),
        now_ms=5,
    )
    strategy = completed["report"]["strategy"]
    assert "decisionDebugTrace" not in strategy
    assert strategy["signalTrace"]["paged"] is True
    page = service.get_signal_trace(str(run["run_id"]), limit=2)
    assert len(page["items"]) == 2 and page["nextAfter"] == 2

    clone = service.clone_run_parameter(
        str(run["run_id"]),
        parameter="length",
        value=3,
        idempotency_key="compare-clone",
    )
    service.execute_bar_run(
        str(clone["run_id"]),
        events=_events(),
        provider=BuiltinRsiWilderLongShortProvider(),
        now_ms=6,
    )
    comparison = service.compare_run_pair(str(run["run_id"]), str(clone["run_id"]))
    assert comparison["schema"] == "RUN_COMPARE_V3"
    assert comparison["directComparisonAllowed"] is False
    assert comparison["incompatibleFields"] == ["market.interval"]
    assert comparison["parameterDiff"] == {"length": {"left": 2, "right": 3}}
    assert "drawdownDaily" in comparison["left"]
    assert set(comparison["tradeDiff"]) == {"tradeCount", "netPnl", "maxDrawdown"}
    assert set(comparison["costDiff"]) == {"fees", "funding", "slippage"}
    service.shutdown()


def test_pine_diagnostics_and_bridge_fail_closed(tmp_path: Path) -> None:
    service = _service(tmp_path)
    with pytest.raises(BacktestError) as caught:
        service.create_strategy_revision(
            {
                "name": "unsafe",
                "language": "PINE_SUBSET",
                "source_text": "strategy('x')\nrequest.security('x','1m',close)",
            },
            now_ms=2,
        )
    assert caught.value.details["next_step"]
    with pytest.raises(BacktestError, match="FLAG_DISABLED"):
        service.create_review_bridge("missing", {"start_time_ms": 1, "end_time_ms": 2})
    service.shutdown()


def test_external_model_revision_only_binds_frozen_offline_artifact(
    tmp_path: Path,
) -> None:
    service = _service(tmp_path)
    artifact = {
        "model_artifact_id": "model-1",
        "artifact_hash": "sha256:" + "a" * 64,
        "format": "REMOTE_DESCRIPTOR",
        "runtime_lock": "onnxruntime==frozen",
        "feature_schema": ["open", "high", "low", "close", "volume"],
        "recorded_expression": "close - open",
        "allow_network": False,
    }
    revision = service.create_strategy_revision(
        {
            "name": "frozen model",
            "language": "EXTERNAL_ARTIFACT_REF",
            "source_text": json.dumps(artifact),
        },
        now_ms=2,
    )
    assert revision["base_revision_id"] == "builtin-expression-model-v1"
    with pytest.raises(BacktestError, match="training"):
        service.create_strategy_revision(
            {
                "name": "unsafe model",
                "language": "EXTERNAL_ARTIFACT_REF",
                "source_text": json.dumps({**artifact, "train": True}),
            },
            now_ms=3,
        )
    service.shutdown()


def test_review_bridge_stays_blind_until_bound_training_run_ends(
    tmp_path: Path,
) -> None:
    service = _service(tmp_path, bridge=True)
    revision = _revision(service)
    payload = _payload(str(revision["revision_id"]))
    service.smoke_strategy_revision(str(revision["revision_id"]), payload, now_ms=3)
    run = service.create_run(payload, idempotency_key="bridge", now_ms=4)
    service.execute_bar_run(
        str(run["run_id"]),
        events=_events(),
        provider=BuiltinRsiWilderLongShortProvider(),
        now_ms=5,
    )
    bridge = service.create_review_bridge(
        str(run["run_id"]), {"start_time_ms": 1, "end_time_ms": 3_600_000}, now_ms=6
    )
    bridge_id = str(bridge["bridgeId"])
    assert bridge["strategyProjection"] is None
    service.bind_review_bridge_training_run(bridge_id, "training-independent-1")
    blinded = service.get_review_bridge(bridge_id)
    assert blinded["state"] == "BLINDED" and blinded["comparison"] is None
    with pytest.raises(BacktestError, match="reach ENDED"):
        service.reveal_review_bridge(
            bridge_id,
            training_run_id="training-independent-1",
            training_state="PAUSED",
            human_results={},
            now_ms=7,
        )
    with pytest.raises(BacktestError, match="does not match"):
        service.reveal_review_bridge(
            bridge_id,
            training_run_id="forged",
            training_state="ENDED",
            human_results={},
            now_ms=7,
        )
    revealed = service.reveal_review_bridge(
        bridge_id,
        training_run_id="training-independent-1",
        training_state="ENDED",
        human_results={
            "schema_version": "replay.training-results.v1",
            "summary": {"trade_count": 0},
            "items": [],
            "returned_count": 0,
            "truncated": False,
        },
        now_ms=8,
    )
    assert revealed["state"] == "REVEALED"
    assert revealed["strategyProjection"]["report_hash"].startswith("sha256:")
    assert revealed["comparison"]["humanProjectionHash"].startswith("sha256:")
    assert (
        service.reveal_review_bridge(
            bridge_id,
            training_run_id="training-independent-1",
            training_state="ENDED",
            human_results={},
        )
        == revealed
    )
    service.shutdown()
