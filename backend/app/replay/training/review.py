"""Content-addressed run rules and immutable ReviewMode timeline."""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING

from app.replay.broker.models import decimal_to_string
from app.replay.canonical import canonical_json, canonical_sha256

from .anchor_codec import encode_anchor_payload
from .errors import TrainingRunError
from .models import REPLAY_V2_PROTOCOL
from .schema import REVIEW_TIMELINE_SCHEMA_VERSION, RUN_RULES_SCHEMA_VERSION

if TYPE_CHECKING:
    from .storage import TrainingRunStore


REVIEW_VIEWPORT_LIMIT = 2_048
REVIEW_CRITICAL_EVENT_LIMIT = 8_192
REVIEW_ARTIFACT_BYTES_LIMIT = 128 * 1024 * 1024
REVIEW_ANCHOR_BYTES_LIMIT = 512 * 1024 * 1024
REVIEW_ZERO_HASH = "sha256:" + ("0" * 64)
REVIEW_DRAWING_ENTITY_LIMIT = 512
REVIEW_DRAWING_DOCUMENT_BYTES_LIMIT = 2_000_000
REVIEW_DRAWING_FREEHAND_POINT_LIMIT = 32_768
REVIEW_DRAWING_FREEHAND_SPAN_LIMIT = 16_384

_DRAWING_DECIMAL_KEY = "$replay_decimal_v1"
_DRAWING_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_DRAWING_MAX_DEPTH = 32
_DRAWING_MAX_NODES = 500_000
_DRAWING_NUMBER_PATTERN = re.compile(
    r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?(?:0|[1-9][0-9]*))?"
)
_DRAWING_ROOT_KEYS = frozenset(
    {
        "documentSchemaVersion",
        "scopeKey",
        "documentRevision",
        "updatedAt",
        "entities",
    }
)
_DRAWING_ENTITY_KEYS = frozenset(
    {
        "id",
        "kind",
        "geometryRevision",
        "styleRevision",
        "geometry",
        "style",
        "bounds",
    }
)
_DRAWING_GEOMETRY_KEYS: dict[str, frozenset[str]] = {
    "angle-measure": frozenset({"dataPoints", "kind"}),
    "axis-line": frozenset({"axisLineType", "dataPoint", "kind"}),
    "fibonacci": frozenset({"dataPoints", "inverted", "kind"}),
    "freehand": frozenset({"dataPoints", "kind", "stroke"}),
    "highlighter": frozenset({"dataPoints", "kind", "stroke"}),
    "line": frozenset({"dataPoints", "kind", "lineType"}),
    "position": frozenset(
        {
            "direction",
            "entryPrice",
            "kind",
            "slPrice",
            "timeRange",
            "tpPrice",
        }
    ),
    "shape": frozenset({"dataPoints", "kind", "shapeType"}),
    "text": frozenset({"dataPoint", "kind"}),
}
_DRAWING_STYLE_KEYS: dict[str, frozenset[str]] = {
    "angle-measure": frozenset({"color", "kind", "lineWidth"}),
    "axis-line": frozenset({"color", "kind", "lineWidth"}),
    "fibonacci": frozenset({"color", "kind", "levels", "lineWidth"}),
    "freehand": frozenset({"color", "kind", "lineWidth"}),
    "highlighter": frozenset(
        {
            "brushShape",
            "color",
            "compositeOperation",
            "kind",
            "lineWidth",
            "opacity",
        }
    ),
    "line": frozenset({"color", "kind", "lineWidth"}),
    "position": frozenset({"infoPanelOffset", "kind", "positionSize"}),
    "shape": frozenset(
        {
            "color",
            "fillColor",
            "fillOpacity",
            "kind",
            "lineStyle",
            "lineWidth",
        }
    ),
    "text": frozenset(
        {
            "align",
            "bgColor",
            "bold",
            "borderColor",
            "borderWidth",
            "color",
            "fontFamily",
            "fontSize",
            "italic",
            "kind",
            "padding",
            "text",
            "underline",
            "widthPx",
        }
    ),
}


def _drawing_plain_object(value: object) -> bool:
    return type(value) is dict


def _drawing_safe_integer(value: object) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= _DRAWING_MAX_SAFE_INTEGER
    )


def _drawing_decimal(value: object, *, path: str) -> Decimal:
    if isinstance(value, bool):
        raise ValueError(f"{path} must be a finite number")
    if isinstance(value, int):
        if abs(value) > _DRAWING_MAX_SAFE_INTEGER:
            raise ValueError(f"{path} exceeds the safe integer range")
        return Decimal(value)
    if not _drawing_plain_object(value):
        raise ValueError(f"{path} must be a canonical number")
    wrapped = value
    if set(wrapped) != {_DRAWING_DECIMAL_KEY}:
        raise ValueError(f"{path} must be an exact decimal wrapper")
    encoded = wrapped[_DRAWING_DECIMAL_KEY]
    if (
        not isinstance(encoded, str)
        or not 1 <= len(encoded) <= 64
        or _DRAWING_NUMBER_PATTERN.fullmatch(encoded) is None
    ):
        raise ValueError(f"{path} has an invalid decimal wrapper")
    try:
        decimal_value = Decimal(encoded)
        binary_value = float(encoded)
    except (InvalidOperation, OverflowError, ValueError) as exc:
        raise ValueError(f"{path} has an invalid decimal wrapper") from exc
    if not decimal_value.is_finite() or not math.isfinite(binary_value):
        raise ValueError(f"{path} must be finite")
    if (
        decimal_value == decimal_value.to_integral_value()
        and abs(decimal_value) <= _DRAWING_MAX_SAFE_INTEGER
    ):
        raise ValueError(f"{path} wraps a value that must be a JSON integer")
    return decimal_value


def _validate_drawing_json_value(
    value: object,
    *,
    path: str,
    depth: int,
    node_count: list[int],
) -> None:
    if depth > _DRAWING_MAX_DEPTH:
        raise ValueError(f"{path} exceeds the drawing nesting limit")
    node_count[0] += 1
    if node_count[0] > _DRAWING_MAX_NODES:
        raise ValueError("drawing document exceeds the node budget")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > _DRAWING_MAX_SAFE_INTEGER:
            raise ValueError(f"{path} exceeds the safe integer range")
        return
    if isinstance(value, str):
        if len(value) > REVIEW_DRAWING_DOCUMENT_BYTES_LIMIT:
            raise ValueError(f"{path} exceeds the drawing string limit")
        return
    if isinstance(value, float):
        raise ValueError(f"{path} contains a forbidden binary float")
    if isinstance(value, list):
        for index, child in enumerate(value):
            _validate_drawing_json_value(
                child,
                path=f"{path}[{index}]",
                depth=depth + 1,
                node_count=node_count,
            )
        return
    if not _drawing_plain_object(value):
        raise ValueError(f"{path} must contain only plain JSON values")
    mapping = value
    if _DRAWING_DECIMAL_KEY in mapping:
        _drawing_decimal(mapping, path=path)
        return
    for key, child in mapping.items():
        if not isinstance(key, str) or not key or len(key) > 128:
            raise ValueError(f"{path} contains an invalid object key")
        normalized_key = key.replace("_", "").lower()
        if (
            key.startswith(("_", "$"))
            or normalized_key.startswith("actual")
            or normalized_key == "archiveid"
        ):
            raise ValueError(f"{path}.{key} is a forbidden private field")
        _validate_drawing_json_value(
            child,
            path=f"{path}.{key}",
            depth=depth + 1,
            node_count=node_count,
        )


