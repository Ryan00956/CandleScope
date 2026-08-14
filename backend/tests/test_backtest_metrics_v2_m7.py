from __future__ import annotations

import json
import math
import statistics
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from app.backtest.metrics_v2 import (
    METRICS_VERSION,
    build_market_context,
    enrich_trades_v2,
    parse_metrics_identity,
)
from app.backtest.reports import build_report, export_bundle, verify_report_hash
from app.backtest.errors import BacktestError
from app.backtest.service import BacktestService
from app.backtest.runtime import BacktestRuntime
from app.core.config import load_backtest_settings
from app.market_dataset.snapshot import MarketEvent
from app.local_data.service import LocalDatasetService, LocalImportOptions


def _run(*, days: int = 31) -> dict[str, object]:
    start = int(datetime(2024, 1, 1, tzinfo=UTC).timestamp() * 1000)
    config = {
        "account_model": "LINEAR_PERP_ONE_WAY_V2",
        "execution_model_revision": "EXECUTION_REALISM_V2",
        "metrics_version": METRICS_VERSION,
        "report_schema": "candlescope.backtest-report/2",
        "equity_sampling": "UTC_DAILY_CLOSE_V1",
        "annualization_days": 365,
        "risk_free_rate_annual": "0",
        "benchmark_model": "BUY_HOLD_SAME_WINDOW_COSTS_V1",
        "sample_role": "OUT_OF_SAMPLE",
        "initial_balance": "10000",
        "taker_fee_bps": "0",
        "slippage_bps": "0",
        "fill_policy": "BAR_VOLUME_PARTICIPATION_WORST_CASE_V2",
    }
    return {
        "run_id": "bt_metrics_v2",
        "state": "COMPLETED",
        "fidelity_mode": "BAR_APPROX",
        "source_event_kind": "BAR",
        "strategy_revision_id": "fixture-v1",
        "dataset_id": "fixture",
        "data_epoch": "epoch-2024",
        "snapshot_hash": "sha256:snapshot",
        "config_hash": "sha256:config",
        "engine_version": "fixture",
        "account_model": "LINEAR_PERP_ONE_WAY_V2",
        "start_time_ms": start,
        "end_time_ms": start + days * 86_400_000,
        "config_json": json.dumps(config),
    }


def _payload(*, days: int = 31, closed_trade: bool = True) -> dict[str, object]:
    start = datetime(2024, 1, 1, tzinfo=UTC)
    equity = []
    for day in range(days + 1):
        value = Decimal("10000") + Decimal(day * 7) + Decimal((-1) ** day * 5)
        equity.append(
            {
                "sequence": day + 1,
                "event_time_ms": int((start + timedelta(days=day)).timestamp() * 1000),
                "equity": str(value),
                "position_qty": "1" if 0 < day < days else "0",
            }
        )
    if closed_trade:
        fills = [
            {
                "order_id": "o1",
                "sequence": 1,
                "event_time_ms": int(start.timestamp() * 1000),
                "side": "BUY",
                "price": "100",
                "qty": "1",
                "fee": "1",
                "reason": "ENTRY",
                "source_sequence": 1,
            },
            {
                "order_id": "o2",
                "sequence": 2,
                "event_time_ms": int((start + timedelta(days=days)).timestamp() * 1000),
                "side": "SELL",
                "price": "202",
                "qty": "1",
                "fee": "1",
                "reason": "EXIT",
                "source_sequence": 2,
            },
        ]
        realized, fees, wallet, final = "102", "2", "10100", "10100"
        equity[-1]["equity"] = final
    else:
        fills = []
        realized, fees, wallet, final = "0", "0", "10000", "10000"
        equity = equity[:2]
        equity[-1]["equity"] = final
    account = {
        "initial_balance": "10000",
        "wallet_balance": wallet,
        "quote_balance": wallet,
        "unrealized_pnl": "0",
        "equity": final,
        "position_qty": "0",
        "cumulative_realized_pnl": realized,
        "cumulative_fees": fees,
        "cumulative_funding": "0",
        "ledger_entries": [],
    }
    return {
        "fills": fills,
        "orders": [],
        "rejected": [],
        "ambiguity_count": 0,
        "decision_hash": "sha256:decision",
        "fill_hash": "sha256:fill",
        "ledger_hash": "sha256:ledger",
        "ledger": {"account": account, "fee_total": fees},
        "equity_curve": equity,
        "data_quality": {"gap_count": 0, "duplicate_count": 0, "warnings": []},
        "fill_model": {"name": "BAR_VOLUME_PARTICIPATION_WORST_CASE_V2"},
        "metrics_market_context": {
            "context_hash": "sha256:market",
            "first": {"event_time_ms": int(start.timestamp() * 1000), "price": "100"},
            "last": {
                "event_time_ms": int((start + timedelta(days=days)).timestamp() * 1000),
                "price": "110",
            },
            "fill_source_prices": {"1": "99", "2": "203"},
        },
    }


