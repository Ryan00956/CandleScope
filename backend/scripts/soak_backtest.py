"""Lower-level trade-kernel/SQLite stress harness.

This intentionally drives private matching helpers and dedicated ``soak_*``
tables. It is useful for profiling those primitives, but it is not a product
path or release soak. Use ``frontend/scripts/backtest-api-smoke.mjs`` for the
public API -> worker -> service -> report/export path.

Does not use the O(n^2) kernel.run() visible copy. It still uses the
reference TradeSimulationKernel matcher, Decimal contract accounting, and
SQLite persistence. Empty-order paths are rejected.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.market_dataset.snapshot import MarketEvent  # noqa: E402
from app.simulation.contract_accounting import ContractAccount  # noqa: E402
from app.simulation.trade_kernel import TradeSimulationKernel  # noqa: E402


def _git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=REPO_DIR, text=True).strip()


def _trade(sequence: int) -> MarketEvent:
    price = 100 + (sequence % 7) - 3
    return MarketEvent(
        sequence=sequence,
        event_time_ms=sequence,
        role="TRADES",
        payload={
            "source_event_kind": "RAW_TRADE",
            "source_sequence": sequence,
            "tie_break": str(sequence),
            "price": str(price),
            "qty": "1",
        },
    )


def _open_db(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS soak_fills (
            ordinal INTEGER PRIMARY KEY,
            order_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            side TEXT NOT NULL,
            price TEXT NOT NULL,
            qty TEXT NOT NULL,
            reason TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS soak_ledger (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            fill_count INTEGER NOT NULL,
            notional TEXT NOT NULL,
            fee_total TEXT NOT NULL,
            quote_balance TEXT NOT NULL,
            position_qty TEXT NOT NULL,
            events INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        );
        """
    )
    connection.commit()
    return connection


