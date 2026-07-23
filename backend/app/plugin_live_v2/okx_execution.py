"""Operation-specific OKX Demo Spot submit/cancel connector for WP-F."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from app.plugin_host.framing import JsonLineError, strict_json_loads

from .accounts import OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
from .errors import broker_error
from .execution import (
    DEMO_EXECUTION_INSTRUMENT,
    ExecutionMutationProof,
)
from .okx_readonly import (
    MAX_OKX_RESPONSE_BYTES,
    OKX_ORDER_CANCEL_PATH,
    OKX_ORDER_SUBMIT_PATH,
    OkxDemoCredential,
    OkxHttpResponse,
    OkxPinnedHttpsTransport,
    parse_okx_demo_credential,
)
from .shadow import ShadowOrderIntent


MAX_SUBMIT_EXPIRY_SECONDS = 5
_CLIENT_ORDER_ID = re.compile(r"^[A-Za-z0-9]{32}$")
_VENUE_ORDER_ID = re.compile(r"^[0-9]{1,32}$")
_VENUE_CODE = re.compile(r"^[0-9A-Z_-]{1,32}$")
_AMBIGUOUS_EXECUTION_CODES = frozenset({"50004"})


class OkxExecutionHttpTransport(Protocol):
    def post(
        self,
        target: str,
        *,
        headers: Mapping[str, str],
        body: bytes,
    ) -> OkxHttpResponse: ...


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise broker_error(
            "LIVE_EXECUTION_CLOCK_INVALID",
            "Demo execution clock must be timezone-aware",
            fatal=True,
        )
    return (
        value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )


def _canonical_json_bytes(value: Mapping[str, str]) -> bytes:
    return json.dumps(
        dict(value),
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def _signed_headers(
    credential: OkxDemoCredential,
    *,
    target: str,
    body: bytes,
    now: datetime,
    submit: bool,
) -> dict[str, str]:
    if target not in {OKX_ORDER_SUBMIT_PATH, OKX_ORDER_CANCEL_PATH}:
        raise broker_error(
            "LIVE_EXECUTION_PATH_DENIED",
            "Demo execution path is not pinned",
            fatal=True,
        )
    timestamp = _timestamp(now)
    prehash = timestamp.encode("ascii") + b"POST" + target.encode("ascii") + body
    signature = base64.b64encode(
        hmac.digest(
            credential.secret_key.encode("utf-8"),
            prehash,
            hashlib.sha256,
        )
    ).decode("ascii")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": credential.api_key,
        "OK-ACCESS-PASSPHRASE": credential.passphrase,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "User-Agent": "CandleScope-Live-Broker/1",
        "x-simulated-trading": "1",
    }
    if submit:
        expiry = now.astimezone(UTC) + timedelta(seconds=MAX_SUBMIT_EXPIRY_SECONDS)
        headers["expTime"] = str(int(expiry.timestamp() * 1000))
    return headers


def _payload(body: bytes) -> dict[str, Any]:
    try:
        value = strict_json_loads(
            body,
            max_message_bytes=MAX_OKX_RESPONSE_BYTES,
        )
    except JsonLineError as exc:
        raise broker_error(
            "LIVE_EXECUTION_RESPONSE_INVALID",
            "OKX execution response is not strict JSON",
            details={"frameCode": exc.code},
        ) from exc
    base = {"code", "msg", "data"}
    timed = base | {"inTime", "outTime"}
    if (
        not isinstance(value, dict)
        or set(value) not in {frozenset(base), frozenset(timed)}
        or not isinstance(value.get("code"), str)
        or _VENUE_CODE.fullmatch(value["code"]) is None
        or not isinstance(value.get("msg"), str)
        or len(value["msg"]) > 512
        or not isinstance(value.get("data"), list)
        or len(value["data"]) > 1
    ):
        raise broker_error(
            "LIVE_EXECUTION_RESPONSE_INVALID",
            "OKX execution response envelope is invalid",
        )
    if set(value) == timed and (
        not isinstance(value["inTime"], str)
        or not value["inTime"].isdigit()
        or not isinstance(value["outTime"], str)
        or not value["outTime"].isdigit()
    ):
        raise broker_error(
            "LIVE_EXECUTION_RESPONSE_INVALID",
            "OKX execution timing metadata is invalid",
        )
    return value


def _item(value: Any) -> dict[str, str]:
    allowed = {
        frozenset({"ordId", "clOrdId", "sCode", "sMsg", "ts"}),
        frozenset({"ordId", "clOrdId", "tag", "sCode", "sMsg", "ts"}),
    }
    if (
        not isinstance(value, dict)
        or frozenset(value) not in allowed
        or not all(isinstance(item, str) for item in value.values())
        or any(len(item) > 512 for item in value.values())
        or not value["ts"].isdigit()
        or _VENUE_CODE.fullmatch(value["sCode"]) is None
        or value.get("tag", "") != ""
    ):
        raise broker_error(
            "LIVE_EXECUTION_RESPONSE_INVALID",
            "OKX execution response item is invalid",
        )
    return value


def _proof(
    *,
    action: str,
    payload: dict[str, Any],
    instrument_id: str,
    client_order_id: str,
    observed_at: str,
) -> ExecutionMutationProof:
    if payload["code"] in _AMBIGUOUS_EXECUTION_CODES:
        raise broker_error(
            "LIVE_EXECUTION_RESULT_UNKNOWN",
            "OKX reported an ambiguous execution timeout",
            details={"venueCode": payload["code"]},
        )
    if payload["code"] != "0":
        if payload["data"]:
            raise broker_error(
                "LIVE_EXECUTION_RESPONSE_INVALID",
                "OKX rejected envelope contains ambiguous order data",
            )
        return ExecutionMutationProof(
            action=action,
            accepted=False,
            instrument_id=instrument_id,
            client_order_id=client_order_id,
            venue_order_id=None,
            venue_code=payload["code"],
            observed_at=observed_at,
        )
    if len(payload["data"]) != 1:
        raise broker_error(
            "LIVE_EXECUTION_RESPONSE_INVALID",
            "OKX execution response cardinality is invalid",
        )
    item = _item(payload["data"][0])
    returned_client = item["clOrdId"]
    if returned_client not in {"", client_order_id}:
        raise broker_error(
            "LIVE_EXECUTION_RESPONSE_INVALID",
            "OKX execution response changed the client order identity",
            fatal=True,
        )
    if item["sCode"] in _AMBIGUOUS_EXECUTION_CODES:
        raise broker_error(
            "LIVE_EXECUTION_RESULT_UNKNOWN",
            "OKX reported an ambiguous execution timeout",
            details={"venueCode": item["sCode"]},
        )
    if item["sCode"] != "0":
        if item["ordId"] != "":
            raise broker_error(
                "LIVE_EXECUTION_RESPONSE_INVALID",
                "OKX rejected execution returned a venue order identity",
            )
        return ExecutionMutationProof(
            action=action,
            accepted=False,
            instrument_id=instrument_id,
            client_order_id=client_order_id,
            venue_order_id=None,
            venue_code=item["sCode"],
            observed_at=observed_at,
        )
    if (
        returned_client != client_order_id
        or _VENUE_ORDER_ID.fullmatch(item["ordId"]) is None
        or item["sMsg"] != ""
    ):
        raise broker_error(
            "LIVE_EXECUTION_RESPONSE_INVALID",
            "OKX accepted execution identity is invalid",
            fatal=True,
        )
    return ExecutionMutationProof(
        action=action,
        accepted=True,
        instrument_id=instrument_id,
        client_order_id=client_order_id,
        venue_order_id=item["ordId"],
        venue_code="0",
        observed_at=observed_at,
    )


class OkxDemoSpotExecutionConnector:
    connector_id = OKX_DEMO_SPOT_EXECUTION_CONNECTOR_ID
    network_method_count = 2

    def __init__(
        self,
        *,
        transport: OkxExecutionHttpTransport | None = None,
        clock: Any = _utc_now,
    ) -> None:
        self._transport = transport or OkxPinnedHttpsTransport()
        self._clock = clock

    def submit(
        self,
        secret: bytearray,
        *,
        intent: ShadowOrderIntent,
        client_order_id: str,
    ) -> ExecutionMutationProof:
        if (
            intent.instrument_id != DEMO_EXECUTION_INSTRUMENT
            or intent.order_type != "limit"
            or _CLIENT_ORDER_ID.fullmatch(client_order_id) is None
        ):
            raise broker_error(
                "LIVE_EXECUTION_SUBMIT_PARAMS_INVALID",
                "Demo submit does not match the fixed Spot limit contract",
            )
        body = _canonical_json_bytes(
            {
                "clOrdId": client_order_id,
                "instId": intent.instrument_id,
                "ordType": "limit",
                "px": intent.limit_price,
                "side": intent.side,
                "sz": intent.quantity,
                "tdMode": "cash",
            }
        )
        credential = parse_okx_demo_credential(secret)
        try:
            now = self._clock()
            response = self._transport.post(
                OKX_ORDER_SUBMIT_PATH,
                headers=_signed_headers(
                    credential,
                    target=OKX_ORDER_SUBMIT_PATH,
                    body=body,
                    now=now,
                    submit=True,
                ),
                body=body,
            )
        finally:
            del credential
        observed_at = _timestamp(self._clock())
        return _proof(
            action="submit",
            payload=_payload(response.body),
            instrument_id=intent.instrument_id,
            client_order_id=client_order_id,
            observed_at=observed_at,
        )

    def cancel(
        self,
        secret: bytearray,
        *,
        instrument_id: str,
        client_order_id: str,
    ) -> ExecutionMutationProof:
        if (
            instrument_id != DEMO_EXECUTION_INSTRUMENT
            or _CLIENT_ORDER_ID.fullmatch(client_order_id) is None
        ):
            raise broker_error(
                "LIVE_EXECUTION_CANCEL_PARAMS_INVALID",
                "Demo cancel identity is invalid",
            )
        body = _canonical_json_bytes(
            {
                "clOrdId": client_order_id,
                "instId": instrument_id,
            }
        )
        credential = parse_okx_demo_credential(secret)
        try:
            now = self._clock()
            response = self._transport.post(
                OKX_ORDER_CANCEL_PATH,
                headers=_signed_headers(
                    credential,
                    target=OKX_ORDER_CANCEL_PATH,
                    body=body,
                    now=now,
                    submit=False,
                ),
                body=body,
            )
        finally:
            del credential
        observed_at = _timestamp(self._clock())
        return _proof(
            action="cancel",
            payload=_payload(response.body),
            instrument_id=instrument_id,
            client_order_id=client_order_id,
            observed_at=observed_at,
        )


__all__ = [
    "MAX_SUBMIT_EXPIRY_SECONDS",
    "OkxDemoSpotExecutionConnector",
    "OkxExecutionHttpTransport",
]