def _validate_drawing_bounds(value: object, *, path: str) -> None:
    if not _drawing_plain_object(value):
        raise ValueError(f"{path} must be an object")
    kind = value.get("kind")
    if kind == "deferred" and set(value) == {"kind"}:
        return
    if (
        kind == "unbounded"
        and set(value) == {"kind", "axis"}
        and value.get("axis") in {"horizontal", "vertical", "both"}
    ):
        return
    expected = {"kind", "minTime", "maxTime", "minPrice", "maxPrice"}
    if kind != "bounded" or set(value) != expected:
        raise ValueError(f"{path} is not a canonical bounds object")
    min_time = _drawing_decimal(value["minTime"], path=f"{path}.minTime")
    max_time = _drawing_decimal(value["maxTime"], path=f"{path}.maxTime")
    min_price = _drawing_decimal(value["minPrice"], path=f"{path}.minPrice")
    max_price = _drawing_decimal(value["maxPrice"], path=f"{path}.maxPrice")
    if min_time > max_time or min_price > max_price:
        raise ValueError(f"{path} has inverted bounds")


def validate_drawing_document(
    document: Mapping[str, object],
    *,
    run_id: str,
    entity_count: int,
) -> tuple[str, str]:
    """Validate and canonicalize the cross-runtime drawing evidence record."""

    try:
        if not _drawing_plain_object(document) or set(document) != _DRAWING_ROOT_KEYS:
            raise ValueError("drawing document root keys are invalid")
        if document["documentSchemaVersion"] != 1:
            raise ValueError("drawing document schema is unsupported")
        if document["scopeKey"] != f"replay-run:{run_id}":
            raise ValueError("drawing document scope does not match the run")
        if not _drawing_safe_integer(document["documentRevision"]):
            raise ValueError("drawing document revision is invalid")
        if not _drawing_safe_integer(document["updatedAt"]):
            raise ValueError("drawing document timestamp is invalid")
        entities = document["entities"]
        if (
            isinstance(entity_count, bool)
            or not isinstance(entity_count, int)
            or not 0 <= entity_count <= REVIEW_DRAWING_ENTITY_LIMIT
            or not isinstance(entities, list)
            or len(entities) != entity_count
        ):
            raise ValueError("drawing document entity count is invalid")

        seen_ids: set[str] = set()
        freehand_points = 0
        freehand_spans = 0
        for index, entity in enumerate(entities):
            path = f"$.entities[{index}]"
            if not _drawing_plain_object(entity) or set(entity) != _DRAWING_ENTITY_KEYS:
                raise ValueError(f"{path} keys are invalid")
            entity_id = entity["id"]
            if (
                not isinstance(entity_id, str)
                or not 1 <= len(entity_id) <= 256
                or entity_id == "__preview__"
                or entity_id in seen_ids
            ):
                raise ValueError(f"{path}.id is invalid or duplicated")
            seen_ids.add(entity_id)
            kind = entity["kind"]
            if not isinstance(kind, str) or kind not in _DRAWING_GEOMETRY_KEYS:
                raise ValueError(f"{path}.kind is unsupported")
            if not _drawing_safe_integer(entity["geometryRevision"]):
                raise ValueError(f"{path}.geometryRevision is invalid")
            if not _drawing_safe_integer(entity["styleRevision"]):
                raise ValueError(f"{path}.styleRevision is invalid")
            geometry = entity["geometry"]
            style = entity["style"]
            if (
                not _drawing_plain_object(geometry)
                or "kind" not in geometry
                or geometry["kind"] != kind
                or not set(geometry).issubset(_DRAWING_GEOMETRY_KEYS[kind])
            ):
                raise ValueError(f"{path}.geometry does not match its kind")
            if (
                not _drawing_plain_object(style)
                or "kind" not in style
                or style["kind"] != kind
                or not set(style).issubset(_DRAWING_STYLE_KEYS[kind])
            ):
                raise ValueError(f"{path}.style does not match its kind")
            if kind in {"freehand", "highlighter"}:
                has_points = "dataPoints" in geometry
                has_stroke = "stroke" in geometry
                if has_points == has_stroke:
                    raise ValueError(
                        f"{path}.geometry needs exactly one freehand payload"
                    )
                if has_points:
                    points = geometry["dataPoints"]
                    if not isinstance(points, list):
                        raise ValueError(f"{path}.geometry.dataPoints must be a list")
                    freehand_points += len(points)
                else:
                    stroke = geometry["stroke"]
                    if (
                        not _drawing_plain_object(stroke)
                        or not isinstance(stroke.get("points"), list)
                        or not isinstance(stroke.get("spans"), list)
                    ):
                        raise ValueError(f"{path}.geometry.stroke is invalid")
                    freehand_points += len(stroke["points"])
                    freehand_spans += len(stroke["spans"])
                if (
                    freehand_points > REVIEW_DRAWING_FREEHAND_POINT_LIMIT
                    or freehand_spans > REVIEW_DRAWING_FREEHAND_SPAN_LIMIT
                ):
                    raise ValueError("drawing freehand aggregate budget is exceeded")
            _validate_drawing_bounds(entity["bounds"], path=f"{path}.bounds")
            _validate_drawing_json_value(
                entity,
                path=path,
                depth=0,
                node_count=[0],
            )

        document_json = canonical_json(document)
        document_bytes = len(document_json.encode("utf-8"))
        if document_bytes > REVIEW_DRAWING_DOCUMENT_BYTES_LIMIT:
            raise ValueError("drawing document byte budget is exceeded")
        return document_json, canonical_sha256(document)
    except (RecursionError, TypeError, ValueError) as exc:
        raise TrainingRunError(
            "REVIEW_DRAWING_INVALID",
            "drawing document is not a bounded run-scoped canonical record",
            status_code=422,
        ) from exc


def _blob_digest(payload: bytes) -> str:
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _decoded_object(raw: object, *, field: str) -> dict[str, object]:
    try:
        value = json.loads(str(raw))
    except json.JSONDecodeError as exc:
        raise TypeError(f"{field} is invalid JSON") from exc
    if not isinstance(value, dict):
        raise TypeError(f"{field} must be an object")
    return value


