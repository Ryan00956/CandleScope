"""The sole Phase 6 adapter from public plugin contracts to DataManager."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    BarsReadRequest,
    BarsSubscribeRequest,
    OrderBookReadRequest,
    SymbolsReadRequest,
    TradesReadRequest,
)

from app.api.v1.order_book import (
    ALLOWED_DEPTH_LEVELS,
    ALLOWED_UPDATE_INTERVALS_BY_MARKET,
    DEFAULT_UPDATE_INTERVAL_MS_BY_MARKET,
    cached_price_tick_size,
    serialize_record,
)
from app.api.v1.symbols import list_cached_symbols
from app.data_engine.data_manager.models import DataEventType
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey

from .ports import BarEventCallback, PortBarSubscription
from .projections import (
    project_trade_history_payload,
    project_trade_recent_payload,
    wrap_order_book,
    wrap_trades,
)


class DataManagerConsumerPort:
    """Narrow facade preserving DataManager ownership and stream leases."""

    def __init__(self, data_manager: Any) -> None:
        self.data_manager = data_manager

    async def list_symbols(
        self, request: SymbolsReadRequest
    ) -> tuple[list[dict[str, Any]], float]:
        return await asyncio.to_thread(
            list_cached_symbols,
            request.context.exchange,
            request.context.market_type,
        )

    async def read_bars(self, request: BarsReadRequest) -> Any:
        return await asyncio.to_thread(
            self.data_manager.query,
            request.series.symbol,
            request.series.interval,
            request.start_ms,
            request.end_ms,
            request.limit,
            request.context.exchange,
            request.context.market_type,
            True,
            "plugin_history",
            "plugin-platform-v2",
        )

    async def subscribe_bars(
        self,
        request: BarsSubscribeRequest,
        *,
        consumer_id: str,
        callback: BarEventCallback,
    ) -> PortBarSubscription:
        handle = self.data_manager.subscribe(
            callback,
            request.series.symbol,
            request.series.interval,
            exchange=request.context.exchange,
            market_type=request.context.market_type,
            event_types={
                DataEventType.BAR_CREATED,
                DataEventType.BAR_UPDATED,
                DataEventType.BAR_CLOSED,
                DataEventType.BAR_AMENDED,
            },
        )
        subscription = PortBarSubscription(handle, consumer_id, request)
        try:
            await self.data_manager.ensure_stream(
                request.series.symbol,
                request.series.interval,
                exchange=request.context.exchange,
                market_type=request.context.market_type,
                focus_scope="background",
                consumer_id=consumer_id,
            )
        except BaseException:
            self.data_manager.unsubscribe(handle)
            raise
        return subscription

    async def unsubscribe_bars(self, subscription: PortBarSubscription) -> None:
        self.data_manager.unsubscribe(subscription.handle)
        request = subscription.request
        await self.data_manager.release_stream(
            request.series.symbol,
            request.series.interval,
            exchange=request.context.exchange,
            market_type=request.context.market_type,
            focus_scope="background",
            consumer_id=subscription.consumer_id,
        )

    @staticmethod
    def _trade_key(request: TradesReadRequest) -> MarketStreamKey:
        return MarketStreamKey.build(
            request.context.exchange,
            request.context.market_type,
            request.symbol,
            MarketChannel.AGG_TRADE,
        )

    async def read_trades(self, request: TradesReadRequest) -> dict[str, Any]:
        key = self._trade_key(request)
        if request.kind == "recent":
            records = self.data_manager.trade_flow_recent(key, limit=request.limit)
            payload = project_trade_recent_payload(key, list(records))
        else:
            records = await self.data_manager.trade_flow_history(
                key,
                start_ms=request.start_ms,
                end_ms=request.end_ms,
                limit=request.limit,
            )
            payload = project_trade_history_payload(
                key, list(records), limit=request.limit
            )
        return wrap_trades(request.context, payload)

    @staticmethod
    def _order_book_key(request: OrderBookReadRequest) -> MarketStreamKey:
        context = request.context
        if (
            context.exchange != "binance"
            or context.market_type not in ALLOWED_UPDATE_INTERVALS_BY_MARKET
        ):
            raise ValueError(
                "partial order books currently support binance spot and futures only"
            )
        if request.depth_levels not in ALLOWED_DEPTH_LEVELS:
            raise ValueError("depthLevels must be one of 5, 10, or 20")
        update_interval = (
            DEFAULT_UPDATE_INTERVAL_MS_BY_MARKET[context.market_type]
            if request.update_interval_ms is None
            else request.update_interval_ms
        )
        if (
            update_interval
            not in ALLOWED_UPDATE_INTERVALS_BY_MARKET[context.market_type]
        ):
            raise ValueError("updateIntervalMs is unsupported for this market")
        return MarketStreamKey.build(
            context.exchange,
            context.market_type,
            request.symbol,
            MarketChannel.DEPTH,
            params={
                "mode": "partial",
                "depth_levels": request.depth_levels,
                "update_interval_ms": update_interval,
            },
        )

    async def read_order_book(
        self, request: OrderBookReadRequest, *, consumer_id: str
    ) -> dict[str, Any]:
        key = self._order_book_key(request)
        leased = False
        try:
            await self.data_manager.ensure_order_book_stream(
                key, consumer_id=consumer_id
            )
            leased = True
            record = await self.data_manager.wait_for_order_book_snapshot(
                key, timeout_seconds=request.wait_ms / 1_000
            )
        finally:
            if leased:
                with suppress(Exception):
                    await self.data_manager.release_order_book_stream(
                        key, consumer_id=consumer_id
                    )
        payload = {
            "type": "order_book.snapshot",
            "protocol": "orderbook.v1",
            "delivery": "latest_snapshot",
            "full_depth": False,
            "backfillable": False,
            "persisted": False,
            "data": serialize_record(
                record, price_tick_size=cached_price_tick_size(key)
            ),
        }
        return wrap_order_book(request.context, payload)


__all__ = ["DataManagerConsumerPort"]
