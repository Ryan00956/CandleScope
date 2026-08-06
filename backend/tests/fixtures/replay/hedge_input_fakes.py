from __future__ import annotations

import json
import sqlite3
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
                _levels([["99", "10"], ["98", "20"]]),
                _levels([["101", "10"], ["102", "20"]]),
            ),
        )
        previous = 100
        ordinal = 1
        event_time = range_start_ms + interval_ms
        while event_time <= range_end_ms:
            final = previous + 1
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
                    _levels([["99", "10"]]),
                    _levels([["101", "10"]]),
                ),
            )
            previous = final
            ordinal += 1
            event_time += interval_ms
    return path


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
    book_path = build_book_archive(
        root / f"{prefix}-book.sqlite3",
        exchange=request.exchange,
        market_type=request.market_type,
        symbol=request.symbol,
        range_start_ms=start,
        range_end_ms=book_end,
        interval_ms=interval_ms,
    )
    book = await training.historical_books.import_archive(
        book_path,
        trusted_origin="TEST_CAPTURE",
    )
    marks = mark_prices or ["100"] * ((end - start) // interval_ms + 1)
    if len(marks) != (end - start) // interval_ms + 1:
        raise ValueError("mark_prices does not cover the requested range")
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
                "contract_size": "1",
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
    events.append(
        {
            "event_time_ms": min(end, start + interval_ms),
            "event_kind": "FUNDING",
            "payload": {"funding_rate": "0.0001", "mark_price": marks[1]},
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
        historical_l2_ref={
            "archive_id": book["archive_id"],
            "dataset_epoch": book["dataset_epoch"],
            "checksum_sha256": book["checksum_sha256"],
        },
        events=events,
    )
    simulation_path = root / f"{prefix}-simulation.json"
    simulation_ref = build_hedge_simulation_manifest(
        simulation_path,
        manifest_id=f"{prefix}-simulation",
        range_start_ms=start,
        range_end_ms=end,
        settlement_asset=request.settlement_asset,
        required_symbols=[request.symbol],
        insurance_events=[
            {
                "effective_time_ms": start,
                "kind": "OPENING_BALANCE",
                "amount": insurance_opening_balance,
            }
        ],
        adl_snapshots=[
            {
                "symbol": request.symbol,
                "effective_time_ms": start,
                "valid_until_ms": end,
                "candidates": adl_candidates
                or [
                    {
                        "candidate_id": f"{prefix}-short-1",
                        "symbol": request.symbol,
                        "position_side": "SHORT",
                        "quantity": "100",
                        "entry_price": "110",
                        "mark_price": "100",
                        "initial_margin": "500",
                        "margin_balance": "1000",
                    }
                ],
            }
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
            "book_mode": "BOOK_ASSISTED_REQUIRED",
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


__all__ = ["build_book_archive", "prepare_hedge_request"]
