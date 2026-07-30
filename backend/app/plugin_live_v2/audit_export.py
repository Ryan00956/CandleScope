"""Offline-verifiable redacted export contract for WP-E Live authority."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any


LIVE_AUDIT_EXPORT_SCHEMA = "candlescope.live-audit-export/1"
LIVE_AUDIT_EXPORT_SCHEMA_V2 = "candlescope.live-audit-export/2"
_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_OPAQUE_REF = re.compile(
    r"(?:cred|acct|shdw)_[A-Za-z0-9_-]{43}|livecfm_[A-Za-z0-9_-]{43}"
)
_FORBIDDEN_KEYS = frozenset(
    {
        "accountRef",
        "authorization",
        "credentialHandle",
        "credentialMaterial",
        "headers",
        "passphrase",
        "rawNetworkResponse",
        "rawResponse",
        "receiptRef",
        "secret",
        "secretBase64",
        "shadowRef",
        "signature",
        "venueOrderId",
    }
)


class LiveAuditExportError(ValueError):
    pass


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _sha256_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise LiveAuditExportError(f"{label} must be an object")
    return value


def _exact(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise LiveAuditExportError(f"{label} fields are invalid")


def _integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise LiveAuditExportError(f"{label} is invalid")
    return value


def _digest(value: Any, label: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise LiveAuditExportError(f"{label} is invalid")
    return value


def _scan_redaction(value: Any, *, path: str = "export") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str) or key in _FORBIDDEN_KEYS:
                raise LiveAuditExportError(f"{path} contains a forbidden field")
            _scan_redaction(item, path=f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _scan_redaction(item, path=f"{path}[{index}]")
    elif isinstance(value, str) and _OPAQUE_REF.search(value):
        raise LiveAuditExportError(f"{path} contains an opaque reference")


def _head(value: Any, label: str) -> tuple[int, str | None]:
    data = _mapping(value, label)
    _exact(data, {"sequence", "sha256"}, label)
    sequence = _integer(data["sequence"], f"{label}.sequence")
    digest = _digest(data["sha256"], f"{label}.sha256", nullable=True)
    if (sequence == 0) != (digest is None):
        raise LiveAuditExportError(f"{label} is inconsistent")
    return sequence, digest


def _verify_source_chain(
    events: Any,
    *,
    label: str,
    head: tuple[int, str | None],
    shadow: bool,
) -> None:
    if not isinstance(events, list):
        raise LiveAuditExportError(f"{label} must be an array")
    previous: str | None = None
    for expected_sequence, raw in enumerate(events, start=1):
        if shadow:
            item = _mapping(raw, f"{label}[{expected_sequence - 1}]")
            _exact(item, {"event", "record"}, f"{label} item")
            event = _mapping(item["event"], f"{label} event")
            record = item["record"]
            if record is not None:
                record_data = _mapping(record, f"{label} record")
                if "venueOrderId" in record_data:
                    raise LiveAuditExportError(
                        "shadow record contains raw venue identity"
                    )
                venue_digest = record_data.get("venueOrderIdSha256")
                if venue_digest is not None:
                    _digest(venue_digest, "shadow venueOrderIdSha256")
        else:
            event = _mapping(raw, f"{label}[{expected_sequence - 1}]")
        expected = {
            "schemaVersion",
            "sequence",
            "eventType",
            "payload",
            "occurredAt",
            "previousSha256",
            "eventSha256",
        }
        if shadow:
            expected.add("recordId")
        _exact(event, expected, f"{label} event")
        if (
            event["schemaVersion"] != 1
            or _integer(event["sequence"], f"{label}.sequence")
            != expected_sequence
            or not isinstance(event["eventType"], str)
            or not event["eventType"]
            or not isinstance(event["payload"], Mapping)
            or not isinstance(event["occurredAt"], str)
            or not event["occurredAt"]
            or event["previousSha256"] != previous
        ):
            raise LiveAuditExportError(f"{label} event is invalid")
        if shadow and (
            not isinstance(event["recordId"], str)
            or re.fullmatch(r"[0-9a-f]{32}", event["recordId"]) is None
        ):
            raise LiveAuditExportError("shadow record identity is invalid")
        body = {
            "schemaVersion": event["schemaVersion"],
            "sequence": event["sequence"],
            **({"recordId": event["recordId"]} if shadow else {}),
            "eventType": event["eventType"],
            "payload": event["payload"],
            "occurredAt": event["occurredAt"],
            "previousSha256": event["previousSha256"],
        }
        actual = _sha256_text(_canonical_json(body))
        if event["eventSha256"] != actual:
            raise LiveAuditExportError(f"{label} event hash is invalid")
        previous = actual
    if len(events) != head[0] or previous != head[1]:
        raise LiveAuditExportError(f"{label} head is invalid")


def verify_live_audit_export(value: Any) -> dict[str, Any]:
    """Validate the export digest, both source chains, and redaction contract."""

    data = dict(_mapping(value, "Live audit export"))
    schema_version = data.get("schemaVersion")
    expected = {
        "schemaVersion",
        "generatedAt",
        "brokerIdSha256",
        "policyEpoch",
        "controlStatus",
        "controlHead",
        "shadowHead",
        "controlEvents",
        "shadowEvents",
        "redaction",
        "liveMutationMethodsAvailable",
        "exportSha256",
    }
    if schema_version == LIVE_AUDIT_EXPORT_SCHEMA_V2:
        expected |= {
            "executionStatus",
            "executionHead",
            "executionEvents",
        }
    _exact(data, expected, "Live audit export")
    if (
        schema_version
        not in {LIVE_AUDIT_EXPORT_SCHEMA, LIVE_AUDIT_EXPORT_SCHEMA_V2}
        or not isinstance(data["generatedAt"], str)
        or not data["generatedAt"]
        or data["liveMutationMethodsAvailable"]
        is not (schema_version == LIVE_AUDIT_EXPORT_SCHEMA_V2)
    ):
        raise LiveAuditExportError("Live audit export metadata is invalid")
    _digest(data["brokerIdSha256"], "brokerIdSha256")
    _integer(data["policyEpoch"], "policyEpoch")
    redaction = _mapping(data["redaction"], "redaction")
    _exact(
        redaction,
        {
            "opaqueHandlesIncluded",
            "credentialMaterialIncluded",
            "authenticationDataIncluded",
            "rawVenueOrderIdsIncluded",
            "rawNetworkResponsesIncluded",
        },
        "redaction",
    )
    if any(value is not False for value in redaction.values()):
        raise LiveAuditExportError("Live audit export redaction is invalid")
    control_status = _mapping(data["controlStatus"], "controlStatus")
    if (
        control_status.get("schemaVersion")
        != "candlescope.live-control-status/1"
        or control_status.get("liveSubmitAvailable")
        is not (schema_version == LIVE_AUDIT_EXPORT_SCHEMA_V2)
        or control_status.get("liveCancelAvailable")
        is not (schema_version == LIVE_AUDIT_EXPORT_SCHEMA_V2)
        or control_status.get("liveTransferAvailable") is not False
        or control_status.get("policyEpoch") != data["policyEpoch"]
    ):
        raise LiveAuditExportError("Live audit control status is invalid")
    control_head = _head(data["controlHead"], "controlHead")
    shadow_head = _head(data["shadowHead"], "shadowHead")
    if (
        control_status.get("eventSequence") != control_head[0]
        or control_status.get("eventSha256") != control_head[1]
    ):
        raise LiveAuditExportError("Live audit control projection is stale")
    _verify_source_chain(
        data["controlEvents"],
        label="controlEvents",
        head=control_head,
        shadow=False,
    )
    _verify_source_chain(
        data["shadowEvents"],
        label="shadowEvents",
        head=shadow_head,
        shadow=True,
    )
    if schema_version == LIVE_AUDIT_EXPORT_SCHEMA_V2:
        execution_status = _mapping(
            data["executionStatus"],
            "executionStatus",
        )
        expected_execution_status = {
            "schemaVersion",
            "available",
            "environment",
            "instrumentId",
            "maxOrderNotional",
            "maxUnresolvedOrders",
            "maxUnresolvedNotional",
            "orderCount",
            "terminalCount",
            "unresolvedCount",
            "unresolvedNotional",
            "eventSequence",
            "eventSha256",
            "liveSubmitAvailable",
            "liveCancelAvailable",
            "liveTransferAvailable",
        }
        _exact(
            execution_status,
            expected_execution_status,
            "executionStatus",
        )
        execution_head = _head(data["executionHead"], "executionHead")
        if (
            execution_status["schemaVersion"]
            != "candlescope.live-execution-status/1"
            or execution_status["available"] is not True
            or execution_status["environment"] != "demo"
            or execution_status["instrumentId"] != "BTC-USDT"
            or execution_status["maxOrderNotional"] != "100"
            or execution_status["maxUnresolvedOrders"] != 2
            or execution_status["maxUnresolvedNotional"] != "200"
            or execution_status["liveSubmitAvailable"] is not True
            or execution_status["liveCancelAvailable"] is not True
            or execution_status["liveTransferAvailable"] is not False
            or any(
                _integer(execution_status[key], f"executionStatus.{key}") < 0
                for key in (
                    "orderCount",
                    "terminalCount",
                    "unresolvedCount",
                    "eventSequence",
                )
            )
            or execution_status["terminalCount"]
            + execution_status["unresolvedCount"]
            != execution_status["orderCount"]
            or execution_status["eventSequence"] != execution_head[0]
            or execution_status["eventSha256"] != execution_head[1]
        ):
            raise LiveAuditExportError(
                "Live audit execution status is invalid"
            )
        _verify_source_chain(
            data["executionEvents"],
            label="executionEvents",
            head=execution_head,
            shadow=True,
        )
    body = {key: data[key] for key in data if key != "exportSha256"}
    expected_digest = _sha256_text(_canonical_json(body))
    if data["exportSha256"] != expected_digest:
        raise LiveAuditExportError("Live audit export digest is invalid")
    _scan_redaction(data)
    return data


__all__ = [
    "LIVE_AUDIT_EXPORT_SCHEMA",
    "LIVE_AUDIT_EXPORT_SCHEMA_V2",
    "LiveAuditExportError",
    "verify_live_audit_export",
]
