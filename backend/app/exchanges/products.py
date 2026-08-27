"""Capability-driven product projections for public exchange data.

Adapter capabilities describe transport primitives.  Product projections keep
the stronger UI/runtime contracts in one place so a generic CCXT snapshot is
never mistaken for sequence-consistent full depth, and an unsequenced trade
feed is never mistaken for repairable aggregate-trade flow.
"""

from __future__ import annotations

from typing import Any

from app.data_engine.market_data.models import (
    DeliveryClass,
    MarketChannel,
    TransportMode,
)


_LIVE_TRANSPORTS = (
    TransportMode.WEBSOCKET,
    TransportMode.PLUGIN_STREAM,
)

_SNAPSHOT_BOOK_LIVE = "live_snapshot"
_SNAPSHOT_BOOK_POLLING = "polling_snapshot"

_ADVANCED_STATE_CHANNELS = (
    MarketChannel.MARK_PRICE,
    MarketChannel.INDEX_PRICE,
    MarketChannel.FUNDING_RATE,
    MarketChannel.OPEN_INTEREST,
)
_ADVANCED_PRODUCT_CHANNELS = (*_ADVANCED_STATE_CHANNELS, MarketChannel.LIQUIDATION)


def _live_capability(capabilities: Any, channel: MarketChannel, market_type: str) -> Any:
    capability = capabilities.channel_capability(channel, market_type)
    if capability is None or not capability.realtime:
        return None
    if not any(capability.supports_transport(mode) for mode in _LIVE_TRANSPORTS):
        return None
    return capability


def supports_snapshot_order_book(capabilities: Any, market_type: str) -> bool:
    """Return whether the product can receive bounded replaceable depth."""

    return snapshot_order_book_mode(capabilities, market_type) is not None


def snapshot_order_book_mode(capabilities: Any, market_type: str) -> str | None:
    """Return the strongest bounded-snapshot transport the product can use.

    Streaming snapshots are preferred when both transports exist.  A REST
    snapshot remains a supported product, but is explicitly projected as
    polling so callers cannot mistake it for a continuously pushed feed.
    """

    capability = capabilities.channel_capability(MarketChannel.DEPTH, market_type)
    if (
        capability is None
        or not capability.realtime
        or capability.delivery is not DeliveryClass.SNAPSHOT
        or not capability.snapshot
    ):
        return None
    if any(capability.supports_transport(mode) for mode in _LIVE_TRANSPORTS):
        return _SNAPSHOT_BOOK_LIVE
    if capability.supports_transport(TransportMode.REST_SNAPSHOT):
        return _SNAPSHOT_BOOK_POLLING
    return None


def supports_strict_full_order_book(capabilities: Any, market_type: str) -> bool:
    """Return whether strict snapshot + ordered-delta reconstruction is valid."""

    capability = _live_capability(capabilities, MarketChannel.FULL_DEPTH, market_type)
    return bool(
        capability is not None
        and capability.delivery is DeliveryClass.ORDERED_DELTA
        and capability.snapshot
        and capability.delta
        and capability.sequence not in {"", "none"}
        and capability.resync == "replace_snapshot"
        and capability.supports_transport(TransportMode.REST_SNAPSHOT)
    )


def supports_strict_trade_flow(capabilities: Any, market_type: str) -> bool:
    """Return whether append flow has exact ID repair semantics."""

    capability = _live_capability(capabilities, MarketChannel.AGG_TRADE, market_type)
    return bool(
        capability is not None
        and capability.history
        and capability.delivery is DeliveryClass.APPEND
        and capability.sequence == "monotonic_id"
        and capability.resync == "snapshot_replay"
        and capability.supports_transport(
            TransportMode.REST_HISTORY,
            history=True,
        )
    )


def supports_observational_trade_tape(capabilities: Any, market_type: str) -> bool:
    """Return whether locally observed unified trades can reach the tape.

    REST polling is deliberately accepted as an observational product.  It is
    deduplicated locally, but never promoted to a complete or gap-repairable
    exchange trade sequence.
    """

    return observational_trade_delivery_mode(capabilities, market_type) is not None


def observational_trade_delivery_mode(
    capabilities: Any,
    market_type: str,
) -> str | None:
    """Return live-stream or polling semantics for the observational tape."""

    capability = capabilities.channel_capability(MarketChannel.TRADE, market_type)
    if capability is None or not capability.realtime:
        return None
    if capability.delivery is not DeliveryClass.APPEND:
        return None
    if any(capability.supports_transport(mode) for mode in _LIVE_TRANSPORTS):
        return "live_stream"
    if capability.supports_transport(TransportMode.REST_POLL):
        return "polling_observational"
    return None


def liquidation_delivery_mode(capabilities: Any, market_type: str) -> str | None:
    """Return the strongest honest public-liquidation observation mode."""

    capability = capabilities.channel_capability(
        MarketChannel.LIQUIDATION,
        market_type,
    )
    if (
        capability is None
        or not capability.realtime
        or capability.delivery is not DeliveryClass.APPEND
        or capability.sequence != "none"
    ):
        return None
    if any(capability.supports_transport(mode) for mode in _LIVE_TRANSPORTS):
        return "live_observational"
    if capability.supports_transport(TransportMode.REST_POLL):
        return "polling_observational"
    return None


