"""Builders for fully verified replay account-history SQLite fixtures."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Sequence
from pathlib import Path

from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.training.account_history import (
    ARCHIVE_CAPTURE_MODE,
    ARCHIVE_CONTRACT_MODEL,
    ARCHIVE_FORMULA_VERSION,
    ARCHIVE_MARGIN_ASSET_MODE,
    ARCHIVE_POSITION_MODE,
    ARCHIVE_PROTOCOL,
    ARCHIVE_ROUNDING_MODE,
    ARCHIVE_SCHEMA_VERSION,
    FUNDING_EVENT_PHASE,
    MARK_INDEX_EVENT_PHASE,
    RULE_EVENT_PHASE,
    account_archive_dataset_epoch,
    account_archive_event_hash,
    account_archive_root_hash,
)


def account_rule_fixture(
    *,
    sequence: int,
    effective_time_ms: int,
    source_kind: str,
    price_tick: str = "0.1",
    quantity_step: str = "0.1",
    min_quantity: str = "0.1",
    max_quantity: str = "100",
    min_notional: str = "5",
    max_notional: str = "100000",
    quote_step: str = "0.01",
    contract_size: str = "1",
    max_leverage: str = "10",
    liquidation_fee_bps: str = "50",
) -> dict[str, object]:
    tiers = [
        {
            "notional_cap": "50000",
            "maintenance_rate": "0.005",
            "maintenance_deduction": "0",
        },
        {
            "notional_cap": max_notional,
            "maintenance_rate": "0.01",
            "maintenance_deduction": "250",
        },
    ]
    if max_notional == "50000":
        tiers = tiers[:1]
    return {
        "sequence": sequence,
        "effective_time_ms": effective_time_ms,
        "source_kind": source_kind,
        "price_tick": price_tick,
        "quantity_step": quantity_step,
        "min_quantity": min_quantity,
        "max_quantity": max_quantity,
        "min_notional": min_notional,
        "max_notional": max_notional,
        "quote_step": quote_step,
        "contract_size": contract_size,
        "max_leverage": max_leverage,
        "liquidation_fee_bps": liquidation_fee_bps,
        "maintenance_tiers": tiers,
    }


def build_account_history_archive(
    path: Path,
    *,
    archive_id: str = "account-history-fixture",
    exchange: str = "binance",
    market_type: str = "futures",
    symbol: str = "BTCUSDT",
    settlement_asset: str = "USDT",
    source_kind: str = "BAR",
    range_start_ms: int,
    range_end_ms: int,
    mark_interval_ms: int = 30_000,
    funding_interval_ms: int = 240_000,
    funding_anchor_ms: int | None = None,
    price_at: Callable[[int], str] | None = None,
    rule_changes: Sequence[dict[str, object]] | None = None,
    capture_mode: str = ARCHIVE_CAPTURE_MODE,
    source: str = "OPERATOR_CAPTURED_TEST_FIXTURE",
    provenance: str = "LOCAL_DETERMINISTIC_FIXTURE",
) -> dict[str, object]:
    """Create one strict, hash-chained archive and return its declared metadata."""

    if range_end_ms <= range_start_ms:
        raise ValueError("fixture range must have positive duration")
    if (range_end_ms - range_start_ms) % mark_interval_ms:
        raise ValueError("fixture range must align to mark_interval_ms")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    if price_at is None:
        def default_price(timestamp: int) -> str:
            return str(
                100 + (timestamp - range_start_ms) // mark_interval_ms
            )

        price_at = default_price
    rules = list(
        rule_changes
        or [
            account_rule_fixture(
                sequence=1,
                effective_time_ms=range_start_ms,
                source_kind=source_kind,
            ),
            account_rule_fixture(
                sequence=2,
                effective_time_ms=range_start_ms + 5 * 60_000,
                source_kind=source_kind,
                price_tick="0.5",
                max_leverage="5",
            ),
        ]
    )
    anchor = (
        0
        if funding_interval_ms == 0
        else (
            range_start_ms + 2 * 60_000
            if funding_anchor_ms is None
            else funding_anchor_ms
        )
    )
    mark_times = set(
        range(range_start_ms, range_end_ms + 1, mark_interval_ms)
    )
    if funding_interval_ms:
        first_funding = anchor
        if first_funding < range_start_ms:
            delta = range_start_ms - first_funding
            first_funding += (
                (delta + funding_interval_ms - 1) // funding_interval_ms
            ) * funding_interval_ms
        mark_times.update(
            range(first_funding, range_end_ms + 1, funding_interval_ms)
        )
    marks = [
        {
            "sequence": sequence,
            "event_time_ms": timestamp,
            "mark_price": price_at(timestamp),
            "index_price": price_at(timestamp),
        }
        for sequence, timestamp in enumerate(
            sorted(mark_times),
            1,
        )
    ]
    if funding_interval_ms:
        first = anchor
        if first < range_start_ms:
            delta = range_start_ms - first
            first += (
                (delta + funding_interval_ms - 1) // funding_interval_ms
            ) * funding_interval_ms
        mark_by_time = {
            int(mark["event_time_ms"]): str(mark["mark_price"])
            for mark in marks
        }
        funding = [
            {
                "sequence": sequence,
                "settlement_time_ms": timestamp,
                "funding_rate": "0.001",
                "mark_price": mark_by_time[timestamp],
            }
            for sequence, timestamp in enumerate(
                range(first, range_end_ms + 1, funding_interval_ms),
                1,
            )
        ]
    else:
        funding = []
    identity = {
        "archive_id": archive_id,
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol,
        "settlement_asset": settlement_asset,
        "contract_model": ARCHIVE_CONTRACT_MODEL,
        "position_mode": ARCHIVE_POSITION_MODE,
        "margin_asset_mode": ARCHIVE_MARGIN_ASSET_MODE,
        "range_start_ms": range_start_ms,
        "range_end_ms": range_end_ms,
        "source": source,
        "provenance": provenance,
        "capture_mode": capture_mode,
        "formula_version": ARCHIVE_FORMULA_VERSION,
        "rounding_mode": ARCHIVE_ROUNDING_MODE,
        "max_mark_gap_ms": mark_interval_ms,
        "funding_interval_ms": funding_interval_ms,
        "funding_anchor_ms": anchor,
    }
    dataset_epoch = account_archive_dataset_epoch(
        metadata_identity=identity,
        rules=rules,
        marks=marks,
        funding=funding,
    )
    components: list[tuple[int, int, str, int, dict[str, object]]] = []
    components.extend(
        (
            int(rule["effective_time_ms"]),
            RULE_EVENT_PHASE,
            "RULE",
            int(rule["sequence"]),
            rule,
        )
        for rule in rules
    )
    components.extend(
        (
            int(mark["event_time_ms"]),
            MARK_INDEX_EVENT_PHASE,
            "MARK_INDEX",
            int(mark["sequence"]),
            mark,
        )
        for mark in marks
    )
    components.extend(
        (
            int(item["settlement_time_ms"]),
            FUNDING_EVENT_PHASE,
            "FUNDING",
            int(item["sequence"]),
            item,
        )
        for item in funding
    )
    components.sort(key=lambda item: (item[0], item[1], item[2], item[3]))
    previous = account_archive_root_hash(
        archive_id=archive_id,
        dataset_epoch=dataset_epoch,
    )
    events: list[dict[str, object]] = []
    for event_sequence, (
        event_time_ms,
        phase,
        kind,
        component_sequence,
        component,
    ) in enumerate(components, 1):
        event_hash = account_archive_event_hash(
            previous_hash=previous,
            event_sequence=event_sequence,
            event_time_ms=event_time_ms,
            event_phase=phase,
            event_kind=kind,
            component_sequence=component_sequence,
            component=component,
        )
        events.append(
            {
                "event_sequence": event_sequence,
                "event_time_ms": event_time_ms,
                "event_phase": phase,
                "event_kind": kind,
                "component_sequence": component_sequence,
                "previous_hash": previous,
                "event_hash": event_hash,
            }
        )
        previous = event_hash
    metadata = {
        "protocol": ARCHIVE_PROTOCOL,
        "schema_version": ARCHIVE_SCHEMA_VERSION,
        **identity,
        "dataset_epoch": dataset_epoch,
        "declared_rule_count": len(rules),
        "declared_mark_count": len(marks),
        "declared_funding_count": len(funding),
        "declared_event_count": len(events),
        "event_chain_tail": previous,
        "created_at_ms": range_end_ms + 1,
    }
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            PRAGMA journal_mode = DELETE;
            PRAGMA foreign_keys = ON;
            CREATE TABLE archive_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE instrument_rule (
                sequence INTEGER PRIMARY KEY,
                effective_time_ms INTEGER NOT NULL,
                source_kind TEXT NOT NULL,
                price_tick TEXT NOT NULL,
                quantity_step TEXT NOT NULL,
                min_quantity TEXT NOT NULL,
                max_quantity TEXT NOT NULL,
                min_notional TEXT NOT NULL,
                max_notional TEXT NOT NULL,
                quote_step TEXT NOT NULL,
                contract_size TEXT NOT NULL,
                max_leverage TEXT NOT NULL,
                liquidation_fee_bps TEXT NOT NULL,
                maintenance_tiers_json TEXT NOT NULL,
                rule_hash TEXT NOT NULL
            );
            CREATE TABLE mark_index_event (
                sequence INTEGER PRIMARY KEY,
                event_time_ms INTEGER NOT NULL,
                mark_price TEXT NOT NULL,
                index_price TEXT NOT NULL
            );
            CREATE TABLE funding_event (
                sequence INTEGER PRIMARY KEY,
                settlement_time_ms INTEGER NOT NULL,
                funding_rate TEXT NOT NULL,
                mark_price TEXT NOT NULL
            );
            CREATE TABLE archive_event (
                event_sequence INTEGER PRIMARY KEY,
                event_time_ms INTEGER NOT NULL,
                event_phase INTEGER NOT NULL,
                event_kind TEXT NOT NULL,
                component_sequence INTEGER NOT NULL,
                previous_hash TEXT NOT NULL,
                event_hash TEXT NOT NULL
            );
            """
        )
        connection.executemany(
            "INSERT INTO archive_meta(key, value) VALUES (?, ?)",
            (
                (key, str(value))
                for key, value in sorted(metadata.items())
            ),
        )
        connection.executemany(
            """
            INSERT INTO instrument_rule(
                sequence, effective_time_ms, source_kind, price_tick,
                quantity_step, min_quantity, max_quantity, min_notional,
                max_notional, quote_step, contract_size, max_leverage,
                liquidation_fee_bps, maintenance_tiers_json, rule_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    rule["sequence"],
                    rule["effective_time_ms"],
                    rule["source_kind"],
                    rule["price_tick"],
                    rule["quantity_step"],
                    rule["min_quantity"],
                    rule["max_quantity"],
                    rule["min_notional"],
                    rule["max_notional"],
                    rule["quote_step"],
                    rule["contract_size"],
                    rule["max_leverage"],
                    rule["liquidation_fee_bps"],
                    canonical_json(rule["maintenance_tiers"]),
                    canonical_sha256(
                        {
                            "schema_version": ARCHIVE_SCHEMA_VERSION,
                            "component": "instrument_rule",
                            "payload": rule,
                        }
                    ),
                )
                for rule in rules
            ),
        )
        connection.executemany(
            """
            INSERT INTO mark_index_event(
                sequence, event_time_ms, mark_price, index_price
            ) VALUES (?, ?, ?, ?)
            """,
            (
                (
                    mark["sequence"],
                    mark["event_time_ms"],
                    mark["mark_price"],
                    mark["index_price"],
                )
                for mark in marks
            ),
        )
        connection.executemany(
            """
            INSERT INTO funding_event(
                sequence, settlement_time_ms, funding_rate, mark_price
            ) VALUES (?, ?, ?, ?)
            """,
            (
                (
                    item["sequence"],
                    item["settlement_time_ms"],
                    item["funding_rate"],
                    item["mark_price"],
                )
                for item in funding
            ),
        )
        connection.executemany(
            """
            INSERT INTO archive_event(
                event_sequence, event_time_ms, event_phase, event_kind,
                component_sequence, previous_hash, event_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    event["event_sequence"],
                    event["event_time_ms"],
                    event["event_phase"],
                    event["event_kind"],
                    event["component_sequence"],
                    event["previous_hash"],
                    event["event_hash"],
                )
                for event in events
            ),
        )
        connection.execute("PRAGMA optimize")
    return metadata


__all__ = ["build_account_history_archive"]
