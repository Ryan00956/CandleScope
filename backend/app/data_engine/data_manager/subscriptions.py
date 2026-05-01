"""Subscription models and persistence for DataManager-owned workflows."""
from __future__ import annotations

import enum
import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from app.exchanges.symbols import normalize_symbol as normalize_exchange_symbol

logger = logging.getLogger("data_manager.subscriptions")


class SubscriptionDataManagerLike(Protocol):
    """Minimal DataManager contract used by SubscriptionService."""

    async def ensure_stream(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> Any:
        ...

    async def stop_stream(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        ...

    def get_all_streams(self) -> list[Any]:
        ...

    async def ensure_price_stream(
        self,
        symbol: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> Any:
        ...

    async def stop_price_stream(
        self,
        symbol: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        ...


class SubscriptionTier(str, enum.Enum):
    """Resource tier for a watched symbol."""

    FULL = "full"
    PRICE_ONLY = "price"
    NONE = "none"


def _infer_exchange_from_symbol(symbol: str, fallback: str = "binance") -> str:
    normalized = str(symbol or "").upper().strip()
    if not normalized:
        return fallback
    if "-" in normalized:
        return "okx"
    return fallback


def parse_subscription_key(key: str) -> tuple[str, str, str]:
    """Parse a subscription key to (exchange, market_type, normalized_symbol)."""
    parts = [part.strip() for part in key.split(":") if part.strip()]
    if len(parts) >= 3:
        exchange = parts[0].lower()
        market_type = parts[1].lower()
        raw_symbol = normalize_exchange_symbol(
            parts[2],
            exchange=exchange,
            market_type=market_type,
        )
        return exchange, market_type, raw_symbol
    if len(parts) == 2:
        market_type = parts[0].lower()
        raw_symbol = parts[1].upper()
        exchange = _infer_exchange_from_symbol(raw_symbol)
        raw_symbol = normalize_exchange_symbol(
            raw_symbol,
            exchange=exchange,
            market_type=market_type,
        )
        return exchange, market_type, raw_symbol
    raw_symbol = key.upper().strip()
    exchange = _infer_exchange_from_symbol(raw_symbol)
    raw_symbol = normalize_exchange_symbol(raw_symbol, exchange=exchange, market_type="spot")
    return exchange, "spot", raw_symbol


def normalize_subscription_key(symbol: str) -> str:
    """Normalize a user symbol into the persisted subscription key."""
    exchange, market_type, raw_symbol = parse_subscription_key(symbol)
    if exchange == "binance":
        return f"{market_type}:{raw_symbol}"
    return f"{exchange}:{market_type}:{raw_symbol}"


@dataclass(slots=True)
class SymbolSubscription:
    symbol: str
    tier: SubscriptionTier = SubscriptionTier.NONE
    added_at: int = 0

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "tier": self.tier.value,
            "added_at": self.added_at,
        }


FULL_TIER_SOFT_LIMIT = 5


class SubscriptionService:
    """Persist and activate watchlist subscription tiers.

    PRICE and FULL tiers both activate DataManager-owned price streams.
    """

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = str(db_path)
        self._subs: dict[str, SymbolSubscription] = {}
        self._data_manager: SubscriptionDataManagerLike | None = None
        self._init_db()
        self._load_from_db()

    def set_data_manager(self, dm: SubscriptionDataManagerLike) -> None:
        self._data_manager = dm

    def normalize_symbol(self, symbol: str) -> str:
        return normalize_subscription_key(symbol)

    async def start(self) -> None:
        """Restore FULL subscriptions and watched price streams."""
        for sub in list(self._subs.values()):
            try:
                if sub.tier == SubscriptionTier.FULL:
                    await self._activate_full(sub.symbol)
                    await self._activate_price(sub.symbol)
                elif sub.tier == SubscriptionTier.PRICE_ONLY:
                    await self._activate_price(sub.symbol)
            except Exception as exc:
                logger.warning("Failed to restore subscription for %s: %s", sub.symbol, exc)

    async def set_tier(self, symbol: str, tier: SubscriptionTier) -> dict:
        key = self.normalize_symbol(symbol)
        now_ms = int(time.time() * 1000)

        old_sub = self._subs.get(key)
        old_tier = old_sub.tier if old_sub else None
        if old_tier == tier:
            return {"symbol": key, "tier": tier.value, "changed": False}

        if old_tier == SubscriptionTier.FULL:
            await self._deactivate_full(key)
        if old_tier in (SubscriptionTier.FULL, SubscriptionTier.PRICE_ONLY) and tier == SubscriptionTier.NONE:
            await self._deactivate_price(key)

        sub = SymbolSubscription(
            symbol=key,
            tier=tier,
            added_at=old_sub.added_at if old_sub else now_ms,
        )

        warning = None
        if tier == SubscriptionTier.FULL:
            await self._activate_full(key)
            await self._activate_price(key)
            full_count = sum(1 for item in self._subs.values() if item.tier == SubscriptionTier.FULL) + (
                0 if old_tier == SubscriptionTier.FULL else 1
            )
            if full_count > FULL_TIER_SOFT_LIMIT:
                warning = (
                    f"已有 {full_count} 个品种设为完全订阅，"
                    f"建议不超过 {FULL_TIER_SOFT_LIMIT} 个以节省内存和带宽。"
                )
        elif tier == SubscriptionTier.PRICE_ONLY:
            await self._activate_price(key)

        self._subs[key] = sub
        self._save_to_db(key, sub)

        result = {"symbol": key, "tier": tier.value, "changed": True}
        if warning:
            result["warning"] = warning
        return result

    async def remove(self, symbol: str) -> None:
        key = self.normalize_symbol(symbol)
        old_sub = self._subs.get(key)
        if old_sub is not None and old_sub.tier == SubscriptionTier.FULL:
            await self._deactivate_full(key)
        if old_sub is not None and old_sub.tier in (SubscriptionTier.FULL, SubscriptionTier.PRICE_ONLY):
            await self._deactivate_price(key)
        self._subs.pop(key, None)
        self._delete_from_db(key)

    def get(self, symbol: str) -> SymbolSubscription | None:
        return self._subs.get(self.normalize_symbol(symbol))

    def get_tier(self, symbol: str) -> SubscriptionTier:
        sub = self.get(symbol)
        return sub.tier if sub is not None else SubscriptionTier.NONE

    def get_all(self) -> list[dict]:
        return [sub.to_dict() for sub in self._subs.values()]

    def get_full_count(self) -> int:
        return sum(1 for sub in self._subs.values() if sub.tier == SubscriptionTier.FULL)

    async def _activate_full(self, key: str) -> None:
        if self._data_manager is None:
            return
        exchange, market_type, raw_symbol = parse_subscription_key(key)
        await self._data_manager.ensure_stream(
            raw_symbol,
            "1m",
            exchange=exchange,
            market_type=market_type,
        )

    async def _deactivate_full(self, key: str) -> None:
        if self._data_manager is None:
            return
        exchange, market_type, raw_symbol = parse_subscription_key(key)
        streams = self._data_manager.get_all_streams()
        for info in streams:
            if (
                info.key.symbol == raw_symbol
                and info.key.exchange == exchange
                and info.key.market_type == market_type
            ):
                await self._data_manager.stop_stream(
                    raw_symbol,
                    info.key.interval,
                    exchange=exchange,
                    market_type=market_type,
                )

    async def _activate_price(self, key: str) -> None:
        if self._data_manager is None:
            return
        exchange, market_type, raw_symbol = parse_subscription_key(key)
        await self._data_manager.ensure_price_stream(
            raw_symbol,
            exchange=exchange,
            market_type=market_type,
        )

    async def _deactivate_price(self, key: str) -> None:
        if self._data_manager is None:
            return
        exchange, market_type, raw_symbol = parse_subscription_key(key)
        await self._data_manager.stop_price_stream(
            raw_symbol,
            exchange=exchange,
            market_type=market_type,
        )

    def _init_db(self) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS subscriptions (
                    symbol   TEXT PRIMARY KEY,
                    tier     TEXT NOT NULL DEFAULT 'none',
                    added_at INTEGER NOT NULL DEFAULT 0
                )
            """)
            conn.commit()

    def _load_from_db(self) -> None:
        with sqlite3.connect(self._db_path) as conn:
            rows = conn.execute("SELECT symbol, tier, added_at FROM subscriptions").fetchall()
        rewrites: list[tuple[str, str, int, str]] = []
        for symbol, tier_str, added_at in rows:
            try:
                tier = SubscriptionTier(tier_str)
            except ValueError:
                tier = SubscriptionTier.NONE
            normalized = self.normalize_symbol(symbol)
            self._subs[normalized] = SymbolSubscription(
                symbol=normalized,
                tier=tier,
                added_at=added_at,
            )
            if normalized != symbol:
                rewrites.append((normalized, tier.value, added_at, symbol))
        if rewrites:
            with sqlite3.connect(self._db_path) as conn:
                for normalized, tier_value, added_at, original in rewrites:
                    conn.execute("DELETE FROM subscriptions WHERE symbol = ?", (original,))
                    conn.execute(
                        "INSERT OR REPLACE INTO subscriptions (symbol, tier, added_at) VALUES (?, ?, ?)",
                        (normalized, tier_value, added_at),
                    )
                conn.commit()

    def _save_to_db(self, symbol: str, sub: SymbolSubscription) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO subscriptions (symbol, tier, added_at) VALUES (?, ?, ?)",
                (sub.symbol, sub.tier.value, sub.added_at),
            )
            conn.commit()

    def _delete_from_db(self, symbol: str) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("DELETE FROM subscriptions WHERE symbol = ?", (symbol,))
            conn.commit()
