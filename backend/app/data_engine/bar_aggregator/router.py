"""
L1: Event Router — routes incoming market data to the correct aggregation pipeline.

Responsibilities:
  * Accept ``MarketEvent`` from ingestion (kline, aggTrade, trade)
  * Accept ``FetchedBar`` from backfill engine
  * Convert all inputs to unified ``BarInput`` format
  * Dispatch by (symbol, target_interval) to downstream layers
  * Support user-registered ``BarInputAdapter`` for custom data sources

The Router is the entry point of the Bar Aggregator pipeline.  It
normalizes heterogeneous inputs into a common ``BarInput`` type and
fans out to all registered aggregation targets.

Usage::

    router = EventRouter(config)
    router.register_target("BTCUSDT", "1m")
    router.register_target("BTCUSDT", "91m")

    # From ingestion
    await router.on_market_event(market_event)

    # From backfill
    await router.on_backfill_bars("BTCUSDT", "1m", fetched_bars)
"""
from __future__ import annotations

import logging
from dataclasses import replace
from typing import Callable, Awaitable, Any

from .config import BarAggregatorConfig
from .models import (
    BarInput,
    BarInputSource,
    BarSourceMode,
    MergeMode,
    BarInputAdapter,
    parse_interval_ms,
    is_standard_interval,
)

logger = logging.getLogger("bar_aggregator.L1_Router")

# Type alias for the callback that receives routed BarInputs
BarInputCallback = Callable[[str, str, str, str, BarInput], Awaitable[None]]
# Signature: (exchange, market_type, symbol, target_interval, bar_input) → None


