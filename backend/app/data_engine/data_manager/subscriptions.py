"""Subscription models and persistence for DataManager-owned workflows."""
from __future__ import annotations

import enum
import json
import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from app.data_engine.interval_policy import parse_custom_interval
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
        *,
        focus_scope: str = "foreground",
        subscription_tier: str | None = None,
        consumer_id: str | None = None,
    ) -> Any:
        ...

    async def release_stream(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
        *,
        consumer_id: str | None = None,
        focus_scope: str = "foreground",
        subscription_tier: str | None = None,
    ) -> None:
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

    def register_storage_intent(
        self,
        symbol: str,
        interval: str = "*",
        *,
        source: str,
        exchange: str = "binance",
        market_type: str = "spot",
        priority: str = "weak",
        storage_allowed: bool = True,
        frontend_cache_allowed: bool = False,
        stream_required: bool = False,
        keep_rows: int | None = None,
        detail: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ...

    def unregister_storage_intent(
        self,
        symbol: str,
        interval: str = "*",
        *,
        source: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        ...

    def unregister_storage_intents_for_source(self, source_prefix: str) -> int:
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


def format_subscription_key(
    exchange: str,
    market_type: str,
    symbol: str,
    *,
    legacy_binance: bool = True,
) -> str:
    """Format a normalized subscription key.

    ``legacy_binance`` keeps existing persisted/watchlist Binance keys in the
    historical two-part shape (``spot:BTCUSDT``) while all other exchanges use
    the explicit three-part shape.
    """
    normalized_exchange = str(exchange or "binance").strip().lower()
    normalized_market = str(market_type or "spot").strip().lower()
    normalized_symbol = normalize_exchange_symbol(
        symbol,
        exchange=normalized_exchange,
        market_type=normalized_market,
    )
    if legacy_binance and normalized_exchange == "binance":
        return f"{normalized_market}:{normalized_symbol}"
    return f"{normalized_exchange}:{normalized_market}:{normalized_symbol}"


def normalize_subscription_key(symbol: str) -> str:
    """Normalize a user symbol into the persisted subscription key."""
    exchange, market_type, raw_symbol = parse_subscription_key(symbol)
    return format_subscription_key(exchange, market_type, raw_symbol)


def normalize_subscription_intervals(intervals: Any) -> list[str]:
    """Normalize persisted/requested intervals while keeping stable order."""
    if intervals is None:
        return []
    if isinstance(intervals, str):
        candidates: list[Any] = [intervals]
    elif isinstance(intervals, (list, tuple, set)):
        candidates = list(intervals)
    else:
        return []

    seen: set[str] = set()
    normalized: list[str] = []
    for item in candidates:
        interval = str(item or "").strip()
        if not interval or interval in seen:
            continue
        if parse_custom_interval(interval) is None:
            continue
        seen.add(interval)
        normalized.append(interval)
    return normalized


@dataclass(slots=True)
class SymbolSubscription:
    symbol: str
    tier: SubscriptionTier = SubscriptionTier.NONE
    added_at: int = 0
    intervals: list[str] | None = None

    def __post_init__(self) -> None:
        self.intervals = normalize_subscription_intervals(self.intervals)

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "tier": self.tier.value,
            "added_at": self.added_at,
            "intervals": list(self.intervals or []),
        }


FULL_TIER_SOFT_LIMIT = 5
LEGACY_FULL_INTERVALS = ["1m"]


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
                self._register_watchlist_storage_intent(sub.symbol, sub.tier, sub.intervals)
                if sub.tier == SubscriptionTier.FULL:
                    await self._activate_full(sub.symbol, sub.intervals)
                    await self._activate_price(sub.symbol)
                elif sub.tier == SubscriptionTier.PRICE_ONLY:
                    await self._activate_price(sub.symbol)
            except Exception as exc:
                logger.warning("Failed to restore subscription for %s: %s", sub.symbol, exc)

    async def set_tier(
        self,
        symbol: str,
        tier: SubscriptionTier,
        *,
        intervals: Any | None = None,
        consumer_id: str | None = None,
        storage_intent: bool = True,
    ) -> dict:
        key = self.normalize_symbol(symbol)
        now_ms = int(time.time() * 1000)

        old_sub = self._subs.get(key)
        old_tier = old_sub.tier if old_sub else None
        requested_intervals = (
            normalize_subscription_intervals(intervals)
            if intervals is not None
            else list(old_sub.intervals or []) if old_sub is not None else []
        )
        if (
            tier == SubscriptionTier.FULL
            and intervals is not None
            and not requested_intervals
        ):
            raise ValueError("Full subscriptions require at least one valid interval.")
        if (
            tier == SubscriptionTier.FULL
            and intervals is None
            and old_tier != SubscriptionTier.FULL
        ):
            raise ValueError("Full subscriptions require intervals.")
        next_intervals = requested_intervals if tier == SubscriptionTier.FULL else []
        old_intervals = list(old_sub.intervals or []) if old_sub is not None else []
        if old_tier == tier and (intervals is None or old_intervals == next_intervals):
            if storage_intent:
                self._register_watchlist_storage_intent(key, tier, next_intervals)
            if tier == SubscriptionTier.FULL:
                await self._activate_full(
                    key,
                    old_intervals,
                    consumer_id=consumer_id,
                )
                await self._activate_price(key)
            elif tier == SubscriptionTier.PRICE_ONLY:
                await self._activate_price(key)
            return {"symbol": key, "tier": tier.value, "changed": False}

        if old_tier == SubscriptionTier.FULL and tier == SubscriptionTier.FULL:
            await self._sync_full_intervals(
                key,
                old_intervals=old_intervals,
                next_intervals=next_intervals,
                consumer_id=consumer_id,
            )
        elif old_tier == SubscriptionTier.FULL:
            await self._deactivate_full(
                key,
                old_intervals,
                consumer_id=consumer_id,
            )
        if old_tier in (SubscriptionTier.FULL, SubscriptionTier.PRICE_ONLY) and tier == SubscriptionTier.NONE:
            await self._deactivate_price(key)

        sub = SymbolSubscription(
            symbol=key,
            tier=tier,
            added_at=old_sub.added_at if old_sub else now_ms,
            intervals=next_intervals if tier == SubscriptionTier.FULL else [],
        )
        if storage_intent:
            self._register_watchlist_storage_intent(key, tier, sub.intervals)

        warning = None
        if tier == SubscriptionTier.FULL:
            if old_tier != SubscriptionTier.FULL:
                await self._activate_full(
                    key,
                    next_intervals,
                    consumer_id=consumer_id,
                )
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
        if old_sub is not None:
            self._unregister_watchlist_storage_intents(key)
        if old_sub is not None and old_sub.tier == SubscriptionTier.FULL:
            await self._deactivate_full(key, old_sub.intervals)
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

    def sync_watchlist_storage_intents(self, symbols: set[str]) -> None:
        """Keep storage intents aligned with the current frontend watchlist set."""
        normalized = {self.normalize_symbol(symbol) for symbol in symbols if str(symbol or "").strip()}
        for key in normalized:
            sub = self._subs.get(key)
            self._register_watchlist_storage_intent(
                key,
                sub.tier if sub is not None else SubscriptionTier.NONE,
                sub.intervals if sub is not None else [],
            )
        for key in list(self._subs):
            if key not in normalized:
                self._unregister_watchlist_storage_intents(key)

    async def _activate_full(
        self,
        key: str,
        intervals: Any,
        *,
        consumer_id: str | None = None,
    ) -> None:
        if self._data_manager is None:
            return
        exchange, market_type, raw_symbol = parse_subscription_key(key)
        consumer = self._subscription_consumer_id(key, consumer_id)
        for interval in self._effective_full_intervals(intervals):
            self._register_watchlist_full_storage_intent(key, interval)
            await self._data_manager.ensure_stream(
                raw_symbol,
                interval,
                exchange=exchange,
                market_type=market_type,
                focus_scope="subscription",
                subscription_tier=SubscriptionTier.FULL.value,
                consumer_id=consumer,
            )

    async def _deactivate_full(
        self,
        key: str,
        intervals: Any,
        *,
        consumer_id: str | None = None,
    ) -> None:
        if self._data_manager is None:
            return
        exchange, market_type, raw_symbol = parse_subscription_key(key)
        consumer = self._subscription_consumer_id(key, consumer_id)
        for interval in self._effective_full_intervals(intervals):
            self._unregister_watchlist_full_storage_intent(key, interval)
            await self._data_manager.release_stream(
                raw_symbol,
                interval,
                exchange=exchange,
                market_type=market_type,
                focus_scope="subscription",
                subscription_tier=SubscriptionTier.FULL.value,
                consumer_id=consumer,
            )

    async def _sync_full_intervals(
        self,
        key: str,
        *,
        old_intervals: Any,
        next_intervals: Any,
        consumer_id: str | None = None,
    ) -> None:
        old_effective = self._effective_full_intervals(old_intervals)
        next_effective = self._effective_full_intervals(next_intervals)
        old_set = set(old_effective)
        next_set = set(next_effective)
        removed = [interval for interval in old_effective if interval not in next_set]
        added = [interval for interval in next_effective if interval not in old_set]
        if removed:
            await self._deactivate_full(key, removed, consumer_id=consumer_id)
        if added:
            await self._activate_full(key, added, consumer_id=consumer_id)

    @staticmethod
    def _effective_full_intervals(intervals: Any) -> list[str]:
        normalized = normalize_subscription_intervals(intervals)
        return normalized or list(LEGACY_FULL_INTERVALS)

    @staticmethod
    def _subscription_consumer_id(key: str, consumer_id: str | None) -> str:
        return f"watchlist:global:{key}"

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

    def _register_watchlist_storage_intent(
        self,
        key: str,
        tier: SubscriptionTier,
        intervals: Any,
    ) -> None:
        if self._data_manager is None:
            return
        exchange, market_type, raw_symbol = parse_subscription_key(key)
        priority = {
            SubscriptionTier.FULL: "strong",
            SubscriptionTier.PRICE_ONLY: "normal",
            SubscriptionTier.NONE: "weak",
        }.get(tier, "weak")
        register = getattr(self._data_manager, "register_storage_intent", None)
        if callable(register):
            register(
                raw_symbol,
                "*",
                exchange=exchange,
                market_type=market_type,
                source=f"watchlist:{key}",
                priority=priority,
                storage_allowed=True,
                frontend_cache_allowed=False,
                stream_required=False,
                detail={"tier": tier.value, "scope": "watchlist"},
            )
        record_access = getattr(
            self._data_manager,
            "record_cache_access_deferred",
            None,
        ) or getattr(self._data_manager, "record_cache_access", None)
        if callable(record_access):
            record_access(
                raw_symbol,
                "*",
                exchange=exchange,
                market_type=market_type,
                action="watchlist-tier",
                source=tier.value,
                detail={"tier": tier.value, "scope": "watchlist"},
            )
        if tier == SubscriptionTier.FULL:
            for interval in self._effective_full_intervals(intervals):
                self._register_watchlist_full_storage_intent(key, interval)

    def _register_watchlist_full_storage_intent(self, key: str, interval: str) -> None:
        if self._data_manager is None:
            return
        exchange, market_type, raw_symbol = parse_subscription_key(key)
        register = getattr(self._data_manager, "register_storage_intent", None)
        if not callable(register):
            return
        register(
            raw_symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            source=f"watchlist-full:{key}:{interval}",
            priority="strong",
            storage_allowed=True,
            frontend_cache_allowed=True,
            stream_required=True,
            detail={"tier": SubscriptionTier.FULL.value, "scope": "watchlist-full"},
        )

    def _unregister_watchlist_full_storage_intent(self, key: str, interval: str) -> None:
        if self._data_manager is None:
            return
        exchange, market_type, raw_symbol = parse_subscription_key(key)
        unregister = getattr(self._data_manager, "unregister_storage_intent", None)
        if not callable(unregister):
            return
        unregister(
            raw_symbol,
            interval,
            exchange=exchange,
            market_type=market_type,
            source=f"watchlist-full:{key}:{interval}",
        )

    def _unregister_watchlist_storage_intents(self, key: str) -> None:
        if self._data_manager is None:
            return
        unregister = getattr(self._data_manager, "unregister_storage_intents_for_source", None)
        if not callable(unregister):
            return
        unregister(f"watchlist:{key}")
        unregister(f"watchlist-full:{key}:")

    def _init_db(self) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS subscriptions (
                    symbol   TEXT PRIMARY KEY,
                    tier     TEXT NOT NULL DEFAULT 'none',
                    added_at INTEGER NOT NULL DEFAULT 0,
                    intervals_json TEXT NOT NULL DEFAULT '[]'
                )
            """)
            columns = {
                row[1]
                for row in conn.execute("PRAGMA table_info(subscriptions)").fetchall()
            }
            if "intervals_json" not in columns:
                conn.execute(
                    "ALTER TABLE subscriptions "
                    "ADD COLUMN intervals_json TEXT NOT NULL DEFAULT '[]'"
                )
            conn.commit()

    def _load_from_db(self) -> None:
        with sqlite3.connect(self._db_path) as conn:
            rows = conn.execute(
                "SELECT symbol, tier, added_at, intervals_json FROM subscriptions"
            ).fetchall()
        rewrites: list[tuple[str, str, int, str, str]] = []
        for symbol, tier_str, added_at, intervals_json in rows:
            try:
                tier = SubscriptionTier(tier_str)
            except ValueError:
                tier = SubscriptionTier.NONE
            try:
                raw_intervals = json.loads(intervals_json or "[]")
            except (TypeError, json.JSONDecodeError):
                raw_intervals = []
            intervals = normalize_subscription_intervals(raw_intervals)
            stored_intervals = intervals if tier == SubscriptionTier.FULL else []
            normalized = self.normalize_symbol(symbol)
            self._subs[normalized] = SymbolSubscription(
                symbol=normalized,
                tier=tier,
                added_at=added_at,
                intervals=stored_intervals,
            )
            normalized_intervals_json = json.dumps(stored_intervals, separators=(",", ":"))
            if normalized != symbol or normalized_intervals_json != (intervals_json or "[]"):
                rewrites.append((
                    normalized,
                    tier.value,
                    added_at,
                    normalized_intervals_json,
                    symbol,
                ))
        if rewrites:
            with sqlite3.connect(self._db_path) as conn:
                for normalized, tier_value, added_at, intervals_json, original in rewrites:
                    conn.execute("DELETE FROM subscriptions WHERE symbol = ?", (original,))
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO subscriptions
                            (symbol, tier, added_at, intervals_json)
                        VALUES (?, ?, ?, ?)
                        """,
                        (normalized, tier_value, added_at, intervals_json),
                    )
                conn.commit()

    def _save_to_db(self, symbol: str, sub: SymbolSubscription) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO subscriptions
                    (symbol, tier, added_at, intervals_json)
                VALUES (?, ?, ?, ?)
                """,
                (
                    sub.symbol,
                    sub.tier.value,
                    sub.added_at,
                    json.dumps(list(sub.intervals or []), separators=(",", ":")),
                ),
            )
            conn.commit()

    def _delete_from_db(self, symbol: str) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute("DELETE FROM subscriptions WHERE symbol = ?", (symbol,))
            conn.commit()
