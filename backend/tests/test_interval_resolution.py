from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolutionError,
    IntervalResolutionErrorCode,
    IntervalResolver,
    IntervalRouteKind,
)
from app.data_engine.market_data.models import MarketChannel
from app.exchanges import bootstrap_default_adapters, get_exchange_registry
from app.exchanges.models import ExchangeCapabilities, MarketChannelCapability


@pytest.mark.parametrize("purpose", [IntervalPurpose.HISTORY, IntervalPurpose.REALTIME])
@pytest.mark.parametrize(
    ("exchange", "interval", "kind", "canonical", "native", "base"),
    [
        ("okx", "8h", IntervalRouteKind.DERIVED, "8h", None, "4h"),
        ("okx", "16h", IntervalRouteKind.DERIVED, "16h", None, "4h"),
        ("binance", "16h", IntervalRouteKind.DERIVED, "16h", None, "8h"),
        ("binance", "60m", IntervalRouteKind.NATIVE, "1h", "1h", None),
        ("okx", "7d", IntervalRouteKind.DERIVED, "7d", None, "1d"),
        ("okx", "30d", IntervalRouteKind.DERIVED, "30d", None, "3d"),
        ("okx", "5M", IntervalRouteKind.DERIVED, "5M", None, "1M"),
    ],
)
def test_builtin_exchange_resolution_matrix(
    purpose: IntervalPurpose,
    exchange: str,
    interval: str,
    kind: IntervalRouteKind,
    canonical: str,
    native: str | None,
    base: str | None,
) -> None:
    route = IntervalResolver().resolve(
        exchange=exchange,
        market_type="spot",
        interval=interval,
        purpose=purpose,
    )

    assert route.kind is kind
    assert route.canonical_interval == canonical
    assert route.native_interval == native
    assert route.base_interval == base
    assert route.source_interval == (native or base)


def test_alignment_aliases_do_not_cross_native_families() -> None:
    resolver = IntervalResolver()

    seven_days = resolver.resolve(
        exchange="okx",
        market_type="spot",
        interval="7d",
        purpose=IntervalPurpose.HISTORY,
    )
    thirty_days = resolver.resolve(
        exchange="okx",
        market_type="spot",
        interval="30d",
        purpose=IntervalPurpose.HISTORY,
    )

    assert seven_days.kind is IntervalRouteKind.DERIVED
    assert seven_days.source_interval == "1d"
    assert seven_days.source_interval != "1w"
    assert thirty_days.kind is IntervalRouteKind.DERIVED
    assert thirty_days.source_interval == "3d"
    assert thirty_days.source_interval != "1M"


def test_kline_intervals_are_market_and_purpose_scoped() -> None:
    bootstrap_default_adapters()
    capabilities = get_exchange_registry().get_capabilities("binance")

    assert "1s" in capabilities.kline_intervals("spot", history=True)
    assert "1s" not in capabilities.kline_intervals("futures", history=True)
    assert "1s" not in capabilities.kline_intervals("futures", history=False)


@dataclass
class _StubRegistry:
    capabilities: ExchangeCapabilities

    def get_capabilities(self, exchange: str) -> ExchangeCapabilities:
        if exchange != self.capabilities.exchange:
            raise KeyError(exchange)
        return self.capabilities


def _capabilities(
    *,
    realtime: bool = True,
    history: bool = True,
    channel_intervals: tuple[str, ...] = ("1m",),
    top_level_intervals: tuple[str, ...] = ("1s", "1m"),
) -> ExchangeCapabilities:
    return ExchangeCapabilities(
        exchange="fixture",
        name="Fixture",
        capability_schema_version=3,
        native_intervals=list(top_level_intervals),
        channels=[
            MarketChannelCapability(
                channel=MarketChannel.KLINE,
                market_types=("spot",),
                realtime=realtime,
                history=history,
                params={"interval": list(channel_intervals)},
            ),
        ],
    )


@pytest.mark.parametrize(
    ("purpose", "capability_overrides"),
    [
        (IntervalPurpose.REALTIME, {"realtime": False}),
        (IntervalPurpose.HISTORY, {"history": False}),
    ],
)
def test_channel_purpose_unsupported_fails_closed(
    purpose: IntervalPurpose,
    capability_overrides: dict[str, bool],
) -> None:
    resolver = IntervalResolver(
        _StubRegistry(_capabilities(**capability_overrides)),
    )

    with pytest.raises(IntervalResolutionError) as captured:
        resolver.resolve(
            exchange="fixture",
            market_type="spot",
            interval="1m",
            purpose=purpose,
        )

    assert captured.value.code is IntervalResolutionErrorCode.PURPOSE_UNSUPPORTED
    assert captured.value.to_dict()["purpose"] == purpose.value


def test_missing_market_channel_fails_closed() -> None:
    resolver = IntervalResolver(_StubRegistry(_capabilities()))

    with pytest.raises(IntervalResolutionError) as captured:
        resolver.resolve(
            exchange="fixture",
            market_type="futures",
            interval="1m",
            purpose=IntervalPurpose.HISTORY,
        )

    assert captured.value.code is IntervalResolutionErrorCode.KLINE_CHANNEL_UNAVAILABLE


def test_top_level_superset_does_not_leak_into_channel_resolution() -> None:
    resolver = IntervalResolver(_StubRegistry(_capabilities(channel_intervals=("1m",))))

    with pytest.raises(IntervalResolutionError) as captured:
        resolver.resolve(
            exchange="fixture",
            market_type="spot",
            interval="30s",
            purpose=IntervalPurpose.HISTORY,
        )

    assert captured.value.code is IntervalResolutionErrorCode.NO_EXACT_BASE


def test_unknown_exchange_and_invalid_interval_are_typed() -> None:
    resolver = IntervalResolver(_StubRegistry(_capabilities()))

    with pytest.raises(IntervalResolutionError) as unknown:
        resolver.resolve(
            exchange="missing",
            market_type="spot",
            interval="1m",
            purpose=IntervalPurpose.HISTORY,
        )
    assert unknown.value.code is IntervalResolutionErrorCode.UNKNOWN_EXCHANGE

    with pytest.raises(IntervalResolutionError) as invalid:
        resolver.resolve(
            exchange="fixture",
            market_type="spot",
            interval="nonsense",
            purpose=IntervalPurpose.HISTORY,
        )
    assert invalid.value.code is IntervalResolutionErrorCode.INVALID_INTERVAL