def _state_delivery_mode(capability: Any) -> str | None:
    if capability is None:
        return None
    if (
        capability.realtime
        and capability.delivery is DeliveryClass.LATEST
        and capability.snapshot
    ):
        if any(capability.supports_transport(mode) for mode in _LIVE_TRANSPORTS):
            return "live_snapshot"
        if capability.supports_transport(TransportMode.REST_POLL):
            return "polling_snapshot"
    return "history_only" if capability.history else None


def _advanced_channel_product(
    capabilities: Any,
    channel: MarketChannel,
    market_type: str,
) -> dict[str, Any]:
    capability = capabilities.channel_capability(channel, market_type)
    delivery_mode = (
        liquidation_delivery_mode(capabilities, market_type)
        if channel is MarketChannel.LIQUIDATION
        else _state_delivery_mode(capability)
    )
    return {
        "supported": delivery_mode is not None,
        "realtime": bool(capability is not None and capability.realtime),
        "history": bool(capability is not None and capability.history),
        "delivery_mode": delivery_mode,
    }


def serialize_advanced_market_support(
    capabilities: Any,
    market_type: str,
) -> dict[str, Any]:
    """Project all advanced public-data channels into product semantics."""

    channels = {
        channel.value: _advanced_channel_product(
            capabilities,
            channel,
            market_type,
        )
        for channel in _ADVANCED_PRODUCT_CHANNELS
    }
    mark = channels[MarketChannel.MARK_PRICE.value]
    index = channels[MarketChannel.INDEX_PRICE.value]
    basis_realtime = bool(
        mark["supported"]
        and index["supported"]
        and mark["realtime"]
        and index["realtime"]
    )
    basis_mode = None
    if basis_realtime:
        basis_mode = (
            "derived_live"
            if mark["delivery_mode"] == index["delivery_mode"] == "live_snapshot"
            else "derived_polling"
        )
    channels[MarketChannel.BASIS.value] = {
        "supported": basis_realtime,
        "realtime": basis_realtime,
        "history": False,
        "delivery_mode": basis_mode,
    }
    return {
        "supported": any(item["supported"] for item in channels.values()),
        "channels": channels,
    }


def preferred_trade_channel(capabilities: Any, market_type: str) -> MarketChannel | None:
    """Prefer repairable aggregate trades, falling back to observational trades."""

    if supports_strict_trade_flow(capabilities, market_type):
        return MarketChannel.AGG_TRADE
    if supports_observational_trade_tape(capabilities, market_type):
        return MarketChannel.TRADE
    return None


def serialize_product_support(capabilities: Any) -> dict[str, Any]:
    """Project primitive channel capabilities into honest per-market products."""

    markets: dict[str, dict[str, Any]] = {}
    for market in tuple(getattr(capabilities, "markets", ()) or ()):
        market_type = str(getattr(market, "market_type", "")).strip().lower()
        if not market_type or market_type in markets:
            continue
        kline = capabilities.channel_capability(MarketChannel.KLINE, market_type)
        trade_channel = preferred_trade_channel(capabilities, market_type)
        strict_trade = trade_channel is MarketChannel.AGG_TRADE
        observational_delivery = observational_trade_delivery_mode(
            capabilities,
            market_type,
        )
        snapshot_mode = snapshot_order_book_mode(capabilities, market_type)
        snapshot_book = snapshot_mode is not None
        strict_book = supports_strict_full_order_book(capabilities, market_type)
        markets[market_type] = {
            "chart": bool(kline is not None and (kline.realtime or kline.history)),
            "order_book": {
                "supported": snapshot_book,
                "channel": MarketChannel.DEPTH.value if snapshot_book else None,
                "mode": "snapshot" if snapshot_book else None,
                "snapshot_mode": snapshot_mode,
                "strict_full_depth": strict_book,
            },
            "trade_flow": {
                "supported": trade_channel is not None,
                "channel": trade_channel.value if trade_channel is not None else None,
                "mode": (
                    "strict_repairable"
                    if strict_trade
                    else "observational"
                    if trade_channel is not None
                    else None
                ),
                "sequence_continuity": strict_trade,
                "history": strict_trade,
                "delivery_mode": (
                    "live_stream" if strict_trade else observational_delivery
                ),
            },
            "advanced_market_data": serialize_advanced_market_support(
                capabilities,
                market_type,
            ),
        }
    return {"markets": markets}


__all__ = [
    "preferred_trade_channel",
    "liquidation_delivery_mode",
    "observational_trade_delivery_mode",
    "serialize_advanced_market_support",
    "serialize_product_support",
    "snapshot_order_book_mode",
    "supports_observational_trade_tape",
    "supports_snapshot_order_book",
    "supports_strict_full_order_book",
    "supports_strict_trade_flow",
]