class EventRouter:
    """Routes incoming data to registered aggregation targets.

    The router maintains a registry of (symbol, interval) targets.
    When data arrives, it is converted to ``BarInput`` and dispatched
    to all matching targets.

    A single source event (e.g. a 1m kline) can be routed to multiple
    targets (e.g. 1m, 5m, 15m, 91m) simultaneously.
    """

    def __init__(self, config: BarAggregatorConfig) -> None:
        self._cfg = config

        # Registered targets: {(exchange, market_type, symbol, interval)} — the set of active pipelines
        self._targets: set[tuple[str, str, str, str]] = set()

        # For each symbol, which source intervals feed it
        # {(exchange, market_type, symbol) → set(source_interval)}
        self._symbol_source_intervals: dict[tuple[str, str, str], set[str]] = {}

        # User-registered adapters: {name → adapter}
        self._adapters: dict[str, BarInputAdapter] = {}

        # Downstream callback (set by BarAggregator during assembly)
        self._on_bar_input: BarInputCallback | None = None

    # ── Public: Target Management ────────────────────────────

    def register_target(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Register a (symbol, interval) aggregation target.

        Once registered, incoming data for this symbol will be routed
        to this interval's aggregation pipeline.

        Args:
            symbol:   Trading pair (e.g. "BTCUSDT")
            interval: Target interval (e.g. "1m", "91m")
        """
        key = (exchange.lower().strip(), market_type.lower().strip(), symbol.upper(), interval)
        if key in self._targets:
            logger.debug("Target already registered: %s:%s:%s@%s", key[0], key[1], symbol, interval)
            return

        self._targets.add(key)
        logger.info("Registered target: %s:%s:%s@%s", key[0], key[1], symbol, interval)

    def unregister_target(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Remove a (symbol, interval) aggregation target."""
        key = (exchange.lower().strip(), market_type.lower().strip(), symbol.upper(), interval)
        self._targets.discard(key)
        logger.info("Unregistered target: %s:%s:%s@%s", key[0], key[1], symbol, interval)

    def get_targets(self) -> list[tuple[str, str, str, str]]:
        """Return all registered (symbol, interval) targets."""
        return sorted(self._targets)

    def get_symbol_targets(
        self,
        symbol: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> list[str]:
        """Return all target intervals for a given symbol."""
        symbol = symbol.upper()
        exchange = exchange.lower().strip()
        market_type = market_type.lower().strip()
        return sorted(
            interval
            for ex, mt, sym, interval in self._targets
            if ex == exchange and mt == market_type and sym == symbol
        )

    # ── Public: Adapter Registration ─────────────────────────

    def register_adapter(self, name: str, adapter: BarInputAdapter) -> None:
        """Register a custom data source adapter.

        Example::

            class MyExchangeAdapter:
                def adapt(self, raw_data):
                    return BarInput(symbol=..., ...)

            router.register_adapter("my_exchange", MyExchangeAdapter())
        """
        self._adapters[name] = adapter
        logger.info("Registered adapter: %s (%s)", name, type(adapter).__name__)

    def remove_adapter(self, name: str) -> None:
        """Remove a custom adapter by name."""
        self._adapters.pop(name, None)

    # ── Public: Set Downstream Callback ──────────────────────

    def set_on_bar_input(self, callback: BarInputCallback) -> None:
        """Set the callback that receives routed BarInputs.

        Called by the BarAggregator during assembly to wire up L1 → L2/L3.
        """
        self._on_bar_input = callback

    # ── Public: Ingest from Ingestion ────────────────────────

    async def on_market_event(self, event: Any) -> None:
        """Accept a MarketEvent from the ingestion DeliveryLayer.

        Converts MarketEvent to BarInput and routes to all matching targets.

        The event is expected to be ``ingestion.models.MarketEvent``.
        We use duck-typing to avoid hard import dependency.
        """
        # Extract event_type as string
        event_type = getattr(event, "event_type", None)
        if event_type is None:
            logger.warning("Received event without event_type, skipping")
            return

        # Convert enum to string if needed
        et_value = event_type.value if hasattr(event_type, "value") else str(event_type)

        # Check if this stream type is accepted
        if not self._is_accepted_stream_type(et_value):
            return

        symbol = getattr(event, "symbol", "").upper()
        exchange = self._extract_exchange(event)
        market_type = self._extract_market_type(event)
        if not symbol:
            return

        # Check if we have any targets for this symbol
        symbol_targets = self.get_symbol_targets(symbol, exchange=exchange, market_type=market_type)
        if not symbol_targets:
            return

        # Convert MarketEvent → BarInput
        bar_input = self._convert_market_event(event, et_value)
        if bar_input is None:
            return

        # Route to all matching targets
        await self._dispatch(exchange, market_type, symbol, bar_input, symbol_targets)

    # ── Public: Ingest from Backfill ─────────────────────────

    async def on_backfill_bars(
        self,
        symbol: str,
        interval: str,
        bars: list[Any],
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Accept FetchedBar list from the backfill engine.

        Each FetchedBar is converted to BarInput and routed.

        Args:
            symbol:   Trading pair
            interval: The interval these bars represent (e.g. "1m")
            bars:     List of FetchedBar objects (or dicts)
        """
        symbol = symbol.upper()
        exchange = exchange.lower().strip()
        market_type = market_type.lower().strip()
        symbol_targets = self.get_symbol_targets(symbol, exchange=exchange, market_type=market_type)
        if not symbol_targets:
            logger.debug("No targets for backfill symbol: %s:%s:%s", exchange, market_type, symbol)
            return

        for bar in bars:
            bar_input = self._convert_fetched_bar(
                bar, symbol, interval, exchange=exchange, market_type=market_type,
            )
            if bar_input is not None:
                await self._dispatch(exchange, market_type, symbol, bar_input, symbol_targets)

    # ── Public: Ingest from Custom Adapter ───────────────────

    async def on_custom_data(self, adapter_name: str, raw_data: Any) -> None:
        """Ingest data through a registered custom adapter.

        Args:
            adapter_name: Name of the registered adapter
            raw_data:     Raw data to pass to the adapter
        """
        adapter = self._adapters.get(adapter_name)
        if adapter is None:
            logger.warning("Unknown adapter: %s", adapter_name)
            return

        try:
            bar_input = adapter.adapt(raw_data)
        except Exception as exc:
            logger.error("Adapter %s error: %s", adapter_name, exc, exc_info=True)
            return

        if bar_input is None:
            return

        bar_input.source = BarInputSource.ADAPTER
        symbol = bar_input.symbol.upper()
        exchange = bar_input.exchange
        market_type = bar_input.market_type
        symbol_targets = self.get_symbol_targets(symbol, exchange=exchange, market_type=market_type)
        if symbol_targets:
            await self._dispatch(exchange, market_type, symbol, bar_input, symbol_targets)

    # ── Public: Snapshot ─────────────────────────────────────

    def snapshot(self) -> dict:
        return {
            "layer": "L1_EventRouter",
            "bar_source_mode": self._cfg.bar_source_mode,
            "targets": [f"{ex}:{mt}:{s}@{i}" for ex, mt, s, i in sorted(self._targets)],
            "adapters": list(self._adapters.keys()),
        }

    # ── Internal: Dispatch ───────────────────────────────────

    async def _dispatch(
        self,
        exchange: str,
        market_type: str,
        symbol: str,
        bar_input: BarInput,
        target_intervals: list[str],
    ) -> None:
        """Dispatch a BarInput to target intervals correctly routed."""
        if self._on_bar_input is None:
            return

        src = bar_input.source_interval

        for interval in target_intervals:
            should_route = False
            merge_mode: MergeMode | None = None

            # Rule 1: Exact match (e.g. 1m to 1m, 5m to 5m, custom 91m to custom 91m)
            if src == interval:
                should_route = True
                merge_mode = MergeMode.SNAPSHOT
            
            # Rule 2: Trade ticks apply to everywhere natively
            elif src == "tick":
                should_route = True
                merge_mode = MergeMode.INCREMENTAL
                
            # Rule 3: Cross-interval mapping for Custom Intervals
            elif not is_standard_interval(interval):
                if bar_input.source == BarInputSource.REALTIME:
                    # Realtime custom bars are built purely from 1m base by convention
                    if src == "1m":
                        should_route = True
                        merge_mode = MergeMode.COMPONENT
                elif bar_input.source == BarInputSource.BACKFILL:
                    # Backfill custom bars accept cleanly decomposed components (standard intervals)
                    tgt_ms = parse_interval_ms(interval) or 0
                    src_ms = parse_interval_ms(src) or 0
                    if is_standard_interval(src) and 0 < src_ms <= tgt_ms:
                        should_route = True
                        merge_mode = MergeMode.COMPONENT

            # Rule 4: OKX realtime 1m -> larger standard intervals
            # OKX native WS channels for large intervals (candle4H, candle1D,
            # etc.) push data infrequently, causing chart prices to appear
            # frozen.  Allow 1m realtime data to fan out to all larger
            # standard intervals so the current forming bar updates in
            # real-time -- matching the behavior of Binance.
            elif (
                is_standard_interval(interval)
                and src == "1m"
                and bar_input.source == BarInputSource.REALTIME
                and exchange == "okx"
            ):
                tgt_ms = parse_interval_ms(interval) or 0
                if tgt_ms > 60_000:
                    should_route = True
                    merge_mode = MergeMode.PRICE_ONLY

            # Discard contaminated source intervals
            if not should_route:
                continue
                
            try:
                routed_input = (
                    replace(bar_input, merge_mode=merge_mode)
                    if merge_mode is not None and bar_input.merge_mode != merge_mode
                    else bar_input
                )
                await self._on_bar_input(exchange, market_type, symbol, interval, routed_input)
            except Exception as exc:
                logger.error(
                    "Dispatch error (%s:%s:%s@%s): %s", exchange, market_type, symbol, interval,
                    exc, exc_info=True,
                )

    # ── Internal: Stream Type Filter ─────────────────────────

    def _is_accepted_stream_type(self, event_type_value: str) -> bool:
        """Check if a stream type is accepted based on bar_source_mode."""
        mode = self._cfg.bar_source_mode

        if mode == BarSourceMode.KLINE.value or mode == "kline":
            return event_type_value == "kline"
        if mode == BarSourceMode.TRADE.value or mode == "trade":
            return event_type_value in ("aggTrade", "trade")
        if mode == BarSourceMode.AUTO.value or mode == "auto":
            return event_type_value in ("kline", "aggTrade", "trade")

        # Fallback: check against configured list
        return event_type_value in self._cfg.accepted_stream_types

    # ── Internal: Converters ─────────────────────────────────

    def _convert_market_event(self, event: Any, event_type: str) -> BarInput | None:
        """Convert a MarketEvent to BarInput."""
        data = getattr(event, "data", None)
        if not isinstance(data, dict):
            return None

        source_val = getattr(event, "source", None)
        source_str = source_val.value if hasattr(source_val, "value") else str(source_val or "")

        # Determine BarInputSource from MarketEvent source
        if source_str == "http_backfill":
            bar_source = BarInputSource.BACKFILL
        else:
            bar_source = BarInputSource.REALTIME

        if event_type == "kline":
            return self._convert_kline_event(event, data, bar_source)
        if event_type in ("aggTrade", "trade"):
            return self._convert_trade_event(event, data, bar_source, event_type)

        return None

    def _convert_kline_event(
        self, event: Any, data: dict, source: BarInputSource,
    ) -> BarInput | None:
        """Convert a kline MarketEvent.data to BarInput."""
        try:
            return BarInput(
                symbol=getattr(event, "symbol", "").upper(),
                source_interval=data.get("interval", "1m"),
                exchange=self._extract_exchange(event),
                open_time_ms=int(data["open_time"]),
                close_time_ms=int(data["close_time"]),
                open=float(data["open"]),
                high=float(data["high"]),
                low=float(data["low"]),
                close=float(data["close"]),
                volume=float(data.get("volume", 0)),
                source=source,
                is_closed=bool(data.get("is_closed", False)),
                market_type=self._extract_market_type(event),
                quote_volume=float(data.get("quote_volume", 0)),
                trades=int(data.get("trades", 0)),
                taker_buy_base=float(data.get("taker_buy_base", 0)),
                taker_buy_quote=float(data.get("taker_buy_quote", 0)),
                sequence=int(data.get("open_time", 0)),
            )
        except (KeyError, ValueError, TypeError) as exc:
            logger.warning("Failed to convert kline event: %s", exc)
            return None

    def _convert_trade_event(
        self, event: Any, data: dict, source: BarInputSource, event_type: str,
    ) -> BarInput | None:
        """Convert a trade/aggTrade MarketEvent.data to BarInput.

        Trades are converted to single-tick bars:
          O = H = L = C = price,  V = quantity
        """
        try:
            price = float(data.get("price", 0))
            quantity = float(data.get("quantity", 0))
            trade_time = int(data.get("trade_time_ms", 0))

            if event_type == "aggTrade":
                seq = int(data.get("agg_trade_id", 0))
            else:
                seq = int(data.get("trade_id", 0))

            return BarInput(
                symbol=getattr(event, "symbol", "").upper(),
                source_interval="tick",  # special marker for trade-based input
                exchange=self._extract_exchange(event),
                open_time_ms=trade_time,
                close_time_ms=trade_time,
                open=price,
                high=price,
                low=price,
                close=price,
                volume=quantity,
                source=source,
                is_closed=True,  # individual trades are always "closed"
                market_type=self._extract_market_type(event),
                sequence=seq,
            )
        except (KeyError, ValueError, TypeError) as exc:
            logger.warning("Failed to convert trade event: %s", exc)
            return None

    def _convert_fetched_bar(
        self,
        bar: Any,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> BarInput | None:
        """Convert a FetchedBar (or dict) to BarInput."""
        try:
            if isinstance(bar, dict):
                return BarInput(
                    symbol=symbol.upper(),
                    source_interval=interval,
                    exchange=str(bar.get("exchange", exchange)),
                    open_time_ms=int(bar["open_time"]),
                    close_time_ms=int(bar["close_time"]),
                    open=float(bar["open"]),
                    high=float(bar["high"]),
                    low=float(bar["low"]),
                    close=float(bar["close"]),
                    volume=float(bar.get("volume", 0)),
                    source=BarInputSource.BACKFILL,
                    is_closed=True,  # backfill bars are always closed
                    market_type=str(bar.get("market_type", market_type)),
                    quote_volume=float(bar.get("quote_volume", 0)),
                    trades=int(bar.get("trades", 0)),
                    taker_buy_base=float(bar.get("taker_buy_base", 0)),
                    taker_buy_quote=float(bar.get("taker_buy_quote", 0)),
                    sequence=int(bar.get("open_time", 0)),
                )
            else:
                # Duck-type: assume FetchedBar dataclass
                return BarInput(
                    symbol=symbol.upper(),
                    source_interval=getattr(bar, "interval", interval),
                    exchange=str(getattr(bar, "exchange", exchange)),
                    open_time_ms=int(getattr(bar, "open_time", 0)),
                    close_time_ms=int(getattr(bar, "close_time", 0)),
                    open=float(getattr(bar, "open", 0)),
                    high=float(getattr(bar, "high", 0)),
                    low=float(getattr(bar, "low", 0)),
                    close=float(getattr(bar, "close", 0)),
                    volume=float(getattr(bar, "volume", 0)),
                    source=BarInputSource.BACKFILL,
                    is_closed=True,
                    market_type=str(getattr(bar, "market_type", market_type)),
                    quote_volume=float(getattr(bar, "quote_volume", 0)),
                    trades=int(getattr(bar, "trades", 0)),
                    taker_buy_base=float(getattr(bar, "taker_buy_base", 0)),
                    taker_buy_quote=float(getattr(bar, "taker_buy_quote", 0)),
                    sequence=int(getattr(bar, "open_time", 0)),
                )
        except (KeyError, ValueError, TypeError, AttributeError) as exc:
            logger.warning("Failed to convert fetched bar: %s", exc)
            return None

    @staticmethod
    def _extract_exchange(event: Any) -> str:
        exchange = getattr(event, "exchange", None)
        if isinstance(exchange, str) and exchange.strip():
            return exchange.strip().lower()
        stream_key = getattr(event, "stream_key", "")
        if isinstance(stream_key, str):
            parts = [part.strip().lower() for part in stream_key.split(":") if part.strip()]
            if len(parts) >= 3:
                return parts[0]
        return "binance"

    @staticmethod
    def _extract_market_type(event: Any) -> str:
        market_type = getattr(event, "market_type", None)
        if isinstance(market_type, str) and market_type.strip():
            return market_type.strip().lower()
        stream_key = getattr(event, "stream_key", "")
        if isinstance(stream_key, str):
            parts = [part.strip().lower() for part in stream_key.split(":") if part.strip()]
            if len(parts) >= 3:
                return parts[1]
            if len(parts) == 2:
                return parts[0] or "spot"
        return "spot"
