from __future__ import annotations

import pytest

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.models import (
    DataSource,
    RawMessage,
    StreamDescriptor,
    StreamType,
    TransportRequest,
)
from app.data_engine.market_data import (
    DeliveryClass,
    MarketChannel,
    TransportMode,
)
from app.exchanges.plugins.binance.normalizer import BinanceNormalizer
from app.exchanges.plugins.binance.plugin import BinancePlugin
from app.exchanges.plugins.binance.protocol import BinanceExchangeProtocol
from app.exchanges.rate_limits import HistoricalRequest
from app.exchanges.ws_protocol import WsSubscriptionMode


def _descriptor(
    *,
    update_interval_ms: int | None = 100,
    market_type: str = "futures",
) -> StreamDescriptor:
    return StreamDescriptor(
        symbol="BTCUSDT",
        stream_type=StreamType.FULL_DEPTH,
        exchange="binance",
        market_type=market_type,
        update_interval_ms=update_interval_ms,
    )


def _delta_payload() -> dict[str, object]:
    return {
        "e": "depthUpdate",
        "E": 1_700_000_000_010,
        "T": 1_700_000_000_009,
        "s": "BTCUSDT",
        "U": 120,
        "u": 124,
        "pu": 119,
        "b": [["100.5", "0"], ["100", "3"]],
        "a": [["101", "4"], ["101.5", "0"]],
        "ps": "BTCUSDT",
        "st": 1,
    }


def _snapshot_payload() -> dict[str, object]:
    return {
        "lastUpdateId": 123,
        "E": 1_700_000_000_008,
        "T": 1_700_000_000_007,
        "bids": [["100.5", "2"], ["100", "3"]],
        "asks": [["101", "4"], ["101.5", "5"]],
    }


def _parse(
    payload: dict[str, object],
    *,
    descriptor: StreamDescriptor | None = None,
    source: DataSource = DataSource.WEBSOCKET,
    request_limit: int | None = None,
):
    target = descriptor or _descriptor()
    return BinanceNormalizer(IngestionConfig(), target).parse(RawMessage(
        payload=payload,
        source=source,
        stream_type=StreamType.FULL_DEPTH,
        received_at_ms=1_700_000_000_020,
        request_limit=request_limit,
    ))


@pytest.mark.parametrize(
    ("update_interval_ms", "expected_stream"),
    [
        (None, "btcusdt@depth"),
        (100, "btcusdt@depth@100ms"),
        (250, "btcusdt@depth"),
        (500, "btcusdt@depth@500ms"),
    ],
)
def test_full_depth_has_independent_identity_and_public_ws_route(
    update_interval_ms: int | None,
    expected_stream: str,
) -> None:
    descriptor = _descriptor(update_interval_ms=update_interval_ms)
    protocol = BinanceExchangeProtocol()

    descriptor.validate()
    expected_key = "futures:BTCUSDT@fullDepth"
    if update_interval_ms is not None:
        expected_key = f"{expected_key}@{update_interval_ms}ms"
    assert descriptor.key == expected_key
    assert descriptor.ws_stream_name == expected_stream
    assert protocol.build_ws_stream_name(descriptor) == expected_stream

    connection = protocol.ws_connection(descriptor)
    assert connection.base_urls[0] == "wss://fstream.binance.com/public/ws"
    assert connection.connection_model == "path_per_stream"
    assert connection.subscription.mode is WsSubscriptionMode.PATH
    assert connection.subscription.stream_name == expected_stream
    assert protocol.supports_ws(descriptor)


def test_full_depth_rest_snapshot_uses_same_logical_descriptor() -> None:
    descriptor = _descriptor()
    protocol = BinanceExchangeProtocol()
    request = protocol.rest_request(TransportRequest(descriptor, limit=1000))

    assert request is not None
    assert request.path == "/fapi/v1/depth"
    assert request.params == {"symbol": "BTCUSDT", "limit": 1000}
    assert protocol.rest_request(
        TransportRequest(descriptor, limit=1000, history=True),
    ) is None


@pytest.mark.parametrize("limit", [5, 10, 20, 50, 100, 500, 1000])
def test_full_depth_rest_snapshot_accepts_only_documented_limits(limit: int) -> None:
    params = BinanceExchangeProtocol().build_http_params(
        TransportRequest(_descriptor(), limit=limit),
    )

    assert params["limit"] == limit


