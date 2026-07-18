from __future__ import annotations

import argparse
import ctypes
import gc
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.data_engine.storage.raw_trade_archive import (  # noqa: E402
    REPLAY_TRADE_DATASET_SCHEMA_VERSION,
    RawAggTradeCursor,
    RawAggTradeDatasetRef,
    RawAggTradeObjectManifest,
    RawAggTradePage,
)
from app.replay.bars.trade_builder import TradeReplayBarBuilder  # noqa: E402
from app.replay.broker.execution import ConservativeBarBroker  # noqa: E402
from app.replay.broker.models import (  # noqa: E402
    BrokerConfig,
    BrokerLimits,
    InstrumentFilters,
)
from app.replay.sources.trade_reader import PagedReplayTradeReader  # noqa: E402
from app.replay.sources.trade_source import TradeReplaySource  # noqa: E402


DEFAULT_TRADE_COUNT = 1_000_000
DEFAULT_PAGE_ROWS = 50_000
START_TIME_MS = 1_800_000_000_000
FIRST_AGG_TRADE_ID = 10_000_000
PRICE_CYCLE = (
    ("100", "1"),
    ("100.1", "1.001"),
    ("99.9", "0.999"),
    ("100.2", "1.002"),
)


def _rss_bytes() -> int | None:
    if sys.platform == "win32":
        class ProcessMemoryCountersEx(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
                ("PrivateUsage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCountersEx()
        counters.cb = ctypes.sizeof(counters)
        get_current_process = ctypes.windll.kernel32.GetCurrentProcess
        get_process_memory_info = ctypes.windll.psapi.GetProcessMemoryInfo
        get_process_memory_info.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_ulong,
        ]
        get_process_memory_info.restype = ctypes.c_int
        handle = get_current_process()
        if get_process_memory_info(handle, ctypes.byref(counters), counters.cb):
            return int(counters.WorkingSetSize)
        return None
    if sys.platform.startswith("linux"):
        try:
            resident_pages = int(
                Path("/proc/self/statm").read_text(encoding="ascii").split()[1]
            )
            return resident_pages * int(os.sysconf("SC_PAGE_SIZE"))
        except (OSError, ValueError, IndexError):
            return None
    return None


@dataclass(slots=True)
class GeneratedPagedArchive:
    dataset_ref: RawAggTradeDatasetRef
    page_calls: int = 0
    max_page_rows_seen: int = 0
    peak_rss_bytes: int | None = None

    @property
    def enabled(self) -> bool:
        return True

    def validate_dataset(self, dataset_ref: RawAggTradeDatasetRef) -> None:
        if dataset_ref != self.dataset_ref:
            raise ValueError("benchmark dataset generation changed")

    def scan_page(
        self,
        *,
        after: RawAggTradeCursor | None,
        limit: int,
        dataset_ref: RawAggTradeDatasetRef,
        **_kwargs: object,
    ) -> RawAggTradePage:
        self.validate_dataset(dataset_ref)
        start_index = (
            0
            if after is None
            else after.agg_trade_id - FIRST_AGG_TRADE_ID + 1
        )
        remaining = dataset_ref.row_count - start_index
        count = min(limit, max(0, remaining))
        rows = tuple(_row(start_index + offset) for offset in range(count))
        self.page_calls += 1
        self.max_page_rows_seen = max(self.max_page_rows_seen, len(rows))
        current_rss = _rss_bytes()
        if current_rss is not None:
            self.peak_rss_bytes = (
                current_rss
                if self.peak_rss_bytes is None
                else max(self.peak_rss_bytes, current_rss)
            )
        exhausted = start_index + count >= dataset_ref.row_count
        cursor = (
            after
            if not rows
            else RawAggTradeCursor(
                int(rows[-1]["trade_time_ms"]),
                int(rows[-1]["agg_trade_id"]),
            )
        )
        return RawAggTradePage(
            rows=rows,
            next_cursor=cursor,
            exhausted=exhausted,
            data_epoch=dataset_ref.data_epoch,
        )


def _row(index: int) -> dict[str, Any]:
    price, quote_quantity = PRICE_CYCLE[index % len(PRICE_CYCLE)]
    agg_trade_id = FIRST_AGG_TRADE_ID + index
    timestamp = START_TIME_MS + index
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "agg_trade_id": agg_trade_id,
        "first_trade_id": agg_trade_id,
        "last_trade_id": agg_trade_id,
        "price": price,
        "quantity": "0.01",
        "quote_quantity": quote_quantity,
        "trade_time_ms": timestamp,
        "is_buyer_maker": index % 2 == 0,
        "source": "binance_public",
    }


