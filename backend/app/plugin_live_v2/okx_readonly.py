"""Operation-specific OKX Demo read-only account connector."""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import re
import socket
import ssl
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from datetime import UTC, datetime
from typing import Any, Protocol

from app.plugin_host.framing import JsonLineError, strict_json_loads

from .accounts import (
    OKX_DEMO_SPOT_READONLY_CONNECTOR_ID,
    ReadOnlyAccountProof,
)
from .errors import broker_error
from .shadow import OrderQueryProof


OKX_DEMO_HOST = "openapi.okx.com"
OKX_DEMO_PORT = 443
OKX_ACCOUNT_CONFIG_PATH = "/api/v5/account/config"
OKX_ACCOUNT_BALANCE_PATH = "/api/v5/account/balance"
OKX_ORDER_QUERY_PATH = "/api/v5/trade/order"
OKX_READONLY_PATHS = frozenset(
    {OKX_ACCOUNT_CONFIG_PATH, OKX_ACCOUNT_BALANCE_PATH}
)
OKX_CREDENTIAL_SCHEMA_VERSION = 1
MAX_OKX_CREDENTIAL_BYTES = 16 * 1024
MAX_OKX_RESPONSE_BYTES = 1024 * 1024
DEFAULT_OKX_TIMEOUT_SECONDS = 4.0

_KEY = re.compile(r"^[A-Za-z0-9_+/=-]{8,256}$")
_VENUE_ACCOUNT_ID = re.compile(r"^[0-9]{1,32}$")
_ASSET = re.compile(r"^[A-Z0-9]{1,20}$")
_INSTRUMENT_ID = re.compile(r"^[A-Z0-9]{2,20}-[A-Z0-9]{2,20}$")
_CLIENT_ORDER_ID = re.compile(r"^[A-Za-z0-9]{32}$")
_ORDER_QUERY_TARGET = re.compile(
    r"^/api/v5/trade/order\?"
    r"instId=(?P<instrument>[A-Z0-9]{2,20}-[A-Z0-9]{2,20})"
    r"&clOrdId=(?P<client>[A-Za-z0-9]{32})$"
)
_VENUE_ORDER_ID = re.compile(r"^[0-9]{1,32}$")
_VENUE_DECIMAL = re.compile(r"^(?:0|[1-9][0-9]{0,30})(?:\.[0-9]{1,30})?$")


@dataclass(frozen=True, slots=True, repr=False)
class OkxDemoCredential:
    api_key: str
    secret_key: str
    passphrase: str

    def __repr__(self) -> str:
        return "OkxDemoCredential(<redacted>)"


@dataclass(frozen=True, slots=True)
class OkxHttpResponse:
    status: int
    headers: tuple[tuple[str, str], ...]
    body: bytes


class OkxHttpTransport(Protocol):
    def get(
        self,
        path: str,
        *,
        headers: Mapping[str, str],
    ) -> OkxHttpResponse: ...


Resolver = Callable[[str, int], tuple[str, ...]]
Clock = Callable[[], datetime]


def build_okx_order_query_target(
    instrument_id: str,
    client_order_id: str,
) -> str:
    if (
        not isinstance(instrument_id, str)
        or _INSTRUMENT_ID.fullmatch(instrument_id) is None
        or not isinstance(client_order_id, str)
        or _CLIENT_ORDER_ID.fullmatch(client_order_id) is None
    ):
        raise broker_error(
            "LIVE_SHADOW_QUERY_PARAMS_INVALID",
            "OKX order query identity is invalid",
        )
    return (
        f"{OKX_ORDER_QUERY_PATH}"
        f"?instId={instrument_id}&clOrdId={client_order_id}"
    )


def _allowed_get_target(target: str) -> bool:
    return (
        target in OKX_READONLY_PATHS
        or (
            isinstance(target, str)
            and _ORDER_QUERY_TARGET.fullmatch(target) is not None
        )
    )


