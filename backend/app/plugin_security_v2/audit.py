"""Immutable hash-chained audit events for plugin security decisions."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from candlescope_plugin_sdk.platform_v2 import canonical_sha256

from .errors import security_error
from .scope import normalize_scope
from .storage import atomic_write_json, read_json, security_lock


AUDIT_SCHEMA_VERSION = 1
_EVENT_FILE = re.compile(r"^(?P<sequence>[0-9]{16})-(?P<event>[0-9a-f]{32})\.json$")


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True, slots=True)
class AuditEvent:
    sequence: int
    event_id: str
    occurred_at: str
    category: str
    action: str
    outcome: str
    trace_id: str
    plugin_id: str | None
    data: dict[str, Any]
    previous_hash: str | None
    event_hash: str

    def body_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": AUDIT_SCHEMA_VERSION,
            "sequence": self.sequence,
            "eventId": self.event_id,
            "occurredAt": self.occurred_at,
            "category": self.category,
            "action": self.action,
            "outcome": self.outcome,
            "traceId": self.trace_id,
            "pluginId": self.plugin_id,
            "data": dict(self.data),
            "previousHash": self.previous_hash,
        }

    def to_wire(self) -> dict[str, Any]:
        return {**self.body_wire(), "eventHash": self.event_hash}

    @classmethod
    def from_wire(cls, value: Any) -> "AuditEvent":
        if not isinstance(value, dict):
            raise security_error(
                "PLUGIN_AUDIT_INVALID",
                "audit event must be a JSON object",
            )
        expected = {
            "schemaVersion",
            "sequence",
            "eventId",
            "occurredAt",
            "category",
            "action",
            "outcome",
            "traceId",
            "pluginId",
            "data",
            "previousHash",
            "eventHash",
        }
        if set(value) != expected or value.get("schemaVersion") != AUDIT_SCHEMA_VERSION:
            raise security_error(
                "PLUGIN_AUDIT_INVALID",
                "audit event schema is invalid",
            )
        sequence = value["sequence"]
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
            raise security_error("PLUGIN_AUDIT_INVALID", "audit sequence is invalid")
        strings = ("eventId", "occurredAt", "category", "action", "outcome", "traceId")
        if any(not isinstance(value[item], str) or not value[item] for item in strings):
            raise security_error(
                "PLUGIN_AUDIT_INVALID", "audit identity fields are invalid"
            )
        plugin_id = value["pluginId"]
        if plugin_id is not None and (not isinstance(plugin_id, str) or not plugin_id):
            raise security_error("PLUGIN_AUDIT_INVALID", "audit pluginId is invalid")
        data = normalize_scope(value["data"], path="audit.data")
        previous_hash = value["previousHash"]
        if previous_hash is not None and (
            not isinstance(previous_hash, str)
            or not previous_hash.startswith("sha256:")
        ):
            raise security_error(
                "PLUGIN_AUDIT_INVALID", "audit previousHash is invalid"
            )
        event_hash = value["eventHash"]
        if not isinstance(event_hash, str) or not event_hash.startswith("sha256:"):
            raise security_error("PLUGIN_AUDIT_INVALID", "audit eventHash is invalid")
        event = cls(
            sequence,
            value["eventId"],
            value["occurredAt"],
            value["category"],
            value["action"],
            value["outcome"],
            value["traceId"],
            plugin_id,
            data,
            previous_hash,
            event_hash,
        )
        if canonical_sha256(event.body_wire()) != event_hash:
            raise security_error("PLUGIN_AUDIT_TAMPERED", "audit event hash mismatch")
        return event


class AuditLog:
    def __init__(
        self, directory: Path | str, *, lock_timeout_seconds: float = 10.0
    ) -> None:
        self.directory = Path(directory).resolve(strict=False)
        self.lock_path = self.directory.parent / "audit-v2.lock"
        self.lock_timeout_seconds = lock_timeout_seconds

    def _paths(self) -> tuple[Path, ...]:
        if not self.directory.exists():
            return ()
        if self.directory.is_symlink() or not self.directory.is_dir():
            raise security_error(
                "PLUGIN_AUDIT_PATH_UNSAFE",
                "audit path must be a regular directory",
            )
        paths = tuple(sorted(self.directory.iterdir()))
        if any(
            item.is_symlink()
            or not item.is_file()
            or _EVENT_FILE.fullmatch(item.name) is None
            for item in paths
        ):
            raise security_error(
                "PLUGIN_AUDIT_INVALID",
                "audit directory contains an unsupported entry",
            )
        return paths

    def read_all(self) -> tuple[AuditEvent, ...]:
        events: list[AuditEvent] = []
        previous_hash: str | None = None
        for expected_sequence, path in enumerate(self._paths(), start=1):
            match = _EVENT_FILE.fullmatch(path.name)
            assert match is not None
            event = AuditEvent.from_wire(read_json(path, "audit event"))
            if (
                int(match.group("sequence")) != expected_sequence
                or event.sequence != expected_sequence
                or event.event_id != match.group("event")
                or event.previous_hash != previous_hash
            ):
                raise security_error(
                    "PLUGIN_AUDIT_TAMPERED",
                    "audit sequence or hash chain is invalid",
                )
            events.append(event)
            previous_hash = event.event_hash
        return tuple(events)

    def append(
        self,
        *,
        category: str,
        action: str,
        outcome: str,
        trace_id: str,
        plugin_id: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> AuditEvent:
        for label, value in (
            ("category", category),
            ("action", action),
            ("outcome", outcome),
            ("trace_id", trace_id),
        ):
            if not isinstance(value, str) or not value or len(value) > 128:
                raise security_error(
                    "PLUGIN_AUDIT_INVALID",
                    f"audit {label} must be a bounded non-empty string",
                )
        normalized = normalize_scope(data or {}, path="audit.data")
        with security_lock(self.lock_path, self.lock_timeout_seconds):
            events = self.read_all()
            sequence = len(events) + 1
            event_id = uuid.uuid4().hex
            previous_hash = events[-1].event_hash if events else None
            provisional = AuditEvent(
                sequence,
                event_id,
                _utc_now(),
                category,
                action,
                outcome,
                trace_id,
                plugin_id,
                normalized,
                previous_hash,
                "",
            )
            event = AuditEvent(
                *(
                    provisional.sequence,
                    provisional.event_id,
                    provisional.occurred_at,
                    provisional.category,
                    provisional.action,
                    provisional.outcome,
                    provisional.trace_id,
                    provisional.plugin_id,
                    provisional.data,
                    provisional.previous_hash,
                ),
                canonical_sha256(provisional.body_wire()),
            )
            self.directory.mkdir(parents=True, exist_ok=True)
            path = self.directory / f"{sequence:016d}-{event_id}.json"
            atomic_write_json(path, event.to_wire(), replace_existing=False)
            return event
