from __future__ import annotations

import json
import sqlite3
from decimal import Decimal
from hashlib import sha256
from pathlib import Path

from app.replay.training.hedge_inputs import (
    build_hedge_public_history_archive,
    build_hedge_simulation_manifest,
)
from app.replay.training.historical_book import (
    ARCHIVE_PROTOCOL,
    ARCHIVE_SCHEMA_VERSION,
    ARCHIVE_SOURCE_CONTRACT_URL,
)
from app.replay.training.models import (
    HEDGE_ACCOUNT_FIDELITY,
    HEDGE_INSURANCE_ADL_FIDELITY,
    TrainingRunCreateRequest,
)


def _levels(value: list[list[str]]) -> str:
    return json.dumps(value, separators=(",", ":"))


def build_book_archive(
    path: Path,
    *,
    exchange: str,
    market_type: str,
    symbol: str,
    range_start_ms: int,
    range_end_ms: int,
    interval_ms: int = 60_000,
    mid_prices: list[str] | None = None,
    level_quantities: list[str] | None = None,
    price_offset: str = "0",
) -> Path:
    dataset_epoch = (
        "sha256:"
        + sha256(
            f"book:{exchange}:{market_type}:{symbol}:{range_start_ms}:{range_end_ms}".encode()
        ).hexdigest()
    )
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE archive_meta (
                singleton INTEGER PRIMARY KEY,
                protocol TEXT NOT NULL,
                schema_version TEXT NOT NULL,
                exchange TEXT NOT NULL,
                market_type TEXT NOT NULL,
                symbol TEXT NOT NULL,
                range_start_ms INTEGER NOT NULL,
                range_end_ms INTEGER NOT NULL,
                dataset_epoch TEXT NOT NULL,
                source TEXT NOT NULL,
                source_contract_url TEXT NOT NULL,
                max_depth_levels INTEGER NOT NULL
            );
            CREATE TABLE book_frame (
                ordinal INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,
                event_time_ms INTEGER NOT NULL,
                transaction_time_ms INTEGER NOT NULL,
                first_update_id INTEGER,
                final_update_id INTEGER NOT NULL,
                previous_final_update_id INTEGER,
                bids_json TEXT NOT NULL,
                asks_json TEXT NOT NULL
            );
            """
        )
        frame_count = (range_end_ms - range_start_ms) // interval_ms + 1
        mids = mid_prices or ["100"] * frame_count
        if not mids or len(mids) > frame_count:
            raise ValueError("book mid_prices exceed the requested range")
        mids = [*mids, *([mids[-1]] * (frame_count - len(mids)))]
        quantities = level_quantities or ["10", "20"]
        if not quantities or any(Decimal(value) <= 0 for value in quantities):
            raise ValueError("book level quantities must be positive")
        offset = Decimal(price_offset)

        def levels_at(mid: str) -> tuple[list[list[str]], list[list[str]]]:
            center = Decimal(mid) + offset
            bids = [
                [format(center - Decimal(index), "f"), quantity]
                for index, quantity in enumerate(quantities, start=1)
            ]
            asks = [
                [format(center + Decimal(index), "f"), quantity]
                for index, quantity in enumerate(quantities, start=1)
            ]
            return bids, asks

        initial_bids, initial_asks = levels_at(mids[0])
        connection.execute(
            """
            INSERT INTO archive_meta VALUES (
                1, ?, ?, ?, ?, ?, ?, ?, ?,
                'BINANCE_USDM_DIFF_DEPTH_CAPTURE', ?, 1000
            )
            """,
            (
                ARCHIVE_PROTOCOL,
                ARCHIVE_SCHEMA_VERSION,
                exchange,
                market_type,
                symbol,
                range_start_ms,
                range_end_ms,
                dataset_epoch,
                ARCHIVE_SOURCE_CONTRACT_URL,
            ),
        )
        connection.execute(
            """
            INSERT INTO book_frame VALUES (
                0, 'SNAPSHOT', ?, ?, NULL, 100, NULL, ?, ?
            )
            """,
            (
                range_start_ms,
                range_start_ms,
                _levels(initial_bids),
                _levels(initial_asks),
            ),
        )
        previous = 100
        previous_bids = {price: quantity for price, quantity in initial_bids}
        previous_asks = {price: quantity for price, quantity in initial_asks}
        ordinal = 1
        event_time = range_start_ms + interval_ms
        while event_time <= range_end_ms:
            final = previous + 1
            next_bids_list, next_asks_list = levels_at(mids[ordinal])
            next_bids = {price: quantity for price, quantity in next_bids_list}
            next_asks = {price: quantity for price, quantity in next_asks_list}
            bid_changes = {
                **{price: "0" for price in previous_bids if price not in next_bids},
                **next_bids,
            }
            ask_changes = {
                **{price: "0" for price in previous_asks if price not in next_asks},
                **next_asks,
            }
            connection.execute(
                """
                INSERT INTO book_frame VALUES (
                    ?, 'DELTA', ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    ordinal,
                    event_time,
                    event_time,
                    previous if ordinal == 1 else final,
                    final,
                    previous,
                    _levels(
                        [[price, quantity] for price, quantity in bid_changes.items()]
                    ),
                    _levels(
                        [[price, quantity] for price, quantity in ask_changes.items()]
                    ),
                ),
            )
            previous = final
            previous_bids = next_bids
            previous_asks = next_asks
            ordinal += 1
            event_time += interval_ms
    return path