def encode_okx_demo_credential(
    *,
    api_key: str,
    secret_key: str,
    passphrase: str,
) -> bytes:
    credential = _validated_credential(api_key, secret_key, passphrase)
    return json.dumps(
        {
            "schemaVersion": OKX_CREDENTIAL_SCHEMA_VERSION,
            "venue": "okx",
            "environment": "demo",
            "apiKey": credential.api_key,
            "secretKey": credential.secret_key,
            "passphrase": credential.passphrase,
        },
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def _secret_field(value: Any) -> str:
    if (
        not isinstance(value, str)
        or _KEY.fullmatch(value) is None
        or any(ord(character) < 0x20 for character in value)
    ):
        raise broker_error(
            "LIVE_ACCOUNT_CREDENTIAL_INVALID",
            "OKX Demo credential envelope is invalid",
        )
    return value


def _passphrase(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > 128
        or any(ord(character) < 0x20 for character in value)
    ):
        raise broker_error(
            "LIVE_ACCOUNT_CREDENTIAL_INVALID",
            "OKX Demo credential envelope is invalid",
        )
    return value


def _validated_credential(
    api_key: Any,
    secret_key: Any,
    passphrase: Any,
) -> OkxDemoCredential:
    return OkxDemoCredential(
        api_key=_secret_field(api_key),
        secret_key=_secret_field(secret_key),
        passphrase=_passphrase(passphrase),
    )


def parse_okx_demo_credential(secret: bytes | bytearray) -> OkxDemoCredential:
    if (
        not isinstance(secret, (bytes, bytearray))
        or not 1 <= len(secret) <= MAX_OKX_CREDENTIAL_BYTES
    ):
        raise broker_error(
            "LIVE_ACCOUNT_CREDENTIAL_INVALID",
            "OKX Demo credential envelope is invalid",
        )
    try:
        value = strict_json_loads(
            bytes(secret),
            max_message_bytes=MAX_OKX_CREDENTIAL_BYTES,
        )
    except JsonLineError as exc:
        raise broker_error(
            "LIVE_ACCOUNT_CREDENTIAL_INVALID",
            "OKX Demo credential envelope is invalid",
            details={"frameCode": exc.code},
        ) from exc
    expected = {
        "schemaVersion",
        "venue",
        "environment",
        "apiKey",
        "secretKey",
        "passphrase",
    }
    if (
        not isinstance(value, dict)
        or set(value) != expected
        or value["schemaVersion"] != OKX_CREDENTIAL_SCHEMA_VERSION
        or value["venue"] != "okx"
        or value["environment"] != "demo"
    ):
        raise broker_error(
            "LIVE_ACCOUNT_CREDENTIAL_INVALID",
            "OKX Demo credential envelope is invalid",
        )
    return _validated_credential(
        value["apiKey"],
        value["secretKey"],
        value["passphrase"],
    )


def _validated_public_addresses(values: Any) -> tuple[str, ...]:
    if not isinstance(values, (set, tuple, list)) or not values:
        raise broker_error(
            "LIVE_ACCOUNT_DNS_FAILED",
            "read-only account DNS resolution returned no addresses",
        )
    normalized = sorted(set(values))
    if not all(isinstance(value, str) and value for value in normalized):
        raise broker_error(
            "LIVE_ACCOUNT_DNS_REJECTED",
            "read-only account DNS returned an invalid address",
            fatal=True,
        )
    parsed: list[str] = []
    for value in normalized:
        try:
            address = ipaddress.ip_address(value)
        except ValueError as exc:
            raise broker_error(
                "LIVE_ACCOUNT_DNS_REJECTED",
                "read-only account DNS returned an invalid address",
                fatal=True,
            ) from exc
        if not address.is_global:
            raise broker_error(
                "LIVE_ACCOUNT_DNS_REJECTED",
                "read-only account DNS returned a non-public address",
                fatal=True,
            )
        parsed.append(str(address))
    return tuple(parsed)


def resolve_public_okx_addresses(
    host: str,
    port: int,
) -> tuple[str, ...]:
    if host != OKX_DEMO_HOST or port != OKX_DEMO_PORT:
        raise broker_error(
            "LIVE_ACCOUNT_ORIGIN_DENIED",
            "read-only account origin is not pinned",
            fatal=True,
        )
    try:
        values = {
            item[4][0]
            for item in socket.getaddrinfo(
                host,
                port,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
                proto=socket.IPPROTO_TCP,
            )
        }
    except OSError as exc:
        raise broker_error(
            "LIVE_ACCOUNT_DNS_FAILED",
            "read-only account DNS resolution failed",
            details={"errorType": type(exc).__name__},
        ) from exc
    return _validated_public_addresses(values)


class _PinnedOkxHttpsConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        *,
        resolved_ip: str,
        timeout_seconds: float,
    ) -> None:
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        super().__init__(
            OKX_DEMO_HOST,
            OKX_DEMO_PORT,
            timeout=timeout_seconds,
            context=context,
        )
        self._resolved_ip = resolved_ip

    def connect(self) -> None:
        raw = socket.create_connection(
            (self._resolved_ip, OKX_DEMO_PORT),
            self.timeout,
        )
        try:
            self.sock = self._context.wrap_socket(
                raw,
                server_hostname=OKX_DEMO_HOST,
            )
        except BaseException:
            raw.close()
            raise


