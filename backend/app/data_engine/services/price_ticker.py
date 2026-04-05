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
from dataclasses import dataclass
from typing import Callable, Awaitable

import aiohttp
import websockets

from app.core.config import BINANCE_BASE_URLS, BINANCE_FUTURES_BASE_URLS, get_effective_proxy
from app.data_engine.ingestion.models import StreamType
from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.symbols import normalize_symbol as normalize_exchange_symbol

logger = logging.getLogger("candlescope.price_ticker")


@dataclass(slots=True)
class PriceTick:
    """Snapshot of a symbol's current price info."""
    symbol: str
    exchange: str
    market_type: str
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


def _composite_key(exchange: str, market_type: str, symbol: str) -> str:
    """Build a subscription key, keeping Binance keys backward-compatible."""
    normalized_exchange = (exchange or "binance").strip().lower()
    normalized_market = (market_type or "spot").strip().lower()
    normalized_symbol = normalize_exchange_symbol(
        symbol,
        exchange=normalized_exchange,
        market_type=normalized_market,
    )
    if normalized_exchange == "binance":
        return f"{normalized_market}:{normalized_symbol}"
    return f"{normalized_exchange}:{normalized_market}:{normalized_symbol}"


def _infer_exchange_from_symbol(symbol: str, fallback: str = "binance") -> str:
    normalized = str(symbol or "").upper().strip()
    if not normalized:
        return fallback
    if "-" in normalized:
        return "okx"
    return fallback


def _parse_composite_key(key: str) -> tuple[str, str, str]:
    """Parse watch keys into (exchange, market_type, symbol)."""
    parts = [part.strip() for part in key.split(":") if part.strip()]
    if len(parts) >= 3:
        exchange = parts[0].lower()
        market_type = parts[1].lower()
        symbol = normalize_exchange_symbol(parts[2], exchange=exchange, market_type=market_type)
        return exchange, market_type, symbol
    if len(parts) == 2:
        market_type = parts[0].lower()
        symbol = parts[1].upper()
        exchange = _infer_exchange_from_symbol(symbol)
        symbol = normalize_exchange_symbol(symbol, exchange=exchange, market_type=market_type)
        return exchange, market_type, symbol
    if len(parts) == 1:
        symbol = parts[0].upper()
        exchange = _infer_exchange_from_symbol(symbol)
        symbol = normalize_exchange_symbol(symbol, exchange=exchange, market_type="spot")
        return exchange, "spot", symbol
    symbol = key.upper().strip()
    exchange = _infer_exchange_from_symbol(symbol)
    symbol = normalize_exchange_symbol(symbol, exchange=exchange, market_type="spot")
    return exchange, "spot", symbol