async def import_hedge_track_public_inputs(
    service: object,
    request: TrainingRunCreateRequest,
    *,
    root: Path,
    prefix: str,
    symbol: str,
    mark_prices: list[str] | None = None,
) -> dict[str, object]:
    """Import exact L2 plus its content-bound public HEDGE archive for one track."""

    training = getattr(service, "training")
    if training is None:
        raise TypeError("replay training service is unavailable")
    start = request.requested_start_ms
    if start is None:
        raise ValueError("HEDGE track input requires a manual start")
    interval_ms = 60_000
    end = start + request.forward_cache_ms
    marks = mark_prices or ["200"] * ((end - start) // interval_ms + 1)
    if len(marks) != (end - start) // interval_ms + 1:
        raise ValueError("track mark_prices does not cover the requested range")
    book_path = build_book_archive(
        root / f"{prefix}-{symbol.lower()}-book.sqlite3",
        exchange=request.exchange,
        market_type=request.market_type,
        symbol=symbol,
        range_start_ms=start,
        range_end_ms=end + interval_ms,
        interval_ms=interval_ms,
        mid_prices=marks,
    )
    book = await training.historical_books.import_archive(
        book_path,
        trusted_origin="TEST_CAPTURE",
    )
    rule = {
        "rule_version": "BINANCE_USDM_LINEAR_V1",
        "price_tick": "0.1",
        "quantity_step": "0.001",
        "min_quantity": "0.001",
        "max_quantity": "100",
        "min_notional": "5",
        "max_notional": "1000000",
        "quote_step": "0.01",
        "contract_size": "1",
        "max_leverage": "20",
        "liquidation_fee_bps": "25",
        "maintenance_tiers": [
            {
                "notional_cap": "50000",
                "maintenance_rate": "0.005",
                "maintenance_deduction": "0",
            },
            {
                "notional_cap": "1000000",
                "maintenance_rate": "0.01",
                "maintenance_deduction": "250",
            },
        ],
    }
    fee = {
        "policy_version": "BINANCE_VIP0_V1",
        "account_tier": "VIP0",
        "maker_fee_bps": "2",
        "taker_fee_bps": "5",
        "liquidation_fee_bps": "25",
    }
    events: list[dict[str, object]] = [
        {"event_time_ms": start, "event_kind": "RULE", "payload": rule},
        {"event_time_ms": start, "event_kind": "FEE_POLICY", "payload": fee},
        *[
            {
                "event_time_ms": start + index * interval_ms,
                "event_kind": "MARK_INDEX",
                "payload": {"mark_price": price, "index_price": price},
            }
            for index, price in enumerate(marks)
        ],
        {
            "event_time_ms": min(end, start + interval_ms),
            "event_kind": "FUNDING",
            "payload": {"funding_rate": "0.0001", "mark_price": marks[1]},
        },
    ]
    events.sort(
        key=lambda item: (
            int(item["event_time_ms"]),
            {"RULE": 10, "FEE_POLICY": 10, "MARK_INDEX": 30, "FUNDING": 40}[
                str(item["event_kind"])
            ],
            str(item["event_kind"]),
        )
    )
    public_path = root / f"{prefix}-{symbol.lower()}-public.json"
    public_ref = build_hedge_public_history_archive(
        public_path,
        archive_id=f"{prefix}-{symbol.lower()}-public",
        exchange=request.exchange,
        market_type=request.market_type,
        symbol=symbol,
        settlement_asset=request.settlement_asset,
        range_start_ms=start,
        range_end_ms=end,
        max_mark_gap_ms=interval_ms,
        source_identity="TEST_PINNED_PUBLIC_CAPTURE",
        capture_receipt=f"receipt:{prefix}:{symbol}",
        historical_l2_ref={
            "archive_id": book["archive_id"],
            "dataset_epoch": book["dataset_epoch"],
            "checksum_sha256": book["checksum_sha256"],
        },
        events=events,
    )
    await training.hedge_inputs.import_public(public_path)
    return {"book": book, "public": public_ref}


async def prepare_hedge_request(
    service: object,
    request: TrainingRunCreateRequest,
    *,
    root: Path,
    prefix: str,
    mark_prices: list[str] | None = None,
    insurance_opening_balance: str = "1000000",
    adl_candidates: list[dict[str, object]] | None = None,
    maintenance_tiers: list[dict[str, str]] | None = None,
    book_level_quantities: list[str] | None = None,
    book_price_offset: str = "0",
    required_symbols: list[str] | None = None,
    book_mode: str = "BOOK_ASSISTED_REQUIRED",
    contract_size: str = "1",
    funding_event_offset_bars: int = 1,
) -> TrainingRunCreateRequest:
    training = getattr(service, "training")
    if training is None:
        raise TypeError("replay training service is unavailable")
    start = request.requested_start_ms
    if start is None:
        raise ValueError("HEDGE test input requires a manual start")
    interval_ms = 60_000
    end = start + request.forward_cache_ms
    book_end = end + interval_ms
    marks = mark_prices or ["100"] * ((end - start) // interval_ms + 1)
    if len(marks) != (end - start) // interval_ms + 1:
        raise ValueError("mark_prices does not cover the requested range")
    book = None
    if book_mode == "BOOK_ASSISTED_REQUIRED":
        book_path = build_book_archive(
            root / f"{prefix}-book.sqlite3",
            exchange=request.exchange,
            market_type=request.market_type,
            symbol=request.symbol,
            range_start_ms=start,
            range_end_ms=book_end,
            interval_ms=interval_ms,
            mid_prices=marks,
            level_quantities=book_level_quantities,
            price_offset=book_price_offset,
        )
        book = await training.historical_books.import_archive(
            book_path,
            trusted_origin="TEST_CAPTURE",
        )
    events: list[dict[str, object]] = [
        {
            "event_time_ms": start,
            "event_kind": "RULE",
            "payload": {
                "rule_version": "BINANCE_USDM_LINEAR_V1",
                "price_tick": "0.1",
                "quantity_step": "0.001",
                "min_quantity": "0.001",
                "max_quantity": "100",
                "min_notional": "5",
                "max_notional": "1000000",
                "quote_step": "0.01",
                "contract_size": contract_size,
                "max_leverage": "20",
                "liquidation_fee_bps": "25",
                "maintenance_tiers": maintenance_tiers
                or [
                    {
                        "notional_cap": "50000",
                        "maintenance_rate": "0.005",
                        "maintenance_deduction": "0",
                    },
                    {
                        "notional_cap": "1000000",
                        "maintenance_rate": "0.01",
                        "maintenance_deduction": "250",
                    },
                ],
            },
        },
        {
            "event_time_ms": start,
            "event_kind": "FEE_POLICY",
            "payload": {
                "policy_version": "BINANCE_VIP0_V1",
                "account_tier": "VIP0",
                "maker_fee_bps": "2",
                "taker_fee_bps": "5",
                "liquidation_fee_bps": "25",
            },
        },
    ]
    events.extend(
        {
            "event_time_ms": start + index * interval_ms,
            "event_kind": "MARK_INDEX",
            "payload": {"mark_price": price, "index_price": price},
        }
        for index, price in enumerate(marks)
    )
    funding_index = min(funding_event_offset_bars, len(marks) - 1)
    events.append(
        {
            "event_time_ms": min(end, start + funding_index * interval_ms),
            "event_kind": "FUNDING",
            "payload": {
                "funding_rate": "0.0001",
                "mark_price": marks[funding_index],
            },
        }
    )
    events.sort(
        key=lambda item: (
            int(item["event_time_ms"]),
            {"RULE": 10, "FEE_POLICY": 10, "MARK_INDEX": 30, "FUNDING": 40}[
                str(item["event_kind"])
            ],
            str(item["event_kind"]),
        )
    )
    public_path = root / f"{prefix}-public.json"
    public_ref = build_hedge_public_history_archive(
        public_path,
        archive_id=f"{prefix}-public",
        exchange=request.exchange,
        market_type=request.market_type,
        symbol=request.symbol,
        settlement_asset=request.settlement_asset,
        range_start_ms=start,
        range_end_ms=end,
        max_mark_gap_ms=interval_ms,
        source_identity="TEST_PINNED_PUBLIC_CAPTURE",
        capture_receipt=f"receipt:{prefix}",
        historical_l2_ref=(
            None
            if book is None
            else {
                "archive_id": book["archive_id"],
                "dataset_epoch": book["dataset_epoch"],
                "checksum_sha256": book["checksum_sha256"],
            }
        ),
        events=events,
    )
    simulation_path = root / f"{prefix}-simulation.json"
    simulation_symbols = required_symbols or [request.symbol]
    if request.symbol not in simulation_symbols:
        raise ValueError("required_symbols must contain the primary request symbol")
    simulation_ref = build_hedge_simulation_manifest(
        simulation_path,
        manifest_id=f"{prefix}-simulation",
        range_start_ms=start,
        range_end_ms=end,
        settlement_asset=request.settlement_asset,
        required_symbols=simulation_symbols,
        insurance_events=[
            {
                "effective_time_ms": start,
                "kind": "OPENING_BALANCE",
                "amount": insurance_opening_balance,
            }
        ],
        adl_snapshots=[
            {
                "symbol": symbol,
                "effective_time_ms": start,
                "valid_until_ms": end,
                "candidates": (
                    adl_candidates
                    if symbol == request.symbol and adl_candidates is not None
                    else [
                        {
                            "candidate_id": f"{prefix}-{symbol.lower()}-short-1",
                            "symbol": symbol,
                            "position_side": "SHORT",
                            "quantity": "100",
                            "entry_price": "110",
                            "mark_price": "100",
                            "initial_margin": "500",
                            "margin_balance": "1000",
                        }
                    ]
                ),
            }
            for symbol in simulation_symbols
        ],
    )
    await training.hedge_inputs.import_public(public_path)
    await training.hedge_inputs.import_simulation(simulation_path)
    payload = request.to_dict()
    payload.update(
        {
            "position_mode": "HEDGE",
            "account_data_mode": "DETERMINISTIC_SIMULATION",
            "account_history_ref": None,
            "book_mode": book_mode,
            "funding_mode": "HISTORICAL_EXACT",
            "fixed_funding_rate": None,
            "funding_interval_ms": None,
            "hedge_public_history_ref": {
                "schema_version": "replay.hedge-public-history-ref.v1",
                **public_ref,
            },
            "simulation_manifest_ref": {
                "schema_version": "replay.hedge-simulation-manifest-ref.v1",
                **simulation_ref,
            },
            "account_fidelity": HEDGE_ACCOUNT_FIDELITY,
            "insurance_adl_fidelity": HEDGE_INSURANCE_ADL_FIDELITY,
        }
    )
    return TrainingRunCreateRequest.from_dict(payload)


__all__ = [
    "build_book_archive",
    "import_hedge_track_public_inputs",
    "prepare_hedge_request",
]
