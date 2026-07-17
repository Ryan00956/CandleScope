from __future__ import annotations

import pytest

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.market_data import DeliveryClass, MarketChannel
from app.exchanges.plugins.binance.normalizer import BinanceNormalizer
from app.exchanges.plugins.binance.plugin import BinancePlugin
from app.exchanges.plugins.binance.protocol import BinanceExchangeProtocol
from app.exchanges.ws_protocol import WsSubscriptionMode


def _descriptor(
    *,
    depth_levels: int = 20,
    update_interval_ms: int | None = 250,
    market_type: str = "futures",
) -> StreamDescriptor:
    return StreamDescriptor(
        symbol="BTCUSDT",
        stream_type=StreamType.DEPTH,
        depth_levels=depth_levels,
        exchange="binance",
        market_type=market_type,
        update_interval_ms=update_interval_ms,
    )


def _payload() -> dict[str, object]:
    return {
        "e": "depthUpdate",
        "E": 1_700_000_000_010,
        "T": 1_700_000_000_009,
        "s": "BTCUSDT",
        "U": 120,
        "u": 124,
        "pu": 119,
        "b": [["100.5", "2"], ["100", "3"]],
        "a": [["101", "4"], ["101.5", "5"]],
        "ps": "BTCUSDT",
        "st": 1,
    }


def _parse(
    payload: dict[str, object],
    descriptor: StreamDescriptor | None = None,
):
    target = descriptor or _descriptor()
    return BinanceNormalizer(IngestionConfig(), target).parse(RawMessage(
        payload=payload,
        source=DataSource.WEBSOCKET,
        stream_type=StreamType.DEPTH,
        received_at_ms=1_700_000_000_020,
    ))


@pytest.mark.parametrize("depth_levels", [5, 10, 20])
@pytest.mark.parametrize("update_interval_ms", [100, 250, 500])
def test_futures_partial_depth_stream_identity_and_public_route(
    depth_levels: int,
    update_interval_ms: int,
) -> None:
    descriptor = _descriptor(
        depth_levels=depth_levels,
        update_interval_ms=update_interval_ms,
    )
    protocol = BinanceExchangeProtocol()

    descriptor.validate()
    expected_stream = f"btcusdt@depth{depth_levels}"
    if update_interval_ms != 250:
        expected_stream = f"{expected_stream}@{update_interval_ms}ms"
    assert descriptor.key == (
        f"futures:BTCUSDT@depth{depth_levels}@{update_interval_ms}ms"
    )
    assert descriptor.ws_stream_name == expected_stream
    assert protocol.build_ws_stream_name(descriptor) == expected_stream
    connection = protocol.ws_connection(descriptor)
    assert connection.base_urls[0] == "wss://fstream.binance.com/public/ws"
    assert connection.connection_model == "path_per_stream"
    assert connection.subscription.mode is WsSubscriptionMode.PATH
    assert connection.subscription.stream_name == expected_stream
    assert protocol.supports_ws(descriptor)


def test_partial_depth_capability_is_replaceable_snapshot_with_current_speeds() -> None:
    depth = BinancePlugin().capabilities().channel_capability(
        MarketChannel.DEPTH,
        "futures",
    )

    assert depth is not None
    assert depth.delivery is DeliveryClass.SNAPSHOT
    assert depth.snapshot is True
    assert depth.delta is False
    assert depth.sequence == "monotonic_id"
    assert depth.resync == "replace_snapshot"
    assert depth.params == {"depth_levels": [5, 10, 20]}
    assert depth.update_intervals_ms == (100, 250, 500)
    assert set(depth.available_fields) == {
        "last_update_id",
        "first_update_id",
        "final_update_id",
        "previous_final_update_id",
        "event_time_ms",
        "transaction_time_ms",
        "depth_levels",
        "update_interval_ms",
        "bids",
        "asks",
    }


def test_default_depth_stream_names_preserve_existing_unsuffixed_behavior() -> None:
    protocol = BinanceExchangeProtocol()
    futures = _descriptor(update_interval_ms=None)
    spot = _descriptor(update_interval_ms=None, market_type="spot")
    spot_explicit_default = _descriptor(
        update_interval_ms=1000,
        market_type="spot",
    )

    assert futures.key == "futures:BTCUSDT@depth20"
    assert futures.ws_stream_name == "btcusdt@depth20"
    assert protocol.build_ws_stream_name(futures) == "btcusdt@depth20"
    assert spot.key == "BTCUSDT@depth20"
    assert spot.ws_stream_name == "btcusdt@depth20"
    assert protocol.build_ws_stream_name(spot) == "btcusdt@depth20"
    assert spot_explicit_default.ws_stream_name == "btcusdt@depth20"
    assert protocol.build_ws_stream_name(spot_explicit_default) == "btcusdt@depth20"
    assert protocol.supports_ws(spot_explicit_default)

    spot_event = _parse(
        {
            "lastUpdateId": 124,
            "bids": [["100", "2"]],
            "asks": [["101", "3"]],
        },
        spot,
    )
    assert spot_event is not None
    assert spot_event.data["last_update_id"] == 124
    assert spot_event.data["depth_levels"] == 20
    assert spot_event.data["update_interval_ms"] == 1000
    assert spot_event.data["bids"] == [[100.0, 2.0]]
    assert spot_event.data["asks"] == [[101.0, 3.0]]


