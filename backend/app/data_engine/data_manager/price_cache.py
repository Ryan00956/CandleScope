"""Price snapshot cache owned by DataManager."""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Iterable

from app.exchanges.symbols import normalize_symbol as normalize_exchange_symbol

from .models import SeriesKey
from .subscriptions import format_subscription_key, parse_subscription_key


_LEGACY_MARKET_PREFIXES = frozenset({
    "commodity",
    "etf",
    "forex",
    "future",
    "futures",
    "index",
    "margin",
    "option",
    "options",
    "perpetual",
    "spot",
    "stock",
    "swap",
    "swap.linear",
    "usdm",
})


def normalize_price_key(
    symbol: str,
    exchange: str = "binance",
    market_type: str = "spot",
) -> tuple[str, str, str]:
    """Normalize a price identifier to (exchange, market_type, symbol)."""
    raw_symbol = str(symbol or "").strip()
    normalized_exchange = (exchange or "binance").strip().lower()
    normalized_market = (market_type or "spot").strip().lower()
    prefix, separator, _remainder = raw_symbol.partition(":")
    if raw_symbol.count(":") >= 2 or (
        separator
        and normalized_exchange == "binance"
        and normalized_market == "spot"
        and prefix.strip().lower() in _LEGACY_MARKET_PREFIXES
    ):
        return parse_subscription_key(raw_symbol)
    normalized_symbol = normalize_exchange_symbol(
        raw_symbol,
        exchange=normalized_exchange,
        market_type=normalized_market,
    )
    return normalized_exchange, normalized_market, normalized_symbol


def price_key(symbol: str, exchange: str = "binance", market_type: str = "spot") -> str:
    """Return the public watchlist key for a price stream."""
    normalized_exchange, normalized_market, normalized_symbol = normalize_price_key(
        symbol,
        exchange=exchange,
        market_type=market_type,
    )
    return format_subscription_key(normalized_exchange, normalized_market, normalized_symbol)


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


@dataclass(slots=True)
class PriceSnapshot:
    """Current price state for one exchange/market/symbol."""

    symbol: str
    exchange: str
    market_type: str
    price: float
    open: float
    high: float
    low: float
    change_pct: float
    volume: float
    quote_volume: float
    daily_open: float = 0.0
    updated_at_ms: int = 0

    def __post_init__(self) -> None:
        exchange, market_type, symbol = normalize_price_key(
            self.symbol,
            exchange=self.exchange,
            market_type=self.market_type,
        )
        self.exchange = exchange
        self.market_type = market_type
        self.symbol = symbol
        if self.updated_at_ms <= 0:
            self.updated_at_ms = int(time.time() * 1000)

    @property
    def key(self) -> str:
        return price_key(self.symbol, exchange=self.exchange, market_type=self.market_type)

    @property
    def series_key(self) -> SeriesKey:
        return SeriesKey(
            self.symbol,
            "price",
            exchange=self.exchange,
            market_type=self.market_type,
        )

    @classmethod
    def from_any(cls, item: Any) -> PriceSnapshot:
        if isinstance(item, cls):
            return item
        if isinstance(item, dict):
            data = item
            return cls(
                symbol=str(data.get("symbol", "")),
                exchange=str(data.get("exchange", "binance")),
                market_type=str(data.get("market_type", "spot")),
                price=_to_float(data.get("price")),
                open=_to_float(data.get("open")),
                high=_to_float(data.get("high")),
                low=_to_float(data.get("low")),
                change_pct=_to_float(data.get("change_pct")),
                volume=_to_float(data.get("volume")),
                quote_volume=_to_float(data.get("quote_volume")),
                daily_open=_to_float(data.get("daily_open")),
                updated_at_ms=_to_int(data.get("updated_at_ms")),
            )
        return cls(
            symbol=str(getattr(item, "symbol", "")),
            exchange=str(getattr(item, "exchange", "binance")),
            market_type=str(getattr(item, "market_type", "spot")),
            price=_to_float(getattr(item, "price", 0)),
            open=_to_float(getattr(item, "open", 0)),
            high=_to_float(getattr(item, "high", 0)),
            low=_to_float(getattr(item, "low", 0)),
            change_pct=_to_float(getattr(item, "change_pct", 0)),
            volume=_to_float(getattr(item, "volume", 0)),
            quote_volume=_to_float(getattr(item, "quote_volume", 0)),
            daily_open=_to_float(getattr(item, "daily_open", 0)),
            updated_at_ms=_to_int(getattr(item, "updated_at_ms", 0)),
        )

    def to_dict(self) -> dict:
        daily_change = 0.0
        daily_change_pct = 0.0
        if self.daily_open > 0:
            daily_change = self.price - self.daily_open
            daily_change_pct = (daily_change / self.daily_open) * 100
        return {
            "symbol": self.key,
            "exchange": self.exchange,
            "market_type": self.market_type,
            "price": self.price,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "change_pct": round(self.change_pct, 4),
            "volume": round(self.volume, 2),
            "quote_volume": round(self.quote_volume, 2),
            "daily_open": self.daily_open,
            "daily_change": round(daily_change, 8),
            "daily_change_pct": round(daily_change_pct, 4),
            "updated_at_ms": self.updated_at_ms,
        }


class PriceSnapshotCache:
    """In-memory price cache and watchlist for DataManager."""

    def __init__(self) -> None:
        self._prices: dict[str, PriceSnapshot] = {}
        self._watched: set[str] = set()

    def watch(
        self,
        symbol: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> tuple[str, bool]:
        key = price_key(symbol, exchange=exchange, market_type=market_type)
        was_new = key not in self._watched
        self._watched.add(key)
        return key, was_new

    def unwatch(
        self,
        symbol: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> tuple[str, bool]:
        key = price_key(symbol, exchange=exchange, market_type=market_type)
        existed = key in self._watched
        self._watched.discard(key)
        return key, existed

    def is_watched_key(self, key: str) -> bool:
        return key in self._watched

    def watched_keys(self) -> list[str]:
        return sorted(self._watched)

    def get(
        self,
        symbol: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> PriceSnapshot | None:
        return self._prices.get(price_key(symbol, exchange=exchange, market_type=market_type))

    def upsert_many(self, items: Iterable[Any]) -> list[PriceSnapshot]:
        updated: list[PriceSnapshot] = []
        for item in items:
            snapshot = PriceSnapshot.from_any(item)
            self._prices[snapshot.key] = snapshot
            updated.append(snapshot)
        return updated

    def snapshot(self, watched_only: bool = True) -> list[dict]:
        keys = self._watched if watched_only else set(self._prices)
        return [
            self._prices[key].to_dict()
            for key in sorted(keys)
            if key in self._prices
        ]

    def diagnostics(self) -> dict:
        return {
            "watched": len(self._watched),
            "cached": len(self._prices),
            "watched_symbols": self.watched_keys(),
        }
