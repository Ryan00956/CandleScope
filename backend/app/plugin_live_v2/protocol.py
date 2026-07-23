"""Strict private protocol for the staged Live Broker."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .errors import LiveBrokerError, broker_error


LIVE_BROKER_PROTOCOL_VERSION = "candlescope.live-broker/4"
MAX_BROKER_MESSAGE_BYTES = 128 * 1024
MAX_BROKER_SEQUENCE = (1 << 53) - 1

METHOD_BOOTSTRAP = "foundation.bootstrap"
METHOD_HEALTH = "foundation.health"
METHOD_POLICY_ADVANCE = "policy.advance"
METHOD_CREDENTIAL_PUT = "credential.put"
METHOD_CREDENTIAL_DESCRIBE = "credential.describe"
METHOD_CREDENTIAL_REVOKE = "credential.revoke"
METHOD_ACCOUNT_DISCOVER = "account.discover"
METHOD_ACCOUNT_DESCRIBE = "account.describe"
METHOD_ACCOUNT_REBIND = "account.rebind"
METHOD_SHADOW_PREPARE = "shadow.prepare"
METHOD_SHADOW_DESCRIBE = "shadow.describe"
METHOD_SHADOW_RECONCILE = "shadow.reconcile"
METHOD_CONTROL_STATUS = "control.status"
METHOD_CONTROL_SET = "control.set"
METHOD_CONTROL_KILL = "control.kill"
METHOD_AUTHORITY_REVOKE = "authority.revoke"
METHOD_CONFIRMATION_PREVIEW = "confirmation.preview"
METHOD_CONFIRMATION_ISSUE = "confirmation.issue"
METHOD_CONFIRMATION_DESCRIBE = "confirmation.describe"
METHOD_CONFIRMATION_REVOKE = "confirmation.revoke"
METHOD_AUDIT_EXPORT_PAGE = "audit.export.page"
METHOD_SHUTDOWN = "foundation.shutdown"

LIVE_BROKER_METHODS = frozenset(
    {
        METHOD_BOOTSTRAP,
        METHOD_HEALTH,
        METHOD_POLICY_ADVANCE,
        METHOD_CREDENTIAL_PUT,
        METHOD_CREDENTIAL_DESCRIBE,
        METHOD_CREDENTIAL_REVOKE,
        METHOD_ACCOUNT_DISCOVER,
        METHOD_ACCOUNT_DESCRIBE,
        METHOD_ACCOUNT_REBIND,
        METHOD_SHADOW_PREPARE,
        METHOD_SHADOW_DESCRIBE,
        METHOD_SHADOW_RECONCILE,
        METHOD_CONTROL_STATUS,
        METHOD_CONTROL_SET,
        METHOD_CONTROL_KILL,
        METHOD_AUTHORITY_REVOKE,
        METHOD_CONFIRMATION_PREVIEW,
        METHOD_CONFIRMATION_ISSUE,
        METHOD_CONFIRMATION_DESCRIBE,
        METHOD_CONFIRMATION_REVOKE,
        METHOD_AUDIT_EXPORT_PAGE,
        METHOD_SHUTDOWN,
    }
)

_SESSION_ID = re.compile(r"^sess_[A-Za-z0-9_-]{43}$")


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise broker_error(
            "LIVE_BROKER_PROTOCOL_INVALID",
            f"{label} must be an object",
            fatal=True,
        )
    return value


def _exact_fields(
    value: Mapping[str, Any],
    expected: set[str],
    label: str,
) -> None:
    if set(value) != expected:
        raise broker_error(
            "LIVE_BROKER_PROTOCOL_INVALID",
            f"{label} fields do not match the protocol",
            fatal=True,
            details={
                "missingFields": sorted(expected - set(value)),
                "unknownFields": sorted(set(value) - expected),
            },
        )


def _sequence(value: Any, label: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1 <= value <= MAX_BROKER_SEQUENCE
    ):
        raise broker_error(
            "LIVE_BROKER_PROTOCOL_INVALID",
            f"{label} is invalid",
            fatal=True,
        )
    return value


def _epoch(value: Any, label: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= MAX_BROKER_SEQUENCE
    ):
        raise broker_error(
            "LIVE_BROKER_PROTOCOL_INVALID",
            f"{label} is invalid",
            fatal=True,
        )
    return value


def _session(value: Any, label: str) -> str:
    if not isinstance(value, str) or _SESSION_ID.fullmatch(value) is None:
        raise broker_error(
            "LIVE_BROKER_PROTOCOL_INVALID",
            f"{label} is invalid",
            fatal=True,
        )
    return value


@dataclass(frozen=True, slots=True)
class BrokerRequest:
    sequence: int
    session_id: str
    method: str
    policy_epoch: int
    params: dict[str, Any]
    protocol_version: str = LIVE_BROKER_PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, value: Any) -> "BrokerRequest":
        data = _mapping(value, "Broker request")
        _exact_fields(
            data,
            {
                "protocolVersion",
                "sequence",
                "sessionId",
                "method",
                "policyEpoch",
                "params",
            },
            "Broker request",
        )
        if data["protocolVersion"] != LIVE_BROKER_PROTOCOL_VERSION:
            raise broker_error(
                "LIVE_BROKER_PROTOCOL_VERSION_REJECTED",
                "Broker protocol version is unsupported",
                fatal=True,
            )
        method = data["method"]
        if not isinstance(method, str) or method not in LIVE_BROKER_METHODS:
            raise broker_error(
                "LIVE_BROKER_METHOD_DENIED",
                "Broker method is not in the private allowlist",
                fatal=True,
            )
        params = _mapping(data["params"], "Broker request params")
        return cls(
            sequence=_sequence(data["sequence"], "Broker request sequence"),
            session_id=_session(data["sessionId"], "Broker request sessionId"),
            method=method,
            policy_epoch=_epoch(
                data["policyEpoch"], "Broker request policyEpoch"
            ),
            params=dict(params),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "protocolVersion": self.protocol_version,
            "sequence": self.sequence,
            "sessionId": self.session_id,
            "method": self.method,
            "policyEpoch": self.policy_epoch,
            "params": dict(self.params),
        }


@dataclass(frozen=True, slots=True)
class BrokerResponse:
    sequence: int
    policy_epoch: int
    ok: bool
    result: dict[str, Any] | None = None
    error: LiveBrokerError | None = None
    protocol_version: str = LIVE_BROKER_PROTOCOL_VERSION

    @classmethod
    def from_wire(cls, value: Any) -> "BrokerResponse":
        data = _mapping(value, "Broker response")
        common = {"protocolVersion", "sequence", "policyEpoch", "ok"}
        if data.get("ok") is True:
            _exact_fields(data, common | {"result"}, "Broker response")
            result = _mapping(data["result"], "Broker response result")
            error = None
        elif data.get("ok") is False:
            _exact_fields(data, common | {"error"}, "Broker response")
            raw_error = _mapping(data["error"], "Broker response error")
            required = {"code", "message", "fatal"}
            allowed = required | {"details"}
            if not required.issubset(raw_error) or not set(raw_error).issubset(allowed):
                raise broker_error(
                    "LIVE_BROKER_PROTOCOL_INVALID",
                    "Broker response error fields do not match the protocol",
                    fatal=True,
                )
            if (
                not isinstance(raw_error["code"], str)
                or not raw_error["code"]
                or not isinstance(raw_error["message"], str)
                or not raw_error["message"]
                or not isinstance(raw_error["fatal"], bool)
            ):
                raise broker_error(
                    "LIVE_BROKER_PROTOCOL_INVALID",
                    "Broker response error is invalid",
                    fatal=True,
                )
            details = raw_error.get("details", {})
            if not isinstance(details, Mapping):
                raise broker_error(
                    "LIVE_BROKER_PROTOCOL_INVALID",
                    "Broker response error details are invalid",
                    fatal=True,
                )
            error = LiveBrokerError(
                raw_error["code"],
                raw_error["message"],
                raw_error["fatal"],
                dict(details),
            )
            result = None
        else:
            raise broker_error(
                "LIVE_BROKER_PROTOCOL_INVALID",
                "Broker response ok flag is invalid",
                fatal=True,
            )
        if data["protocolVersion"] != LIVE_BROKER_PROTOCOL_VERSION:
            raise broker_error(
                "LIVE_BROKER_PROTOCOL_VERSION_REJECTED",
                "Broker response protocol version is unsupported",
                fatal=True,
            )
        return cls(
            sequence=_sequence(data["sequence"], "Broker response sequence"),
            policy_epoch=_epoch(
                data["policyEpoch"], "Broker response policyEpoch"
            ),
            ok=data["ok"],
            result=dict(result) if result is not None else None,
            error=error,
        )

    def to_wire(self) -> dict[str, Any]:
        common = {
            "protocolVersion": self.protocol_version,
            "sequence": self.sequence,
            "policyEpoch": self.policy_epoch,
            "ok": self.ok,
        }
        if self.ok:
            return {**common, "result": dict(self.result or {})}
        if self.error is None:
            raise ValueError("failed Broker response requires an error")
        return {**common, "error": self.error.to_wire()}


def success_response(
    sequence: int,
    policy_epoch: int,
    result: Mapping[str, Any] | None = None,
) -> BrokerResponse:
    return BrokerResponse(
        sequence=sequence,
        policy_epoch=policy_epoch,
        ok=True,
        result=dict(result or {}),
    )


def failure_response(
    sequence: int,
    policy_epoch: int,
    error: LiveBrokerError,
) -> BrokerResponse:
    return BrokerResponse(
        sequence=sequence,
        policy_epoch=policy_epoch,
        ok=False,
        error=error,
    )
