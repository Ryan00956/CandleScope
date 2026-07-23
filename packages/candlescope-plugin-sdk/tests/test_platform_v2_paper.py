from __future__ import annotations

import copy

import pytest
from candlescope_plugin_sdk.platform_v2 import (
    PAPER_ACCOUNT_SNAPSHOT_V1,
    PAPER_EXECUTOR_ACK_V1,
    HOST_API_V1,
    OrderIntent,
    PlatformContractError,
    PlatformJsonLineServer,
    validate_paper_account_snapshot,
    validate_paper_executor_ack,
)
from candlescope_plugin_sdk.platform_v2.examples.paper_broker import (
    PaperBrokerPlugin,
    paper_broker_manifest,
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
    plugin = PaperBrokerPlugin()
    manifest = plugin.manifest()
    server = PlatformJsonLineServer(plugin)
    server.handle_message(
        _request(
            "handshake",
            "handshake",
            generation=0,
            params={
                "protocols": ["candlescope.plugin/2"],
                "host": {"name": "CandleScope", "version": "0.4.0"},
                "entrypointId": "main",
                "hostApis": [HOST_API_V1],
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
                "instanceId": "paper-instance",
                "generation": 1,
                "capabilities": [
                    {
                        "handle": f"cap-{item.id}",
                        "permissionId": item.id,
                        "scope": item.scope,
                    }
                    for item in manifest.permissions.required
                ],
            },
        )
    )
    return server


def _invoke(server: PlatformJsonLineServer, contribution_id: str, value: dict):
    return server.handle_message(
        _request(
            "invoke-" + value["operation"],
            "invoke",
            generation=1,
            params={
                "contributionId": contribution_id,
                "input": value,
                "requestContext": {
                    "contributionId": contribution_id,
                    "userAction": True,
                    "generation": 1,
                    "traceId": "paper-test",
                },
            },
        )
    )[0]["result"]


def _intent(idempotency_key: str = "submit-1") -> dict:
    return {
        "brokerId": "fixture-paper",
        "accountId": "paper-main",
        "clientOrderId": "client-1",
        "idempotencyKey": idempotency_key,
        "symbol": "BTCUSDT",
        "marketType": "spot",
        "side": "buy",
        "orderType": "market",
        "quantity": "0.01",
        "limitPrice": None,
        "quoteId": "quote-1",
        "observedMarketTimeMs": 1_700_000_000_000,
    }


def test_paper_manifest_is_paper_only_and_has_no_live_authority() -> None:
    manifest = paper_broker_manifest()
    assert {item.kind for item in manifest.contributions} == {
        "account-provider/1",
        "order-executor/1",
    }
    assert {item.id for item in manifest.permissions.required} == {
        "accounts.read",
        "trade.simulate",
    }
    assert not {
        "network.connect",
        "secrets.use",
        "trade.submit",
        "trade.cancel",
    } & {item.id for item in manifest.permissions.required}


def test_order_intent_requires_exact_shape_canonical_decimal_and_price_semantics() -> None:
    assert OrderIntent.from_wire(_intent()).to_wire() == _intent()
    for name, value in (
        ("quantity", "0.010"),
        ("quantity", 0.01),
        ("limitPrice", "100"),
    ):
        invalid = _intent()
        invalid[name] = value
        with pytest.raises(PlatformContractError):
            OrderIntent.from_wire(invalid)
    invalid = _intent()
    invalid["extra"] = True
    with pytest.raises(PlatformContractError):
        OrderIntent.from_wire(invalid)


def test_reference_executor_unknown_submit_requires_explicit_recovery() -> None:
    server = _server()
    intent = _intent("unknown-submit-1")
    submitted = _invoke(server, "executor", {"operation": "orders.submit", "intent": intent})
    assert submitted["schemaVersion"] == PAPER_EXECUTOR_ACK_V1
    assert submitted["status"] == "unknown"
    recovered = _invoke(
        server,
        "executor",
        {
            "operation": "orders.recover",
            "brokerId": "fixture-paper",
            "accountId": "paper-main",
            "idempotencyKey": "unknown-submit-1",
        },
    )
    assert (
        validate_paper_executor_ack(
            recovered,
            expected_operation="orders.recover",
            expected_broker_id="fixture-paper",
            expected_account_id="paper-main",
            expected_idempotency_key="unknown-submit-1",
        )["status"]
        == "accepted"
    )


def test_account_snapshot_is_exact_and_rejects_negative_balances() -> None:
    snapshot = _invoke(
        _server(),
        "accounts",
        {"operation": "accounts.snapshot", "brokerId": "fixture-paper", "accountId": "paper-main"},
    )
    assert validate_paper_account_snapshot(snapshot)["schemaVersion"] == PAPER_ACCOUNT_SNAPSHOT_V1
    invalid = copy.deepcopy(snapshot)
    invalid["balances"][0]["available"] = "-1"
    with pytest.raises(PlatformContractError):
        validate_paper_account_snapshot(invalid)
