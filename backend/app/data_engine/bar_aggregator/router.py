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

from app.data_engine.market_data.kline_metrics import declared_enhanced_fields
from app.data_engine.interval_policy import intervals_equivalent, parse_interval_spec
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolutionError,
    IntervalResolver,
    IntervalRoute,
    IntervalRouteKind,
)
from app.exchanges import bootstrap_default_adapters, get_exchange_registry

from .config import BarAggregatorConfig
from .models import (
    BarInput,
    BarInputSource,
    BarSourceMode,
    MergeMode,
    BarInputAdapter,
    parse_interval_ms,
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

    def __init__(
        self,
        config: BarAggregatorConfig,
        interval_resolver: IntervalResolver | None = None,
    ) -> None:
        self._cfg = config
        self._interval_resolver = interval_resolver or IntervalResolver()
        self._route_cache: dict[
            tuple[str, str, str, IntervalPurpose],
            IntervalRoute | IntervalResolutionError,
        ] = {}

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
        spec = parse_interval_spec(interval)
        canonical_interval = spec.canonical if spec is not None else interval
        key = (
            exchange.lower().strip(),
            market_type.lower().strip(),
            symbol.upper(),
            canonical_interval,
        )
        if key in self._targets:
            logger.debug("Target already registered: %s:%s:%s@%s", key[0], key[1], symbol, interval)
            return

        self._targets.add(key)
        for purpose in (IntervalPurpose.HISTORY, IntervalPurpose.REALTIME):
            try:
                self._route_for(key[0], key[1], key[3], purpose)
            except IntervalResolutionError:
                pass
        logger.info("Registered target: %s:%s:%s@%s", key[0], key[1], symbol, interval)

    def unregister_target(
        self,
        symbol: str,
        interval: str,
        exchange: str = "binance",
        market_type: str = "spot",
    ) -> None:
        """Remove a (symbol, interval) aggregation target."""
        spec = parse_interval_spec(interval)
        key = (
            exchange.lower().strip(),
            market_type.lower().strip(),
            symbol.upper(),
            spec.canonical if spec is not None else interval,
        )
        self._targets.discard(key)
        for purpose in (IntervalPurpose.HISTORY, IntervalPurpose.REALTIME):
            self._route_cache.pop((key[0], key[1], key[3], purpose), None)
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
            if src == interval or intervals_equivalent(src, interval):
                should_route = True
                merge_mode = MergeMode.SNAPSHOT
            
            # Rule 2: Trade ticks apply to everywhere natively
            elif src == "tick":
                should_route = True
                merge_mode = MergeMode.INCREMENTAL
                
            # Rule 3: exchange-resolved derived targets accept only their
            # exact native base, regardless of whether the target spelling is
            # globally listed as a standard interval.
            else:
                purpose = (
                    IntervalPurpose.HISTORY
                    if bar_input.source == BarInputSource.BACKFILL
                    else IntervalPurpose.REALTIME
                )
                try:
                    route = self._route_for(exchange, market_type, interval, purpose)
                except IntervalResolutionError as exc:
                    logger.warning("Interval route unavailable for %s: %s", interval, exc)
                    continue
                if (
                    route.kind is IntervalRouteKind.DERIVED
                    and route.base_interval is not None
                    and intervals_equivalent(src, route.base_interval)
                ):
                    should_route = True
                    merge_mode = MergeMode.COMPONENT

            # Rule 4: exchange policy can fan out realtime base interval
            # updates to larger standard intervals when native large-interval
            # WS channels update too slowly for active charts.
                elif (
                route.kind is IntervalRouteKind.NATIVE
                and bar_input.source == BarInputSource.REALTIME
                and self._realtime_policy(exchange).should_fanout_realtime_base(src, interval)
                ):
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

    @staticmethod
    def _realtime_policy(exchange: str):
        bootstrap_default_adapters()
        return get_exchange_registry().get_plugin(exchange).realtime_policy()

    def _route_for(
        self,
        exchange: str,
        market_type: str,
        interval: str,
        purpose: IntervalPurpose,
    ) -> IntervalRoute:
        key = (exchange, market_type, interval, purpose)
        cached = self._route_cache.get(key)
        if isinstance(cached, IntervalResolutionError):
            raise cached
        if cached is not None:
            return cached
        try:
            route = self._interval_resolver.resolve(
                exchange=exchange,
                market_type=market_type,
                interval=interval,
                purpose=purpose,
            )
        except IntervalResolutionError as exc:
            self._route_cache[key] = exc
            raise
        self._route_cache[key] = route
        return route

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
        elif source_str == "plugin" and bool(data.get("is_correction", False)):
            bar_source = BarInputSource.CORRECTION
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
            exchange = self._extract_exchange(event)
            market_type = self._extract_market_type(event)
            sequence = self._kline_freshness_sequence(event, data)
            return BarInput(
                symbol=getattr(event, "symbol", "").upper(),
                source_interval=data.get("interval", "1m"),
                exchange=exchange,
                open_time_ms=int(data["open_time"]),
                close_time_ms=int(data["close_time"]),
                open=float(data["open"]),
                high=float(data["high"]),
                low=float(data["low"]),
                close=float(data["close"]),
                volume=float(data.get("volume", 0)),
                source=source,
                is_closed=bool(data.get("is_closed", False)),
                market_type=market_type,
                quote_volume=float(data.get("quote_volume", 0)),
                trades=int(data.get("trades", 0)),
                taker_buy_base=float(data.get("taker_buy_base", 0)),
                taker_buy_quote=float(data.get("taker_buy_quote", 0)),
                enhanced_fields=declared_enhanced_fields(
                    exchange,
                    market_type,
                    data,
                ),
                sequence=sequence,
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
                resolved_exchange = str(bar.get("exchange", exchange))
                resolved_market_type = str(bar.get("market_type", market_type))
                explicit_fields = bar.get("enhanced_fields")
                if isinstance(explicit_fields, (str, bytes, dict)):
                    explicit_fields = ()
                return BarInput(
                    symbol=symbol.upper(),
                    source_interval=interval,
                    exchange=resolved_exchange,
                    open_time_ms=int(bar["open_time"]),
                    close_time_ms=int(bar["close_time"]),
                    open=float(bar["open"]),
                    high=float(bar["high"]),
                    low=float(bar["low"]),
                    close=float(bar["close"]),
                    volume=float(bar.get("volume", 0)),
                    source=BarInputSource.BACKFILL,
                    # Persisted backfill rows omit this field and remain
                    # closed by default. Custom read aggregation can also pass
                    # the live forming tail through this batch adapter.
                    is_closed=bool(bar.get("is_closed", True)),
                    market_type=resolved_market_type,
                    quote_volume=float(bar.get("quote_volume") or 0),
                    trades=int(bar.get("trades") or 0),
                    taker_buy_base=float(bar.get("taker_buy_base") or 0),
                    taker_buy_quote=float(bar.get("taker_buy_quote") or 0),
                    enhanced_fields=declared_enhanced_fields(
                        resolved_exchange,
                        resolved_market_type,
                        bar,
                        explicit_fields=explicit_fields,
                    ),
                    sequence=self._fetched_bar_freshness_sequence(bar),
                )
            else:
                # Duck-type: assume FetchedBar dataclass
                resolved_exchange = str(getattr(bar, "exchange", exchange))
                resolved_market_type = str(getattr(bar, "market_type", market_type))
                enhanced_values = {
                    "volume": getattr(bar, "volume", None),
                    "quote_volume": getattr(bar, "quote_volume", None),
                    "trades": getattr(bar, "trades", None),
                    "taker_buy_base": getattr(bar, "taker_buy_base", None),
                    "taker_buy_quote": getattr(bar, "taker_buy_quote", None),
                }
                return BarInput(
                    symbol=symbol.upper(),
                    source_interval=getattr(bar, "interval", interval),
                    exchange=resolved_exchange,
                    open_time_ms=int(getattr(bar, "open_time", 0)),
                    close_time_ms=int(getattr(bar, "close_time", 0)),
                    open=float(getattr(bar, "open", 0)),
                    high=float(getattr(bar, "high", 0)),
                    low=float(getattr(bar, "low", 0)),
                    close=float(getattr(bar, "close", 0)),
                    volume=float(getattr(bar, "volume", 0)),
                    source=BarInputSource.BACKFILL,
                    is_closed=bool(getattr(bar, "is_closed", True)),
                    market_type=resolved_market_type,
                    quote_volume=float(getattr(bar, "quote_volume", 0)),
                    trades=int(getattr(bar, "trades", 0)),
                    taker_buy_base=float(getattr(bar, "taker_buy_base", 0)),
                    taker_buy_quote=float(getattr(bar, "taker_buy_quote", 0)),
                    enhanced_fields=declared_enhanced_fields(
                        resolved_exchange,
                        resolved_market_type,
                        enhanced_values,
                        explicit_fields=getattr(bar, "enhanced_fields", None),
                    ),
                    sequence=self._fetched_bar_freshness_sequence(bar),
                )
        except (KeyError, ValueError, TypeError, AttributeError) as exc:
            logger.warning("Failed to convert fetched bar: %s", exc)
            return None

    @staticmethod
    def _kline_freshness_sequence(event: Any, data: dict) -> int | None:
        """Extract an update sequence, never substituting component identity.

        Normalizers historically expose a kline's ``open_time`` as
        ``MarketEvent.sequence``.  That value is useful for deduplication of
        closed bars but cannot order cumulative updates for the same bar.
        Prefer a distinct exchange sequence, then a distinct exchange event
        timestamp.  When neither exists, the state engine will require
        monotonic cumulative evidence before replacing the component.
        """
        open_time_ms = int(data.get("open_time", 0))
        for value in (
            data.get("update_id"),
            data.get("last_update_id"),
            data.get("sequence"),
            getattr(event, "sequence", None),
        ):
            if value is None:
                continue
            sequence = int(value)
            if sequence > 0 and sequence != open_time_ms:
                return sequence

        event_time_ms = getattr(event, "event_time_ms", None)
        if event_time_ms is not None:
            sequence = int(event_time_ms)
            if sequence > 0 and sequence != open_time_ms:
                return sequence
        return None

    @staticmethod
    def _fetched_bar_freshness_sequence(bar: Any) -> int | None:
        """Return explicit fetched-row freshness metadata when available."""
        if isinstance(bar, dict):
            values = (
                bar.get("sequence"),
                bar.get("event_time_ms"),
                bar.get("updated_at_ms"),
            )
            open_time_ms = int(bar.get("open_time", 0))
        else:
            values = (
                getattr(bar, "sequence", None),
                getattr(bar, "event_time_ms", None),
                getattr(bar, "updated_at_ms", None),
            )
            open_time_ms = int(getattr(bar, "open_time", 0))
        for value in values:
            if value is None:
                continue
            sequence = int(value)
            if sequence > 0 and sequence != open_time_ms:
                return sequence
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
