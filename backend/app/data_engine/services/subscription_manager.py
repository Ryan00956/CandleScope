"""
SubscriptionManager — three-tier subscription system.

Manages per-symbol subscription levels:
  * **FULL**       — complete ingestion pipeline (WS kline stream → BarAggregator
                     → Cache → EventBus).  Seamless switching, highest resource cost.
  * **PRICE_ONLY** — lightweight ticker stream.  Only the latest price/24h change
                     is tracked.  No kline data, minimal resources.
  * **NONE**       — pure bookmark.  Zero backend resources.  Data is fetched +
                     backfilled on demand when the user switches to this symbol.

Persistence:
  Subscription tiers are stored in SQLite (``subscriptions`` table) so they
  survive restarts.  On startup, FULL subscriptions are auto-restored.

The manager coordinates with DataManager for FULL tier and with
PriceTickerService for PRICE_ONLY tier.
"""
from __future__ import annotations

import enum
import json
import logging
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.exchanges.symbols import normalize_symbol as normalize_exchange_symbol

logger = logging.getLogger("candlescope.subscriptions")


def _infer_exchange_from_symbol(symbol: str, fallback: str = "binance") -> str:
    normalized = str(symbol or "").upper().strip()
    if not normalized:
        return fallback
    if "-" in normalized:
        return "okx"
    return fallback


def _to_composite_key(symbol: str) -> str:
    """Ensure a symbol is in composite key format.

    'BTCUSDT' -> 'spot:BTCUSDT'
    'spot:BTCUSDT' -> 'spot:BTCUSDT' (unchanged)
    'okx:spot:BTC-USDT' -> 'okx:spot:BTC-USDT' (unchanged)
    'futures:ETHUSDT' -> 'futures:ETHUSDT' (unchanged)
    """
    exchange, market_type, raw_symbol = _parse_composite_key(symbol)
    raw_symbol = normalize_exchange_symbol(
        raw_symbol,
        exchange=exchange,
        market_type=market_type,
    )
    if exchange == "binance":
        return f"{market_type}:{raw_symbol}"
    return f"{exchange}:{market_type}:{raw_symbol}"


def _parse_composite_key(key: str) -> tuple[str, str, str]:
    """Parse to (exchange, market_type, raw_symbol)."""
    parts = [part.strip() for part in key.split(":") if part.strip()]
    if len(parts) >= 3:
        exchange = parts[0].lower()
        market_type = parts[1].lower()
        raw_symbol = normalize_exchange_symbol(parts[2], exchange=exchange, market_type=market_type)
        return exchange, market_type, raw_symbol
    if len(parts) == 2:
        market_type = parts[0].lower()
        raw_symbol = parts[1].upper()
        exchange = _infer_exchange_from_symbol(raw_symbol)
        raw_symbol = normalize_exchange_symbol(raw_symbol, exchange=exchange, market_type=market_type)
        return exchange, market_type, raw_symbol
    raw_symbol = key.upper().strip()
    exchange = _infer_exchange_from_symbol(raw_symbol)
    raw_symbol = normalize_exchange_symbol(raw_symbol, exchange=exchange, market_type="spot")
    return exchange, "spot", raw_symbol


class SubscriptionTier(str, enum.Enum):
    FULL = "full"
    PRICE_ONLY = "price"
    NONE = "none"


@dataclass
class SymbolSubscription:
    symbol: str
    tier: SubscriptionTier = SubscriptionTier.NONE
    added_at: int = 0  # ms timestamp

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "tier": self.tier.value,
            "added_at": self.added_at,
        }


# Maximum recommended FULL subscriptions before warning
FULL_TIER_SOFT_LIMIT = 5