class ReviewRecorder:
    """Writes review evidence inside the owning replay SQLite transaction."""

    def __init__(self, owner: TrainingRunStore) -> None:
        self.owner = owner

    def backfill(self, connection: sqlite3.Connection, *, now_ms: int) -> None:
        """Create one explicit migration frame for pre-Phase-17 v9 runs."""

        rows = connection.execute(
            """
            SELECT run.run_id, run.adapter_session_id, run.virtual_time_ms,
                   session.source_sequence, session.event_sequence,
                   session.state_hash
            FROM replay_training_run AS run
            JOIN replay_session AS session
              ON session.session_id = run.adapter_session_id
            JOIN replay_training_contract_account AS account USING(run_id)
            JOIN replay_training_leverage_policy AS leverage
              ON leverage.run_id = run.run_id AND leverage.revision = 1
            JOIN replay_training_funding_policy AS funding
              ON funding.run_id = run.run_id AND funding.revision = 1
            WHERE NOT EXISTS(
                SELECT 1 FROM replay_review_timeline_event AS event
                WHERE event.run_id = run.run_id
            )
            ORDER BY run.run_id
            """
        ).fetchall()
        for row in rows:
            checkpoint = connection.execute(
                """
                SELECT payload, source_sequence, event_sequence, state_hash
                FROM replay_checkpoint
                WHERE session_id = ? AND active = 1
                ORDER BY checkpoint_id DESC LIMIT 1
                """,
                (row["adapter_session_id"],),
            ).fetchone()
            if checkpoint is None:
                raise TrainingRunError(
                    "REVIEW_ANCHOR_UNAVAILABLE",
                    "existing run has no recoverable Phase 17 anchor",
                    status_code=503,
                )
            self.append(
                connection,
                run_id=str(row["run_id"]),
                session_id=str(row["adapter_session_id"]),
                context={
                    "kind": "DIRECT",
                    "category": "SYSTEM",
                    "event_type": "PHASE17_BACKFILL",
                },
                state={
                    "cursor": {
                        "virtual_time_ms": int(row["virtual_time_ms"]),
                    },
                    "source_sequence": int(checkpoint["source_sequence"]),
                    "event_sequence": int(checkpoint["event_sequence"]),
                    "state_hash": str(checkpoint["state_hash"]),
                },
                checkpoint=bytes(checkpoint["payload"]),
                now_ms=now_ms,
            )

    def rules_projection(
        self,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        virtual_time_ms: int | None = None,
        source_sequence: int | None = None,
        include_history: bool,
    ) -> dict[str, object]:
        run = connection.execute(
            """
            SELECT r.adapter_session_id, r.virtual_time_ms, r.source_sequence,
                   r.time_disclosure_policy,
                   COALESCE(i.revealed, 0) AS revealed
            FROM replay_training_run AS r
            LEFT JOIN replay_training_integrity AS i USING(run_id)
            WHERE r.run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if run is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training run does not exist",
                status_code=404,
            )
        at_time = int(run["virtual_time_ms"] if virtual_time_ms is None else virtual_time_ms)
        at_sequence = int(
            run["source_sequence"] if source_sequence is None else source_sequence
        )
        action_by_hash: dict[str, sqlite3.Row] = {}
        for action in connection.execute(
            """
            SELECT command_id, public_time_json, old_value_json,
                   new_value_json, reason
            FROM replay_run_action_event
            WHERE run_id = ? AND command_id IS NOT NULL
            ORDER BY action_sequence
            """,
            (run_id,),
        ).fetchall():
            try:
                value = json.loads(str(action["new_value_json"]))
            except json.JSONDecodeError:
                continue
            if isinstance(value, Mapping) and isinstance(
                value.get("policy_hash"), str
            ):
                action_by_hash[str(value["policy_hash"])] = action

        def public_time(
            effective_time_ms: int,
            sequence: int,
            policy_hash: str,
        ) -> dict[str, object]:
            action = action_by_hash.get(policy_hash)
            if action is not None:
                decoded = _decoded_object(
                    action["public_time_json"], field="rule public_time"
                )
                return decoded
            return self.owner._public_time(
                connection,
                session_id=str(run["adapter_session_id"]),
                policy=str(run["time_disclosure_policy"]),
                revealed=bool(run["revealed"]),
                public_time_ms=effective_time_ms,
                sequence=sequence,
            )

        fee_rows = connection.execute(
            """
            SELECT * FROM replay_training_fee_policy
            WHERE run_id = ? AND effective_virtual_time_ms <= ?
            ORDER BY effective_virtual_time_ms, revision
            """,
            (run_id, at_time),
        ).fetchall()
        leverage_rows = connection.execute(
            """
            SELECT * FROM replay_training_leverage_policy
            WHERE run_id = ?
              AND (
                  effective_virtual_time_ms < ?
                  OR (
                      effective_virtual_time_ms = ?
                      AND source_sequence <= ?
                  )
              )
            ORDER BY effective_virtual_time_ms, source_sequence, revision
            """,
            (run_id, at_time, at_time, at_sequence),
        ).fetchall()
        funding_rows = connection.execute(
            """
            SELECT * FROM replay_training_funding_policy
            WHERE run_id = ?
              AND (
                  effective_virtual_time_ms < ?
                  OR (
                      effective_virtual_time_ms = ?
                      AND source_sequence <= ?
                  )
              )
            ORDER BY effective_virtual_time_ms, source_sequence, revision
            """,
            (run_id, at_time, at_time, at_sequence),
        ).fetchall()
        if not fee_rows or not leverage_rows or not funding_rows:
            raise TrainingRunError(
                "RUN_RULES_INCOMPLETE",
                "run rule history is incomplete",
                status_code=503,
            )

        def revision_transition(
            action: sqlite3.Row | None,
            current: Mapping[str, object],
        ) -> tuple[object, dict[str, object], str | None, str]:
            if action is None:
                return None, dict(current), None, "creation policy"
            old_value = _decoded_object(
                action["old_value_json"], field="rule old value"
            )
            new_value = _decoded_object(
                action["new_value_json"], field="rule new value"
            )
            return (
                old_value,
                new_value,
                str(action["command_id"]),
                str(action["reason"]),
            )

        def fee_value(row: sqlite3.Row) -> dict[str, object]:
            digest = str(row["policy_hash"])
            action = action_by_hash.get(digest)
            current = {
                "maker_fee_bps": str(row["maker_fee_bps"]),
                "taker_fee_bps": str(row["taker_fee_bps"]),
                "revision": int(row["revision"]),
                "policy_hash": digest,
            }
            old_value, new_value, command_id, reason = revision_transition(
                action, current
            )
            effective_public_time = public_time(
                int(row["effective_virtual_time_ms"]), 0, digest
            )
            return {
                "kind": "FEE_POLICY",
                "revision": int(row["revision"]),
                "effective_cursor": {
                    "virtual_time_ms": int(row["effective_virtual_time_ms"]),
                    "source_sequence": int(
                        effective_public_time.get("sequence", 0)
                    ),
                },
                "public_time": effective_public_time,
                "maker_fee_bps": str(row["maker_fee_bps"]),
                "taker_fee_bps": str(row["taker_fee_bps"]),
                "policy_hash": digest,
                "fidelity": str(row["fidelity"]),
                "reason": reason,
                "command_id": command_id,
                "old": old_value,
                "new": new_value,
            }

        def leverage_value(row: sqlite3.Row) -> dict[str, object]:
            digest = str(row["policy_hash"])
            action = action_by_hash.get(digest)
            current = {
                "max_leverage": str(row["max_leverage"]),
                "revision": int(row["revision"]),
                "policy_hash": digest,
            }
            old_value, new_value, command_id, reason = revision_transition(
                action, current
            )
            return {
                "kind": "LEVERAGE_CAP",
                "revision": int(row["revision"]),
                "effective_cursor": {
                    "virtual_time_ms": int(row["effective_virtual_time_ms"]),
                    "source_sequence": int(row["source_sequence"]),
                },
                "public_time": public_time(
                    int(row["effective_virtual_time_ms"]),
                    int(row["source_sequence"]),
                    digest,
                ),
                "max_leverage": str(row["max_leverage"]),
                "policy_hash": digest,
                "fidelity": str(row["fidelity"]),
                "reason": reason,
                "command_id": command_id,
                "old": old_value,
                "new": new_value,
            }

        def funding_value(row: sqlite3.Row) -> dict[str, object]:
            digest = str(row["policy_hash"])
            action = action_by_hash.get(digest)
            current = {
                "funding_mode": str(row["funding_mode"]),
                "fixed_funding_rate": row["fixed_funding_rate"],
                "funding_interval_ms": row["funding_interval_ms"],
                "revision": int(row["revision"]),
                "policy_hash": digest,
            }
            old_value, new_value, command_id, reason = revision_transition(
                action, current
            )
            return {
                "kind": "FUNDING_POLICY",
                "revision": int(row["revision"]),
                "effective_cursor": {
                    "virtual_time_ms": int(row["effective_virtual_time_ms"]),
                    "source_sequence": int(row["source_sequence"]),
                },
                "public_time": public_time(
                    int(row["effective_virtual_time_ms"]),
                    int(row["source_sequence"]),
                    digest,
                ),
                "funding_mode": str(row["funding_mode"]),
                "fixed_funding_rate": row["fixed_funding_rate"],
                "funding_interval_ms": row["funding_interval_ms"],
                "policy_hash": digest,
                "fidelity": str(row["fidelity"]),
                "reason": reason,
                "command_id": command_id,
                "old": old_value,
                "new": new_value,
            }

        instrument_rows = connection.execute(
            """
            SELECT rule.* FROM replay_training_instrument_rule AS rule
            JOIN (
                SELECT track_id, MAX(revision) AS revision
                FROM replay_training_instrument_rule
                WHERE run_id = ? AND effective_virtual_time_ms <= ?
                GROUP BY track_id
            ) AS active
              ON active.track_id = rule.track_id
             AND active.revision = rule.revision
            WHERE rule.run_id = ? ORDER BY rule.track_id
            """,
            (run_id, at_time, run_id),
        ).fetchall()
        leverage = leverage_value(leverage_rows[-1])
        user_cap = Decimal(str(leverage["max_leverage"]))
        instrument_rules: list[dict[str, object]] = []
        effective_leverage: dict[str, str] = {}
        for row in instrument_rows:
            rule = _decoded_object(row["rule_json"], field="instrument rule")
            track_id = str(row["track_id"])
            instrument_rules.append(
                {
                    "track_id": track_id,
                    "revision": int(row["revision"]),
                    "effective_virtual_time_ms": int(
                        row["effective_virtual_time_ms"]
                    ),
                    "rule": rule,
                    "rule_hash": str(row["rule_hash"]),
                    "fidelity": str(row["fidelity"]),
                    "immutable_exchange_rule": True,
                }
            )
            effective_leverage[track_id] = decimal_to_string(
                min(user_cap, Decimal(str(rule["max_leverage"]))),
                field_name="effective leverage",
            )
        history: list[dict[str, object]] = []
        if include_history:
            history.extend(fee_value(row) for row in fee_rows)
            history.extend(leverage_value(row) for row in leverage_rows)
            history.extend(funding_value(row) for row in funding_rows)
            history.sort(
                key=lambda item: (
                    int(
                        dict(item["effective_cursor"])["virtual_time_ms"]  # type: ignore[arg-type]
                    ),
                    int(
                        dict(item["effective_cursor"])["source_sequence"]  # type: ignore[arg-type]
                    ),
                    str(item["kind"]),
                    int(item["revision"]),
                )
            )
        return {
            "protocol": REPLAY_V2_PROTOCOL,
            "schema_version": RUN_RULES_SCHEMA_VERSION,
            "run_id": run_id,
            "effective_cursor": {
                "virtual_time_ms": at_time,
                "source_sequence": at_sequence,
            },
            "fee_policy": fee_value(fee_rows[-1]),
            "leverage_policy": leverage,
            "funding_policy": funding_value(funding_rows[-1]),
            "instrument_rules": instrument_rules,
            "effective_leverage_by_track": effective_leverage,
            "history": history,
        }

    @staticmethod
    def _internal_adapter_command(context: Mapping[str, object]) -> bool:
        if context.get("kind") != "COMMAND":
            return False
        command = context.get("command")
        if not isinstance(command, Mapping):
            return False
        command_id = command.get("command_id")
        command_type = command.get("type")
        return (
            isinstance(command_id, str)
            and command_id.startswith("v2multi-")
            and command_type
            in {
                "acquire_controller",
                "step",
                "advance_by",
            }
        )

    @staticmethod
    def _position_descriptor(position: object) -> dict[str, object]:
        """Exclude mark-only fields from the critical position identity."""

        if not isinstance(position, Mapping):
            return {}
        return {
            field: position[field]
            for field in (
                "side",
                "quantity",
                "entry_price",
                "realized_pnl",
            )
            if field in position
        }

    @staticmethod
    def _descriptor_domain(
        connection: sqlite3.Connection,
        *,
        run_id: str,
    ) -> dict[str, object]:
        """Build only the domain fields consumed while actors are unaligned."""

        run = connection.execute(
            "SELECT current_equity FROM replay_training_run WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if run is None:
            raise TypeError("review projection owner is incomplete")
        orders = [
            _decoded_object(row["order_json"], field="review order")
            for row in connection.execute(
                """
                SELECT order_json FROM replay_training_contract_order
                WHERE run_id = ? ORDER BY track_id, order_id
                """,
                (run_id,),
            ).fetchall()
        ]
        positions = [
            {
                "track_id": str(row["track_id"]),
                "position": ReviewRecorder._position_descriptor(
                    _decoded_object(
                        row["position_json"],
                        field="track position",
                    )
                ),
            }
            for row in connection.execute(
                """
                SELECT track_id, position_json
                FROM replay_training_market_track
                WHERE run_id = ?
                ORDER BY stable_ordinal, track_id
                """,
                (run_id,),
            ).fetchall()
        ]
        counts = connection.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM replay_training_contract_fill
                 WHERE run_id = ?) AS fill_count,
                (SELECT COUNT(*) FROM replay_training_contract_ledger
                 WHERE run_id = ?) AS ledger_count,
                (SELECT COUNT(*) FROM replay_training_funding_settlement
                 WHERE run_id = ?) AS funding_count,
                (SELECT COUNT(*) FROM replay_training_liquidation_event
                 WHERE run_id = ?) AS liquidation_count,
                (SELECT COUNT(*) FROM replay_training_liquidation_event
                 WHERE run_id = ? AND state = 'COMPLETED')
                    AS completed_liquidation_count
            """,
            (run_id, run_id, run_id, run_id, run_id),
        ).fetchone()
        if counts is None:
            raise TypeError("review descriptor counts are incomplete")
        return {
            "order_count": len(orders),
            "order_hash": canonical_sha256(orders),
            "fill_count": int(counts["fill_count"]),
            "ledger_count": int(counts["ledger_count"]),
            "funding_count": int(counts["funding_count"]),
            "liquidation_count": int(counts["liquidation_count"]),
            "completed_liquidation_count": int(
                counts["completed_liquidation_count"]
            ),
            "position_hash": canonical_sha256(positions),
            "equity": str(run["current_equity"]),
        }

    def projection(
        self,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        virtual_time_ms: int,
        source_sequence: int,
    ) -> dict[str, object]:
        viewer = connection.execute(
            "SELECT * FROM replay_training_viewer_state WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        account = connection.execute(
            "SELECT * FROM replay_training_contract_account WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        run = connection.execute(
            "SELECT current_equity FROM replay_training_run WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if viewer is None or account is None or run is None:
            raise TypeError("review projection owner is incomplete")
        tracks: list[dict[str, object]] = []
        for row in connection.execute(
            """
            SELECT track.*, session.state_hash
            FROM replay_training_market_track AS track
            LEFT JOIN replay_session AS session
              ON session.session_id = track.adapter_session_id
            WHERE track.run_id = ?
            ORDER BY track.stable_ordinal, track.track_id
            """,
            (run_id,),
        ).fetchall():
            tracks.append(
                {
                    "track_id": str(row["track_id"]),
                    "stable_ordinal": int(row["stable_ordinal"]),
                    "exchange": str(row["exchange"]),
                    "market_type": str(row["market_type"]),
                    "symbol": str(row["symbol"]),
                    "source_kind": str(row["source_kind"]),
                    "subscription_tier": str(row["subscription_tier"]),
                    "state": str(row["state"]),
                    "state_hash": (
                        None if row["state_hash"] is None else str(row["state_hash"])
                    ),
                    "position": _decoded_object(
                        row["position_json"], field="track position"
                    ),
                    "account": _decoded_object(
                        row["account_json"], field="track account"
                    ),
                    "open_orders": json.loads(str(row["open_orders_json"])),
                }
            )
        orders = [
            _decoded_object(row["order_json"], field="review order")
            for row in connection.execute(
                """
                SELECT order_json FROM replay_training_contract_order
                WHERE run_id = ? ORDER BY track_id, order_id
                """,
                (run_id,),
            ).fetchall()
        ]
        fills = [
            _decoded_object(row["fill_json"], field="review fill")
            for row in connection.execute(
                """
                SELECT fill_json FROM replay_training_contract_fill
                WHERE run_id = ? ORDER BY track_id, fill_id
                """,
                (run_id,),
            ).fetchall()
        ]
        ledger = [
            {
                "ledger_sequence": int(row["ledger_sequence"]),
                "posting_id": str(row["posting_id"]),
                "track_id": (
                    None if row["track_id"] is None else str(row["track_id"])
                ),
                "kind": str(row["kind"]),
                "cash_delta": str(row["cash_delta"]),
                "asset": str(row["asset"]),
                "virtual_time_ms": int(row["virtual_time_ms"]),
                "source_sequence": int(row["source_sequence"]),
                "fidelity": str(row["fidelity"]),
                "rule_revision": int(row["rule_revision"]),
                "reference_type": str(row["reference_type"]),
                "reference_id": str(row["reference_id"]),
                "metadata": _decoded_object(
                    row["metadata_json"], field="review ledger metadata"
                ),
                "previous_hash": str(row["previous_hash"]),
                "entry_hash": str(row["entry_hash"]),
            }
            for row in connection.execute(
                """
                SELECT * FROM replay_training_contract_ledger
                WHERE run_id = ? ORDER BY ledger_sequence
                """,
                (run_id,),
            ).fetchall()
        ]
        markers = [
            {
                "marker_id": str(row["marker_id"]),
                "command_id": str(row["command_id"]),
                "text": str(row["text"]),
                "content_hash": str(row["content_hash"]),
                "cursor": {
                    "virtual_time_ms": int(row["virtual_time_ms"]),
                    "source_sequence": int(row["source_sequence"]),
                },
            }
            for row in connection.execute(
                """
                SELECT * FROM replay_review_marker
                WHERE run_id = ? ORDER BY created_at_ms, marker_id
                """,
                (run_id,),
            ).fetchall()
        ]
        liquidations = [
            {
                "liquidation_id": str(row["liquidation_id"]),
                "track_id": str(row["track_id"]),
                "state": str(row["state"]),
                "reason": str(row["reason"]),
                "trigger_cursor": {
                    "virtual_time_ms": int(row["trigger_virtual_time_ms"]),
                    "source_sequence": int(row["trigger_source_sequence"]),
                },
                "maintenance_margin": str(row["maintenance_margin"]),
                "account_equity_before": str(row["account_equity_before"]),
                "liquidation_fee": str(row["liquidation_fee"]),
                "fidelity": str(row["fidelity"]),
                "canceled_order_ids": json.loads(
                    str(row["canceled_order_ids_json"])
                ),
                "close_order_id": (
                    None
                    if row["close_order_id"] is None
                    else str(row["close_order_id"])
                ),
                "account_equity_after": (
                    None
                    if row["account_equity_after"] is None
                    else str(row["account_equity_after"])
                ),
            }
            for row in connection.execute(
                """
                SELECT * FROM replay_training_liquidation_event
                WHERE run_id = ? ORDER BY liquidation_id
                """,
                (run_id,),
            ).fetchall()
        ]
        viewer_state = {
            "run_id": run_id,
            "selected_track_id": str(viewer["selected_track_id"]),
            "display_interval": str(viewer["display_interval"]),
            "chart_type": str(viewer["chart_type"]),
            "visible_range": (
                None
                if viewer["visible_range_json"] is None
                else json.loads(str(viewer["visible_range_json"]))
            ),
            "pane_layout": _decoded_object(
                viewer["pane_layout_json"], field="pane layout"
            ),
            "rail_layout": _decoded_object(
                viewer["rail_layout_json"], field="rail layout"
            ),
            "semantic_view_revision": int(viewer["semantic_view_revision"]),
        }
        domain = {
            "order_count": int(
                connection.execute(
                    "SELECT COUNT(*) FROM replay_training_contract_order "
                    "WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
            ),
            "order_hash": canonical_sha256(
                orders
            ),
            "fill_count": int(
                connection.execute(
                    "SELECT COUNT(*) FROM replay_training_contract_fill "
                    "WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
            ),
            "ledger_count": int(
                connection.execute(
                    "SELECT COUNT(*) FROM replay_training_contract_ledger "
                    "WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
            ),
            "funding_count": int(
                connection.execute(
                    "SELECT COUNT(*) FROM replay_training_funding_settlement "
                    "WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
            ),
            "liquidation_count": int(
                len(liquidations)
            ),
            "completed_liquidation_count": sum(
                item["state"] == "COMPLETED" for item in liquidations
            ),
            "liquidation_hash": canonical_sha256(liquidations),
            "position_hash": canonical_sha256(
                [
                    {
                        "track_id": track["track_id"],
                        "position": self._position_descriptor(track["position"]),
                    }
                    for track in tracks
                ]
            ),
            "equity": str(run["current_equity"]),
        }
        drawing = connection.execute(
            """
            SELECT document_hash, revision
            FROM replay_review_drawing_document
            WHERE run_id = ? ORDER BY revision DESC LIMIT 1
            """,
            (run_id,),
        ).fetchone()
        history = connection.execute(
            """
            SELECT * FROM replay_training_account_history WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        history_inputs: dict[str, object] | None = None
        if history is not None and history["account_data_mode"] == "HISTORICAL_EXACT":
            input_rows = connection.execute(
                """
                SELECT projection.*, ref.binding_generation,
                       ref.bound_range_start_ms, ref.bound_range_end_ms,
                       ref.dataset_epoch, ref.checksum_sha256,
                       ref.event_chain_tail
                FROM replay_account_history_projection AS projection
                JOIN replay_account_history_ref AS ref
                  ON ref.run_id = projection.run_id
                 AND ref.track_id = projection.track_id
                 AND ref.active = 1
                WHERE projection.run_id = ?
                ORDER BY projection.track_id
                """,
                (run_id,),
            ).fetchall()
            history_inputs = {
                "account_data_mode": "HISTORICAL_EXACT",
                "archive_proof_hash": str(history["archive_proof_hash"]),
                "fidelity": str(history["fidelity"]),
                "tracks": [dict(row) for row in input_rows],
            }
        book_rows = connection.execute(
            """
            SELECT ref.archive_id, ref.track_id, ref.binding_generation,
                   ref.bound_range_start_ms, ref.bound_range_end_ms,
                   projection.capability_state, projection.status,
                   projection.execution_fidelity, projection.queue_exact,
                   projection.as_of_actual_ms, projection.as_of_virtual_ms,
                   projection.last_update_id, projection.bids_json,
                   projection.asks_json, projection.book_hash,
                   projection.message
            FROM replay_historical_book_ref AS ref
            LEFT JOIN replay_historical_book_projection AS projection
              ON projection.run_id = ref.run_id
             AND projection.track_id = ref.track_id
             AND projection.archive_id = ref.archive_id
            WHERE ref.run_id = ? AND ref.active = 1
            ORDER BY ref.track_id, ref.binding_generation DESC
            """,
            (run_id,),
        ).fetchall()
        books = [
            {
                "track_id": str(row["track_id"]),
                "capability_state": (
                    None
                    if row["capability_state"] is None
                    else str(row["capability_state"])
                ),
                "status": None if row["status"] is None else str(row["status"]),
                "execution_fidelity": (
                    None
                    if row["execution_fidelity"] is None
                    else str(row["execution_fidelity"])
                ),
                "queue_exact": bool(row["queue_exact"] or 0),
                "as_of_virtual_ms": row["as_of_virtual_ms"],
                "last_update_id": row["last_update_id"],
                "bids": (
                    []
                    if row["bids_json"] is None
                    else json.loads(str(row["bids_json"]))
                ),
                "asks": (
                    []
                    if row["asks_json"] is None
                    else json.loads(str(row["asks_json"]))
                ),
                "book_hash": row["book_hash"],
                "message": None if row["message"] is None else str(row["message"]),
            }
            for row in book_rows
        ]
        book_inputs = {
            "tracks": [dict(row) for row in book_rows],
        }
        account_state = {
            "account_model": str(account["account_model"]),
            "margin_mode": str(account["margin_mode"]),
            "funding_mode": str(account["funding_mode"]),
            "overlay_cash": str(account["overlay_cash"]),
            "isolated_margin": _decoded_object(
                account["isolated_margin_json"], field="isolated margin"
            ),
            "status": str(account["status"]),
            "fidelity": str(account["fidelity"]),
            "ledger_tail_hash": str(account["ledger_tail_hash"]),
        }
        return {
            "schema_version": REVIEW_TIMELINE_SCHEMA_VERSION,
            "run_id": run_id,
            "cursor": {
                "virtual_time_ms": virtual_time_ms,
                "source_sequence": source_sequence,
            },
            "tracks": tracks,
            "orders": orders,
            "fills": fills,
            "ledger": ledger,
            "markers": markers,
            "liquidations": liquidations,
            "books": books,
            "account": account_state,
            "account_hash": canonical_sha256(
                {"account": account_state, "tracks": tracks}
            ),
            "rules": self.rules_projection(
                connection,
                run_id=run_id,
                virtual_time_ms=virtual_time_ms,
                source_sequence=source_sequence,
                include_history=False,
            ),
            "viewer_state": viewer_state,
            "viewer_hash": canonical_sha256(viewer_state),
            "drawing_document_hash": (
                None if drawing is None else str(drawing["document_hash"])
            ),
            "drawing_revision": 0 if drawing is None else int(drawing["revision"]),
            "domain": domain,
            # Stored for exact Fork reconstruction. API projections remove
            # actual archive timestamps before crossing the disclosure boundary.
            "_account_history_internal": history_inputs,
            "_book_history_internal": book_inputs,
        }

    def anchor(
        self,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        session_id: str,
        checkpoint: bytes | None,
        state: Mapping[str, object] | None,
        now_ms: int,
    ) -> str:
        track = connection.execute(
            """
            SELECT track.track_id, track.dataset_epoch, track.virtual_time_ms
            FROM replay_training_market_track AS track
            WHERE track.run_id = ? AND track.adapter_session_id = ?
            """,
            (run_id, session_id),
        ).fetchone()
        if track is None:
            raise TypeError("review anchor track is missing")
        if checkpoint is None:
            checkpoint_row = connection.execute(
                """
                SELECT * FROM replay_checkpoint
                WHERE session_id = ? AND active = 1
                ORDER BY checkpoint_id DESC LIMIT 1
                """,
                (session_id,),
            ).fetchone()
            if checkpoint_row is None:
                existing = connection.execute(
                    """
                    SELECT anchor_id FROM replay_review_actor_anchor
                    WHERE run_id = ? AND track_id = ?
                    ORDER BY virtual_time_ms DESC, source_sequence DESC,
                             checkpoint_id DESC LIMIT 1
                    """,
                    (run_id, track["track_id"]),
                ).fetchone()
                if existing is None:
                    raise TrainingRunError(
                        "REVIEW_ANCHOR_UNAVAILABLE",
                        "run has no durable actor checkpoint",
                        status_code=409,
                    )
                return str(existing["anchor_id"])
            payload = bytes(checkpoint_row["payload"])
        else:
            payload = bytes(checkpoint)
            checkpoint_row = connection.execute(
                """
                SELECT * FROM replay_checkpoint
                WHERE session_id = ? AND payload_sha256 = ?
                ORDER BY checkpoint_id DESC LIMIT 1
                """,
                (session_id, _blob_digest(payload)),
            ).fetchone()
            if checkpoint_row is None:
                raise TypeError("transaction-local review checkpoint is missing")
        digest = _blob_digest(payload)
        if digest != str(checkpoint_row["payload_sha256"]):
            raise TypeError("review checkpoint checksum mismatch")
        anchor_hash = canonical_sha256(
            {
                "schema_version": "replay.review.actor-anchor.v1",
                "run_id": run_id,
                "track_id": str(track["track_id"]),
                "adapter_session_id": session_id,
                "checkpoint_id": int(checkpoint_row["checkpoint_id"]),
                "source_sequence": int(checkpoint_row["source_sequence"]),
                "event_sequence": int(checkpoint_row["event_sequence"]),
                "state_hash": str(checkpoint_row["state_hash"]),
                "payload_sha256": digest,
            }
        )
        anchor_id = f"anchor-{anchor_hash.removeprefix('sha256:')}"
        if connection.execute(
            """
            SELECT 1 FROM replay_review_actor_anchor
            WHERE run_id = ? AND anchor_id = ?
            """,
            (run_id, anchor_id),
        ).fetchone() is not None:
            return anchor_id
        encoded = encode_anchor_payload(payload)
        used = int(
            connection.execute(
                "SELECT COALESCE(SUM("
                "CASE WHEN stored_bytes > 0 THEN stored_bytes "
                "ELSE length(payload) END"
                "), 0) "
                "FROM replay_review_actor_anchor WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0]
        )
        if used + encoded.stored_bytes > REVIEW_ANCHOR_BYTES_LIMIT:
            raise TrainingRunError(
                "REVIEW_ANCHOR_BUDGET_EXCEEDED",
                "review actor-anchor budget is exhausted",
                status_code=409,
                details={
                    "used_bytes": used,
                    "offered_bytes": encoded.stored_bytes,
                    "offered_raw_bytes": encoded.raw_bytes,
                    "limit_bytes": REVIEW_ANCHOR_BYTES_LIMIT,
                    "event_dropped": False,
                },
            )
        cursor = state.get("cursor") if isinstance(state, Mapping) else None
        virtual_time_ms = (
            int(cursor["virtual_time_ms"])
            if isinstance(cursor, Mapping)
            else int(track["virtual_time_ms"] or 0)
        )
        connection.execute(
            """
            INSERT INTO replay_review_actor_anchor(
                run_id, anchor_id, track_id, adapter_session_id,
                checkpoint_id, source_sequence, event_sequence,
                virtual_time_ms, state_hash, dataset_epoch, payload,
                payload_encoding, payload_sha256, payload_bytes,
                stored_bytes, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                anchor_id,
                track["track_id"],
                session_id,
                checkpoint_row["checkpoint_id"],
                checkpoint_row["source_sequence"],
                checkpoint_row["event_sequence"],
                virtual_time_ms,
                checkpoint_row["state_hash"],
                track["dataset_epoch"],
                encoded.payload,
                encoded.encoding,
                digest,
                len(payload),
                encoded.stored_bytes,
                now_ms,
            ),
        )
        return anchor_id

    @staticmethod
    def descriptors(
        context: Mapping[str, object],
        previous: Mapping[str, object] | None,
        projection: Mapping[str, object],
    ) -> list[tuple[str, str]]:
        kind = str(context.get("kind", ""))
        if kind == "INITIAL":
            return [("INITIAL", "INITIAL_CHECKPOINT")]
        if kind == "DIRECT":
            return [
                (
                    str(context.get("category", "SYSTEM")),
                    str(context.get("event_type", "DIRECT_EVENT")),
                )
            ]
        if kind == "COMMAND":
            if context.get("accepted") is not True:
                return []
            command = context.get("command")
            command_type = (
                str(command.get("type", "COMMAND"))
                if isinstance(command, Mapping)
                else "COMMAND"
            )
            if command_type == "acquire_controller":
                # Controller leases are transport ownership, not a training
                # decision or a forkable market/account transition.
                return []
            if command_type == "_training_adjust_capital" and isinstance(
                command, Mapping
            ):
                payload = command.get("payload")
                if isinstance(payload, Mapping) and payload.get("kind") in {
                    "deposit",
                    "withdraw",
                }:
                    command_type = str(payload["kind"])
            elif command_type == "_training_reveal_history":
                command_type = "reveal_time"
            category = (
                "ORDER"
                if command_type in {"place_order", "cancel_order", "close_position"}
                else "MARKER"
                if command_type == "add_journal_note"
                else "COMMAND"
            )
            descriptors = [(category, command_type.upper())]
            if command_type in {"deposit", "withdraw", "reveal_time"}:
                return descriptors
            if previous is not None:
                descriptors.extend(
                    ReviewRecorder.descriptors(
                        {"kind": "SOURCE_EVENT"},
                        previous,
                        projection,
                    )
                )
            return list(dict.fromkeys(descriptors))
        if kind == "STATE":
            return [("SYSTEM", str(context.get("state_kind", "STATE")).upper())]
        if kind != "SOURCE_EVENT" or previous is None:
            return []
        old = previous.get("domain")
        new = projection.get("domain")
        if not isinstance(old, Mapping) or not isinstance(new, Mapping):
            return []
        descriptors: list[tuple[str, str]] = []
        for field, category, event_type in (
            ("liquidation_count", "LIQUIDATION", "LIQUIDATION_TRIGGERED"),
            ("completed_liquidation_count", "LIQUIDATION", "LIQUIDATION"),
            ("funding_count", "FUNDING", "FUNDING_SETTLEMENT"),
            ("fill_count", "FILL", "FILL"),
            ("ledger_count", "POSITION", "LEDGER_POSTING"),
        ):
            if int(new.get(field, 0)) > int(old.get(field, 0)):
                descriptors.append((category, event_type))
        if new.get("order_hash") != old.get("order_hash"):
            descriptors.append(("ORDER", "ORDER_STATE"))
        if new.get("position_hash") != old.get("position_hash"):
            descriptors.append(("POSITION", "POSITION_STATE"))
        try:
            if Decimal(str(new["equity"])) < Decimal(str(old["equity"])):
                descriptors.append(("EQUITY", "DRAWDOWN"))
        except (InvalidOperation, KeyError):
            pass
        return list(dict.fromkeys(descriptors))

    def append(
        self,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        session_id: str,
        context: Mapping[str, object],
        state: Mapping[str, object] | None,
        checkpoint: bytes | None,
        now_ms: int,
    ) -> tuple[str, ...]:
        if self._internal_adapter_command(context):
            return ()
        run = connection.execute(
            """
            SELECT r.time_disclosure_policy, r.virtual_time_ms,
                   r.source_sequence, COALESCE(i.revealed, 0) AS revealed,
                   s.state_hash, s.event_sequence
            FROM replay_training_run AS r
            JOIN replay_session AS s ON s.session_id = ?
            LEFT JOIN replay_training_integrity AS i USING(run_id)
            WHERE r.run_id = ?
            """,
            (session_id, run_id),
        ).fetchone()
        if run is None:
            return ()
        cursor = state.get("cursor") if isinstance(state, Mapping) else None
        virtual_time_ms = int(
            cursor["virtual_time_ms"]
            if isinstance(cursor, Mapping)
            else run["virtual_time_ms"]
        )
        source_sequence = int(
            state["source_sequence"] if isinstance(state, Mapping) else run["source_sequence"]
        )
        event_sequence = int(
            state["event_sequence"] if isinstance(state, Mapping) else run["event_sequence"]
        )
        state_hash = str(
            state["state_hash"] if isinstance(state, Mapping) else run["state_hash"]
        )
        full_times = {
            int(row["virtual_time_ms"])
            for row in connection.execute(
                """
                SELECT virtual_time_ms FROM replay_training_market_track
                WHERE run_id = ? AND subscription_tier = 'FULL'
                  AND adapter_session_id IS NOT NULL
                """,
                (run_id,),
            ).fetchall()
            if row["virtual_time_ms"] is not None
        }
        previous_row = connection.execute(
            """
            SELECT projection_json FROM replay_review_timeline_event
            WHERE run_id = ? ORDER BY timeline_sequence DESC LIMIT 1
            """,
            (run_id,),
        ).fetchone()
        previous: Mapping[str, object] | None = None
        if previous_row is not None:
            decoded = json.loads(str(previous_row["projection_json"]))
            if isinstance(decoded, Mapping):
                previous = decoded
        context_kind = str(context.get("kind", ""))
        preliminary_descriptors: list[tuple[str, str]] | None = None
        if len(full_times) > 1 or context_kind == "SOURCE_EVENT":
            preliminary_descriptors = self.descriptors(
                context,
                previous,
                {
                    "domain": self._descriptor_domain(
                        connection,
                        run_id=run_id,
                    )
                },
            )
        if (
            len(full_times) > 1
            and context_kind not in {"INITIAL", "DIRECT"}
        ):
            # A critical mutation may be observed before the coordinator has
            # aligned the remaining actors. Preserve only this actor's exact
            # checkpoint now; the aligned transaction will build the global
            # frame and pull the latest durable checkpoint for every track.
            if preliminary_descriptors:
                self.anchor(
                    connection,
                    run_id=run_id,
                    session_id=session_id,
                    checkpoint=checkpoint,
                    state=state,
                    now_ms=now_ms,
                )
            return ()
        if context_kind == "SOURCE_EVENT" and not preliminary_descriptors:
            return ()
        projection = self.projection(
            connection,
            run_id=run_id,
            virtual_time_ms=virtual_time_ms,
            source_sequence=source_sequence,
        )
        descriptors = self.descriptors(context, previous, projection)
        if any(category == "EQUITY" for category, _ in descriptors):
            prior_equities: list[Decimal] = []
            for row in connection.execute(
                """
                SELECT projection_json FROM replay_review_timeline_event
                WHERE run_id = ? ORDER BY timeline_sequence
                """,
                (run_id,),
            ).fetchall():
                try:
                    decoded = json.loads(str(row["projection_json"]))
                    prior_equities.append(
                        Decimal(str(decoded["domain"]["equity"]))
                    )
                except (InvalidOperation, KeyError, TypeError):
                    continue
            current_equity = Decimal(
                str(dict(projection["domain"])["equity"])  # type: ignore[arg-type]
            )
            descriptors = [
                (
                    category,
                    "MAX_DRAWDOWN" if category == "EQUITY" else event_type,
                )
                for category, event_type in descriptors
                if category != "EQUITY"
                or not prior_equities
                or current_equity < min(prior_equities)
            ]
        if not descriptors:
            return ()
        event_count = int(
            connection.execute(
                "SELECT COUNT(*) FROM replay_review_timeline_event WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0]
        )
        if event_count + len(descriptors) > REVIEW_CRITICAL_EVENT_LIMIT:
            raise TrainingRunError(
                "REVIEW_TIMELINE_BUDGET_EXCEEDED",
                "critical review timeline budget is exhausted",
                status_code=409,
                details={
                    "used_events": event_count,
                    "offered_events": len(descriptors),
                    "limit_events": REVIEW_CRITICAL_EVENT_LIMIT,
                    "event_dropped": False,
                },
            )
        projection_json = canonical_json(projection)
        artifact_bytes = int(
            connection.execute(
                """
                SELECT
                    COALESCE((
                        SELECT SUM(length(CAST(projection_json AS BLOB)))
                        FROM replay_review_timeline_event WHERE run_id = ?
                    ), 0)
                     + COALESCE((
                         SELECT SUM(document_bytes)
                         FROM replay_review_drawing_document WHERE run_id = ?
                     ), 0)
                    + COALESCE((
                        SELECT SUM(length(CAST(text AS BLOB)))
                        FROM replay_review_marker WHERE run_id = ?
                    ), 0)
                 """,
                (run_id, run_id, run_id),
            ).fetchone()[0]
        )
        offered = len(projection_json.encode("utf-8")) * len(descriptors)
        if artifact_bytes + offered > REVIEW_ARTIFACT_BYTES_LIMIT:
            raise TrainingRunError(
                "REVIEW_ARTIFACT_BUDGET_EXCEEDED",
                "review projection artifact budget is exhausted",
                status_code=409,
                details={
                    "used_bytes": artifact_bytes,
                    "offered_bytes": offered,
                    "limit_bytes": REVIEW_ARTIFACT_BYTES_LIMIT,
                    "event_dropped": False,
                },
            )
        primary_anchor = self.anchor(
            connection,
            run_id=run_id,
            session_id=session_id,
            checkpoint=checkpoint,
            state=state,
            now_ms=now_ms,
        )
        primary_track = connection.execute(
            """
            SELECT track_id FROM replay_training_market_track
            WHERE run_id = ? AND adapter_session_id = ?
            """,
            (run_id, session_id),
        ).fetchone()
        if primary_track is None:
            raise TypeError("review primary track is missing")
        anchors = {str(primary_track["track_id"]): primary_anchor}
        for track in connection.execute(
            """
            SELECT track_id, adapter_session_id
            FROM replay_training_market_track
            WHERE run_id = ? AND adapter_session_id IS NOT NULL
              AND subscription_tier = 'FULL'
            ORDER BY stable_ordinal, track_id
            """,
            (run_id,),
        ).fetchall():
            track_id = str(track["track_id"])
            if track_id not in anchors:
                anchors[track_id] = self.anchor(
                    connection,
                    run_id=run_id,
                    session_id=str(track["adapter_session_id"]),
                    checkpoint=None,
                    state=None,
                    now_ms=now_ms,
                )
        anchor_set_hash = canonical_sha256(
            [
                {"track_id": track_id, "anchor_id": anchors[track_id]}
                for track_id in sorted(anchors)
            ]
        )
        public_time = self.owner._public_time(
            connection,
            session_id=session_id,
            policy=str(run["time_disclosure_policy"]),
            revealed=bool(run["revealed"]),
            public_time_ms=virtual_time_ms,
            sequence=source_sequence,
        )
        command = context.get("command")
        command_id = context.get("command_id")
        if command_id is None and isinstance(command, Mapping):
            command_id = command.get("command_id")
        created: list[str] = []
        for category, event_type in descriptors:
            tail = connection.execute(
                """
                SELECT timeline_sequence, event_hash
                FROM replay_review_timeline_event
                WHERE run_id = ? ORDER BY timeline_sequence DESC LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            sequence = 1 if tail is None else int(tail["timeline_sequence"]) + 1
            previous_hash = (
                REVIEW_ZERO_HASH if tail is None else str(tail["event_hash"])
            )
            event_id = f"review-event-{sequence:08d}"
            material = {
                "schema_version": REVIEW_TIMELINE_SCHEMA_VERSION,
                "run_id": run_id,
                "timeline_sequence": sequence,
                "event_id": event_id,
                "category": category,
                "event_type": event_type,
                "command_id": command_id,
                "track_id": str(primary_track["track_id"]),
                "virtual_time_ms": virtual_time_ms,
                "source_sequence": source_sequence,
                "event_sequence": event_sequence,
                "state_hash": state_hash,
                "account_hash": projection["account_hash"],
                "ledger_tail_hash": dict(projection["account"])[  # type: ignore[arg-type]
                    "ledger_tail_hash"
                ],
                "viewer_revision": dict(projection["viewer_state"])[  # type: ignore[arg-type]
                    "semantic_view_revision"
                ],
                "public_time": public_time,
                "projection_hash": canonical_sha256(projection),
                "anchor_set_hash": anchor_set_hash,
                "previous_event_hash": previous_hash,
            }
            event_hash = canonical_sha256(material)
            connection.execute(
                """
                INSERT INTO replay_review_timeline_event(
                    run_id, timeline_sequence, event_id, category, event_type,
                    command_id, track_id, virtual_time_ms, source_sequence,
                    event_sequence, state_hash, account_hash, ledger_tail_hash,
                    viewer_revision, public_time_json, projection_json,
                    anchor_set_hash, previous_event_hash, event_hash,
                    created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          ?, ?, ?, ?)
                """,
                (
                    run_id,
                    sequence,
                    event_id,
                    category,
                    event_type,
                    command_id,
                    primary_track["track_id"],
                    virtual_time_ms,
                    source_sequence,
                    event_sequence,
                    state_hash,
                    projection["account_hash"],
                    material["ledger_tail_hash"],
                    material["viewer_revision"],
                    canonical_json(public_time),
                    projection_json,
                    anchor_set_hash,
                    previous_hash,
                    event_hash,
                    now_ms,
                ),
            )
            for track_id, anchor_id in sorted(anchors.items()):
                connection.execute(
                    """
                    INSERT INTO replay_review_event_anchor(
                        run_id, timeline_sequence, track_id, anchor_id
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (run_id, sequence, track_id, anchor_id),
                )
            created.append(event_id)
        return tuple(created)

    def record_viewport(
        self,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        bucket_key: str,
        event_type: str,
        value: Mapping[str, object],
        public_time: Mapping[str, object],
        now_ms: int,
    ) -> dict[str, object]:
        value_json = canonical_json(value)
        digest = canonical_sha256(
            {
                "event_type": event_type,
                "bucket_key": bucket_key,
                "value": value,
            }
        )
        encoded_time = canonical_json(public_time)
        existing = connection.execute(
            """
            SELECT sample_count FROM replay_review_viewport_sample
            WHERE run_id = ? AND bucket_key = ?
            """,
            (run_id, bucket_key),
        ).fetchone()
        if existing is not None:
            sample_count = int(existing["sample_count"]) + 1
            connection.execute(
                """
                UPDATE replay_review_viewport_sample
                SET event_type = ?, value_json = ?, content_hash = ?,
                    sample_count = ?, last_public_time_json = ?,
                    last_used_at_ms = ?
                WHERE run_id = ? AND bucket_key = ?
                """,
                (
                    event_type,
                    value_json,
                    digest,
                    sample_count,
                    encoded_time,
                    now_ms,
                    run_id,
                    bucket_key,
                ),
            )
            return {
                "bucket_key": bucket_key,
                "content_hash": digest,
                "sample_count": sample_count,
                "coalesced": True,
            }
        count = int(
            connection.execute(
                "SELECT COUNT(*) FROM replay_review_viewport_sample WHERE run_id = ?",
                (run_id,),
            ).fetchone()[0]
        )
        if count >= REVIEW_VIEWPORT_LIMIT:
            connection.execute(
                """
                DELETE FROM replay_review_viewport_sample WHERE rowid = (
                    SELECT rowid FROM replay_review_viewport_sample
                    WHERE run_id = ? ORDER BY last_used_at_ms, bucket_key LIMIT 1
                )
                """,
                (run_id,),
            )
        connection.execute(
            """
            INSERT INTO replay_review_viewport_sample(
                run_id, bucket_key, event_type, value_json, content_hash,
                sample_count, first_public_time_json, last_public_time_json,
                last_used_at_ms, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
            """,
            (
                run_id,
                bucket_key,
                event_type,
                value_json,
                digest,
                encoded_time,
                encoded_time,
                now_ms,
                now_ms,
            ),
        )
        return {
            "bucket_key": bucket_key,
            "content_hash": digest,
            "sample_count": 1,
            "coalesced": False,
        }

    def sync(
        self,
        connection: sqlite3.Connection,
        session_id: str,
        context: Mapping[str, object],
        state: Mapping[str, object],
        component_state: Mapping[str, object],
        checkpoint: bytes | None,
        now_ms: int,
    ) -> None:
        del component_state
        if self._internal_adapter_command(context):
            return
        run = connection.execute(
            """
            SELECT track.run_id
            FROM replay_training_market_track AS track
            JOIN replay_training_contract_account AS account
              ON account.run_id = track.run_id
            JOIN replay_training_leverage_policy AS leverage
              ON leverage.run_id = track.run_id AND leverage.revision = 1
            JOIN replay_training_funding_policy AS funding
              ON funding.run_id = track.run_id AND funding.revision = 1
            WHERE track.adapter_session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if run is None:
            return
        self.append(
            connection,
            run_id=str(run["run_id"]),
            session_id=session_id,
            context=context,
            state=state,
            checkpoint=checkpoint,
            now_ms=now_ms,
        )


__all__ = [
    "REVIEW_ANCHOR_BYTES_LIMIT",
    "REVIEW_ARTIFACT_BYTES_LIMIT",
    "REVIEW_CRITICAL_EVENT_LIMIT",
    "REVIEW_VIEWPORT_LIMIT",
    "ReviewRecorder",
]
