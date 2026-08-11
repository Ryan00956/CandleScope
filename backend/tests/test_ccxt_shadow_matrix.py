from __future__ import annotations

import json

import pytest

from app.exchanges.ccxt_ext.models import CcxtRawMarketEvent
from app.exchanges.ccxt_ext.shadow_matrix import (
    MATRIX_SHADOW_SCHEMA_VERSION,
    CcxtShadowMatrixRunner,
    CcxtShadowMatrixSpec,
    CcxtShadowTarget,
    load_shadow_matrix_spec,
)


def _kline(symbol: str, *, open_time: int = 60_000) -> dict:
    return {
        "e": "kline",
        "E": open_time + 10,
        "s": symbol,
        "k": {
            "t": open_time,
            "T": open_time + 59_999,
            "s": symbol,
            "i": "1m",
            "f": 1,
            "L": 2,
            "o": "1",
            "c": "2",
            "h": "3",
            "l": "0.5",
            "v": "10",
            "n": 2,
            "x": True,
            "q": "20",
            "V": "6",
            "Q": "12",
        },
    }


def _trade(symbol: str, sequence: int = 10) -> dict:
    return {
        "e": "aggTrade",
        "E": 1_700_000_000_000 + sequence,
        "s": symbol,
        "a": sequence,
        "p": "64000",
        "q": "0.1",
        "f": sequence * 2,
        "l": sequence * 2 + 1,
        "T": 1_700_000_000_000 + sequence,
        "m": False,
    }


def _depth(symbol: str, final_id: int = 105, previous_id: int = 100) -> dict:
    return {
        "e": "depthUpdate",
        "E": 1_700_000_000_000 + final_id,
        "T": 1_700_000_000_000 + final_id,
        "s": symbol,
        "U": previous_id + 1,
        "u": final_id,
        "pu": previous_id,
        "b": [["100", "1"]],
        "a": [["101", "2"]],
    }


def _observe_complete_target(runner: CcxtShadowMatrixRunner, symbol: str) -> None:
    comparator = runner._comparators[symbol]
    for channel, payload in (
        ("kline", _kline(symbol)),
        ("aggTrade", _trade(symbol)),
        ("depth", _depth(symbol)),
    ):
        received_at_ms = int(payload["E"]) + 5
        comparator.observe("native", channel, payload, received_at_ms)
        comparator.observe("ccxt", channel, payload, received_at_ms + 1)


def _two_target_spec() -> CcxtShadowMatrixSpec:
    return CcxtShadowMatrixSpec(
        targets=(
            CcxtShadowTarget("BTCUSDT"),
            CcxtShadowTarget("ETHUSDT"),
        ),
        duration_seconds=1,
        startup_timeout_seconds=1,
    )


def test_matrix_spec_is_strict_and_normalizes_symbols(tmp_path) -> None:
    path = tmp_path / "matrix.json"
    path.write_text(
        json.dumps(
            {
                "profile": "BINANCE_USDM",
                "targets": [
                    {
                        "symbol": "btcusdt",
                        "interval": "5m",
                        "depth_update_interval_ms": 250,
                    }
                ],
                "duration_seconds": 10,
                "startup_timeout_seconds": 20,
            }
        ),
        encoding="utf-8",
    )

    spec = load_shadow_matrix_spec(path)

    assert spec.profile == "binance_usdm"
    assert spec.targets[0].symbol == "BTCUSDT"
    assert spec.targets[0].interval == "5m"
    assert spec.targets[0].depth_update_interval_ms == 250

    with pytest.raises(ValueError, match="must be unique"):
        CcxtShadowMatrixSpec(
            targets=(CcxtShadowTarget("BTCUSDT"), CcxtShadowTarget("btcusdt"))
        )
    with pytest.raises(ValueError, match="unknown shadow matrix fields"):
        CcxtShadowMatrixSpec.from_mapping({"targets": [], "relax_gate": True})


def test_every_target_and_channel_must_pass_for_matrix_pass() -> None:
    runner = CcxtShadowMatrixRunner(_two_target_spec())
    _observe_complete_target(runner, "BTCUSDT")
    _observe_complete_target(runner, "ETHUSDT")

    report = runner._build_report(1_000, 2_000, True)

    assert report["schema_version"] == MATRIX_SHADOW_SCHEMA_VERSION
    assert report["overall_verdict"] == "PASS"
    assert report["summary"]["target_verdicts"] == {
        "pass": 2,
        "fail": 0,
        "inconclusive": 0,
    }
    assert report["summary"]["channels"]["aggTrade"]["payload_matches"] == 2
    assert report["capacity"]["stream_count"] == 6


def test_profile_routing_delivers_to_exactly_one_target_and_fails_crosstalk() -> None:
    runner = CcxtShadowMatrixRunner(_two_target_spec())
    payload = _trade("BTCUSDT")

    runner._on_ccxt_raw(
        CcxtRawMarketEvent(
            channel="aggTrade",
            symbol="BTCUSDT",
            payload=payload,
            received_at_ms=int(payload["E"]) + 1,
        )
    )

    assert (
        runner._comparators["BTCUSDT"].report()["channels"]["aggTrade"]["sources"][
            "ccxt"
        ]["received"]
        == 1
    )
    assert (
        runner._comparators["ETHUSDT"].report()["channels"]["aggTrade"]["sources"][
            "ccxt"
        ]["received"]
        == 0
    )
    assert runner._routing_checks == 6
    assert runner._max_route_matches == 1

    unknown = _trade("LTCUSDT")
    runner._on_ccxt_raw(
        CcxtRawMarketEvent(
            channel="aggTrade",
            symbol="LTCUSDT",
            payload=unknown,
            received_at_ms=int(unknown["E"]) + 1,
        )
    )

    assert runner._routing_violations[0]["reason"] == "unmatched_event"
    assert runner._routing_violations[0]["observed_symbol"] == "LTCUSDT"


def test_runtime_error_fails_matrix_even_when_payloads_match() -> None:
    runner = CcxtShadowMatrixRunner(_two_target_spec())
    _observe_complete_target(runner, "BTCUSDT")
    _observe_complete_target(runner, "ETHUSDT")
    runner._ccxt_errors.append(
        {
            "symbol": "ETHUSDT",
            "channel": "depth",
            "type": "NetworkError",
            "message": "connection closed",
            "phase": "measurement",
            "observed_at_ms": 1_500,
        }
    )

    report = runner._build_report(1_000, 2_000, True)

    assert report["overall_verdict"] == "FAIL"
    assert "ccxt_watch_error" in report["reasons"]
    assert report["targets"]["BTCUSDT"]["overall_verdict"] == "PASS"
    assert report["targets"]["ETHUSDT"]["overall_verdict"] == "FAIL"
    assert report["runtime"]["observation_window"] == "INTERRUPTED"
