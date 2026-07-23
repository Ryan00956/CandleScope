from __future__ import annotations

import copy

import pytest
from candlescope_plugin_sdk.platform_v2 import (
    PROVIDER_DATA_PLANE_V1,
    PlatformContractError,
    PlatformJsonLineServer,
    ProviderHistoryRequest,
    ProviderStreamDescriptor,
    validate_provider_history_page,
    validate_provider_stream_batch,
    validate_provider_stream_close,
    validate_provider_stream_open,
    validate_provider_symbols_page,
)
from candlescope_plugin_sdk.platform_v2.examples.mock_exchange_provider import (
    MockExchangeProviderPlugin,
    mock_exchange_provider_manifest,
)


def _request(request_id, method, *, generation, params):
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
        "generation": generation,
    }


def _server() -> PlatformJsonLineServer:
    server = PlatformJsonLineServer(MockExchangeProviderPlugin())
    server.handle_message(
        _request(
            "handshake",
            "handshake",
            generation=0,
            params={
                "protocols": ["candlescope.plugin/2"],
                "host": {"name": "CandleScope", "version": "0.4.0"},
                "entrypointId": "main",
                "hostApis": [],
                "transports": ["jsonl/1"],
            },
        )
    )
    server.handle_message(
        _request(
            "activate",
            "activate",
            generation=1,
            params={
                "instanceId": "mock-provider-instance",
                "generation": 1,
                "capabilities": [],
            },
        )
    )
    return server


def _invoke(server: PlatformJsonLineServer, contribution_id: str, value: dict):
    return server.handle_message(
        _request(
            f"invoke-{contribution_id}-{value['operation']}",
            "invoke",
            generation=1,
            params={
                "contributionId": contribution_id,
                "input": value,
                "requestContext": {
                    "contributionId": contribution_id,
                    "userAction": False,
                    "generation": 1,
                    "traceId": f"provider-{value['operation']}",
                },
            },
        )
    )[0]["result"]


def test_mock_provider_manifest_is_service_scoped_and_credential_free() -> None:
    manifest = mock_exchange_provider_manifest()
    assert manifest.permissions.required == ()
    assert manifest.permissions.optional == ()
    assert manifest.backend_entrypoints[0].resource_profile == "service"
    assert manifest.backend_entrypoints[0].activation_events == ("onMarketSubscription",)
    by_kind = {item.kind: item for item in manifest.contributions}
    assert set(by_kind) == {"symbol-provider/1", "market-data-provider/1"}
    assert by_kind["market-data-provider/1"].configuration["dataPlane"] == (PROVIDER_DATA_PLANE_V1)


def test_mock_provider_symbols_and_history_are_canonical_and_bounded() -> None:
    server = _server()
    symbols = _invoke(
        server,
        "symbols",
        {
            "operation": "symbols.list",
            "marketType": "spot",
            "quoteAsset": "USDT",
            "limit": 1,
        },
    )
    first = validate_provider_symbols_page(
        symbols,
        expected_exchange="mock",
        expected_market_type="spot",
        max_rows=1,
    )
    assert [item["symbol"] for item in first["symbols"]] == ["BTCUSDT"]
    assert first["nextCursor"] == "BTCUSDT"

    descriptor = ProviderStreamDescriptor("mock", "spot", "kline", "BTCUSDT", "1m")
    request = ProviderHistoryRequest(descriptor, 1_700_000_000_000, 1_700_000_300_000, 3)
    history = _invoke(
        server,
        "market-data",
        {
            "operation": "history.read",
            "descriptor": descriptor.to_wire(),
            "startMs": request.start_ms,
            "endMs": request.end_ms,
            "limit": request.limit,
        },
    )
    page = validate_provider_history_page(history, request=request)
    assert len(page["rows"]) == 3
    assert all(row["finality"] == "final" for row in page["rows"])
    assert page["nextBeforeMs"] == page["rows"][0]["openTimeMs"] - 1


def test_history_validation_rejects_identity_range_and_finality_drift() -> None:
    server = _server()
    descriptor = ProviderStreamDescriptor("mock", "spot", "kline", "BTCUSDT", "1m")
    request = ProviderHistoryRequest(descriptor, 1_700_000_000_000, 1_700_000_300_000, 3)
    page = _invoke(
        server,
        "market-data",
        {
            "operation": "history.read",
            "descriptor": descriptor.to_wire(),
            "startMs": request.start_ms,
            "endMs": request.end_ms,
            "limit": request.limit,
        },
    )
    drifted = copy.deepcopy(page)
    drifted["descriptor"]["symbol"] = "ETHUSDT"
    with pytest.raises(PlatformContractError):
        validate_provider_history_page(drifted, request=request)
    forming = copy.deepcopy(page)
    forming["rows"][0]["finality"] = "forming"
    with pytest.raises(PlatformContractError):
        validate_provider_history_page(forming, request=request)
    duplicate = copy.deepcopy(page)
    duplicate["rows"][1]["openTimeMs"] = duplicate["rows"][0]["openTimeMs"]
    with pytest.raises(PlatformContractError):
        validate_provider_history_page(duplicate, request=request)