@pytest.mark.parametrize("limit", [True, 0, 1, 99, 101, 999, 1001])
def test_full_depth_rest_snapshot_rejects_undocumented_limits(limit: object) -> None:
    request = TransportRequest(_descriptor(), limit=100)
    request.limit = limit  # type: ignore[assignment]

    with pytest.raises(ValueError, match="snapshot limit"):
        BinanceExchangeProtocol().build_http_params(request)


def test_full_depth_supports_spot_and_rejects_partial_depth_levels() -> None:
    protocol = BinanceExchangeProtocol()
    spot = _descriptor(market_type="spot", update_interval_ms=100)
    with_levels = _descriptor()
    with_levels.depth_levels = 20

    assert protocol.supports_ws(spot)
    assert protocol.build_ws_stream_name(spot) == "btcusdt@depth@100ms"
    request = protocol.rest_request(TransportRequest(spot, limit=1000))
    assert request is not None
    assert request.path == "/api/v3/depth"
    assert request.params == {"symbol": "BTCUSDT", "limit": 1000}
    with pytest.raises(ValueError, match="partial depth_levels"):
        with_levels.validate()
    assert not protocol.supports_ws(with_levels)


@pytest.mark.parametrize("update_interval_ms", [True, 0, -1, 1000])
def test_full_depth_rejects_unsupported_ws_speed(update_interval_ms: object) -> None:
    descriptor = _descriptor()
    descriptor.update_interval_ms = update_interval_ms  # type: ignore[assignment]
    protocol = BinanceExchangeProtocol()

    assert not protocol.supports_ws(descriptor)
    with pytest.raises(ValueError, match="update_interval_ms"):
        protocol.build_ws_stream_name(descriptor)


def test_full_depth_capability_declares_snapshot_plus_ordered_delta() -> None:
    capability = BinancePlugin().capabilities().channel_capability(
        MarketChannel.FULL_DEPTH,
        "futures",
    )

    assert capability is not None
    assert capability.delivery is DeliveryClass.ORDERED_DELTA
    assert capability.snapshot is True
    assert capability.delta is True
    assert capability.history is False
    assert capability.sequence == "previous_link"
    assert capability.resync == "replace_snapshot"
    assert capability.realtime_transports == (
        TransportMode.WEBSOCKET,
        TransportMode.REST_SNAPSHOT,
    )
    assert capability.params == {
        "snapshot_limit": [5, 10, 20, 50, 100, 500, 1000],
    }
    assert capability.update_intervals_ms == (100, 250, 500)
    assert set(capability.available_fields) == {
        "kind",
        "last_update_id",
        "first_update_id",
        "final_update_id",
        "previous_final_update_id",
        "event_time_ms",
        "transaction_time_ms",
        "update_interval_ms",
        "snapshot_limit",
        "bids",
        "asks",
    }
    spot = BinancePlugin().capabilities().channel_capability(
        MarketChannel.FULL_DEPTH,
        "spot",
    )
    assert spot is not None
    assert spot.delivery is DeliveryClass.ORDERED_DELTA
    assert spot.snapshot is True
    assert spot.delta is True
    assert spot.sequence == "range"
    assert spot.update_intervals_ms == (100, 1000)
    assert spot.params == {
        "snapshot_limit": [5, 10, 20, 50, 100, 500, 1000, 5000],
    }
    assert "previous_final_update_id" not in spot.available_fields
    assert "transaction_time_ms" not in spot.available_fields


def test_spot_full_depth_uses_spot_ws_cadence_and_rejects_futures_only_speed() -> None:
    protocol = BinanceExchangeProtocol()
    default = _descriptor(market_type="spot", update_interval_ms=None)
    slow = _descriptor(market_type="spot", update_interval_ms=1000)
    unsupported = _descriptor(market_type="spot", update_interval_ms=250)

    assert protocol.build_ws_stream_name(default) == "btcusdt@depth"
    assert protocol.build_ws_stream_name(slow) == "btcusdt@depth"
    assert protocol.ws_connection(default).base_urls[0] == (
        "wss://stream.binance.com:9443/ws"
    )
    assert not protocol.supports_ws(unsupported)
    with pytest.raises(ValueError, match="spot full depth update_interval_ms"):
        protocol.build_ws_stream_name(unsupported)