def _dataset(trade_count: int) -> RawAggTradeDatasetRef:
    if trade_count < 1:
        raise ValueError("trade_count must be positive")
    last_index = trade_count - 1
    last_id = FIRST_AGG_TRADE_ID + last_index
    last_time = START_TIME_MS + last_index
    replay_end_time = (
        START_TIME_MS
        + ((last_time - START_TIME_MS) // 60_000 + 1) * 60_000
        - 1
    )
    manifest = RawAggTradeObjectManifest(
        object_id="synthetic-benchmark.parquet",
        parquet_sha256="1" * 64,
        manifest_sha256="2" * 64,
        row_count=trade_count,
        min_agg_trade_id=FIRST_AGG_TRADE_ID,
        max_agg_trade_id=last_id,
        min_trade_time_ms=START_TIME_MS,
        max_trade_time_ms=last_time,
        first_trade_time_ms=START_TIME_MS,
        first_agg_trade_id=FIRST_AGG_TRADE_ID,
        source_quality="binance_public_checksum",
        source_checksum_sha256="3" * 64,
    )
    return RawAggTradeDatasetRef(
        schema_version=REPLAY_TRADE_DATASET_SCHEMA_VERSION,
        data_epoch="sha256:" + "4" * 64,
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_time_ms=START_TIME_MS,
        end_time_ms=replay_end_time,
        expected_first_agg_trade_id=FIRST_AGG_TRADE_ID,
        expected_last_agg_trade_id=last_id,
        row_count=trade_count,
        objects=(manifest,),
    )


def _broker(*, replay_end_time_ms: int, max_closed_bars: int) -> ConservativeBarBroker:
    config = BrokerConfig(
        initial_equity="10000",
        quote_asset="USDT",
        maker_bps="2",
        taker_bps="4",
        market_slippage_bps="1",
        initial_mark_price="100",
        instrument=InstrumentFilters(
            price_tick="0.1",
            quantity_step="0.001",
            min_quantity="0.001",
            max_quantity="100",
            min_notional="5",
            max_notional="1000000",
            quote_step="0.00000001",
        ),
        limits=BrokerLimits(
            max_leverage="5",
            max_position_notional="50000",
            max_order_quantity="10",
            max_open_orders=64,
            max_orders=256,
            max_fills=512,
            max_ledger_entries=4096,
            max_warnings=256,
        ),
    )
    return ConservativeBarBroker(
        config=config,
        bar_builder=TradeReplayBarBuilder(
            base_interval="1m",
            display_interval="1m",
            replay_start_ms=START_TIME_MS,
            replay_end_time_ms=replay_end_time_ms,
            max_closed_bars=max_closed_bars,
        ),
    )


def run_benchmark(
    *,
    trade_count: int = DEFAULT_TRADE_COUNT,
    page_rows: int = DEFAULT_PAGE_ROWS,
    max_closed_bars: int = 128,
) -> dict[str, object]:
    dataset_ref = _dataset(trade_count)
    archive = GeneratedPagedArchive(dataset_ref)
    source = TradeReplaySource(
        PagedReplayTradeReader(archive, dataset_ref, page_rows=page_rows)
    )
    broker = _broker(
        replay_end_time_ms=dataset_ref.end_time_ms,
        max_closed_bars=max_closed_bars,
    )
    milestone_targets = {
        max(1, trade_count // 4): "25pct",
        max(1, trade_count // 2): "50pct",
        max(1, trade_count * 3 // 4): "75pct",
        trade_count: "100pct",
    }
    memory_milestones: dict[str, int | None] = {}
    max_source_buffer = 0
    baseline_rss = _rss_bytes()
    started = time.perf_counter()
    processed = 0
    while (trade := source.next()) is not None:
        broker.apply_source_event(trade)
        processed += 1
        max_source_buffer = max(max_source_buffer, source.buffered_count)
        label = milestone_targets.get(processed)
        if label is not None:
            gc.collect()
            memory_milestones[label] = _rss_bytes()
    broker.finalize_session(
        open_order_disposition="expire",
        position_disposition="keep",
        virtual_time_ms=dataset_ref.end_time_ms,
    )
    elapsed_seconds = time.perf_counter() - started
    final_rss = _rss_bytes()

    builder = broker.bar_builder
    if processed != trade_count or source.cursor().source_sequence != trade_count:
        raise RuntimeError("aggregate-trade benchmark did not consume the full dataset")
    if archive.max_page_rows_seen > page_rows or max_source_buffer > page_rows:
        raise RuntimeError("aggregate-trade benchmark exceeded its page bound")
    if len(builder.closed_bars) > max_closed_bars:
        raise RuntimeError("aggregate-trade builder exceeded its closed-bar bound")
    midpoint = memory_milestones.get("50pct")
    end = memory_milestones.get("100pct")
    measured_rss = [
        value
        for value in (
            baseline_rss,
            archive.peak_rss_bytes,
            final_rss,
            *memory_milestones.values(),
        )
        if value is not None
    ]
    return {
        "schema": "replay-agg-trade-benchmark.v1",
        "fixture": {
            "source_kind": "AGG_TRADE",
            "trade_count": trade_count,
            "page_rows": page_rows,
            "data_epoch": dataset_ref.data_epoch,
            "generated": True,
        },
        "result": {
            "elapsed_seconds": round(elapsed_seconds, 6),
            "events_per_second": round(trade_count / elapsed_seconds, 2),
            "source_sequence": source.cursor().source_sequence,
            "last_agg_trade_id": source.cursor().last_agg_trade_id,
            "broker_state_hash": broker.state_hash,
            "report_hash": broker.build_report().report_hash,
        },
        "bounds": {
            "archive_page_calls": archive.page_calls,
            "archive_max_page_rows": archive.max_page_rows_seen,
            "source_max_buffered_rows": max_source_buffer,
            "builder_closed_bars": len(builder.closed_bars),
            "builder_max_closed_bars": max_closed_bars,
            "full_history_materialized": False,
        },
        "memory": {
            "baseline_rss_bytes": baseline_rss,
            "final_rss_bytes": final_rss,
            "peak_sampled_rss_bytes": max(measured_rss) if measured_rss else None,
            "milestones_rss_bytes": memory_milestones,
            "late_half_growth_bytes": (
                None if midpoint is None or end is None else end - midpoint
            ),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run a generated, bounded-page AGG_TRADE source/broker/builder benchmark."
        )
    )
    parser.add_argument("--trades", type=int, default=DEFAULT_TRADE_COUNT)
    parser.add_argument("--page-rows", type=int, default=DEFAULT_PAGE_ROWS)
    parser.add_argument("--max-closed-bars", type=int, default=128)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = run_benchmark(
        trade_count=args.trades,
        page_rows=args.page_rows,
        max_closed_bars=args.max_closed_bars,
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
