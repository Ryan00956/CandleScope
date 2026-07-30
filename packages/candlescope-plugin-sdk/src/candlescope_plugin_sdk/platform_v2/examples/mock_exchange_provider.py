"""Credential-free reference market-data provider for Phase 10."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from importlib.resources import files
from typing import Any

from ..errors import PlatformContractError
from ..json_codec import loads_strict
from ..models import ActivationRequest, InvokeRequest, PluginManifest, RuntimeDescriptor
from ..provider import (
    PROVIDER_HISTORY_PAGE_V1,
    PROVIDER_STREAM_BATCH_V1,
    PROVIDER_STREAM_CLOSE_V1,
    PROVIDER_STREAM_OPEN_V1,
    PROVIDER_SYMBOLS_PAGE_V1,
    ProviderHistoryRequest,
    ProviderStreamCloseRequest,
    ProviderStreamDescriptor,
    ProviderStreamOpenRequest,
    ProviderStreamPollRequest,
    ProviderSymbolsRequest,
    parse_provider_operation,
)
from ..runtime import BasePlatformPlugin, InvocationOutcome
from ..server import serve_platform_plugin
from ..models import descriptor_from_manifest


_QUALITY = {
    "quality": "synthetic",
    "finality": "explicit",
    "timestamp": "provider",
}


def mock_exchange_provider_manifest() -> PluginManifest:
    resource = files(__package__).joinpath("mock-exchange-provider.manifest.json")
    return PluginManifest.from_wire(loads_strict(resource.read_bytes()))


def _interval_ms(value: str) -> int:
    unit_ms = {"s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}
    try:
        amount = int(value[:-1])
        multiplier = unit_ms[value[-1]]
    except (KeyError, TypeError, ValueError) as exc:
        raise PlatformContractError(
            "INVALID_CONTRACT", "mock provider interval is unsupported"
        ) from exc
    return amount * multiplier


def _bar(open_time_ms: int, interval_ms: int, *, finality: str, correction: float = 0) -> dict:
    bucket = open_time_ms // interval_ms
    opening = 100.0 + float(bucket % 1_000) / 10.0
    closing = opening + 0.5 + correction
    return {
        "openTimeMs": open_time_ms,
        "closeTimeMs": open_time_ms + interval_ms - 1,
        "open": opening,
        "high": max(opening, closing) + 0.25,
        "low": min(opening, closing) - 0.25,
        "close": closing,
        "volume": 10.0 + float(bucket % 10),
        "quoteVolume": (10.0 + float(bucket % 10)) * closing,
        "trades": 20 + int(bucket % 5),
        "takerBuyBase": 4.0,
        "takerBuyQuote": 4.0 * closing,
        "eventTimeMs": open_time_ms + interval_ms - 1,
        "sequence": int(bucket),
        "finality": finality,
    }


@dataclass(slots=True)
class _StreamState:
    descriptor: ProviderStreamDescriptor
    generation: int
    next_sequence: int = 1


class MockExchangeProviderPlugin(BasePlatformPlugin):
    def __init__(self) -> None:
        self._manifest = mock_exchange_provider_manifest()
        self._generation = 0
        self._streams: dict[str, _StreamState] = {}

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def activate(self, request: ActivationRequest) -> None:
        self._generation = request.generation
        self._streams.clear()

    def deactivate(self, reason: str) -> None:
        self._streams.clear()

    def health_check(self) -> dict[str, Any]:
        return {
            "status": "ready",
            "provider": "mock",
            "openStreams": len(self._streams),
        }

    @staticmethod
    def _symbols(request: ProviderSymbolsRequest) -> dict[str, Any]:
        if request.market_type != "spot":
            rows: list[dict[str, Any]] = []
        else:
            rows = [
                {
                    "symbol": "BTCUSDT",
                    "baseAsset": "BTC",
                    "quoteAsset": "USDT",
                    "status": "active",
                    "exchange": "mock",
                    "marketType": "spot",
                    "productType": "spot",
                    "priceTickSize": "0.01",
                },
                {
                    "symbol": "ETHUSDT",
                    "baseAsset": "ETH",
                    "quoteAsset": "USDT",
                    "status": "active",
                    "exchange": "mock",
                    "marketType": "spot",
                    "productType": "spot",
                    "priceTickSize": "0.01",
                },
            ]
        if request.quote_asset is not None:
            rows = [item for item in rows if item["quoteAsset"] == request.quote_asset]
        if request.search is not None:
            needle = request.search.upper()
            rows = [item for item in rows if needle in item["symbol"]]
        if request.cursor is not None:
            rows = [item for item in rows if item["symbol"] > request.cursor]
        page = rows[: request.limit]
        exhausted = len(page) == len(rows)
        return {
            "schemaVersion": PROVIDER_SYMBOLS_PAGE_V1,
            "exchange": "mock",
            "marketType": request.market_type,
            "symbols": page,
            "nextCursor": None if exhausted or not page else page[-1]["symbol"],
            "exhausted": exhausted,
            "sourceQuality": dict(_QUALITY),
        }

    @staticmethod
    def _history(request: ProviderHistoryRequest) -> dict[str, Any]:
        descriptor = request.descriptor
        assert descriptor.interval is not None
        interval_ms = _interval_ms(descriptor.interval)
        end_ms = request.end_ms if request.end_ms is not None else int(time.time() * 1000)
        last_open = end_ms // interval_ms * interval_ms
        start_bound = request.start_ms
        opens: list[int] = []
        cursor = last_open
        while len(opens) < request.limit and cursor >= 0:
            if start_bound is not None and cursor < start_bound:
                break
            opens.append(cursor)
            cursor -= interval_ms
        opens.sort()
        exhausted = start_bound is not None and (not opens or opens[0] <= start_bound)
        rows = [_bar(item, interval_ms, finality="final") for item in opens]
        return {
            "schemaVersion": PROVIDER_HISTORY_PAGE_V1,
            "descriptor": descriptor.to_wire(),
            "rows": rows,
            "nextBeforeMs": None if exhausted or not rows else rows[0]["openTimeMs"] - 1,
            "exhausted": exhausted,
            "sourceQuality": dict(_QUALITY),
        }

    def _open(self, request: ProviderStreamOpenRequest) -> dict[str, Any]:
        stream_id = "mock-stream-" + uuid.uuid4().hex
        self._streams[stream_id] = _StreamState(request.descriptor, self._generation)
        return {
            "schemaVersion": PROVIDER_STREAM_OPEN_V1,
            "hostStreamId": request.host_stream_id,
            "providerStreamId": stream_id,
            "generation": self._generation,
            "nextSequence": 1,
            "sourceQuality": dict(_QUALITY),
        }

    @staticmethod
    def _kline_event(state: _StreamState, sequence: int) -> dict[str, Any]:
        descriptor = state.descriptor
        assert descriptor.interval is not None
        interval_ms = _interval_ms(descriptor.interval)
        now_ms = int(time.time() * 1000)
        current_open = now_ms // interval_ms * interval_ms
        phase = (sequence - 1) % 3
        if phase == 0:
            event_type = "bar.closed"
            bar = _bar(current_open - interval_ms, interval_ms, finality="final")
        elif phase == 1:
            event_type = "bar.updated"
            bar = _bar(current_open, interval_ms, finality="forming")
        else:
            event_type = "bar.amended"
            bar = _bar(
                current_open - interval_ms,
                interval_ms,
                finality="corrected",
                correction=0.1,
            )
        return {
            "sequence": sequence,
            "eventType": event_type,
            "descriptor": descriptor.to_wire(),
            "eventTimeMs": int(bar["eventTimeMs"]),
            "payload": bar,
        }

    @staticmethod
    def _book_event(state: _StreamState, sequence: int) -> dict[str, Any]:
        descriptor = state.descriptor
        now_ms = int(time.time() * 1000)
        if sequence == 1:
            event_type = "orderbook.snapshot"
            payload = {
                "kind": "snapshot",
                "lastUpdateId": 100,
                "eventTimeMs": now_ms,
                "updateIntervalMs": 100,
                "bids": [[100.0, 2.0], [99.5, 3.0]],
                "asks": [[100.5, 2.5], [101.0, 4.0]],
            }
        else:
            update_id = 99 + sequence
            event_type = "orderbook.delta"
            payload = {
                "kind": "delta",
                "firstUpdateId": update_id,
                "finalUpdateId": update_id,
                "previousFinalUpdateId": update_id - 1,
                "eventTimeMs": now_ms,
                "updateIntervalMs": 100,
                "bids": [[100.0, 2.0 + sequence / 10]],
                "asks": [],
            }
        return {
            "sequence": sequence,
            "eventType": event_type,
            "descriptor": descriptor.to_wire(),
            "eventTimeMs": now_ms,
            "payload": payload,
        }

    def _poll(self, request: ProviderStreamPollRequest) -> dict[str, Any]:
        state = self._streams.get(request.provider_stream_id)
        if state is None or state.generation != self._generation:
            raise PlatformContractError("INVALID_CONTRACT", "mock provider stream is stale")
        if request.after_sequence != state.next_sequence - 1:
            raise PlatformContractError(
                "INVALID_CONTRACT", "mock provider stream cursor is invalid"
            )
        sequence = state.next_sequence
        event = (
            self._kline_event(state, sequence)
            if state.descriptor.channel == "kline"
            else self._book_event(state, sequence)
        )
        state.next_sequence += 1
        return {
            "schemaVersion": PROVIDER_STREAM_BATCH_V1,
            "providerStreamId": request.provider_stream_id,
            "generation": state.generation,
            "firstSequence": sequence,
            "nextSequence": state.next_sequence,
            "events": [event],
            "heartbeat": False,
            "sourceQuality": dict(_QUALITY),
        }

    def _close(self, request: ProviderStreamCloseRequest) -> dict[str, Any]:
        closed = self._streams.pop(request.provider_stream_id, None) is not None
        return {
            "schemaVersion": PROVIDER_STREAM_CLOSE_V1,
            "providerStreamId": request.provider_stream_id,
            "closed": closed,
        }

    def invoke(self, request: InvokeRequest) -> InvocationOutcome:
        operation = parse_provider_operation(request.input)
        if request.contribution_id == "symbols" and isinstance(operation, ProviderSymbolsRequest):
            return self._symbols(operation)
        if request.contribution_id != "market-data":
            raise PlatformContractError(
                "INVALID_CONTRACT", "provider contribution and operation do not match"
            )
        if isinstance(operation, ProviderHistoryRequest):
            return self._history(operation)
        if isinstance(operation, ProviderStreamOpenRequest):
            return self._open(operation)
        if isinstance(operation, ProviderStreamPollRequest):
            return self._poll(operation)
        if isinstance(operation, ProviderStreamCloseRequest):
            return self._close(operation)
        raise PlatformContractError(
            "INVALID_CONTRACT", "provider operation is unsupported by this contribution"
        )


def main() -> int:
    return serve_platform_plugin(MockExchangeProviderPlugin())


if __name__ == "__main__":
    raise SystemExit(main())