@pytest.mark.parametrize("depth_levels", [None, True, 0, 1, 50])
def test_descriptor_rejects_non_partial_depth_levels(depth_levels: object) -> None:
    descriptor = _descriptor(depth_levels=20)
    descriptor.depth_levels = depth_levels  # type: ignore[assignment]

    with pytest.raises(ValueError, match="depth_levels"):
        descriptor.validate()


@pytest.mark.parametrize("update_interval_ms", [True, 0, -1, 1000])
def test_futures_protocol_rejects_unsupported_update_speed(
    update_interval_ms: object,
) -> None:
    descriptor = _descriptor(update_interval_ms=250)
    descriptor.update_interval_ms = update_interval_ms  # type: ignore[assignment]
    protocol = BinanceExchangeProtocol()

    assert not protocol.supports_ws(descriptor)
    with pytest.raises(ValueError, match="update_interval_ms"):
        protocol.build_ws_stream_name(descriptor)


def test_futures_depth_payload_filter_requires_matching_um_symbol() -> None:
    protocol = BinanceExchangeProtocol()
    descriptor = _descriptor()
    payload = _payload()

    assert protocol.payload_matches_descriptor(payload, descriptor)
    without_migration_tag = dict(payload)
    without_migration_tag.pop("st")
    assert protocol.payload_matches_descriptor(without_migration_tag, descriptor)
    assert not protocol.payload_matches_descriptor({**payload, "st": 2}, descriptor)
    assert not protocol.payload_matches_descriptor({**payload, "st": True}, descriptor)
    assert not protocol.payload_matches_descriptor(
        {**payload, "s": "ETHUSDT"},
        descriptor,
    )
    assert not protocol.payload_matches_descriptor(
        {**payload, "e": "bookTicker"},
        descriptor,
    )


def test_futures_depth_normalizer_retains_snapshot_metadata_and_levels() -> None:
    event = _parse(_payload(), _descriptor(depth_levels=10, update_interval_ms=100))

    assert event is not None
    assert event.event_type is StreamType.DEPTH
    assert event.event_time_ms == 1_700_000_000_010
    assert event.sequence == 124
    assert event.data == {
        "last_update_id": 124,
        "first_update_id": 120,
        "final_update_id": 124,
        "previous_final_update_id": 119,
        "event_time_ms": 1_700_000_000_010,
        "transaction_time_ms": 1_700_000_000_009,
        "depth_levels": 10,
        "update_interval_ms": 100,
        "bids": [[100.5, 2.0], [100.0, 3.0]],
        "asks": [[101.0, 4.0], [101.5, 5.0]],
    }


@pytest.mark.parametrize(
    ("overrides", "removed_field"),
    [
        pytest.param({"st": 2}, None, id="cm-symbol-type"),
        pytest.param({"st": True}, None, id="boolean-symbol-type"),
        pytest.param({"s": "ETHUSDT"}, None, id="wrong-symbol"),
        pytest.param({"e": "bookTicker"}, None, id="wrong-event"),
        pytest.param({}, "u", id="missing-final-update-id"),
        pytest.param({"u": True}, None, id="boolean-update-id"),
        pytest.param({"u": 0}, None, id="zero-update-id"),
        pytest.param({"u": -1}, None, id="negative-update-id"),
        pytest.param({"U": 125}, None, id="reversed-update-range"),
        pytest.param({"pu": 125}, None, id="future-previous-update-id"),
        pytest.param({"E": -1}, None, id="negative-event-time"),
        pytest.param({"b": "invalid"}, None, id="non-array-bids"),
        pytest.param({"b": []}, None, id="empty-bids"),
        pytest.param({"a": None}, None, id="missing-asks"),
        pytest.param({"b": [["nan", "1"]]}, None, id="nan-price"),
        pytest.param({"b": [["inf", "1"]]}, None, id="infinite-price"),
        pytest.param({"b": [["100", "-1"]]}, None, id="negative-quantity"),
        pytest.param({"b": [["100", "0"]]}, None, id="zero-quantity"),
        pytest.param({"b": [[-1, "1"]]}, None, id="negative-price"),
        pytest.param({"b": [[True, "1"]]}, None, id="boolean-price"),
        pytest.param({"b": [["100"]]}, None, id="short-level"),
        pytest.param({"b": [["100", "1", "extra"]]}, None, id="long-level"),
    ],
)
def test_futures_depth_normalizer_rejects_malformed_payloads(
    overrides: dict[str, object],
    removed_field: str | None,
) -> None:
    payload = {**_payload(), **overrides}
    if removed_field is not None:
        payload.pop(removed_field)

    assert _parse(payload) is None


def test_depth_normalizer_rejects_more_rows_than_configured_top_n() -> None:
    payload = _payload()
    payload["b"] = [[str(100 - index), "1"] for index in range(6)]

    assert _parse(payload, _descriptor(depth_levels=5)) is None


def test_http_depth_normalizer_rejects_non_finite_levels_without_raising() -> None:
    descriptor = _descriptor()
    event = BinanceNormalizer(IngestionConfig(), descriptor).parse(RawMessage(
        payload={
            "lastUpdateId": 124,
            "bids": [["100", "NaN"]],
            "asks": [["101", "3"]],
        },
        source=DataSource.HTTP,
        stream_type=StreamType.DEPTH,
        received_at_ms=1_700_000_000_020,
    ))

    assert event is None
