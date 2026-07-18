from __future__ import annotations

from typing import Any

from app.data_engine.storage.raw_trade_archive import (
    RawAggTradeCursor,
    RawAggTradeDatasetRef,
    RawAggTradeObjectManifest,
    RawAggTradePage,
)


START_MS = 1_780_272_001_000


def make_trade_row(
    index: int,
    *,
    trade_time_ms: int | None = None,
) -> dict[str, Any]:
    trade_id = 100 + index
    timestamp = START_MS + index if trade_time_ms is None else trade_time_ms
    return {
        "exchange": "binance",
        "market_type": "futures",
        "symbol": "BTCUSDT",
        "agg_trade_id": trade_id,
        "first_trade_id": 1_000 + index * 2,
        "last_trade_id": 1_001 + index * 2,
        "price": 100.0 + index / 10,
        "quantity": 0.5,
        "quote_quantity": (100.0 + index / 10) * 0.5,
        "trade_time_ms": timestamp,
        "event_time_ms": timestamp,
        "received_at_ms": timestamp,
        "is_buyer_maker": index % 2 == 0,
        "source": "binance_public",
    }


def make_trade_dataset(row_count: int) -> RawAggTradeDatasetRef:
    return RawAggTradeDatasetRef(
        schema_version="raw-agg-trade-replay.v1",
        data_epoch="sha256:" + "1" * 64,
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        start_time_ms=START_MS,
        end_time_ms=START_MS + max(0, row_count - 1),
        expected_first_agg_trade_id=100,
        expected_last_agg_trade_id=99 + row_count,
        row_count=row_count,
        objects=(
            RawAggTradeObjectManifest(
                object_id="exchange=binance/date=2026-06-01/part.parquet",
                parquet_sha256="2" * 64,
                manifest_sha256="3" * 64,
                row_count=row_count,
                min_agg_trade_id=100,
                max_agg_trade_id=99 + row_count,
                min_trade_time_ms=START_MS,
                max_trade_time_ms=START_MS + max(0, row_count - 1),
                first_trade_time_ms=START_MS,
                first_agg_trade_id=100,
                source_quality="binance_public_checksum",
                source_checksum_sha256="4" * 64,
            ),
        ),
    )


class FakeRawAggTradeArchive:
    enabled = True

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.epoch_override: str | None = None
        self.inject_overlap = False

    def validate_dataset(self, _dataset: RawAggTradeDatasetRef) -> None:
        return None

    def scan_page(
        self,
        *,
        after: RawAggTradeCursor | None,
        limit: int,
        dataset_ref: RawAggTradeDatasetRef,
        **_kwargs: object,
    ) -> RawAggTradePage:
        start = 0 if after is None else after.agg_trade_id - 99
        if self.inject_overlap and after is not None:
            start -= 1
        selected = self.rows[start : start + limit]
        exhausted = start + len(selected) >= len(self.rows)
        next_cursor = (
            after
            if not selected
            else RawAggTradeCursor(
                int(selected[-1]["trade_time_ms"]),
                int(selected[-1]["agg_trade_id"]),
            )
        )
        return RawAggTradePage(
            rows=tuple(selected),
            next_cursor=next_cursor,
            exhausted=exhausted,
            data_epoch=self.epoch_override or dataset_ref.data_epoch,
        )
