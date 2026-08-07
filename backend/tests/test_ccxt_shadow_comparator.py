from __future__ import annotations

from app.exchanges.ccxt_ext.shadow import (
    BinanceCcxtShadowComparator,
    _ccxt_symbol_from_native,
)


def _kline(*, open_time: int = 60_000, closed: bool = True, close: str = "2") -> dict:
    return {
        "e": "kline",
        "E": open_time + 10,
        "s": "BTCUSDT",
        "k": {
            "t": open_time,
            "T": open_time + 59_999,
            "s": "BTCUSDT",
            "i": "1m",
            "f": 1,
            "L": 2,
            "o": "1",
            "c": close,
            "h": "3",
            "l": "0.5",
            "v": "10",
            "n": 2,
            "x": closed,
            "q": "20",
            "V": "6",
            "Q": "12",
        },
    }


def _trade(sequence: int, *, price: str = "64000") -> dict:
    return {
        "e": "aggTrade",
        "E": 1_700_000_000_000 + sequence,
        "s": "BTCUSDT",
        "a": sequence,
        "p": price,
        "q": "0.1",
        "f": sequence * 2,
        "l": sequence * 2 + 1,
        "T": 1_700_000_000_000 + sequence,
        "m": False,
    }


def _depth(final_id: int, previous_id: int, *, quantity: str = "1") -> dict:
    return {
        "e": "depthUpdate",
        "E": 1_700_000_000_000 + final_id,
        "T": 1_700_000_000_000 + final_id,
        "s": "BTCUSDT",
        "U": previous_id + 1,
        "u": final_id,
        "pu": previous_id,
        "b": [["100", quantity]],
        "a": [["101", "2"]],
    }


def _observe_pair(
    comparator: BinanceCcxtShadowComparator, channel: str, payload: dict
) -> None:
    received_at = int(payload["E"]) + 5
    comparator.observe("native", channel, payload, received_at)
    comparator.observe("ccxt", channel, payload, received_at + 1)


def test_matching_closed_kline_trade_and_depth_pass() -> None:
    comparator = BinanceCcxtShadowComparator()
    _observe_pair(comparator, "kline", _kline())
    for sequence in (10, 11, 12):
        _observe_pair(comparator, "aggTrade", _trade(sequence))
    _observe_pair(comparator, "depth", _depth(105, 100))
    _observe_pair(comparator, "depth", _depth(110, 105))

    report = comparator.report()

    assert report["overall_verdict"] == "PASS"
    assert report["channels"]["kline"]["strict_comparison"]["payload_matches"] == 1
    assert report["channels"]["aggTrade"]["strict_comparison"]["payload_matches"] == 3
    assert report["channels"]["depth"]["strict_comparison"]["payload_matches"] == 2


def test_connection_edges_are_trimmed_from_strict_comparison() -> None:
    comparator = BinanceCcxtShadowComparator()
    _observe_pair(comparator, "kline", _kline())
    for sequence in (1, 2, 3):
        comparator.observe("native", "aggTrade", _trade(sequence), 1_700_000_001_000)
    for sequence in (2, 3, 4):
        comparator.observe("ccxt", "aggTrade", _trade(sequence), 1_700_000_001_001)
    for source in ("native", "ccxt"):
        comparator.observe(source, "depth", _depth(105, 100), 1_700_000_001_005)

    comparison = comparator.report()["channels"]["aggTrade"]["strict_comparison"]

    assert comparison["overlap_start"] == 2
    assert comparison["overlap_end"] == 3
    assert comparison["native_only_in_overlap"] == 0
    assert comparison["ccxt_only_in_overlap"] == 0
    assert comparison["payload_matches"] == 2


