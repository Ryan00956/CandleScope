from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import MarketEvent, RawMessage, StreamDescriptor, StreamType
from app.data_engine.interval_policy import parse_interval_spec


logger = logging.getLogger("ingestion.normalizers.twelvedata")


def _parse_open_time_ms(value: object) -> int:
    text = str(value or "").strip()
    if not text:
        raise ValueError("missing Twelve Data datetime")
    # The provider ignores timezone=UTC for daily and coarser bars and returns
    # an exchange-local calendar date. M1 deliberately stores that provider
    # date at UTC midnight so daily identities remain stable across venues.
    if len(text) == 10:
        parsed = datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    else:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        else:
            parsed = parsed.astimezone(timezone.utc)
    return int(parsed.timestamp() * 1000)


def _finite_float(value: object, field_name: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError(f"non-finite Twelve Data {field_name}")
    return parsed


class TwelveDataNormalizer:
    def __init__(self, config: IngestionConfig, descriptor: StreamDescriptor) -> None:
        self._cfg = config
        self._descriptor = descriptor
        self._ticker_seed: dict[str, float] = {}

    def parse(self, msg: RawMessage) -> MarketEvent | None:
        if msg.stream_type == StreamType.TICKER:
            return self._parse_ticker(msg)
        if msg.stream_type != StreamType.KLINE:
            return None
        row = msg.payload
        if not isinstance(row, dict):
            return None
        try:
            interval = str(self._descriptor.interval or "")
            spec = parse_interval_spec(interval)
            if spec is None:
                raise ValueError(f"unsupported interval: {interval!r}")
            open_time = _parse_open_time_ms(row.get("datetime"))
            close_time = spec.next_ms(open_time) - 1
            market_type = str(self._descriptor.market_type or "").strip().lower()
            volume_value = row.get("volume")
            volume_available = volume_value not in (None, "")
            if market_type in {"stock", "etf"} and not volume_available:
                raise ValueError(
                    f"Twelve Data {market_type} row omitted required share volume"
                )
            volume = (
                _finite_float(volume_value, "volume")
                if volume_available
                else 0.0
            )
            data = {
                "interval": interval,
                "open_time": open_time,
                "close_time": close_time,
                "open": _finite_float(row.get("open"), "open"),
                "high": _finite_float(row.get("high"), "high"),
                "low": _finite_float(row.get("low"), "low"),
                "close": _finite_float(row.get("close"), "close"),
                "volume": volume,
                "volume_available": volume_available,
                "is_closed": True,
                "provider_meta": dict(row.get("_twelve_data_meta") or {}),
            }
        except (TypeError, ValueError) as exc:
            logger.warning("Rejected Twelve Data K-line row: %s", exc)
            return None

        return MarketEvent(
            event_type=StreamType.KLINE,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=open_time,
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=open_time,
            market_type=self._descriptor.market_type,
        )

    def _parse_ticker(self, msg: RawMessage) -> MarketEvent | None:
        row = msg.payload
        if not isinstance(row, dict):
            return None
        try:
            price_value = row.get("price", row.get("close"))
            last_price = _finite_float(price_value, "price")
            timestamp_value = row.get("timestamp")
            if timestamp_value in (None, ""):
                event_time_ms = int(msg.received_at_ms)
            else:
                timestamp = _finite_float(timestamp_value, "timestamp")
                event_time_ms = int(timestamp * 1000 if timestamp < 1_000_000_000_000 else timestamp)

            for source_name, target_name in (
                ("open", "open_price"),
                ("high", "high_price"),
                ("low", "low_price"),
                ("previous_close", "previous_close"),
                ("percent_change", "price_change_pct"),
            ):
                value = row.get(source_name)
                if value not in (None, ""):
                    self._ticker_seed[target_name] = _finite_float(value, source_name)

            market_type = str(self._descriptor.market_type or "").strip().lower()
            volume_value = row.get("day_volume", row.get("volume"))
            volume_available = (
                market_type in {"stock", "etf"}
                and volume_value not in (None, "")
            )
            if volume_available:
                self._ticker_seed["volume"] = _finite_float(volume_value, "volume")

            open_price = self._ticker_seed.get("open_price", 0.0)
            high_price = self._ticker_seed.get("high_price", last_price)
            low_price = self._ticker_seed.get("low_price", last_price)
            high_price = max(high_price, last_price)
            low_price = min(low_price, last_price) if low_price > 0 else last_price
            self._ticker_seed["high_price"] = high_price
            self._ticker_seed["low_price"] = low_price
            change_pct = self._ticker_seed.get("price_change_pct")
            if change_pct is None:
                change_pct = (
                    ((last_price - open_price) / open_price) * 100
                    if open_price > 0
                    else 0.0
                )
            data = {
                "last_price": last_price,
                "close_price": last_price,
                "open_price": open_price,
                "high_price": high_price,
                "low_price": low_price,
                "price_change_pct": change_pct,
                "volume": self._ticker_seed.get("volume", 0.0),
                "volume_available": volume_available or "volume" in self._ticker_seed,
                "quote_volume": 0.0,
                "quote_volume_available": False,
                "provider_meta": {
                    "event": row.get("event"),
                    "exchange": row.get("exchange"),
                    "currency": row.get("currency"),
                    "type": row.get("type"),
                    "ws_generation": row.get("_twelve_data_ws_generation"),
                    "snapshot_generation": row.get("_twelve_data_snapshot_generation"),
                },
            }
        except (TypeError, ValueError) as exc:
            logger.warning("Rejected Twelve Data ticker row: %s", exc)
            return None

        return MarketEvent(
            event_type=StreamType.TICKER,
            symbol=self._descriptor.symbol,
            exchange=self._descriptor.exchange,
            event_time_ms=event_time_ms,
            received_at_ms=msg.received_at_ms,
            source=msg.source,
            data=data,
            stream_key=self._descriptor.key,
            sequence=event_time_ms,
            market_type=self._descriptor.market_type,
        )


__all__ = ["TwelveDataNormalizer"]
