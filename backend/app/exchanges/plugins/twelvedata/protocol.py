from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.data_engine.ingestion.models import StreamType
from app.exchanges.protocol import RestRequestSpec, WsConnectionSpec
from app.exchanges.ws_protocol import WsSubscriptionMode, WsSubscriptionSpec

from .adapter import (
    ALL_INTERVALS,
    DAILY_INTERVALS,
    TwelveDataConfigurationError,
    twelve_data_auth_headers,
)
from .identity import SUPPORTED_MARKET_TYPES


_INTERVALS = {
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "45m": "45min",
    "1h": "1h",
    "2h": "2h",
    "4h": "4h",
    "8h": "8h",
    "1d": "1day",
    "1w": "1week",
    "1M": "1month",
}


def _utc_datetime(value_ms: int) -> str:
    return datetime.fromtimestamp(int(value_ms) / 1000, timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )


class TwelveDataExchangeProtocol:
    def rest_request(self, req: Any, config: Any | None = None) -> RestRequestSpec | None:
        descriptor = req.descriptor
        if descriptor.stream_type == StreamType.TICKER:
            market_type = str(descriptor.market_type or "").strip().lower()
            if market_type not in {"stock", "etf", "forex", "commodity"}:
                raise ValueError(
                    f"unsupported Twelve Data ticker market type: {market_type!r}"
                )
            return RestRequestSpec(
                base_urls=list(
                    getattr(config, "twelve_data_http_base_urls", None)
                    or ["https://api.twelvedata.com"]
                ),
                path="/quote",
                params={
                    "symbol": descriptor.symbol,
                    "dp": 11,
                    "prepost": "false",
                },
                headers=twelve_data_auth_headers(config),
                method="GET",
                weight=1,
            )
        if descriptor.stream_type != StreamType.KLINE:
            return None
        market_type = str(descriptor.market_type or "").strip().lower()
        if market_type not in SUPPORTED_MARKET_TYPES:
            raise ValueError(f"unsupported Twelve Data market type: {market_type!r}")
        interval = str(descriptor.interval or "")
        provider_interval = _INTERVALS.get(interval)
        if provider_interval is None:
            raise ValueError(f"unsupported Twelve Data interval: {interval!r}")
        if interval not in ALL_INTERVALS:
            raise ValueError(f"unsupported Twelve Data interval: {interval!r}")
        if market_type == "index" and interval not in DAILY_INTERVALS:
            raise ValueError(
                "Twelve Data integration limits index history "
                "to daily or coarser intervals"
            )

        base_urls = list(
            getattr(config, "twelve_data_http_base_urls", None)
            or ["https://api.twelvedata.com"]
        )
        params: dict[str, Any] = {
            "symbol": descriptor.symbol,
            "interval": provider_interval,
            "order": "ASC",
            "timezone": "UTC",
            "format": "JSON",
            "dp": 11,
            # Twelve Data defaults daily+ equity data to split adjustment.
            # M1 stores only the explicitly raw series identity.
            "adjust": "none",
            "outputsize": min(5000, max(1, int(req.limit or 1))),
        }
        if market_type in {"stock", "etf"} and interval not in DAILY_INTERVALS:
            # Basic includes US regular-session intraday data.  Extended hours
            # are a separate entitlement and a different durable series.
            params["prepost"] = "false"
        if req.start_ms is not None:
            params["start_date"] = _utc_datetime(req.start_ms)
        if req.end_ms is not None:
            params["end_date"] = _utc_datetime(req.end_ms)
        return RestRequestSpec(
            base_urls=base_urls,
            path="/time_series",
            params=params,
            headers=twelve_data_auth_headers(config),
            method="GET",
            weight=1,
        )

    def extract_http_rows(self, payload: Any, descriptor: Any) -> list[Any]:
        if not isinstance(payload, dict):
            raise ValueError("Twelve Data response must be an object")
        if payload.get("status") == "error":
            raise TwelveDataConfigurationError(
                str(payload.get("message") or "Twelve Data request failed")
            )
        if getattr(descriptor, "stream_type", None) == StreamType.TICKER:
            if payload.get("close") in (None, "") and payload.get("price") in (None, ""):
                raise ValueError("Twelve Data quote response omitted the latest price")
            return [payload]
        values = payload.get("values")
        if values is None:
            return []
        if not isinstance(values, list):
            raise ValueError("Twelve Data values must be an array")
        meta = dict(payload.get("meta") or {}) if isinstance(payload.get("meta"), dict) else {}
        rows: list[dict[str, Any]] = []
        for value in values:
            if not isinstance(value, dict):
                continue
            rows.append({**value, "_twelve_data_meta": meta})
        return rows

    def ws_connection(self, descriptor: Any, config: Any | None = None) -> WsConnectionSpec:
        del descriptor, config
        return WsConnectionSpec(
            base_urls=[],
            subscription=WsSubscriptionSpec(mode=WsSubscriptionMode.PATH),
        )

    def rest_base_urls(self, market_type: str = "stock", config: Any | None = None) -> list[str]:
        del market_type
        return list(
            getattr(config, "twelve_data_http_base_urls", None)
            or ["https://api.twelvedata.com"]
        )

    def ws_base_urls(self, descriptor: Any, config: Any | None = None) -> list[str]:
        del descriptor, config
        return []

    def rest_path(self, stream_type: Any, market_type: str = "stock") -> str | None:
        del market_type
        if stream_type == StreamType.KLINE:
            return "/time_series"
        if stream_type == StreamType.TICKER:
            return "/quote"
        return None

    def build_http_params(self, req: Any) -> dict[str, Any]:
        spec = self.rest_request(req)
        return dict(spec.params) if spec is not None else {}

    def build_ws_subscription(self, descriptor: Any) -> WsSubscriptionSpec:
        del descriptor
        return WsSubscriptionSpec(mode=WsSubscriptionMode.PATH)

    def build_combined_subscribe(self, descriptors: list[Any]) -> dict[str, Any]:
        del descriptors
        return {}

    def payload_matches_descriptor(self, payload: Any, descriptor: Any) -> bool:
        del payload, descriptor
        return False

    @staticmethod
    def sanitize_http_urls(urls: list[str]) -> list[str]:
        return list(dict.fromkeys(url.rstrip("/") for url in urls if url))

    @staticmethod
    def sanitize_ws_urls(urls: list[str]) -> list[str]:
        del urls
        return []


__all__ = ["TwelveDataExchangeProtocol"]