def test_mock_kline_stream_has_contiguous_sequence_and_explicit_corrections() -> None:
    server = _server()
    descriptor = ProviderStreamDescriptor("mock", "spot", "kline", "BTCUSDT", "1m")
    opened = validate_provider_stream_open(
        _invoke(
            server,
            "market-data",
            {
                "operation": "stream.open",
                "hostStreamId": "host-stream-kline",
                "descriptor": descriptor.to_wire(),
                "batchLimit": 8,
                "resync": False,
            },
        ),
        expected_host_stream_id="host-stream-kline",
    )
    event_types = []
    after = 0
    for _ in range(3):
        batch = validate_provider_stream_batch(
            _invoke(
                server,
                "market-data",
                {
                    "operation": "stream.poll",
                    "providerStreamId": opened["providerStreamId"],
                    "afterSequence": after,
                    "batchLimit": 8,
                    "waitMs": 0,
                },
            ),
            expected_provider_stream_id=opened["providerStreamId"],
            expected_generation=opened["generation"],
            expected_descriptor=descriptor,
        )
        after = batch["nextSequence"] - 1
        event_types.extend(item["eventType"] for item in batch["events"])
    assert event_types == ["bar.closed", "bar.updated", "bar.amended"]

    closed = validate_provider_stream_close(
        _invoke(
            server,
            "market-data",
            {
                "operation": "stream.close",
                "providerStreamId": opened["providerStreamId"],
            },
        ),
        expected_provider_stream_id=opened["providerStreamId"],
    )
    assert closed["closed"] is True


def test_mock_order_book_stream_starts_with_snapshot_then_linked_delta() -> None:
    server = _server()
    descriptor = ProviderStreamDescriptor("mock", "spot", "full_depth", "BTCUSDT")
    opened = validate_provider_stream_open(
        _invoke(
            server,
            "market-data",
            {
                "operation": "stream.open",
                "hostStreamId": "host-stream-book",
                "descriptor": descriptor.to_wire(),
                "batchLimit": 8,
                "resync": True,
            },
        )
    )
    batches = []
    after = 0
    for _ in range(2):
        batch = validate_provider_stream_batch(
            _invoke(
                server,
                "market-data",
                {
                    "operation": "stream.poll",
                    "providerStreamId": opened["providerStreamId"],
                    "afterSequence": after,
                    "batchLimit": 8,
                    "waitMs": 0,
                },
            ),
            expected_provider_stream_id=opened["providerStreamId"],
            expected_descriptor=descriptor,
        )
        batches.append(batch)
        after = batch["nextSequence"] - 1
    snapshot = batches[0]["events"][0]
    delta = batches[1]["events"][0]
    assert snapshot["eventType"] == "orderbook.snapshot"
    assert delta["eventType"] == "orderbook.delta"
    assert delta["payload"]["previousFinalUpdateId"] == snapshot["payload"]["lastUpdateId"]


def test_stream_batch_rejects_transport_sequence_gap_and_book_link_corruption() -> None:
    server = _server()
    descriptor = ProviderStreamDescriptor("mock", "spot", "full_depth", "BTCUSDT")
    opened = _invoke(
        server,
        "market-data",
        {
            "operation": "stream.open",
            "hostStreamId": "host-stream-invalid",
            "descriptor": descriptor.to_wire(),
            "batchLimit": 8,
            "resync": True,
        },
    )
    batch = _invoke(
        server,
        "market-data",
        {
            "operation": "stream.poll",
            "providerStreamId": opened["providerStreamId"],
            "afterSequence": 0,
            "batchLimit": 8,
            "waitMs": 0,
        },
    )
    skipped = copy.deepcopy(batch)
    skipped["events"][0]["sequence"] = 2
    with pytest.raises(PlatformContractError):
        validate_provider_stream_batch(skipped)

    malformed = copy.deepcopy(batch)
    malformed["events"][0]["payload"]["bids"] = [[100.0, -1.0]]
    with pytest.raises(PlatformContractError):
        validate_provider_stream_batch(malformed)
