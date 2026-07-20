from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.data_engine.interval_policy import parse_interval_ms


@dataclass(frozen=True, slots=True)
class FixtureIdentity:
    exchange: str
    market_type: str
    symbol: str


def make_bar(
    open_time_ms: int,
    *,
    interval_ms: int = 60_000,
    price: str = "100.00",
    source: str = "fixture",
) -> dict[str, object]:
    price_value = float(price)
    return {
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
        "open_time": open_time_ms,
        "close_time": open_time_ms + interval_ms - 1,
        "open": price_value,
        "high": price_value + 1.0,
        "low": price_value - 1.0,
        "close": price_value + 0.5,
        "volume": 10.0,
        "quote_volume": 1_005.0,
        "trades": 7,
        "taker_buy_base": 4.0,
        "taker_buy_quote": 402.0,
        "source": source,
    }


class FakeKlinesRepo:
    """Read-only KlinesRepo contract fixture with call diagnostics."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str, str, str], list[dict[str, object]]] = {}
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.query_transform: Callable[
            [list[dict[str, object]]], list[dict[str, object]]
        ] | None = None

    def add_rows(
        self,
        identity: FixtureIdentity,
        interval: str,
        rows: list[dict[str, object]],
    ) -> None:
        normalized = [
            {
                **row,
                "exchange": identity.exchange,
                "market_type": identity.market_type,
                "symbol": identity.symbol,
                "interval": interval,
            }
            for row in rows
        ]
        self.rows[(identity.exchange, identity.market_type, identity.symbol, interval)] = normalized

    def list_all_series(self, custom_only: bool = False) -> list[dict[str, object]]:
        self.calls.append(("list_all_series", {"custom_only": custom_only}))
        summaries: list[dict[str, object]] = []
        for (exchange, market_type, symbol, interval), rows in sorted(self.rows.items()):
            if not rows:
                continue
            opens = [int(row["open_time"]) for row in rows]
            summaries.append(
                {
                    "exchange": exchange,
                    "market_type": market_type,
                    "symbol": symbol,
                    "interval": interval,
                    "earliest_open_time": min(opens),
                    "latest_open_time": max(opens),
                    "total_count": len(rows),
                }
            )
        return summaries

    def list_series(
        self,
        custom_only: bool = False,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict[str, object]]:
        return [
            summary
            for summary in self.list_all_series(custom_only=custom_only)
            if (exchange is None or summary["exchange"] == exchange)
            and (market_type is None or summary["market_type"] == market_type)
        ]

    def get_bounds(
        self,
        symbol: str,
        interval: str,
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> dict[str, object]:
        key = (exchange or "binance", market_type or "spot", symbol, interval)
        rows = self.rows.get(key, [])
        self.calls.append(("get_bounds", {"key": key}))
        if not rows:
            return {"earliest_open_time": None, "latest_open_time": None, "total_count": 0}
        opens = [int(row["open_time"]) for row in rows]
        return {
            "earliest_open_time": min(opens),
            "latest_open_time": max(opens),
            "total_count": len(rows),
        }

    def query_bars(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        limit: int | None = None,
        order: str = "ASC",
        exchange: str | None = None,
        market_type: str | None = None,
    ) -> list[dict[str, object]]:
        key = (exchange or "binance", market_type or "spot", symbol, interval)
        self.calls.append(
            (
                "query_bars",
                {
                    "key": key,
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "limit": limit,
                    "order": order,
                },
            )
        )
        rows = [dict(row) for row in self.rows.get(key, [])]
        if start_ms is not None:
            rows = [row for row in rows if int(row["open_time"]) >= start_ms]
        if end_ms is not None:
            rows = [row for row in rows if int(row["open_time"]) <= end_ms]
        rows.sort(key=lambda row: int(row["open_time"]), reverse=order.upper() == "DESC")
        if self.query_transform is not None:
            rows = self.query_transform(rows)
        if limit is not None:
            rows = rows[:limit]
        return rows

    def scan_gaps(
        self,
        symbol: str,
        interval: str,
        start_ms: int | None = None,
        end_ms: int | None = None,
        exchange: str | None = None,
        market_type: str | None = None,
        limit: int = 50_000,
        calendar: object | None = None,
    ) -> dict[str, object]:
        del calendar
        key = (exchange or "binance", market_type or "spot", symbol, interval)
        self.calls.append(
            (
                "scan_gaps",
                {"key": key, "start_ms": start_ms, "end_ms": end_ms, "limit": limit},
            )
        )
        interval_ms = parse_interval_ms(interval)
        assert interval_ms is not None
        rows = sorted(
            {
                int(row["open_time"])
                for row in self.rows.get(key, [])
                if (start_ms is None or int(row["open_time"]) >= start_ms)
                and (end_ms is None or int(row["open_time"]) <= end_ms)
            }
        )
        truncated = len(rows) > limit
        rows = rows[:limit]
        gaps: list[dict[str, object]] = []
        if start_ms is not None and end_ms is not None:
            expected = set(range(start_ms, end_ms + 1, interval_ms))
            missing = sorted(expected - set(rows))
            if missing:
                range_start = missing[0]
                previous = missing[0]
                for current in missing[1:] + [None]:
                    if current is None or current != previous + interval_ms:
                        gaps.append(
                            {
                                "start_ms": range_start,
                                "end_ms": previous,
                                "missing_bars": ((previous - range_start) // interval_ms) + 1,
                                "reason": "fixture_gap",
                                "status": "detected",
                            }
                        )
                        if current is not None:
                            range_start = current
                    if current is not None:
                        previous = current
        return {
            "exchange": key[0],
            "market_type": key[1],
            "symbol": key[2],
            "interval": interval,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "gaps": gaps,
            "gap_count": len(gaps),
            "missing_bars": sum(int(gap["missing_bars"]) for gap in gaps),
            "scanned_bars": len(rows),
            "truncated": truncated,
            "calendar_id": "crypto.24x7.utc",
        }