def test_metrics_identity_is_explicit_and_fail_closed() -> None:
    assert parse_metrics_identity({}) == {}
    identity = parse_metrics_identity(
        {"metrics_version": METRICS_VERSION, "sample_role": "OUT_OF_SAMPLE"}
    )
    assert identity["report_schema"] == "candlescope.backtest-report/2"
    assert identity["equity_sampling"] == "UTC_DAILY_CLOSE_V1"
    with pytest.raises(ValueError, match="sample_role"):
        parse_metrics_identity(
            {"metrics_version": METRICS_VERSION, "sample_role": "BEST"}
        )
    with pytest.raises(ValueError, match="risk_free_rate_annual"):
        parse_metrics_identity(
            {"metrics_version": METRICS_VERSION, "risk_free_rate_annual": "NaN"}
        )


def test_service_persists_metrics_identity_and_requires_mature_dependencies(
    tmp_path: Path,
) -> None:
    service = BacktestService.start(
        load_backtest_settings(
            {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
            data_dir=tmp_path,
            klines_db_path=tmp_path / "candlescope.db",
            replay_db_path=tmp_path / "replay.db",
        ),
        now_ms=1,
    )
    base = {
        "strategy_revision_id": "builtin-sma-cross-v1",
        "dataset_id": "local-m7",
        "data_epoch": "sha256:" + "11" * 32,
        "snapshot_hash": "sha256:" + "22" * 32,
        "fidelity_mode": "BAR_APPROX",
        "source_event_kind": "BAR",
        "start_time_ms": 1,
        "end_time_ms": 100,
        "parameters": {"fast": 2, "slow": 3},
        "metrics_version": METRICS_VERSION,
        "sample_role": "OUT_OF_SAMPLE",
        "risk_free_rate_annual": "0.02",
    }
    with pytest.raises(BacktestError, match="requires LINEAR_PERP_ONE_WAY_V2"):
        service.validate_run(base)
    created = service.create_run(
        {
            **base,
            "account_model": "LINEAR_PERP_ONE_WAY_V2",
            "contract_data_mode": "HISTORICAL_CONTRACT_V1",
            "execution_model_revision": "EXECUTION_REALISM_V2",
            "participation_rate": "0.1",
            "bar_path_scenario": "OHLC_WORST_CASE_STOP_FIRST_V1",
        },
        idempotency_key="m7-identity",
        now_ms=2,
    )
    config = json.loads(str(created["config_json"]))
    assert config["report_schema"] == "candlescope.backtest-report/2"
    assert config["metrics_version"] == METRICS_VERSION
    assert config["risk_free_rate_annual"] == "0.02"
    assert config["sample_role"] == "OUT_OF_SAMPLE"
    service.shutdown()


def test_metrics_v2_matches_independent_daily_reference() -> None:
    report = build_report(_run(), _payload())
    assert report["schemaVersion"] == "candlescope.backtest-report/2"
    assert verify_report_hash(report)
    performance = report["performance"]
    assert performance["reconciliation"]["passed"] is True
    assert performance["trading"]["trade_count"] == 1
    assert performance["returns"]["net_pnl"]["value"] == "100"

    closes = [Decimal(item["equity"]) for item in performance["equity_daily"]]
    returns = [float(right / left - 1) for left, right in zip(closes, closes[1:])]
    reference = statistics.stdev(returns) * math.sqrt(365)
    observed = float(performance["risk"]["volatility"]["value"])
    assert observed == pytest.approx(reference, rel=1e-12)


def test_trade_mae_mfe_uses_authoritative_source_sequence() -> None:
    fills = [
        {
            "order_id": "o1",
            "sequence": 1,
            "source_sequence": 1,
            "side": "BUY",
            "price": "100",
            "qty": "1",
            "fee": "0",
            "reason": "RSI_LONG",
        },
        {
            "order_id": "o2",
            "sequence": 4,
            "source_sequence": 4,
            "side": "SELL",
            "price": "110",
            "qty": "1",
            "fee": "0",
            "reason": "RSI_EXIT",
        },
    ]
    events = tuple(
        MarketEvent(
            sequence=index,
            event_time_ms=index * 1000,
            role="BARS",
            payload=payload,
        )
        for index, payload in enumerate(
            (
                {"open": "100", "high": "101", "low": "99", "close": "100"},
                {"open": "95", "high": "102", "low": "90", "close": "95"},
                {"open": "120", "high": "130", "low": "100", "close": "120"},
                {"open": "110", "high": "200", "low": "1", "close": "110"},
            ),
            start=1,
        )
    )
    context = build_market_context(events, fills)
    trade = {
        "trade_id": "trade-1",
        "side": "LONG",
        "entry_sequence": "1",
        "exit_sequence": "4",
    }
    enriched = enrich_trades_v2([trade], context)[0]
    assert enriched["mae"] == "-0.1"
    assert enriched["mfe"] == "0.3"
    assert enriched["entry_reason"] == "RSI_LONG"
    assert enriched["exit_reason"] == "RSI_EXIT"


def test_zero_trade_and_short_window_are_null_with_reasons() -> None:
    report = build_report(_run(days=1), _payload(days=1, closed_trade=False))
    performance = report["performance"]
    assert performance["trading"]["win_rate"] == {
        "value": None,
        "reason": "NO_CLOSED_TRADES",
    }
    assert performance["risk"]["sharpe"]["reason"] == "FEWER_THAN_30_DAILY_RETURNS"
    assert performance["returns"]["annualized_return"]["value"] is None
    assert performance["reconciliation"]["passed"] is True


def test_non_positive_equity_has_explicit_null_reasons() -> None:
    payload = _payload(days=31, closed_trade=False)
    account = payload["ledger"]["account"]
    account["wallet_balance"] = "-1"
    account["quote_balance"] = "-1"
    account["equity"] = "-1"
    payload["equity_curve"][-1]["equity"] = "-1"
    report = build_report(_run(days=400), payload)
    assert report["performance"]["returns"]["annualized_return"] == {
        "value": None,
        "reason": "NON_POSITIVE_FINAL_EQUITY",
    }
    assert report["performance"]["risk"]["sharpe"]["reason"] == (
        "NON_POSITIVE_EQUITY_IN_SAMPLING"
    )


def test_v2_export_binds_json_and_csv_to_same_report_hash() -> None:
    run = _run()
    report = build_report(run, _payload())
    bundle = export_bundle(run, report)
    expected = report["hashes"]["report"]
    assert bundle["manifest"]["reportSchema"] == "candlescope.backtest-report/2"
    assert bundle["manifest"]["artifacts"] == {
        "json": {"reportHash": expected},
        "csv": {"reportHash": expected},
    }


def test_legacy_report_v1_remains_readable_and_hash_stable() -> None:
    run = _run()
    legacy_config = json.loads(str(run["config_json"]))
    for key in (
        "metrics_version",
        "report_schema",
        "equity_sampling",
        "annualization_days",
        "risk_free_rate_annual",
        "benchmark_model",
        "sample_role",
    ):
        legacy_config.pop(key, None)
    run["config_json"] = json.dumps(legacy_config)

    first = build_report(run, _payload())
    second = build_report(run, _payload())
    assert first["schemaVersion"] == "candlescope.backtest-report/1"
    assert "performance" not in first
    assert verify_report_hash(first)
    assert second["hashes"]["report"] == first["hashes"]["report"]
    assert export_bundle(run, first)["manifest"]["reportSchema"] == (
        "candlescope.backtest-report/1"
    )


def test_public_runtime_seals_report_v2_and_export(tmp_path: Path) -> None:
    start = 1_704_067_200_000
    day = 86_400_000
    csv_path = tmp_path / "bars.csv"
    csv_path.write_text(
        "time,open,high,low,close,volume\n"
        + "\n".join(
            f"{start + index * day},{100 + index},{103 + index},{98 + index},{101 + index},10"
            for index in range(40)
        ),
        encoding="utf-8",
    )
    local_root = tmp_path / "local"
    local = LocalDatasetService(local_root)
    original = local.import_csv(
        csv_path,
        LocalImportOptions(
            name="M7 runtime fixture",
            symbol="BTCUSDT",
            interval="1d",
            timestamp_unit="ms",
        ),
    )
    tier = {
        "notional_floor": "0",
        "notional_cap": "1000000",
        "maintenance_rate": "0.005",
        "maintenance_deduction": "0",
    }
    provenance = {
        "provider": "M7_PINNED_FIXTURE",
        "source_url": "https://example.invalid/m7",
        "capture_receipt": "m7-fixture",
    }
    bundle = {
        "schema_version": "candlescope.contract-history.v1",
        "identity": {"venue": "binance", "market_type": "usdm", "symbol": "BTCUSDT"},
        "roles": {
            "MARK_INDEX": {
                "cadence_ms": day,
                "retention_policy": "user_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "event_time_ms": start + index * day,
                        "mark_price": str(101 + index),
                        "index_price": str(101 + index),
                    }
                    for index in range(40)
                ],
            },
            "FUNDING": {
                "period_ms": day,
                "retention_policy": "user_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "settlement_time_ms": start + index * day,
                        "period_id": f"p-{index}",
                        "funding_rate": "0",
                        "mark_price": str(101 + index),
                    }
                    for index in range(1, 41)
                ],
            },
            "INSTRUMENT_RULES": {
                "retention_policy": "user_local_immutable",
                "provenance": provenance,
                "records": [
                    {
                        "effective_from_ms": start,
                        "effective_to_ms": start + 40 * day - 1,
                        "rule_version": "m7-rule-v1",
                        "contract_multiplier": "1",
                        "price_tick": "0.1",
                        "quantity_step": "0.001",
                        "min_quantity": "0.001",
                        "max_quantity": "1000",
                        "min_notional": "5",
                        "maintenance_tiers": [tier],
                    }
                ],
            },
        },
    }
    bundle_path = tmp_path / "contract.json"
    bundle_path.write_text(json.dumps(bundle), encoding="utf-8")
    attached = local.import_contract_history(
        bundle_path,
        dataset_id=str(original["dataset_id"]),
        data_epoch=str(original["data_epoch"]),
    )
    settings = load_backtest_settings(
        {"BACKTEST_ENABLED": "1", "BACKTEST_BAR_ENABLED": "1"},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "candlescope.db",
        replay_db_path=tmp_path / "replay.db",
    )
    runtime = BacktestRuntime.start(settings, local_data_dir=local_root)
    try:
        preview = runtime.preview_snapshot(
            dataset_id=str(attached["dataset_id"]),
            data_epoch=str(attached["data_epoch"]),
            start_time_ms=start,
            end_time_ms=start + 40 * day - 1,
            interval="1d",
            contract_data_mode="HISTORICAL_CONTRACT_V1",
            account_model="LINEAR_PERP_ONE_WAY_V2",
            funding_mode="OFF",
        )
        created = runtime.service.create_run(
            {
                "strategy_revision_id": "builtin-order-command-v1",
                "dataset_id": attached["dataset_id"],
                "data_epoch": attached["data_epoch"],
                "snapshot_hash": preview["snapshot_hash"],
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": start,
                "end_time_ms": start + 40 * day - 1,
                "interval": "1d",
                "strategy_source": json.dumps({"commands": []}),
                "output_mode": "ORDER_INTENT",
                "account_model": "LINEAR_PERP_ONE_WAY_V2",
                "contract_data_mode": "HISTORICAL_CONTRACT_V1",
                "funding_mode": "OFF",
                "execution_model_revision": "EXECUTION_REALISM_V2",
                "participation_rate": "0.1",
                "bar_path_scenario": "OHLC_WORST_CASE_STOP_FIRST_V1",
                "metrics_version": METRICS_VERSION,
                "sample_role": "OUT_OF_SAMPLE",
                "risk_free_rate_annual": "0.02",
            },
            idempotency_key="m7-runtime",
        )
        deadline = time.monotonic() + 8
        record = created
        while time.monotonic() < deadline:
            record = runtime.service.get_run(str(created["run_id"]))
            if record["state"] in {"COMPLETED", "FAILED"}:
                break
            time.sleep(0.05)
        assert record["state"] == "COMPLETED", record
        report = runtime.service.get_report(str(created["run_id"]))
        assert report["schemaVersion"] == "candlescope.backtest-report/2"
        assert report["performance"]["reconciliation"]["passed"] is True
        assert report["performance"]["risk"]["volatility"]["value"] is not None
        assert len(report["performance"]["equity_daily"]) == 40
        exported = export_bundle(record, report)
        assert exported["manifest"]["reportHash"] == report["hashes"]["report"]
    finally:
        runtime.shutdown()


def test_report_v2_golden_fixture() -> None:
    fixture = json.loads(
        (
            Path(__file__).parent / "fixtures" / "backtest" / "report_v2_golden.json"
        ).read_text(encoding="utf-8")
    )
    report = build_report(_run(days=1), _payload(days=1, closed_trade=False))
    observed = {
        "schemaVersion": report["schemaVersion"],
        "reportHash": report["hashes"]["report"],
        "identity": report["identity"],
        "credibility": report["credibility"],
        "returns": report["performance"]["returns"],
        "risk": report["performance"]["risk"],
        "trading": report["performance"]["trading"],
        "execution": report["performance"]["execution"],
        "monthly_returns": report["performance"]["monthly_returns"],
        "reconciliation": report["performance"]["reconciliation"],
        "metricsHash": report["performance"]["metrics_hash"],
    }
    assert observed == fixture
