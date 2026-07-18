from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    VerifiedRawAggTradeDay,
)
from app.replay.constants import REPLAY_PROTOCOL
from app.replay.models import FeeModel, ReplaySessionConfig, SlippageModel
from tests.fixtures.replay.fakes import FakeKlinesRepo, FixtureIdentity


INTERVAL_MS = 60_000
DAY_START_MS = int(
    datetime(2026, 6, 1, tzinfo=timezone.utc).timestamp() * 1_000
)
TRADE_REPLAY_START_MS = DAY_START_MS + 5 * INTERVAL_MS
TRADE_REPLAY_MINUTES = 4
TRADE_NOW_MS = TRADE_REPLAY_START_MS + 10 * INTERVAL_MS


def trade_replay_repository() -> FakeKlinesRepo:
    identity = FixtureIdentity("binance", "futures", "BTCUSDT")
    rows: list[dict[str, object]] = []
    for minute in range(-2, TRADE_REPLAY_MINUTES + 2):
        open_ms = TRADE_REPLAY_START_MS + minute * INTERVAL_MS
        price = 100 + minute
        if minute < 0:
            volume = 0
            trades = 0
            taker_base = 0
            quote_volume = 0
            taker_quote = 0
        else:
            volume = 2
            trades = 2
            taker_base = 1
            quote_volume = price * 2
            taker_quote = price
        rows.append(
            {
                "open_time": open_ms,
                "close_time": open_ms + INTERVAL_MS - 1,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": volume,
                "quote_volume": quote_volume,
                "trades": trades,
                "taker_buy_base": taker_base,
                "taker_buy_quote": taker_quote,
                "source": "verified_fixture",
            }
        )
    repository = FakeKlinesRepo()
    repository.add_rows(identity, "1m", rows)
    return repository


def verified_trade_archive(root: Path) -> ParquetRawAggTradeArchive:
    archive = ParquetRawAggTradeArchive(
        root,
        max_rows_per_file=3,
        max_scan_rows=10_000,
        max_physical_scan_rows=10_000,
    )
    rows: list[dict[str, object]] = []
    for minute in range(TRADE_REPLAY_MINUTES):
        price = 100 + minute
        for within in range(2):
            index = minute * 2 + within
            timestamp = (
                TRADE_REPLAY_START_MS
                + minute * INTERVAL_MS
                + 1_000
                + within
            )
            rows.append(
                {
                    "exchange": "binance",
                    "market_type": "futures",
                    "symbol": "BTCUSDT",
                    "agg_trade_id": 1_000 + index,
                    "first_trade_id": 10_000 + index,
                    "last_trade_id": 10_000 + index,
                    "price": price,
                    "quantity": 1,
                    "quote_quantity": price,
                    "trade_time_ms": timestamp,
                    "event_time_ms": timestamp,
                    "received_at_ms": timestamp,
                    "is_buyer_maker": within == 0,
                    "source": "binance_public",
                }
            )
    checksum = sha256(b"synthetic-official-fixture").hexdigest()
    metadata = VerifiedRawAggTradeDay(
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        date="2026-06-01",
        source_url=(
            "https://data.binance.vision/data/futures/um/daily/aggTrades/"
            "BTCUSDT/BTCUSDT-aggTrades-2026-06-01.zip"
        ),
        source_file="BTCUSDT-aggTrades-2026-06-01.zip",
        source_checksum_sha256=checksum,
        row_count=len(rows),
        first_agg_trade_id=1_000,
        last_agg_trade_id=1_000 + len(rows) - 1,
        first_trade_time_ms=int(rows[0]["trade_time_ms"]),
        last_trade_time_ms=int(rows[-1]["trade_time_ms"]),
    )
    archive.import_verified_day(rows, metadata)
    return archive


def trade_replay_config(*, blind_mode: bool = False) -> ReplaySessionConfig:
    return ReplaySessionConfig(
        protocol=REPLAY_PROTOCOL,
        source_kind="agg_trade",  # type: ignore[arg-type]
        exchange="binance",
        market_type="futures",
        symbol="BTCUSDT",
        base_interval="1m",
        display_interval="1m",
        start_policy="manual",  # type: ignore[arg-type]
        requested_start_ms=TRADE_REPLAY_START_MS,
        warmup_bars=2,
        horizon_ms=TRADE_REPLAY_MINUTES * INTERVAL_MS,
        random_seed=7,
        quality_mode="exact",  # type: ignore[arg-type]
        blind_mode=blind_mode,
        initial_equity="10000",
        quote_asset="USDT",
        execution_model="paper_linear_v1",  # type: ignore[arg-type]
        fee_model=FeeModel("2", "5"),
        slippage_model=SlippageModel("fixed_bps", "1"),  # type: ignore[arg-type]
        max_leverage="3",
        pause_on_controller_loss=True,
    )