def test_full_depth_payload_filter_requires_matching_um_depth_event() -> None:
    protocol = BinanceExchangeProtocol()
    descriptor = _descriptor()
    payload = _delta_payload()

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


def test_full_depth_delta_normalizer_preserves_zero_quantity_deletions() -> None:
    event = _parse(_delta_payload())

    assert event is not None
    assert event.event_type is StreamType.FULL_DEPTH
    assert event.event_time_ms == 1_700_000_000_010
    assert event.sequence == 124
    assert event.data == {
        "kind": "delta",
        "last_update_id": None,
        "first_update_id": 120,
        "final_update_id": 124,
        "previous_final_update_id": 119,
        "event_time_ms": 1_700_000_000_010,
        "transaction_time_ms": 1_700_000_000_009,
        "update_interval_ms": 100,
        "snapshot_limit": None,
        "bids": [[100.5, 0.0], [100.0, 3.0]],
        "asks": [[101.0, 4.0], [101.5, 0.0]],
    }


def test_spot_full_depth_delta_normalizer_uses_update_ranges_without_pu() -> None:
    payload = _delta_payload()
    payload.pop("T")
    payload.pop("pu")
    payload.pop("st")
    event = _parse(
        payload,
        descriptor=_descriptor(market_type="spot", update_interval_ms=100),
    )

    assert event is not None
    assert event.market_type == "spot"
    assert event.sequence == 124
    assert event.data["first_update_id"] == 120
    assert event.data["final_update_id"] == 124
    assert event.data["previous_final_update_id"] is None
    assert event.data["transaction_time_ms"] is None
    assert event.data["update_interval_ms"] == 100


def test_full_depth_delta_allows_one_or_both_empty_update_sides() -> None:
    payload = _delta_payload()
    payload["b"] = []
    payload["a"] = []

    event = _parse(payload)

    assert event is not None
    assert event.data["bids"] == []
    assert event.data["asks"] == []


@pytest.mark.parametrize(
    ("overrides", "removed_field"),
    [
        pytest.param({"st": 2}, None, id="cm-symbol-type"),
        pytest.param({"s": "ETHUSDT"}, None, id="wrong-symbol"),
        pytest.param({"e": "bookTicker"}, None, id="wrong-event"),
        pytest.param({}, "U", id="missing-first-update-id"),
        pytest.param({}, "u", id="missing-final-update-id"),
        pytest.param({}, "pu", id="missing-previous-update-id"),
        pytest.param({}, "E", id="missing-event-time"),
        pytest.param({}, "T", id="missing-transaction-time"),
        pytest.param({"U": 125}, None, id="reversed-range"),
        pytest.param({"pu": 124}, None, id="nonadvancing-link"),
        pytest.param({"u": 0}, None, id="zero-update-id"),
        pytest.param({"E": -1}, None, id="negative-event-time"),
        pytest.param({"b": "invalid"}, None, id="non-array-bids"),
        pytest.param({"a": None}, None, id="missing-asks"),
        pytest.param({"b": [["nan", "1"]]}, None, id="nan-price"),
        pytest.param({"b": [["100", "nan"]]}, None, id="nan-quantity"),
        pytest.param({"b": [["100", "-1"]]}, None, id="negative-quantity"),
        pytest.param({"b": [["0", "1"]]}, None, id="zero-price"),
        pytest.param({"b": [[True, "1"]]}, None, id="boolean-price"),
        pytest.param({"b": [["100"]]}, None, id="short-level"),
        pytest.param({"b": [["100", "1", "extra"]]}, None, id="long-level"),
    ],
)
def test_full_depth_delta_normalizer_rejects_malformed_payloads(
    overrides: dict[str, object],
    removed_field: str | None,
) -> None:
    payload = {**_delta_payload(), **overrides}
    if removed_field is not None:
        payload.pop(removed_field)

    assert _parse(payload) is None


def test_full_depth_rest_snapshot_normalizer_preserves_seed_metadata() -> None:
    event = _parse(
        _snapshot_payload(),
        source=DataSource.HTTP,
        request_limit=1000,
    )

    assert event is not None
    assert event.event_type is StreamType.FULL_DEPTH
    assert event.event_time_ms == 1_700_000_000_008
    assert event.sequence == 123
    assert event.data == {
        "kind": "snapshot",
        "last_update_id": 123,
        "first_update_id": None,
        "final_update_id": None,
        "previous_final_update_id": None,
        "event_time_ms": 1_700_000_000_008,
        "transaction_time_ms": 1_700_000_000_007,
        "update_interval_ms": 100,
        "snapshot_limit": 1000,
        "bids": [[100.5, 2.0], [100.0, 3.0]],
        "asks": [[101.0, 4.0], [101.5, 5.0]],
    }