def test_payload_mismatch_and_depth_link_violation_fail() -> None:
    comparator = BinanceCcxtShadowComparator()
    _observe_pair(comparator, "kline", _kline())
    comparator.observe("native", "aggTrade", _trade(10), 1_700_000_001_000)
    comparator.observe("ccxt", "aggTrade", _trade(10, price="64001"), 1_700_000_001_001)
    for source in ("native", "ccxt"):
        comparator.observe(source, "depth", _depth(105, 100), 1_700_000_001_005)
    comparator.observe("native", "depth", _depth(110, 104), 1_700_000_001_010)
    comparator.observe("ccxt", "depth", _depth(110, 105), 1_700_000_001_011)

    report = comparator.report()

    assert report["overall_verdict"] == "FAIL"
    assert (
        report["channels"]["aggTrade"]["strict_comparison"]["payload_mismatches"] == 1
    )
    assert "native_continuity_violation" in report["channels"]["depth"]["reasons"]


def test_live_only_kline_is_inconclusive_not_pass() -> None:
    comparator = BinanceCcxtShadowComparator()
    _observe_pair(comparator, "kline", _kline(closed=False))
    for sequence in (10, 11):
        _observe_pair(comparator, "aggTrade", _trade(sequence))
    _observe_pair(comparator, "depth", _depth(105, 100))

    report = comparator.report()

    assert report["overall_verdict"] == "INCONCLUSIVE"
    assert report["channels"]["kline"]["verdict"] == "INCONCLUSIVE"
    assert (
        report["channels"]["kline"]["live_diagnostic_comparison"]["payload_matches"]
        == 1
    )


def test_missing_required_fields_fail_closed() -> None:
    comparator = BinanceCcxtShadowComparator()
    malformed = _trade(10)
    del malformed["f"]
    comparator.observe("native", "aggTrade", malformed, 1_700_000_001_000)
    comparator.observe("ccxt", "aggTrade", _trade(10), 1_700_000_001_001)

    channel = comparator.report()["channels"]["aggTrade"]

    assert channel["verdict"] == "FAIL"
    assert channel["sources"]["native"]["missing_required_fields"] == 1


def test_latency_samples_are_bounded_for_long_shadow_runs() -> None:
    comparator = BinanceCcxtShadowComparator(max_records_per_channel=100)
    for sequence in range(150):
        payload = _trade(sequence)
        comparator.observe("native", "aggTrade", payload, int(payload["E"]) + 5)

    source = comparator.report()["channels"]["aggTrade"]["sources"]["native"]

    assert source["received"] == 150
    assert source["receive_minus_exchange_event_ms"]["samples"] == 100


def test_strict_comparison_accumulates_beyond_retention_window() -> None:
    comparator = BinanceCcxtShadowComparator(max_records_per_channel=100)
    for sequence in range(250):
        _observe_pair(comparator, "aggTrade", _trade(sequence))

    comparison = comparator.report()["channels"]["aggTrade"]["strict_comparison"]

    assert comparison["shared_records"] == 250
    assert comparison["payload_matches"] == 250
    assert comparison["payload_mismatches"] == 0
    assert comparison["unpaired_evictions"] == {"native": 0, "ccxt": 0}


def test_early_payload_mismatch_survives_retention_window() -> None:
    comparator = BinanceCcxtShadowComparator(max_records_per_channel=100)
    comparator.observe("native", "aggTrade", _trade(0), 1_700_000_001_000)
    comparator.observe("ccxt", "aggTrade", _trade(0, price="64001"), 1_700_000_001_001)
    for sequence in range(1, 250):
        _observe_pair(comparator, "aggTrade", _trade(sequence))

    comparison = comparator.report()["channels"]["aggTrade"]["strict_comparison"]

    assert comparison["shared_records"] == 250
    assert comparison["payload_matches"] == 249
    assert comparison["payload_mismatches"] == 1
    assert comparison["mismatch_sequences"] == [0]


def test_usdt_symbol_conversion_is_explicit() -> None:
    assert _ccxt_symbol_from_native("btcusdt") == "BTC/USDT:USDT"
