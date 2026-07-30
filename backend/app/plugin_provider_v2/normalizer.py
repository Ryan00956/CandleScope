"""Normalize Host-validated provider payloads into the existing Data Engine schema."""

from __future__ import annotations

from typing import Any

from app.data_engine.ingestion.models import (
    MarketEvent,
    RawMessage,
    StreamDescriptor,
    StreamType,
)


class ProviderNormalizer:
    """Map canonical provider DTOs without introducing a parallel storage path."""

    def __init__(self, descriptor: StreamDescriptor) -> None:
        self._descriptor = descriptor

    def parse(self, msg: RawMessage) -> MarketEvent | None:
        envelope = msg.payload
        if not isinstance(envelope, dict):
            raise ValueError("provider message must be an object")
        payload = envelope.get("payload")
        quality = envelope.get("sourceQuality")
        event_type = envelope.get("eventType", "")
        if not isinstance(payload, dict) or not isinstance(quality, dict):
            raise ValueError("provider message is missing its canonical envelope")
        if self._descriptor.stream_type == StreamType.KLINE:
            return self._parse_bar(payload, quality, str(event_type), msg)
        if self._descriptor.stream_type == StreamType.FULL_DEPTH:
            return self._parse_book(payload, quality, str(event_type), msg)
        raise ValueError("provider stream type is unsupported")

    def _parse_bar(
        self,
        payload: dict[str, Any],
        quality: dict[str, Any],
        event_type: str,
        msg: RawMessage,
    ) -> MarketEvent:
        finality = str(payload["finality"])
        is_correction = finality == "corrected" or event_type == "bar.amended"
        provider_sequence = (
            msg.payload.get("providerSequence")
            if isinstance(msg.payload, dict)
            else None
        )
        data = {
            "open_time": int(payload["openTimeMs"]),
            "close_time": int(payload["closeTimeMs"]),
            "open": float(payload["open"]),
            "high": float(payload["high"]),
            "low": float(payload["low"]),
            "close": float(payload["close"]),
            "volume": float(payload["volume"]),
            "quote_volume": float(payload.get("quoteVolume", 0.0)),
            "trades": int(payload.get("trades", 0)),
            "taker_buy_base": float(payload.get("takerBuyBase", 0.0)),
            "taker_buy_quote": float(payload.get("takerBuyQuote", 0.0)),
            "is_closed": finality in {"final", "corrected"},
            "is_correction": is_correction,
            "finality": finality,
            "interval": self._descriptor.interval,
            "source_quality": dict(quality),
        }
        return MarketEvent(
            event_type=StreamType.KLINE,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=int(payload.get("eventTimeMs", payload["closeTimeMs"])),
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=(
                int(provider_sequence)
                if provider_sequence is not None
                else int(payload["sequence"])
                if payload.get("sequence") is not None
                else None
            ),
            market_type=self._descriptor.market_type,
        )

    def _parse_book(
        self,
        payload: dict[str, Any],
        quality: dict[str, Any],
        event_type: str,
        msg: RawMessage,
    ) -> MarketEvent:
        snapshot = (
            event_type == "orderbook.snapshot" or payload.get("kind") == "snapshot"
        )
        if snapshot:
            sequence = int(payload["lastUpdateId"])
            data = {
                "kind": "snapshot",
                "last_update_id": sequence,
                "first_update_id": None,
                "final_update_id": sequence,
                "previous_final_update_id": None,
            }
        else:
            sequence = int(payload["finalUpdateId"])
            data = {
                "kind": "delta",
                "last_update_id": None,
                "first_update_id": int(payload["firstUpdateId"]),
                "final_update_id": sequence,
                "previous_final_update_id": int(payload["previousFinalUpdateId"]),
            }
        data.update(
            {
                "bids": [
                    [float(price), float(quantity)]
                    for price, quantity in payload["bids"]
                ],
                "asks": [
                    [float(price), float(quantity)]
                    for price, quantity in payload["asks"]
                ],
                "update_interval_ms": payload.get("updateIntervalMs"),
                "source_quality": dict(quality),
            }
        )
        return MarketEvent(
            event_type=StreamType.FULL_DEPTH,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=int(payload["eventTimeMs"]),
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=sequence,
            market_type=self._descriptor.market_type,
        )