def test_spot_full_depth_rest_snapshot_accepts_native_timestamp_less_payload() -> None:
    payload = _snapshot_payload()
    payload.pop("E")
    payload.pop("T")
    event = _parse(
        payload,
        descriptor=_descriptor(market_type="spot", update_interval_ms=100),
        source=DataSource.HTTP,
        request_limit=1000,
    )

    assert event is not None
    assert event.market_type == "spot"
    assert event.event_time_ms == 1_700_000_000_020
    assert event.data["event_time_ms"] == 1_700_000_000_020
    assert event.data["transaction_time_ms"] is None
    assert event.data["snapshot_limit"] == 1000


def test_full_depth_snapshot_uses_documented_default_without_request_context() -> None:
    event = _parse(_snapshot_payload(), source=DataSource.HTTP)

    assert event is not None
    assert event.data["snapshot_limit"] == 500


@pytest.mark.parametrize(
    ("overrides", "source", "request_limit"),
    [
        pytest.param({"lastUpdateId": 0}, DataSource.HTTP, 1000, id="zero-update-id"),
        pytest.param({"E": 0}, DataSource.HTTP, 1000, id="zero-output-time"),
        pytest.param({"T": -1}, DataSource.HTTP, 1000, id="negative-transaction-time"),
        pytest.param({"bids": []}, DataSource.HTTP, 1000, id="empty-bids"),
        pytest.param({"asks": None}, DataSource.HTTP, 1000, id="missing-asks"),
        pytest.param(
            {"bids": [["100", "0"]]},
            DataSource.HTTP,
            1000,
            id="zero-snapshot-quantity",
        ),
        pytest.param({}, DataSource.HTTP, 1, id="invalid-request-limit"),
        pytest.param({}, DataSource.HTTP_BACKFILL, 1000, id="history-source"),
    ],
)
def test_full_depth_snapshot_normalizer_rejects_invalid_seed(
    overrides: dict[str, object],
    source: DataSource,
    request_limit: int,
) -> None:
    assert _parse(
        {**_snapshot_payload(), **overrides},
        source=source,
        request_limit=request_limit,
    ) is None


@pytest.mark.parametrize(
    ("limit", "weight"),
    [(5, 2), (10, 2), (20, 2), (50, 2), (100, 5), (500, 10), (1000, 20)],
)
def test_full_depth_snapshot_rate_limit_weight_matches_exchange_contract(
    limit: int,
    weight: int,
) -> None:
    policy = BinancePlugin().rate_limit_policy()
    request = HistoricalRequest(
        exchange="binance",
        market_type="futures",
        endpoint="/fapi/v1/depth",
        symbol="BTCUSDT",
        limit=limit,
    )
    rule = policy.rule_for(request)

    assert rule.name == "binance_futures_depth_snapshot"
    assert rule.bucket_key == "binance:futures:request_weight:ip"
    assert rule.request_cost(request) == weight


def test_partial_and_full_depth_keep_distinct_wire_and_normalizer_semantics() -> None:
    partial = StreamDescriptor(
        symbol="BTCUSDT",
        stream_type=StreamType.DEPTH,
        depth_levels=20,
        exchange="binance",
        market_type="futures",
        update_interval_ms=100,
    )
    protocol = BinanceExchangeProtocol()

    assert partial.key == "futures:BTCUSDT@depth20@100ms"
    assert _descriptor().key == "futures:BTCUSDT@fullDepth@100ms"
    assert protocol.build_ws_stream_name(partial) == "btcusdt@depth20@100ms"
    assert protocol.build_ws_stream_name(_descriptor()) == "btcusdt@depth@100ms"
    assert BinanceNormalizer(IngestionConfig(), partial).parse(RawMessage(
        payload=_delta_payload(),
        source=DataSource.WEBSOCKET,
        stream_type=StreamType.DEPTH,
        received_at_ms=1_700_000_000_020,
    )) is None
    assert _parse(_delta_payload()) is not None