class OkxPinnedHttpsTransport:
    def __init__(
        self,
        *,
        resolver: Resolver = resolve_public_okx_addresses,
        timeout_seconds: float = DEFAULT_OKX_TIMEOUT_SECONDS,
    ) -> None:
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not 0.1 <= float(timeout_seconds) <= 10.0
        ):
            raise ValueError("OKX timeout is outside the supported range")
        self._resolver = resolver
        self._timeout_seconds = float(timeout_seconds)

    def get(
        self,
        target: str,
        *,
        headers: Mapping[str, str],
    ) -> OkxHttpResponse:
        if not _allowed_get_target(target):
            raise broker_error(
                "LIVE_ACCOUNT_PATH_DENIED",
                "read-only account path is not pinned",
                fatal=True,
            )
        expected_headers = {
            "Accept",
            "OK-ACCESS-KEY",
            "OK-ACCESS-PASSPHRASE",
            "OK-ACCESS-SIGN",
            "OK-ACCESS-TIMESTAMP",
            "User-Agent",
            "x-simulated-trading",
        }
        if (
            set(headers) != expected_headers
            or headers.get("x-simulated-trading") != "1"
        ):
            raise broker_error(
                "LIVE_ACCOUNT_HEADERS_DENIED",
                "read-only account headers do not match the pinned contract",
                fatal=True,
            )
        addresses = _validated_public_addresses(
            self._resolver(OKX_DEMO_HOST, OKX_DEMO_PORT)
        )
        connection = _PinnedOkxHttpsConnection(
            resolved_ip=addresses[0],
            timeout_seconds=self._timeout_seconds,
        )
        try:
            connection.request("GET", target, headers=dict(headers))
            response = connection.getresponse()
            body = response.read(MAX_OKX_RESPONSE_BYTES + 1)
            response_headers = tuple(response.getheaders())
        except (
            OSError,
            TimeoutError,
            ssl.SSLError,
            http.client.HTTPException,
        ) as exc:
            raise broker_error(
                "LIVE_ACCOUNT_TRANSPORT_FAILED",
                "read-only account HTTPS request failed",
                details={"errorType": type(exc).__name__},
            ) from exc
        finally:
            connection.close()
        if len(body) > MAX_OKX_RESPONSE_BYTES:
            raise broker_error(
                "LIVE_ACCOUNT_RESPONSE_LIMIT",
                "read-only account response exceeded its hard limit",
            )
        if response.status != 200:
            raise broker_error(
                "LIVE_ACCOUNT_HTTP_REJECTED",
                "read-only account endpoint returned a non-success status",
                details={"status": response.status},
            )
        content_types = [
            value
            for key, value in response_headers
            if key.casefold() == "content-type"
        ]
        if (
            len(content_types) != 1
            or content_types[0].split(";", 1)[0].strip().casefold()
            != "application/json"
        ):
            raise broker_error(
                "LIVE_ACCOUNT_CONTENT_TYPE_REJECTED",
                "read-only account response is not JSON",
            )
        return OkxHttpResponse(response.status, response_headers, body)


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _timestamp(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise broker_error(
            "LIVE_ACCOUNT_CLOCK_INVALID",
            "read-only account clock must be timezone-aware",
            fatal=True,
        )
    return (
        value.astimezone(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _okx_payload(body: bytes, label: str) -> list[Any]:
    try:
        value = strict_json_loads(
            body,
            max_message_bytes=MAX_OKX_RESPONSE_BYTES,
        )
    except JsonLineError as exc:
        raise broker_error(
            "LIVE_ACCOUNT_RESPONSE_INVALID",
            f"{label} response is not strict JSON",
            details={"frameCode": exc.code},
        ) from exc
    if (
        not isinstance(value, dict)
        or set(value) != {"code", "msg", "data"}
        or value["code"] != "0"
        or not isinstance(value["msg"], str)
        or not isinstance(value["data"], list)
    ):
        raise broker_error(
            "LIVE_ACCOUNT_RESPONSE_INVALID",
            f"{label} response envelope is invalid",
        )
    return value["data"]


def _bounded_text(value: Any, label: str, *, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or any(ord(character) < 0x20 for character in value)
    ):
        raise broker_error(
            "LIVE_ACCOUNT_RESPONSE_INVALID",
            f"{label} is invalid",
        )
    return value


def _canonical_venue_decimal(
    value: Any,
    label: str,
    *,
    allow_zero: bool,
) -> str:
    if not isinstance(value, str) or _VENUE_DECIMAL.fullmatch(value) is None:
        raise broker_error(
            "LIVE_SHADOW_QUERY_RESPONSE_INVALID",
            f"{label} is invalid",
        )
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise broker_error(
            "LIVE_SHADOW_QUERY_RESPONSE_INVALID",
            f"{label} is invalid",
        ) from exc
    if parsed < 0 or (parsed == 0 and not allow_zero):
        raise broker_error(
            "LIVE_SHADOW_QUERY_RESPONSE_INVALID",
            f"{label} is invalid",
        )
    canonical = format(parsed, "f")
    if "." in canonical:
        canonical = canonical.rstrip("0").rstrip(".")
    return canonical


def _signed_headers(
    credential: OkxDemoCredential,
    target: str,
    timestamp: str,
) -> dict[str, str]:
    if not _allowed_get_target(target):
        raise broker_error(
            "LIVE_ACCOUNT_PATH_DENIED",
            "read-only account path is not pinned",
            fatal=True,
        )
    prehash = f"{timestamp}GET{target}".encode("ascii")
    signature = base64.b64encode(
        hmac.digest(
            credential.secret_key.encode("utf-8"),
            prehash,
            hashlib.sha256,
        )
    ).decode("ascii")
    return {
        "Accept": "application/json",
        "OK-ACCESS-KEY": credential.api_key,
        "OK-ACCESS-PASSPHRASE": credential.passphrase,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "User-Agent": "CandleScope-Live-Broker/1",
        "x-simulated-trading": "1",
    }


class OkxDemoReadOnlyConnector:
    connector_id = OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
    network_method_count = 2

    def __init__(
        self,
        *,
        transport: OkxHttpTransport | None = None,
        clock: Clock = _utc_now,
    ) -> None:
        self._transport = transport or OkxPinnedHttpsTransport()
        self._clock = clock

    def _get(
        self,
        credential: OkxDemoCredential,
        path: str,
    ) -> list[Any]:
        timestamp = _timestamp(self._clock())
        response = self._transport.get(
            path,
            headers=_signed_headers(credential, path, timestamp),
        )
        return _okx_payload(response.body, path)

    def discover(self, secret: bytearray) -> ReadOnlyAccountProof:
        credential = parse_okx_demo_credential(secret)
        try:
            config_data = self._get(credential, OKX_ACCOUNT_CONFIG_PATH)
            balance_data = self._get(credential, OKX_ACCOUNT_BALANCE_PATH)
        finally:
            del credential
        if len(config_data) != 1 or not isinstance(config_data[0], dict):
            raise broker_error(
                "LIVE_ACCOUNT_RESPONSE_INVALID",
                "OKX account configuration cardinality is invalid",
            )
        config = config_data[0]
        uid = _bounded_text(config.get("uid"), "OKX uid", maximum=32)
        main_uid = _bounded_text(
            config.get("mainUid"),
            "OKX mainUid",
            maximum=32,
        )
        if (
            _VENUE_ACCOUNT_ID.fullmatch(uid) is None
            or _VENUE_ACCOUNT_ID.fullmatch(main_uid) is None
        ):
            raise broker_error(
                "LIVE_ACCOUNT_RESPONSE_INVALID",
                "OKX account identity is invalid",
            )
        permission_value = _bounded_text(
            config.get("perm"),
            "OKX credential permission",
            maximum=64,
        )
        permissions = permission_value.split(",")
        if (
            any(not item or item != item.strip() for item in permissions)
            or len(permissions) != len(set(permissions))
            or set(permissions) != {"read_only"}
        ):
            raise broker_error(
                "LIVE_ACCOUNT_PERMISSION_REJECTED",
                "OKX credential must have read_only permission only",
            )
        if config.get("acctLv") != "1":
            raise broker_error(
                "LIVE_ACCOUNT_SCOPE_REJECTED",
                "OKX Demo account is not in spot mode",
            )
        position_mode = _bounded_text(
            config.get("posMode"),
            "OKX position mode",
            maximum=32,
        )
        if position_mode not in {"net_mode", "long_short_mode"}:
            raise broker_error(
                "LIVE_ACCOUNT_RESPONSE_INVALID",
                "OKX position mode is unsupported",
            )
        if len(balance_data) != 1 or not isinstance(balance_data[0], dict):
            raise broker_error(
                "LIVE_ACCOUNT_RESPONSE_INVALID",
                "OKX balance cardinality is invalid",
            )
        details = balance_data[0].get("details")
        if not isinstance(details, list) or len(details) > 10_000:
            raise broker_error(
                "LIVE_ACCOUNT_RESPONSE_INVALID",
                "OKX balance details are invalid",
            )
        assets: set[str] = set()
        for item in details:
            if not isinstance(item, dict):
                raise broker_error(
                    "LIVE_ACCOUNT_RESPONSE_INVALID",
                    "OKX balance asset is invalid",
                )
            asset = item.get("ccy")
            if not isinstance(asset, str) or _ASSET.fullmatch(asset) is None:
                raise broker_error(
                    "LIVE_ACCOUNT_RESPONSE_INVALID",
                    "OKX balance asset is invalid",
                )
            if asset in assets:
                raise broker_error(
                    "LIVE_ACCOUNT_RESPONSE_INVALID",
                    "OKX balance contains duplicate assets",
                )
            assets.add(asset)
        canonical = (
            "okx\0demo\0spot\0" + main_uid + "\0" + uid
        ).encode("ascii")
        return ReadOnlyAccountProof(
            connector_id=self.connector_id,
            venue="okx",
            environment="demo",
            product_scope="spot",
            canonical_account_sha256=(
                f"sha256:{hashlib.sha256(canonical).hexdigest()}"
            ),
            permission="read_only",
            account_mode="spot",
            position_mode=position_mode,
            asset_count=len(assets),
            observed_at=_timestamp(self._clock()),
        )


class OkxDemoOrderQueryConnector:
    connector_id = OKX_DEMO_SPOT_READONLY_CONNECTOR_ID
    network_method_count = 1

    def __init__(
        self,
        *,
        transport: OkxHttpTransport | None = None,
        clock: Clock = _utc_now,
    ) -> None:
        self._transport = transport or OkxPinnedHttpsTransport()
        self._clock = clock

    @staticmethod
    def _payload(body: bytes) -> dict[str, Any]:
        try:
            value = strict_json_loads(
                body,
                max_message_bytes=MAX_OKX_RESPONSE_BYTES,
            )
        except JsonLineError as exc:
            raise broker_error(
                "LIVE_SHADOW_QUERY_RESPONSE_INVALID",
                "OKX order query response is not strict JSON",
                details={"frameCode": exc.code},
            ) from exc
        base = {"code", "msg", "data"}
        timed = base | {"inTime", "outTime"}
        if (
            not isinstance(value, dict)
            or set(value) not in {frozenset(base), frozenset(timed)}
            or not isinstance(value.get("code"), str)
            or not isinstance(value.get("msg"), str)
            or not isinstance(value.get("data"), list)
        ):
            raise broker_error(
                "LIVE_SHADOW_QUERY_RESPONSE_INVALID",
                "OKX order query response envelope is invalid",
            )
        if set(value) == timed and (
            not isinstance(value["inTime"], str)
            or not value["inTime"].isdigit()
            or not isinstance(value["outTime"], str)
            or not value["outTime"].isdigit()
        ):
            raise broker_error(
                "LIVE_SHADOW_QUERY_RESPONSE_INVALID",
                "OKX order query timing metadata is invalid",
            )
        return value

    def query_order(
        self,
        secret: bytearray,
        *,
        instrument_id: str,
        client_order_id: str,
    ) -> OrderQueryProof:
        target = build_okx_order_query_target(
            instrument_id,
            client_order_id,
        )
        credential = parse_okx_demo_credential(secret)
        try:
            timestamp = _timestamp(self._clock())
            response = self._transport.get(
                target,
                headers=_signed_headers(credential, target, timestamp),
            )
        finally:
            del credential
        payload = self._payload(response.body)
        if payload["code"] != "0":
            raise broker_error(
                "LIVE_SHADOW_QUERY_UNRESOLVED",
                "OKX could not prove the shadow order state",
                details={"venueCode": payload["code"][:32]},
            )
        data = payload["data"]
        if len(data) != 1 or not isinstance(data[0], dict):
            raise broker_error(
                "LIVE_SHADOW_QUERY_RESPONSE_INVALID",
                "OKX order query cardinality is invalid",
            )
        item = data[0]
        returned_instrument = _bounded_text(
            item.get("instId"),
            "OKX order instrument",
            maximum=41,
        )
        returned_client = _bounded_text(
            item.get("clOrdId"),
            "OKX client order identity",
            maximum=32,
        )
        venue_order_id = _bounded_text(
            item.get("ordId"),
            "OKX venue order identity",
            maximum=32,
        )
        state = _bounded_text(
            item.get("state"),
            "OKX order state",
            maximum=32,
        )
        if (
            returned_instrument != instrument_id
            or returned_client != client_order_id
            or _VENUE_ORDER_ID.fullmatch(venue_order_id) is None
            or state
            not in {
                "live",
                "partially_filled",
                "filled",
                "canceled",
                "mmp_canceled",
            }
        ):
            raise broker_error(
                "LIVE_SHADOW_QUERY_RESPONSE_INVALID",
                "OKX order query identity or state is invalid",
            )
        accumulated = _canonical_venue_decimal(
            item.get("accFillSz"),
            "OKX accumulated fill size",
            allow_zero=True,
        )
        average_raw = item.get("avgPx")
        average = (
            None
            if average_raw == ""
            else _canonical_venue_decimal(
                average_raw,
                "OKX average fill price",
                allow_zero=False,
            )
        )
        try:
            return OrderQueryProof(
                connector_id=self.connector_id,
                instrument_id=returned_instrument,
                client_order_id=returned_client,
                venue_order_id=venue_order_id,
                state=state,
                accumulated_fill_size=accumulated,
                average_price=average,
                observed_at=_timestamp(self._clock()),
            )
        except ValueError as exc:
            raise broker_error(
                "LIVE_SHADOW_QUERY_RESPONSE_INVALID",
                "OKX order query fill metadata is inconsistent",
            ) from exc