class TradeSoak:
    def __init__(self, db_path: Path) -> None:
        self.kernel = TradeSimulationKernel(
            checkpoint_event_interval=0, max_events=10_000_000
        )
        self.kernel.source_kind = "RAW_TRADE"
        self.account = ContractAccount(
            quote_balance=Decimal("100000000"),
            taker_fee_bps=Decimal("1"),
            require_mark=False,
        )
        self.sides: dict[str, str] = {}
        self.connection = _open_db(db_path)
        self.fill_ordinal = 0
        self.events = 0
        self.sqlite_writes = 0
        self.open_orders_peak = 0
        self.notional = Decimal("0")
        self.last_sequence = 0
        self._pending_rows: list[tuple[object, ...]] = []
        self._restock(0)

    def close(self) -> None:
        self._flush_fills()
        self.connection.close()

    def _working(self) -> int:
        return sum(
            1 for order in self.kernel.orders if order.status in {"OPEN", "PARTIAL"}
        )

    def _restock(self, sequence: int) -> None:
        while self._working() < 6:
            buy = sequence % 2 == 0
            self.kernel._enqueue(
                {
                    "side": "BUY" if buy else "SELL",
                    "type": "LIMIT",
                    "qty": "4",
                    "limit_price": "100" if buy else "102",
                },
                current_sequence=sequence,
            )
            self.sides[self.kernel.orders[-1].order_id] = "BUY" if buy else "SELL"
        self.open_orders_peak = max(self.open_orders_peak, self._working())

    def step(self, sequence: int) -> None:
        if self.last_sequence and sequence != self.last_sequence + 1:
            raise RuntimeError(f"sequence gap {self.last_sequence} -> {sequence}")
        before = len(self.kernel.fills)
        self.kernel._match(_trade(sequence))
        for fill in self.kernel.fills[before:]:
            side = self.sides[fill.order_id]
            self.account.mark = fill.price
            self.account.apply_fill(side=side, price=fill.price, qty=fill.qty)
            self.notional += fill.price * fill.qty
            self.fill_ordinal += 1
            self._pending_rows.append(
                (
                    self.fill_ordinal,
                    fill.order_id,
                    fill.sequence,
                    side,
                    str(fill.price),
                    str(fill.qty),
                    fill.reason,
                )
            )
        if self.kernel.fills:
            self.kernel.fills.clear()
        if len(self.kernel.orders) > 32:
            self.kernel.orders = [
                order
                for order in self.kernel.orders
                if order.status in {"OPEN", "PARTIAL"}
            ]
        if len(self.account.journal) > 256:
            self.account.journal = self.account.journal[-32:]
        if len(self._pending_rows) >= 1_000:
            self._flush_fills()
        self.events += 1
        self.last_sequence = sequence
        if self._working() < 4:
            self._restock(sequence)

    def _flush_fills(self) -> None:
        if not self._pending_rows:
            return
        self.connection.executemany(
            """
            INSERT INTO soak_fills(ordinal, order_id, sequence, side, price, qty, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            self._pending_rows,
        )
        self.sqlite_writes += 1
        self._pending_rows.clear()

    def persist_ledger(self) -> None:
        self._flush_fills()
        self.connection.execute(
            """
            INSERT INTO soak_ledger(
                id, fill_count, notional, fee_total, quote_balance,
                position_qty, events, updated_at_ms
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                fill_count = excluded.fill_count,
                notional = excluded.notional,
                fee_total = excluded.fee_total,
                quote_balance = excluded.quote_balance,
                position_qty = excluded.position_qty,
                events = excluded.events,
                updated_at_ms = excluded.updated_at_ms
            """,
            (
                self.fill_ordinal,
                str(self.notional),
                str(self.account.fees_paid),
                str(self.account.quote_balance),
                str(self.account.position_qty),
                self.events,
                int(time.time() * 1000),
            ),
        )
        self.connection.commit()
        self.sqlite_writes += 1

    def run_events(
        self, count: int, *, start_sequence: int = 1, persist_every: int = 50_000
    ) -> None:
        end = start_sequence + count
        for sequence in range(start_sequence, end):
            self.step(sequence)
            if persist_every and sequence % persist_every == 0:
                self.persist_ledger()
                print(
                    f"progress events={sequence} fills={self.fill_ordinal} "
                    f"working={self._working()} fees={self.account.fees_paid}",
                    flush=True,
                )
        self.persist_ledger()
        if self.fill_ordinal < 1 or self._working() < 1:
            raise RuntimeError("soak collapsed to an empty-order path")


def hash_probe() -> bool:
    first = TradeSimulationKernel()
    second = TradeSimulationKernel()

    def buy_first(visible, event):
        if event.sequence == 1:
            return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
        return []

    events = tuple(_trade(index) for index in range(1, 129))
    left = first.run(events, buy_first)
    right = second.run(events, buy_first)
    return left.fill_hash == right.fill_hash and left.ledger_hash == right.ledger_hash


def _evidence(payload: dict[str, Any], out_path: Path) -> dict[str, Any]:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    payload["sha256"] = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


def run_million(out_path: Path, events: int) -> dict[str, Any]:
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="backtest-soak-") as tmp:
        soak = TradeSoak(Path(tmp) / "soak.db")
        try:
            soak.run_events(events)
            stored = soak.connection.execute(
                "SELECT COUNT(*), SUM(CAST(qty AS REAL)) FROM soak_fills"
            ).fetchone()
            ledger = soak.connection.execute(
                "SELECT fill_count, events FROM soak_ledger WHERE id = 1"
            ).fetchone()
            payload = {
                "schemaVersion": "candlescope.backtest-soak/1",
                "harnessKind": "PRIVATE_KERNEL_SQLITE_MICROBENCHMARK",
                "releaseEligible": False,
                "kind": "million-trade" if events >= 1_000_000 else "trade-tape",
                "commit": _git("rev-parse", "HEAD"),
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "durationSeconds": round(time.monotonic() - started, 3),
                "events": soak.events,
                "fillCount": soak.fill_ordinal,
                "sqliteFillRows": int(stored[0] or 0),
                "ledgerFillCount": int(ledger[0]),
                "openOrdersPeak": soak.open_orders_peak,
                "workingOrdersEnd": soak._working(),
                "sqliteWrites": soak.sqlite_writes,
                "feeTotal": str(soak.account.fees_paid),
                "positionQty": str(soak.account.position_qty),
                "notional": str(soak.notional),
                "emptyPath": False,
                "decimalLedger": True,
                "hashProbeEqual": hash_probe(),
                "ok": True,
            }
        finally:
            soak.close()
    if (
        payload["fillCount"] != payload["sqliteFillRows"]
        or payload["fillCount"] != payload["ledgerFillCount"]
    ):
        raise RuntimeError("sqlite ledger drifted from in-memory fills")
    if not payload["hashProbeEqual"]:
        raise RuntimeError("determinism probe failed")
    return _evidence(payload, out_path)


def run_hour(out_path: Path, duration_s: int, chunk_events: int) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + duration_s
    cycles = 0
    total_events = 0
    total_fills = 0
    writes = 0
    peak = 0
    with tempfile.TemporaryDirectory(prefix="backtest-soak-1h-") as tmp:
        soak = TradeSoak(Path(tmp) / "soak.db")
        try:
            sequence = 1
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                soak.run_events(
                    chunk_events, start_sequence=sequence, persist_every=chunk_events
                )
                sequence += chunk_events
                cycles += 1
                total_events = soak.events
                total_fills = soak.fill_ordinal
                writes = soak.sqlite_writes
                peak = max(peak, soak.open_orders_peak)
                print(
                    f"1h cycle={cycles} events={total_events} fills={total_fills} remaining_s={remaining:.1f}",
                    flush=True,
                )
            elapsed = time.monotonic() - started
            if elapsed + 1 < duration_s:
                raise RuntimeError(f"1h soak ended early after {elapsed:.1f}s")
            payload = {
                "schemaVersion": "candlescope.backtest-soak/1",
                "harnessKind": "PRIVATE_KERNEL_SQLITE_MICROBENCHMARK",
                "releaseEligible": False,
                "kind": "1h",
                "commit": _git("rev-parse", "HEAD"),
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "durationSeconds": round(elapsed, 3),
                "requestedDurationSeconds": duration_s,
                "cycles": cycles,
                "events": total_events,
                "fillCount": total_fills,
                "openOrdersPeak": peak,
                "workingOrdersEnd": soak._working(),
                "sqliteWrites": writes,
                "feeTotal": str(soak.account.fees_paid),
                "positionQty": str(soak.account.position_qty),
                "emptyPath": False,
                "decimalLedger": True,
                "hashProbeEqual": hash_probe(),
                "ok": True,
            }
        finally:
            soak.close()
    if payload["cycles"] < 1 or payload["fillCount"] < 1:
        raise RuntimeError("1h soak produced no real fills")
    if not payload["hashProbeEqual"]:
        raise RuntimeError("determinism probe failed")
    return _evidence(payload, out_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("million-trade", "1h"))
    parser.add_argument("--events", type=int, default=1_000_000)
    parser.add_argument("--duration-s", type=int, default=3600)
    parser.add_argument("--chunk-events", type=int, default=50_000)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "million-trade":
        payload = run_million(args.out, args.events)
    else:
        payload = run_hour(args.out, args.duration_s, args.chunk_events)
    print(json.dumps(payload, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
