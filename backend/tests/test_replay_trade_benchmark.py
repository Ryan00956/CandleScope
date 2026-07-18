from __future__ import annotations

from scripts.benchmark_replay_trade import run_benchmark


def test_generated_trade_benchmark_keeps_reader_and_builder_bounded() -> None:
    report = run_benchmark(
        trade_count=1_000,
        page_rows=100,
        max_closed_bars=4,
    )

    assert report["result"]["source_sequence"] == 1_000
    assert report["bounds"] == {
        "archive_page_calls": 10,
        "archive_max_page_rows": 100,
        "source_max_buffered_rows": 99,
        "builder_closed_bars": 1,
        "builder_max_closed_bars": 4,
        "full_history_materialized": False,
    }
