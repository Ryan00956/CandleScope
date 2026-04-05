"""
PriceTickerService — lightweight real-time price feed.

Connects to a **single** Binance ``!miniTicker@arr`` WebSocket stream that
pushes 24h ticker data for ALL trading pairs every ~1 second.  The service
filters for watched symbols and maintains an in-memory price cache.

Additionally, it fetches the current-day 1D kline open price for each watched
symbol so the frontend can display daily change (matching the 1D chart).

Consumers:
  * WatchlistSidebar — shows latest price + daily change next to each symbol
  * REST endpoint ``GET /subscriptions/prices`` — snapshot of current prices
  * WebSocket endpoint ``/stream/prices`` — real-time push to frontend

Resource cost: **one WS connection total**, regardless of how many symbols
are in the watchlist.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

import aiohttp
import websockets

from app.core.config import (
    BINANCE_BASE_URL, BINANCE_BASE_URLS,
    get_effective_proxy,
)

logger = logging.getLogger("candlescope.price_ticker")


@dataclass(slots=True)
class PriceTick:
    """Snapshot of a symbol's current price info."""
    symbol: str
    price: float            # latest close price
    open: float             # 24h open
    high: float             # 24h high
    low: float              # 24h low
    change_pct: float       # 24h price change percentage
    volume: float           # 24h base asset volume
    quote_volume: float     # 24h quote asset volume
    daily_open: float = 0.0  # daily (1D) open price (UTC 00:00)
    updated_at_ms: int = 0

    def to_dict(self) -> dict:
        # Calculate daily change (based on 1D open, not 24h rolling)
        daily_change = 0.0
        daily_change_pct = 0.0
        if self.daily_open > 0:
            daily_change = self.price - self.daily_open
            daily_change_pct = (daily_change / self.daily_open) * 100

        return {
            "symbol": self.symbol,
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


class PriceTickerService:
    """Single-connection price ticker using Binance !miniTicker@arr.

    Usage::

        pts = PriceTickerService(ws_urls=[...])
        pts.set_watched_symbols(["BTCUSDT", "ETHUSDT"])
        await pts.start()

        # Get current price
        tick = pts.get_price("BTCUSDT")

        # Subscribe for push updates
        pts.on_price_update(my_callback)

        await pts.stop()
    """

    def __init__(
        self,
        ws_urls: list[str] | None = None,
        rest_base_urls: list[str] | None = None,
    ) -> None:
        self._ws_urls = ws_urls or ["wss://stream.binance.com:9443/ws"]
        self._rest_base_urls = rest_base_urls or list(BINANCE_BASE_URLS)
        self._watched: set[str] = set()
        self._prices: dict[str, PriceTick] = {}
        self._daily_opens: dict[str, float] = {}  # symbol -> daily open price
        self._daily_opens_fetched_at: float = 0.0  # last fetch timestamp
        self._callbacks: list[Callable[[list[PriceTick]], Awaitable[None]]] = []

        self._task: asyncio.Task | None = None
        self._daily_task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._last_working_url: str | None = None
        self._last_working_rest_url: str | None = None

    # ── Configuration ────────────────────────────────────────

    def set_watched_symbols(self, symbols: list[str]) -> None:
        """Update the set of symbols to track prices for."""
        self._watched = {s.upper().strip() for s in symbols}

    def add_symbol(self, symbol: str) -> None:
        self._watched.add(symbol.upper().strip())

    def remove_symbol(self, symbol: str) -> None:
        s = symbol.upper().strip()
        self._watched.discard(s)
        self._prices.pop(s, None)
        self._daily_opens.pop(s, None)

    # ── Callbacks ────────────────────────────────────────────

    def on_price_update(self, callback: Callable[[list[PriceTick]], Awaitable[None]]) -> None:
        """Register a callback invoked with updated PriceTicks on each batch."""
        self._callbacks.append(callback)

    # ── Queries ──────────────────────────────────────────────

    def get_price(self, symbol: str) -> PriceTick | None:
        return self._prices.get(symbol.upper().strip())

    def get_all_prices(self) -> dict[str, PriceTick]:
        """Return prices for all watched symbols."""
        return {s: t for s, t in self._prices.items() if s in self._watched}

    def get_prices_snapshot(self) -> list[dict]:
        """Return JSON-serializable snapshot of all watched prices."""
        return [
            t.to_dict() for s, t in self._prices.items()
            if s in self._watched
        ]

    # ── Lifecycle ────────────────────────────────────────────

    async def start(self) -> None:
        """Start the background WS connection and daily open fetcher."""
        if self._task and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="price_ticker")
        self._daily_task = asyncio.create_task(self._daily_open_loop(), name="daily_open_fetcher")
        logger.info("PriceTickerService started")

    async def stop(self) -> None:
        """Stop the background WS connection."""
        self._stop_event.set()
        for task in [self._task, self._daily_task]:
            if task:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        self._task = None
        self._daily_task = None
        logger.info("PriceTickerService stopped")

    # ── Internal: Daily open fetcher ─────────────────────────

    async def _daily_open_loop(self) -> None:
        """Periodically fetch daily (1D) open prices for all watched symbols."""
        while not self._stop_event.is_set():
            try:
                await self._fetch_daily_opens()
            except Exception as exc:
                logger.warning("Daily open fetch error: %s", exc)

            # Re-fetch every 60 seconds (or when new day starts)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=60)
                return  # stop_event was set
            except asyncio.TimeoutError:
                pass  # continue loop

    async def _fetch_daily_opens(self) -> None:
        """Fetch the current 1D kline open price for all watched symbols."""
        symbols = list(self._watched)
        if not symbols:
            return

        # Build candidate REST URLs (last working first)
        urls = []
        if self._last_working_rest_url:
            urls.append(self._last_working_rest_url)
        for u in self._rest_base_urls:
            if u not in urls:
                urls.append(u)

        proxy = get_effective_proxy()

        # Fetch in batches to avoid rate limits
        batch_size = 10
        connector = aiohttp.TCPConnector(limit=batch_size, ssl=False)
        timeout = aiohttp.ClientTimeout(total=15)

        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            for i in range(0, len(symbols), batch_size):
                batch = symbols[i:i + batch_size]
                tasks = [
                    self._fetch_single_daily_open(session, sym, urls, proxy)
                    for sym in batch
                ]
                results = await asyncio.gather(*tasks, return_exceptions=True)

                for sym, result in zip(batch, results):
                    if isinstance(result, (float, int)) and result > 0:
                        self._daily_opens[sym] = result
                        # Update existing tick if available
                        if sym in self._prices:
                            self._prices[sym].daily_open = result
                    elif isinstance(result, Exception):
                        logger.debug("Failed to fetch daily open for %s: %s", sym, result)

                # Small delay between batches
                if i + batch_size < len(symbols):
                    await asyncio.sleep(0.5)

        self._daily_opens_fetched_at = time.time()
        logger.debug("Daily opens fetched for %d symbols", len(self._daily_opens))

    async def _fetch_single_daily_open(
        self,
        session: aiohttp.ClientSession,
        symbol: str,
        base_urls: list[str],
        proxy: str | None,
    ) -> float:
        """Fetch the 1D kline open price for a single symbol."""
        for base_url in base_urls:
            url = f"{base_url}/api/v3/klines"
            params = {"symbol": symbol, "interval": "1d", "limit": 1}
            try:
                async with session.get(url, params=params, proxy=proxy) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        if data and len(data) > 0:
                            self._last_working_rest_url = base_url
                            # data[0][1] = open price of the current 1D candle
                            return float(data[0][1])
            except Exception:
                continue
        return 0.0

    # ── Internal: WS loop ────────────────────────────────────

    async def _run(self) -> None:
        """Main reconnect loop for the !miniTicker@arr stream."""
        reconnect_delay = 2
        max_delay = 60

        while not self._stop_event.is_set():
            for ws_base in self._candidate_urls():
                if self._stop_event.is_set():
                    return
                url = f"{ws_base.rstrip('/')}/!miniTicker@arr"
                try:
                    async with websockets.connect(
                        url,
                        open_timeout=10,
                        close_timeout=2,
                        ping_interval=20,
                        ping_timeout=20,
                    ) as ws:
                        self._last_working_url = ws_base
                        reconnect_delay = 2
                        logger.info("PriceTickerService connected: %s", url)

                        async for message in ws:
                            if self._stop_event.is_set():
                                return
                            await self._handle_message(message)

                except (websockets.exceptions.ConnectionClosed, OSError, Exception) as exc:
                    logger.warning("PriceTickerService WS error (%s): %s", ws_base, exc)
                    continue  # try next URL

            # All URLs failed, wait before retrying
            if not self._stop_event.is_set():
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, max_delay)

    def _candidate_urls(self) -> list[str]:
        urls = []
        if self._last_working_url:
            urls.append(self._last_working_url)
        for u in self._ws_urls:
            if u not in urls:
                urls.append(u)
        return urls

    async def _handle_message(self, raw: str) -> None:
        """Parse a !miniTicker@arr batch and update prices."""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return

        if not isinstance(data, list):
            return

        now_ms = int(time.time() * 1000)
        updated: list[PriceTick] = []

        for item in data:
            sym = item.get("s", "")
            if not sym or sym not in self._watched:
                continue

            close_price = float(item.get("c", 0))
            open_price = float(item.get("o", 0))

            # Calculate 24h change percentage
            if open_price > 0:
                change_pct = ((close_price - open_price) / open_price) * 100
            else:
                change_pct = 0.0

            # Use cached daily open if available
            daily_open = self._daily_opens.get(sym, 0.0)

            tick = PriceTick(
                symbol=sym,
                price=close_price,
                open=open_price,
                high=float(item.get("h", 0)),
                low=float(item.get("l", 0)),
                change_pct=change_pct,
                volume=float(item.get("v", 0)),
                quote_volume=float(item.get("q", 0)),
                daily_open=daily_open,
                updated_at_ms=now_ms,
            )
            self._prices[sym] = tick
            updated.append(tick)

        # Notify callbacks
        if updated and self._callbacks:
            for cb in self._callbacks:
                try:
                    await cb(updated)
                except Exception as exc:
                    logger.warning("Price callback error: %s", exc)
