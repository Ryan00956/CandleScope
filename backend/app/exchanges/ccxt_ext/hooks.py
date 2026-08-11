"""Reusable raw/lifecycle hooks for upstream CCXT Pro exchange classes."""

from __future__ import annotations

import inspect
import time
from collections.abc import Callable, Mapping
from typing import Any, TypeVar

import ccxt

from .models import CcxtLifecycleEvent, CcxtRawMarketEvent

ExchangeT = TypeVar("ExchangeT")
RawEventSink = Callable[[CcxtRawMarketEvent], None]
LifecycleSink = Callable[[CcxtLifecycleEvent], None]


class CcxtRawHooksMixin:
    """Intercept decoded messages before exchange-specific CCXT projection.

    CCXT Pro binds ``handle_message`` as the websocket client's callback.  A
    mixin placed before the upstream exchange class in the MRO therefore
    preserves the complete decoded envelope without patching every individual
    ``handle_*`` method.
    """

    def handle_message(self, client: Any, message: Any) -> Any:
        self._candlescope_emit_decoded(message)
        return super().handle_message(client, message)  # type: ignore[misc]

    def on_connected(self, client: Any, message: Any = None) -> Any:
        self._candlescope_emit_lifecycle("connected", client)
        return super().on_connected(client, message)  # type: ignore[misc]

    def on_error(self, client: Any, error: BaseException) -> Any:
        self._candlescope_emit_lifecycle("error", client, error)
        return super().on_error(client, error)  # type: ignore[misc]

    def on_close(self, client: Any, error: BaseException | None) -> Any:
        state = "closed" if self._candlescope_closing else "disconnected"
        self._candlescope_emit_lifecycle(state, client, error)
        return super().on_close(client, error)  # type: ignore[misc]

    def set_raw_event_sink(self, sink: RawEventSink | None) -> None:
        self._candlescope_raw_event_sink = sink

    def set_lifecycle_sink(self, sink: LifecycleSink | None) -> None:
        self._candlescope_lifecycle_sink = sink

    def _candlescope_emit_decoded(self, message: Any) -> None:
        sink = self._candlescope_raw_event_sink
        if sink is None or not isinstance(message, dict):
            return
        result = sink(
            CcxtRawMarketEvent(
                channel=_raw_channel(message),
                symbol=_raw_symbol(message),
                payload=dict(message),
                received_at_ms=int(time.time() * 1000),
                exchange=self._candlescope_exchange_id,
                market_type=self._candlescope_market_type,
            )
        )
        _require_synchronous_sink(result, "raw_event_sink")

    def _candlescope_emit_lifecycle(
        self,
        state: str,
        client: Any,
        error: BaseException | None = None,
    ) -> None:
        sink = self._candlescope_lifecycle_sink
        if sink is None:
            return
        url = getattr(client, "url", None)
        result = sink(
            CcxtLifecycleEvent(
                state=state,
                url=str(url) if url is not None else None,
                observed_at_ms=int(time.time() * 1000),
                error=str(error) if error is not None else None,
            )
        )
        _require_synchronous_sink(result, "lifecycle_sink")


def build_hooked_exchange_class(
    upstream_class: type[ExchangeT],
    *,
    exchange_id: str,
    market_type: str,
    supported_ccxt_version: str,
) -> type[ExchangeT]:
    """Create a raw-observable CCXT class without forking upstream source."""

    class HookedCcxtExchange(CcxtRawHooksMixin, upstream_class):  # type: ignore[misc, valid-type]
        def __init__(
            self,
            config: Mapping[str, Any] | None = None,
            *,
            raw_event_sink: RawEventSink | None = None,
            lifecycle_sink: LifecycleSink | None = None,
            enforce_version: bool = True,
        ) -> None:
            if enforce_version and ccxt.__version__ != supported_ccxt_version:
                raise RuntimeError(
                    f"CCXT hook was tested with ccxt=={supported_ccxt_version}, "
                    f"found {ccxt.__version__}"
                )
            super().__init__(dict(config or {}))
            self._candlescope_raw_event_sink = raw_event_sink
            self._candlescope_lifecycle_sink = lifecycle_sink
            self._candlescope_exchange_id = exchange_id
            self._candlescope_market_type = market_type
            self._candlescope_closing = False

        async def close(self, *args: Any, **kwargs: Any) -> Any:
            self._candlescope_closing = True
            try:
                return await super().close(*args, **kwargs)
            finally:
                self._candlescope_closing = False

    HookedCcxtExchange.__name__ = (
        f"CandleScope{upstream_class.__name__.replace('_', '').title()}"
    )
    HookedCcxtExchange.__qualname__ = HookedCcxtExchange.__name__
    return HookedCcxtExchange


def _raw_channel(message: Mapping[str, Any]) -> str:
    event = message.get("e") or message.get("event")
    if event is not None:
        value = str(event)
        if value == "depthUpdate":
            return "depth"
        return value
    arg = message.get("arg")
    if isinstance(arg, Mapping) and arg.get("channel") is not None:
        return str(arg["channel"])
    channel = message.get("channel") or message.get("topic")
    return str(channel) if channel is not None else "message"


def _raw_symbol(message: Mapping[str, Any]) -> str | None:
    kline = message.get("k")
    arg = message.get("arg")
    data = message.get("data")
    candidates = [
        message.get("s"),
        message.get("symbol"),
        kline.get("s") if isinstance(kline, Mapping) else None,
        arg.get("instId") if isinstance(arg, Mapping) else None,
    ]
    if isinstance(data, list) and data and isinstance(data[0], Mapping):
        candidates.extend((data[0].get("instId"), data[0].get("symbol")))
    for candidate in candidates:
        if candidate not in (None, ""):
            return str(candidate)
    return None


def _require_synchronous_sink(result: Any, name: str) -> None:
    if not inspect.isawaitable(result):
        return
    close = getattr(result, "close", None)
    if callable(close):
        close()
    raise TypeError(f"{name} must be synchronous and non-blocking")
