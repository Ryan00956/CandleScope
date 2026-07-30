"""Credential-free deterministic Paper broker reference for Phase 11A."""

from __future__ import annotations

import time
import uuid
from importlib.resources import files
from typing import Any

from ..errors import PlatformContractError
from ..json_codec import loads_strict
from ..models import (
    ActivationRequest,
    InvokeRequest,
    PluginManifest,
    RuntimeDescriptor,
    descriptor_from_manifest,
)
from ..paper import (
    PAPER_ACCOUNT_SNAPSHOT_V1,
    PAPER_EXECUTOR_ACK_V1,
    PaperAccountSnapshotRequest,
    PaperCancelRequest,
    PaperRecoverRequest,
    PaperSubmitRequest,
    parse_paper_operation,
)
from ..runtime import BasePlatformPlugin, InvocationOutcome
from ..server import serve_platform_plugin


def paper_broker_manifest() -> PluginManifest:
    resource = files(__package__).joinpath("paper-broker.manifest.json")
    return PluginManifest.from_wire(loads_strict(resource.read_bytes()))


class PaperBrokerPlugin(BasePlatformPlugin):
    def __init__(self) -> None:
        self._manifest = paper_broker_manifest()
        self._generation = 0
        self._submissions: dict[str, dict[str, str]] = {}
        self._cancellations: dict[str, dict[str, str]] = {}

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def activate(self, request: ActivationRequest) -> None:
        self._generation = request.generation

    def deactivate(self, reason: str) -> None:
        return None

    def health_check(self) -> dict[str, Any]:
        return {
            "status": "ready",
            "mode": "paper-only",
            "generation": self._generation,
            "knownSubmissions": len(self._submissions),
        }

    @staticmethod
    def _snapshot(request: PaperAccountSnapshotRequest) -> dict[str, Any]:
        if request.broker_id != "fixture-paper" or request.account_id != "paper-main":
            raise PlatformContractError("INVALID_CONTRACT", "fixture Paper account is unknown")
        return {
            "schemaVersion": PAPER_ACCOUNT_SNAPSHOT_V1,
            "environment": "paper",
            "brokerId": request.broker_id,
            "accountId": request.account_id,
            "baseCurrency": "USDT",
            "asOfMs": int(time.time() * 1_000),
            "balances": [
                {"asset": "BTC", "available": "2", "locked": "0"},
                {"asset": "USDT", "available": "100000", "locked": "0"},
            ],
            "positions": [],
            "orders": [],
        }

    @staticmethod
    def _ack(
        *,
        operation: str,
        broker_id: str,
        account_id: str,
        idempotency_key: str,
        status: str,
        executor_order_id: str | None = None,
        reason_code: str | None = None,
    ) -> dict[str, Any]:
        return {
            "schemaVersion": PAPER_EXECUTOR_ACK_V1,
            "operation": operation,
            "status": status,
            "brokerId": broker_id,
            "accountId": account_id,
            "idempotencyKey": idempotency_key,
            "executorOrderId": executor_order_id,
            "reasonCode": reason_code,
        }

    def _submit(self, request: PaperSubmitRequest) -> dict[str, Any]:
        intent = request.intent
        if intent.broker_id != "fixture-paper" or intent.account_id != "paper-main":
            raise PlatformContractError("INVALID_CONTRACT", "fixture Paper target is unknown")
        if intent.idempotency_key.startswith("reject-"):
            return self._ack(
                operation="orders.submit",
                broker_id=intent.broker_id,
                account_id=intent.account_id,
                idempotency_key=intent.idempotency_key,
                status="rejected",
                reason_code="FIXTURE_REJECTED",
            )
        executor_id = self._submissions.setdefault(
            intent.idempotency_key,
            {"executorOrderId": "fixture-" + uuid.uuid4().hex},
        )["executorOrderId"]
        if intent.idempotency_key.startswith("unknown-"):
            return self._ack(
                operation="orders.submit",
                broker_id=intent.broker_id,
                account_id=intent.account_id,
                idempotency_key=intent.idempotency_key,
                status="unknown",
            )
        return self._ack(
            operation="orders.submit",
            broker_id=intent.broker_id,
            account_id=intent.account_id,
            idempotency_key=intent.idempotency_key,
            status="accepted",
            executor_order_id=executor_id,
        )

    def _cancel(self, request: PaperCancelRequest) -> dict[str, Any]:
        existing = self._cancellations.get(request.idempotency_key)
        if existing is not None and existing["orderId"] != request.order_id:
            return self._ack(
                operation="orders.cancel",
                broker_id=request.broker_id,
                account_id=request.account_id,
                idempotency_key=request.idempotency_key,
                status="rejected",
                reason_code="FIXTURE_CANCEL_IDEMPOTENCY_CONFLICT",
            )
        self._cancellations.setdefault(
            request.idempotency_key,
            {"orderId": request.order_id},
        )
        return self._ack(
            operation="orders.cancel",
            broker_id=request.broker_id,
            account_id=request.account_id,
            idempotency_key=request.idempotency_key,
            status="accepted",
            executor_order_id=request.order_id,
        )

    def _recover(self, request: PaperRecoverRequest) -> dict[str, Any]:
        records = (
            self._cancellations
            if request.target_operation == "orders.cancel"
            else self._submissions
        )
        record = records.get(request.idempotency_key)
        if (
            record is not None
            and request.target_operation == "orders.cancel"
            and record["orderId"] != request.order_id
        ):
            record = None
        if record is None:
            return self._ack(
                operation="orders.recover",
                broker_id=request.broker_id,
                account_id=request.account_id,
                idempotency_key=request.idempotency_key,
                status="rejected",
                reason_code=(
                    "FIXTURE_UNKNOWN_CANCEL"
                    if request.target_operation == "orders.cancel"
                    else "FIXTURE_UNKNOWN_SUBMISSION"
                ),
            )
        return self._ack(
            operation="orders.recover",
            broker_id=request.broker_id,
            account_id=request.account_id,
            idempotency_key=request.idempotency_key,
            status="accepted",
            executor_order_id=(
                record["orderId"]
                if request.target_operation == "orders.cancel"
                else record["executorOrderId"]
            ),
        )

    def invoke(self, request: InvokeRequest) -> InvocationOutcome:
        operation = parse_paper_operation(request.input)
        if request.contribution_id == "accounts" and isinstance(
            operation, PaperAccountSnapshotRequest
        ):
            return self._snapshot(operation)
        if request.contribution_id != "executor":
            raise PlatformContractError(
                "INVALID_CONTRACT", "Paper contribution and operation do not match"
            )
        if isinstance(operation, PaperSubmitRequest):
            return self._submit(operation)
        if isinstance(operation, PaperCancelRequest):
            return self._cancel(operation)
        if isinstance(operation, PaperRecoverRequest):
            return self._recover(operation)
        raise PlatformContractError(
            "INVALID_CONTRACT", "Paper operation is unsupported by this contribution"
        )


def main() -> int:
    return serve_platform_plugin(PaperBrokerPlugin())


if __name__ == "__main__":
    raise SystemExit(main())