class SubscriptionManager:
    """Manages subscription tiers for watchlist symbols.

    Usage::

        mgr = SubscriptionManager(db_path)
        mgr.set_data_manager(dm)
        mgr.set_price_ticker(price_ticker_service)

        await mgr.start()  # restores FULL subscriptions

        await mgr.set_tier("ETHUSDT", SubscriptionTier.FULL)
        await mgr.set_tier("SOLUSDT", SubscriptionTier.PRICE_ONLY)
        await mgr.set_tier("DOTUSDT", SubscriptionTier.NONE)

        info = mgr.get_all()
    """

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = str(db_path)
        self._subs: dict[str, SymbolSubscription] = {}
        self._data_manager: Any = None
        self._price_ticker: Any = None
        self._init_db()
        self._load_from_db()

    # ── Dependency injection ─────────────────────────────────

    def set_data_manager(self, dm: Any) -> None:
        self._data_manager = dm

    def set_price_ticker(self, pt: Any) -> None:
        self._price_ticker = pt

    def normalize_symbol(self, symbol: str) -> str:
        """Normalize a user/API symbol into the persisted subscription key."""
        return _to_composite_key(symbol)

    # ── Lifecycle ────────────────────────────────────────────

    async def start(self) -> None:
        """Restore FULL subscriptions by ensuring their streams are active."""
        full_syms = [s for s in self._subs.values() if s.tier == SubscriptionTier.FULL]
        if not full_syms:
            return

        logger.info("Restoring %d FULL subscriptions...", len(full_syms))
        for sub in full_syms:
            try:
                await self._activate_full(sub.symbol)
            except Exception as exc:
                logger.warning("Failed to restore FULL for %s: %s", sub.symbol, exc)

        # Also tell PriceTickerService about PRICE_ONLY symbols
        price_syms = [s.symbol for s in self._subs.values() if s.tier == SubscriptionTier.PRICE_ONLY]
        if price_syms and self._price_ticker:
            self._price_ticker.set_watched_symbols(
                price_syms + [s.symbol for s in full_syms]
            )

    # ── Public API ───────────────────────────────────────────

    async def set_tier(self, symbol: str, tier: SubscriptionTier) -> dict:
        """Set or update subscription tier for a symbol.

        Accepts composite keys ('spot:BTCUSDT', 'futures:ETHUSDT') or
        plain symbols ('BTCUSDT' treated as spot).

        Returns a status dict including a ``warning`` key if the FULL
        soft limit is exceeded.
        """
        key = self.normalize_symbol(symbol)
        now_ms = int(time.time() * 1000)

        old_sub = self._subs.get(key)
        old_tier = old_sub.tier if old_sub else None

        if old_tier == tier:
            return {"symbol": key, "tier": tier.value, "changed": False}

        # Deactivate old tier
        if old_tier == SubscriptionTier.FULL:
            await self._deactivate_full(key)
        elif old_tier == SubscriptionTier.PRICE_ONLY:
            self._deactivate_price_only(key)

        # Activate new tier
        sub = SymbolSubscription(
            symbol=key,
            tier=tier,
            added_at=old_sub.added_at if old_sub else now_ms,
        )

        warning = None
        if tier == SubscriptionTier.FULL:
            await self._activate_full(key)
            full_count = sum(1 for s in self._subs.values() if s.tier == SubscriptionTier.FULL) + (
                0 if old_tier == SubscriptionTier.FULL else 1
            )
            if full_count > FULL_TIER_SOFT_LIMIT:
                warning = (
                    f"已有 {full_count} 个品种设为完全订阅，"
                    f"建议不超过 {FULL_TIER_SOFT_LIMIT} 个以节省内存和带宽。"
                )
        elif tier == SubscriptionTier.PRICE_ONLY:
            self._activate_price_only(key)

        self._subs[key] = sub
        self._save_to_db(key, sub)
        self._sync_price_ticker_symbols()

        result = {"symbol": key, "tier": tier.value, "changed": True}
        if warning:
            result["warning"] = warning
        return result

    async def remove(self, symbol: str) -> None:
        """Remove a symbol from subscriptions entirely and release resources."""
        key = self.normalize_symbol(symbol)
        old_sub = self._subs.get(key)
        if old_sub is not None:
            if old_sub.tier == SubscriptionTier.FULL:
                await self._deactivate_full(key)
            elif old_sub.tier == SubscriptionTier.PRICE_ONLY:
                self._deactivate_price_only(key)
        self._subs.pop(key, None)
        self._delete_from_db(key)
        self._sync_price_ticker_symbols()

    def get(self, symbol: str) -> SymbolSubscription | None:
        key = self.normalize_symbol(symbol)
        return self._subs.get(key)

    def get_tier(self, symbol: str) -> SubscriptionTier:
        key = self.normalize_symbol(symbol)
        sub = self._subs.get(key)
        return sub.tier if sub else SubscriptionTier.NONE

    def get_all(self) -> list[dict]:
        return [s.to_dict() for s in self._subs.values()]

    def get_full_count(self) -> int:
        return sum(1 for s in self._subs.values() if s.tier == SubscriptionTier.FULL)

    # ── Internal: tier activation ────────────────────────────

    async def _activate_full(self, key: str) -> None:
        """Start the full ingestion pipeline for a symbol."""
        if self._data_manager is None:
            return
        exchange, market_type, raw_sym = _parse_composite_key(key)
        for interval in ("1m",):
            try:
                await self._data_manager.ensure_stream(
                    raw_sym,
                    interval,
                    exchange=exchange,
                    market_type=market_type,
                )
            except Exception as exc:
                logger.warning(
                    "ensure_stream(%s, %s, exchange=%s, market_type=%s) failed: %s",
                    raw_sym,
                    interval,
                    exchange,
                    market_type,
                    exc,
                )

    async def _deactivate_full(self, key: str) -> None:
        """Stop the full ingestion pipeline for a symbol."""
        if self._data_manager is None:
            return
        exchange, market_type, raw_sym = _parse_composite_key(key)
        try:
            streams = self._data_manager.get_all_streams()
            for info in streams:
                if (
                    info.key.symbol == raw_sym
                    and info.key.exchange == exchange
                    and info.key.market_type == market_type
                ):
                    await self._data_manager.stop_stream(
                        raw_sym,
                        info.key.interval,
                        exchange=exchange,
                        market_type=market_type,
                    )
        except Exception as exc:
            logger.warning("deactivate_full(%s) failed: %s", key, exc)

    def _activate_price_only(self, symbol: str) -> None:
        """Register symbol with the PriceTickerService."""
        # PriceTickerService filters symbols from its all-tickers stream
        pass  # Handled by _sync_price_ticker_symbols

    def _deactivate_price_only(self, symbol: str) -> None:
        pass  # Handled by _sync_price_ticker_symbols

    def _sync_price_ticker_symbols(self) -> None:
        """Tell the PriceTickerService which symbols to track."""
        if self._price_ticker is None:
            return
        watched = [
            s.symbol for s in self._subs.values()
            if s.tier in (SubscriptionTier.FULL, SubscriptionTier.PRICE_ONLY)
        ]
        self._price_ticker.set_watched_symbols(watched)

    # ── Persistence (SQLite) ─────────────────────────────────

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
        for sym, tier_str, added_at in rows:
            try:
                tier = SubscriptionTier(tier_str)
            except ValueError:
                tier = SubscriptionTier.NONE
            normalized = self.normalize_symbol(sym)
            self._subs[normalized] = SymbolSubscription(
                symbol=normalized,
                tier=tier,
                added_at=added_at,
            )
            if normalized != sym:
                rewrites.append((normalized, tier.value, added_at, sym))
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