class PriceTickerService:
    """Dual-stream price ticker using Binance !miniTicker@arr.

    Connects to both spot and futures WebSocket streams so that
    spot and futures prices are tracked independently.  Prices are
    stored with composite keys ('spot:BTCUSDT', 'futures:BTCUSDT').

    Usage::

        pts = PriceTickerService(ws_urls=[...], futures_ws_urls=[...])
        pts.set_watched_symbols(["spot:BTCUSDT", "futures:ETHUSDT"])
        await pts.start()

        tick = pts.get_price("spot:BTCUSDT")
        pts.on_price_update(my_callback)
        await pts.stop()
    """

    def __init__(
        self,
        ws_urls: list[str] | None = None,
        rest_base_urls: list[str] | None = None,
        futures_ws_urls: list[str] | None = None,
        futures_rest_base_urls: list[str] | None = None,
    ) -> None:
        bootstrap_default_adapters()
        self._registry = get_exchange_registry()
        self._binance_ws_urls = ws_urls or ["wss://stream.binance.com:9443/ws"]
        self._binance_rest_base_urls = rest_base_urls or list(BINANCE_BASE_URLS)
        self._binance_futures_ws_urls = futures_ws_urls or ["wss://fstream.binance.com/ws"]
        self._binance_futures_rest_base_urls = futures_rest_base_urls or list(BINANCE_FUTURES_BASE_URLS)
        self._watched: set[str] = set()
        self._prices: dict[str, PriceTick] = {}  # composite key → PriceTick
        self._daily_opens: dict[str, float] = {}  # composite key → daily open
        self._daily_opens_fetched_at: float = 0.0
        self._callbacks: list[Callable[[list[PriceTick]], Awaitable[None]]] = []

        self._tasks: dict[tuple[str, str], asyncio.Task] = {}
        self._daily_task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._last_working_ws_url: dict[tuple[str, str], str] = {}
        self._last_working_rest_url: dict[tuple[str, str], str] = {}

    # ── Configuration ────────────────────────────────────────

    def set_watched_symbols(self, symbols: list[str]) -> None:
        """Update the set of symbols to track prices for.

        Accepts composite keys like 'spot:BTCUSDT' or 'futures:ETHUSDT'.
        Plain symbols without prefix are treated as spot.
        """
        normalised: set[str] = set()
        for s in symbols:
            exchange, market_type, symbol = _parse_composite_key(s.strip())
            normalised.add(_composite_key(exchange, market_type, symbol))
        self._watched = normalised

    def add_symbol(self, symbol: str) -> None:
        exchange, market_type, raw_symbol = _parse_composite_key(symbol.strip())
        self._watched.add(_composite_key(exchange, market_type, raw_symbol))

    def remove_symbol(self, symbol: str) -> None:
        exchange, market_type, raw_symbol = _parse_composite_key(symbol.strip())
        s = _composite_key(exchange, market_type, raw_symbol)
        self._watched.discard(s)
        self._prices.pop(s, None)
        self._daily_opens.pop(s, None)

    # ── Callbacks ────────────────────────────────────────────

    def on_price_update(self, callback: Callable[[list[PriceTick]], Awaitable[None]]) -> None:
        """Register a callback invoked with updated PriceTicks on each batch."""
        self._callbacks.append(callback)

    # ── Queries ──────────────────────────────────────────────

    def get_price(self, symbol: str) -> PriceTick | None:
        exchange, market_type, raw_symbol = _parse_composite_key(symbol.strip())
        key = _composite_key(exchange, market_type, raw_symbol)
        return self._prices.get(key)

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
        """Start background WS connections and the daily open fetcher."""
        if self._tasks:
            return
        self._stop_event.clear()
        for exchange, adapter in self._registry.items():
            capabilities = adapter.capabilities()
            if not capabilities.supports_multi_symbol_ticker:
                continue
            for market in capabilities.markets:
                task_key = (exchange, market.market_type)
                self._tasks[task_key] = asyncio.create_task(
                    self._run_stream(exchange, market.market_type),
                    name=f"price_ticker_{exchange}_{market.market_type}",
                )
        self._daily_task = asyncio.create_task(self._daily_open_loop(), name="daily_open_fetcher")
        logger.info("PriceTickerService started (%d streams)", len(self._tasks))

    async def stop(self) -> None:
        """Stop all background WS connections."""
        self._stop_event.set()
        for task in [*self._tasks.values(), self._daily_task]:
            if task:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        self._tasks.clear()
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
        composite_keys = list(self._watched)
        if not composite_keys:
            return

        grouped: dict[tuple[str, str], list[tuple[str, str]]] = {}
        for ck in composite_keys:
            exchange, market_type, sym = _parse_composite_key(ck)
            grouped.setdefault((exchange, market_type), []).append((ck, sym))

        proxy = get_effective_proxy()

        batch_size = 10
        connector = aiohttp.TCPConnector(limit=batch_size, ssl=False)
        timeout = aiohttp.ClientTimeout(total=15)

        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            for (exchange, market_type), items in grouped.items():
                rest_urls = self._build_rest_urls(exchange, market_type)
                if not rest_urls:
                    continue
                try:
                    adapter = self._registry.get(exchange)
                except KeyError:
                    continue
                kline_path = adapter.get_rest_path(StreamType.KLINE, market_type)
                if not kline_path:
                    continue
                await self._fetch_daily_opens_batch(
                    session, items, rest_urls, kline_path, proxy, exchange, market_type,
                )

        self._daily_opens_fetched_at = time.time()
        logger.debug("Daily opens fetched for %d symbols", len(self._daily_opens))

    def _build_rest_urls(self, exchange: str, market_type: str) -> list[str]:
        key = (exchange, market_type)
        urls: list[str] = []
        cached = self._last_working_rest_url.get(key)
        if cached:
            urls.append(cached)
        try:
            adapter = self._registry.get(exchange)
        except KeyError:
            return urls
        if exchange == "binance":
            base_urls = (
                self._binance_futures_rest_base_urls
                if market_type == "futures"
                else self._binance_rest_base_urls
            )
        else:
            base_urls = adapter.get_http_base_urls(market_type)
        for url in base_urls:
            if url not in urls:
                urls.append(url)
        return urls

    async def _fetch_daily_opens_batch(
        self,
        session: aiohttp.ClientSession,
        items: list[tuple[str, str]],  # (composite_key, raw_symbol)
        base_urls: list[str],
        kline_path: str,
        proxy: str | None,
        exchange: str,
        market_type: str,
    ) -> None:
        batch_size = 10
        for i in range(0, len(items), batch_size):
            batch = items[i:i + batch_size]
            tasks = [
                self._fetch_single_daily_open(
                    session,
                    sym,
                    base_urls,
                    kline_path,
                    proxy,
                    exchange=exchange,
                    market_type=market_type,
                )
                for _, sym in batch
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for (ck, sym), result in zip(batch, results):
                if isinstance(result, (float, int)) and result > 0:
                    self._daily_opens[ck] = result
                    if ck in self._prices:
                        self._prices[ck].daily_open = result
                elif isinstance(result, Exception):
                    logger.debug("Failed to fetch daily open for %s: %s", ck, result)

            if i + batch_size < len(items):
                await asyncio.sleep(0.5)

    async def _fetch_single_daily_open(
        self,
        session: aiohttp.ClientSession,
        symbol: str,
        base_urls: list[str],
        kline_path: str,
        proxy: str | None,
        exchange: str,
        market_type: str,
    ) -> float:
        """Fetch the 1D kline open price for a single symbol."""
        for base_url in base_urls:
            url = f"{base_url}{kline_path}"
            params = {"symbol": symbol, "interval": "1d", "limit": 1}
            try:
                async with session.get(url, params=params, proxy=proxy) as resp:
                    if resp.status == 200:
                        self._last_working_rest_url[(exchange, market_type)] = base_url
                        data = await resp.json()
                        if data and len(data) > 0:
                            return float(data[0][1])
            except Exception:
                continue
        return 0.0

    # ── Internal: WS loop ────────────────────────────────────

    async def _run_stream(self, exchange: str, market_type: str) -> None:
        """Reconnect loop for one exchange/market all-symbol ticker stream."""
        reconnect_delay = 2
        max_delay = 60

        try:
            adapter = self._registry.get(exchange)
        except KeyError:
            return
        stream_name = adapter.get_multi_symbol_ticker_stream_name(market_type)
        if not stream_name:
            return

        while not self._stop_event.is_set():
            for ws_base in self._candidate_ws_urls(exchange, market_type):
                if self._stop_event.is_set():
                    return
                url = f"{ws_base.rstrip('/')}/{stream_name}"
                try:
                    async with websockets.connect(
                        url,
                        open_timeout=10,
                        close_timeout=2,
                        ping_interval=20,
                        ping_timeout=20,
                    ) as ws:
                        self._last_working_ws_url[(exchange, market_type)] = ws_base
                        reconnect_delay = 2
                        logger.info("PriceTickerService [%s:%s] connected: %s", exchange, market_type, url)

                        async for message in ws:
                            if self._stop_event.is_set():
                                return
                            await self._handle_message(message, exchange, market_type)

                except (websockets.exceptions.ConnectionClosed, OSError, Exception) as exc:
                    logger.warning(
                        "PriceTickerService [%s:%s] WS error (%s): %s",
                        exchange, market_type, ws_base, exc,
                    )
                    continue

            if not self._stop_event.is_set():
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, max_delay)

    def _candidate_ws_urls(self, exchange: str, market_type: str) -> list[str]:
        key = (exchange, market_type)
        urls: list[str] = []
        cached = self._last_working_ws_url.get(key)
        if cached:
            urls.append(cached)
        try:
            adapter = self._registry.get(exchange)
        except KeyError:
            return urls
        if exchange == "binance":
            base_urls = (
                self._binance_futures_ws_urls
                if market_type == "futures"
                else self._binance_ws_urls
            )
        else:
            base_urls = adapter.get_ws_base_urls(market_type)
        for url in base_urls:
            if url not in urls:
                urls.append(url)
        return urls

    async def _handle_message(self, raw: str, exchange: str, market_type: str) -> None:
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
            raw_sym = item.get("s", "")
            if not raw_sym:
                continue

            ck = _composite_key(exchange, market_type, raw_sym)
            if ck not in self._watched:
                continue

            close_price = float(item.get("c", 0))
            open_price = float(item.get("o", 0))

            if open_price > 0:
                change_pct = ((close_price - open_price) / open_price) * 100
            else:
                change_pct = 0.0

            daily_open = self._daily_opens.get(ck, 0.0)

            tick = PriceTick(
                symbol=ck,
                exchange=exchange,
                market_type=market_type,
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
            self._prices[ck] = tick
            updated.append(tick)

        if updated and self._callbacks:
            for cb in self._callbacks:
                try:
                    await cb(updated)
                except Exception as exc:
                    logger.warning("Price callback error: %s", exc)
