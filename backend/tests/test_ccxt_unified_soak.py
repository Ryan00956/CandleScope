from __future__ import annotations

from app.exchanges.ccxt_ext.unified_soak import (
    CcxtUnifiedSoakRunner,
    unified_soak_failure_reasons,
)


def test_unified_soak_rejects_invalid_configuration() -> None:
    for values in (
        {"duration_seconds": 0},
        {"symbols": ()},
        {"depth_levels": 50},
        {"duration_seconds": 10, "disconnect_at_seconds": (10,)},
    ):
        try:
            CcxtUnifiedSoakRunner(**values)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid unified soak config accepted: {values}")


def test_unified_soak_gate_accepts_complete_clean_run() -> None:
    report = _clean_report()

    assert unified_soak_failure_reasons(report) == []


def test_unified_soak_gate_rejects_stream_fault_recovery_and_cleanup_failures() -> None:
    report = _clean_report()
    stream = report["streams"]["bybit:swap.linear:BTC/USDT:USDT@trade"]
    stream["duplicates"] = 1
    stream["last_event_at_ms"] = 1
    report["fault_injection"]["faults"][0]["recovered"] = False
    report["shutdown"]["completed"] = False

    assert unified_soak_failure_reasons(report) == [
        "duplicates:bybit:swap.linear:BTC/USDT:USDT@trade",
        "stale:bybit:swap.linear:BTC/USDT:USDT@trade",
        "fault_not_recovered:0",
        "shutdown_incomplete",
    ]


def _clean_report() -> dict:
    key = "bybit:swap.linear:BTC/USDT:USDT@trade"
    return {
        "ready": True,
        "completed_duration": True,
        "completed_at_ms": 1_700_000_100_000,
        "observed_at_ms": 1_700_000_100_000,
        "fatal_errors": [],
        "config": {"stale_after_seconds": 90},
        "streams": {
            key: {
                "events": 100,
                "parse_failures": 0,
                "validation_failures": 0,
                "duplicates": 0,
                "regressions": 0,
                "timestamp_regressions": 3,
                "max_timestamp_regression_ms": 40,
                "last_event_at_ms": 1_700_000_099_000,
            }
        },
        "fault_injection": {
            "requested": 1,
            "completed": 1,
            "faults": [{"recovered": True}],
        },
        "shutdown": {"completed": True},
    }
