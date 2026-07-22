"""Lightweight TrainingRun metadata storage layered on the replay.v1 database."""

from __future__ import annotations

import base64
import json
import sqlite3
from collections.abc import Callable, Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import cast

from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.broker.models import decimal_to_string
from app.replay.storage.sqlite_store import ReplaySQLiteStore

from .errors import TrainingRunError
from .disclosure import project_public_time
from .models import (
    CapabilityKind,
    CapabilityState,
    REPLAY_V2_PROTOCOL,
    TrainingRunCreateRequest,
    ViewerState,
    validate_v2_counter,
)
from .multitrack import (
    GLOBAL_ORDERING_VERSION,
    StableMarketEvent,
    global_ordering_hash,
    stable_market_event_order,
)
from .schema import TRAINING_SCHEMA_ID, migrate_training_schema


_LIST_LIMIT_MAX = 100
_COMPATIBILITY_FILTERS = {"READY", "LEGACY_ADAPTER", "LEGACY_V1", "UNAVAILABLE"}
_STATES = {"PAUSED", "PLAYING", "ADVANCING", "ENDED", "ERROR"}
_SOURCES = {"BAR", "AGG_TRADE"}
_VIEW_EVENT_LIMIT = 2_048
_EQUITY_RESOLUTIONS: tuple[tuple[str, int, int], ...] = (
    ("EVENT", 0, 2_048),
    ("1M", 60_000, 4_096),
    ("15M", 900_000, 2_048),
    ("1H", 3_600_000, 2_048),
)


_CARD_CTE = """
WITH cards AS (
    SELECT
        r.run_id AS run_id,
        'V2' AS kind,
        r.name AS name,
        CASE WHEN s.state = 'INITIALIZING' THEN 'PAUSED' ELSE s.state END AS state,
        r.source_kind AS source_kind,
        r.integrity_mode AS integrity_mode,
        r.time_disclosure_policy AS time_disclosure_policy,
        r.last_symbol AS last_symbol,
        (
            SELECT COUNT(*) FROM replay_training_market_track AS t
            WHERE t.run_id = r.run_id AND t.subscription_tier != 'NONE'
        ) AS subscribed_track_count,
        s.source_sequence AS progress_sequence,
        CASE WHEN r.summary_revision = s.revision THEN r.current_equity ELSE NULL END AS equity,
        CASE
            WHEN r.summary_revision = s.revision AND r.current_equity IS NOT NULL THEN 'CURRENT'
            ELSE 'STALE'
        END AS equity_status,
        r.settlement_asset AS settlement_asset,
        CASE WHEN s.updated_at_ms > r.updated_at_ms THEN s.updated_at_ms ELSE r.updated_at_ms END AS updated_at_ms,
        CASE WHEN s.degraded_reason IS NULL THEN r.compatibility ELSE 'UNAVAILABLE' END AS compatibility,
        CASE WHEN s.degraded_reason IS NULL THEN 'OPEN_ADAPTER' ELSE 'UNAVAILABLE' END AS resume_action,
        selected_track.adapter_session_id AS adapter_session_id,
        r.parent_legacy_session_id AS parent_legacy_session_id,
        s.degraded_reason AS degraded_reason,
        s.status_reason AS status_reason,
        EXISTS(
            SELECT 1 FROM replay_report AS report
            WHERE report.session_id IN (
                SELECT adapter_session_id
                FROM replay_training_market_track
                WHERE run_id = r.run_id AND adapter_session_id IS NOT NULL
            )
        ) AS report_available,
        EXISTS(
            SELECT 1 FROM replay_equity_sample AS sample
            WHERE sample.run_id = r.run_id
        ) AS review_available
    FROM replay_training_run AS r
    JOIN replay_training_viewer_state AS viewer USING(run_id)
    JOIN replay_training_market_track AS selected_track
      ON selected_track.run_id = r.run_id
     AND selected_track.track_id = viewer.selected_track_id
     AND selected_track.adapter_session_id IS NOT NULL
    JOIN replay_session AS s ON s.session_id = selected_track.adapter_session_id

    UNION ALL

    SELECT
        s.session_id AS run_id,
        'LEGACY_V1' AS kind,
        'Legacy ' || COALESCE(json_extract(s.config_json, '$.symbol'), s.session_id) AS name,
        CASE WHEN s.state = 'INITIALIZING' THEN 'PAUSED' ELSE s.state END AS state,
        CASE json_extract(s.config_json, '$.source_kind')
            WHEN 'agg_trade' THEN 'AGG_TRADE'
            ELSE 'BAR'
        END AS source_kind,
        NULL AS integrity_mode,
        CASE WHEN json_extract(s.config_json, '$.blind_mode') = 1 THEN 'HIDE_ALL' ELSE 'NONE' END AS time_disclosure_policy,
        COALESCE(json_extract(s.config_json, '$.symbol'), 'UNKNOWN') AS last_symbol,
        1 AS subscribed_track_count,
        s.source_sequence AS progress_sequence,
        NULL AS equity,
        'UNAVAILABLE' AS equity_status,
        COALESCE(json_extract(s.config_json, '$.quote_asset'), 'UNKNOWN') AS settlement_asset,
        s.updated_at_ms AS updated_at_ms,
        CASE WHEN s.degraded_reason IS NULL THEN 'LEGACY_V1' ELSE 'UNAVAILABLE' END AS compatibility,
        CASE WHEN s.degraded_reason IS NULL THEN 'OPEN_V1' ELSE 'UNAVAILABLE' END AS resume_action,
        s.session_id AS adapter_session_id,
        NULL AS parent_legacy_session_id,
        s.degraded_reason AS degraded_reason,
        s.status_reason AS status_reason,
        EXISTS(
            SELECT 1 FROM replay_report AS report
            WHERE report.session_id = s.session_id
        ) AS report_available,
        0 AS review_available
    FROM replay_session AS s
    WHERE NOT EXISTS(
        SELECT 1 FROM replay_training_run AS r
        WHERE r.adapter_session_id = s.session_id
    )
      AND NOT EXISTS(
        SELECT 1 FROM replay_training_market_track AS t
        WHERE t.adapter_session_id = s.session_id
    )
)
"""


def _safe_name(value: str | None, *, fallback: str) -> str:
    if value is None:
        return fallback[:80]
    if not isinstance(value, str):
        raise TrainingRunError(
            "TRAINING_RUN_INVALID",
            "training name must be a string or null",
            status_code=422,
        )
    normalized = value.strip()
    if not normalized or len(normalized) > 80 or any(ord(char) < 32 for char in normalized):
        raise TrainingRunError(
            "TRAINING_RUN_INVALID",
            "training name must contain 1-80 display-safe characters",
            status_code=422,
        )
    return normalized


def _phase1_capabilities(source_kind: str) -> dict[str, str]:
    capabilities = {
        kind.value: CapabilityState.UNSUPPORTED_NO_HISTORY.value
        for kind in CapabilityKind
    }
    capabilities[CapabilityKind.OHLCV.value] = CapabilityState.AVAILABLE_EXACT.value
    capabilities[CapabilityKind.INDICATORS.value] = CapabilityState.AVAILABLE_EXACT.value
    capabilities[CapabilityKind.SIMULATED_LIQUIDATION.value] = (
        CapabilityState.AVAILABLE_APPROX.value
    )
    if source_kind == "AGG_TRADE":
        capabilities[CapabilityKind.AGG_TRADE_TAPE.value] = (
            CapabilityState.AVAILABLE_EXACT.value
        )
        capabilities[CapabilityKind.ORDER_FLOW.value] = (
            CapabilityState.AVAILABLE_APPROX.value
        )
    else:
        capabilities[CapabilityKind.AGG_TRADE_TAPE.value] = (
            CapabilityState.UNSUPPORTED_SOURCE_MODE.value
        )
        capabilities[CapabilityKind.ORDER_FLOW.value] = (
            CapabilityState.UNSUPPORTED_SOURCE_MODE.value
        )
    return capabilities


def _cursor_payload(value: str | None) -> tuple[int, str, str] | None:
    if value is None:
        return None
    try:
        padding = "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(value + padding).decode("utf-8"))
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise TrainingRunError(
            "TRAINING_RUN_INVALID_CURSOR",
            "run list cursor is invalid",
            status_code=422,
        ) from exc
    if (
        not isinstance(payload, dict)
        or set(payload) != {"updated_at_ms", "run_id", "kind"}
        or isinstance(payload["updated_at_ms"], bool)
        or not isinstance(payload["updated_at_ms"], int)
        or payload["updated_at_ms"] < 0
        or not isinstance(payload["run_id"], str)
        or not isinstance(payload["kind"], str)
    ):
        raise TrainingRunError(
            "TRAINING_RUN_INVALID_CURSOR",
            "run list cursor is invalid",
            status_code=422,
        )
    return payload["updated_at_ms"], payload["run_id"], payload["kind"]


def _encode_cursor(row: Mapping[str, object]) -> str:
    payload = canonical_json(
        {
            "updated_at_ms": int(row["updated_at_ms"]),
            "run_id": str(row["run_id"]),
            "kind": str(row["kind"]),
        }
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


class TrainingRunStore:
    """Own v2 metadata while reusing the v1 transaction and dataset owner."""

    def __init__(self, base_store: ReplaySQLiteStore) -> None:
        self.base_store = base_store

    async def start(self) -> None:
        now = self.base_store._validated_now_ms()
        await self.base_store.run_extension_write(
            lambda connection: migrate_training_schema(connection, now_ms=now)
        )
        self.base_store.register_session_summary_writer(self._sync_session_summary)
        self.base_store.register_session_mutation_writer(self._sync_session_mutation)

    def initial_run_writer(
        self,
        *,
        run_id: str,
        request: TrainingRunCreateRequest,
        adapter_session_id: str,
        session_state: Mapping[str, object],
        component_state: Mapping[str, object],
    ) -> Callable[[sqlite3.Connection, int], None]:
        def write(connection: sqlite3.Connection, now_ms: int) -> None:
            cursor = session_state.get("cursor")
            if not isinstance(cursor, Mapping):
                raise TypeError("training adapter cursor must be an object")
            account = component_state.get("account")
            if not isinstance(account, Mapping) or not isinstance(account.get("equity"), str):
                raise TypeError("training adapter account equity is missing")
            name = _safe_name(
                request.name,
                fallback=f"{request.symbol} 训练 {run_id[-8:]}",
            )
            rule = request.to_dict(redact_hidden_start=True)
            self._insert_run(
                connection,
                {
                    "run_id": run_id,
                    "adapter_session_id": adapter_session_id,
                    "parent_legacy_session_id": None,
                    "name": name,
                    "state": str(session_state["state"]),
                    "source_kind": request.source_kind.value,
                    "start_mode": request.start_mode.value,
                    "integrity_mode": request.integrity_mode.value,
                    "time_disclosure_policy": request.time_disclosure_policy.value,
                    "book_mode": request.book_mode.value,
                    "margin_mode": request.margin_mode.value,
                    "funding_mode": request.funding_mode,
                    "allow_rule_changes": int(request.allow_rule_changes),
                    "exchange": request.exchange,
                    "market_type": request.market_type,
                    "last_symbol": request.symbol,
                    "settlement_asset": request.settlement_asset,
                    "base_interval": request.base_interval,
                    "display_interval": request.display_interval,
                    "initial_equity": request.initial_equity,
                    "current_equity": str(account["equity"]),
                    "summary_revision": int(session_state["revision"]),
                    "revision": int(session_state["revision"]),
                    "source_sequence": int(session_state["source_sequence"]),
                    "virtual_time_ms": int(cursor["virtual_time_ms"]),
                    "catalog_epoch": request.catalog_epoch,
                    "dataset_epoch": str(session_state["data_epoch"]),
                    "compatibility": "READY",
                    "now_ms": now_ms,
                },
            )
            self._insert_track(
                connection,
                run_id=run_id,
                adapter_session_id=adapter_session_id,
                source_kind=request.source_kind.value,
                exchange=request.exchange,
                market_type=request.market_type,
                symbol=request.symbol,
                settlement_asset=request.settlement_asset,
                dataset_epoch=str(session_state["data_epoch"]),
                cursor={**cursor, "revision": int(session_state["revision"])},
                component_state=component_state,
                now_ms=now_ms,
            )
            self._insert_viewer_state(
                connection,
                ViewerState(
                    run_id=run_id,
                    selected_track_id="track-1",
                    display_interval=request.display_interval,
                    chart_type="candles",
                    visible_range=None,
                    pane_layout={},
                    rail_layout={},
                    semantic_view_revision=0,
                ),
                now_ms=now_ms,
            )
            self._insert_rule(connection, run_id=run_id, rule=rule, now_ms=now_ms)
            self._insert_initial_action(
                connection,
                run_id=run_id,
                action_type="CREATE_RUN",
                action={
                    "schema": "replay.training.action.v1",
                    "adapter_session_id": adapter_session_id,
                    "source_kind": request.source_kind.value,
                    "start_mode": request.start_mode.value,
                },
                now_ms=now_ms,
            )
            self._insert_pin(
                connection,
                run_id=run_id,
                adapter_session_id=adapter_session_id,
                dataset_epoch=str(session_state["data_epoch"]),
                now_ms=now_ms,
            )
            start_time_known = request.start_mode.value == "MANUAL"
            strict_eligible = (
                request.integrity_mode.value == "CHALLENGE"
                and not start_time_known
                and request.time_disclosure_policy.value != "NONE"
            )
            result_label = self._result_label(
                integrity_mode=request.integrity_mode.value,
                start_time_known=start_time_known,
                strict_eligible=strict_eligible,
                revealed=False,
            )
            connection.execute(
                """
                INSERT INTO replay_training_integrity(
                    run_id, strict_eligible, start_time_known, revealed,
                    allowed_mutations_json, result_label, updated_at_ms
                ) VALUES (?, ?, ?, 0, ?, ?, ?)
                """,
                (
                    run_id,
                    int(strict_eligible),
                    int(start_time_known),
                    canonical_json(list(request.allowed_mutations)),
                    result_label,
                    now_ms,
                ),
            )
            public_time = self._public_time(
                connection,
                session_id=adapter_session_id,
                policy=request.time_disclosure_policy.value,
                revealed=False,
                public_time_ms=int(cursor["virtual_time_ms"]),
                sequence=validate_v2_counter(
                    session_state["source_sequence"],
                    field_name="session source_sequence",
                ),
            )
            state_hash = str(session_state["state_hash"])
            connection.execute(
                """
                INSERT INTO replay_run_action_event(
                    run_id, action_sequence, event_id, command_id, event_type,
                    rule_revision, public_time_json, old_value_json,
                    new_value_json, reason, state_hash_before,
                    state_hash_after, created_at_ms
                ) VALUES (?, 1, 'action-00000001', NULL, 'CREATE_RUN', 1,
                          ?, '{}', ?, 'atomic create', NULL, ?, ?)
                """,
                (
                    run_id,
                    canonical_json(public_time),
                    canonical_json(
                        {
                            "integrity_mode": request.integrity_mode.value,
                            "time_disclosure_policy": request.time_disclosure_policy.value,
                            "result_label": result_label,
                        }
                    ),
                    state_hash,
                    now_ms,
                ),
            )
            self._upsert_equity_samples(
                connection,
                run_id=run_id,
                session_id=adapter_session_id,
                policy=request.time_disclosure_policy.value,
                revealed=False,
                state=session_state,
                component_state=component_state,
                now_ms=now_ms,
            )

        return write

    def fork_run_writer(
        self,
        *,
        child_run_id: str,
        parent_run_id: str,
        parent_event_id: str,
        parent_checkpoint_id: int,
    ) -> Callable[..., object]:
        """Build the v2 metadata half of an exact checkpoint fork."""

        def write(
            connection: sqlite3.Connection,
            now_ms: int,
            *,
            session_id: str,
            session_state: Mapping[str, object],
            component_state: Mapping[str, object],
        ) -> None:
            parent = connection.execute(
                """
                SELECT r.*, i.strict_eligible, i.start_time_known, i.revealed,
                       i.allowed_mutations_json, i.result_label,
                       rule.rule_json, rule.rule_hash
                FROM replay_training_run AS r
                JOIN replay_training_integrity AS i USING(run_id)
                JOIN replay_training_rule AS rule
                  ON rule.run_id = r.run_id
                 AND rule.revision = r.active_rule_revision
                WHERE r.run_id = ?
                """,
                (parent_run_id,),
            ).fetchone()
            if parent is None:
                raise TrainingRunError(
                    "TRAINING_RUN_NOT_FOUND",
                    "parent training run does not exist",
                    status_code=404,
                )
            checkpoint = connection.execute(
                """
                SELECT state_hash FROM replay_checkpoint
                WHERE checkpoint_id = ? AND session_id = ? AND active = 1
                """,
                (parent_checkpoint_id, parent["adapter_session_id"]),
            ).fetchone()
            if checkpoint is None or str(checkpoint["state_hash"]) != str(
                session_state["state_hash"]
            ):
                raise TrainingRunError(
                    "REVIEW_FORK_MISMATCH",
                    "fork checkpoint state hash changed",
                    status_code=409,
                )
            cursor = session_state.get("cursor")
            account = component_state.get("account")
            if not isinstance(cursor, Mapping) or not isinstance(account, Mapping):
                raise TypeError("forked training snapshot is invalid")
            self._insert_run(
                connection,
                {
                    "run_id": child_run_id,
                    "adapter_session_id": session_id,
                    "parent_legacy_session_id": parent["parent_legacy_session_id"],
                    "name": _safe_name(
                        f"{parent['name']} · Fork"[:80],
                        fallback=f"Fork {child_run_id[-8:]}",
                    ),
                    "state": str(session_state["state"]),
                    "source_kind": str(parent["source_kind"]),
                    "start_mode": str(parent["start_mode"]),
                    "integrity_mode": str(parent["integrity_mode"]),
                    "time_disclosure_policy": str(parent["time_disclosure_policy"]),
                    "book_mode": str(parent["book_mode"]),
                    "margin_mode": str(parent["margin_mode"]),
                    "funding_mode": str(parent["funding_mode"]),
                    "allow_rule_changes": int(parent["allow_rule_changes"]),
                    "exchange": str(parent["exchange"]),
                    "market_type": str(parent["market_type"]),
                    "last_symbol": str(parent["last_symbol"]),
                    "settlement_asset": str(parent["settlement_asset"]),
                    "base_interval": str(parent["base_interval"]),
                    "display_interval": str(parent["display_interval"]),
                    "initial_equity": str(parent["initial_equity"]),
                    "current_equity": str(account["equity"]),
                    "summary_revision": validate_v2_counter(
                        session_state["revision"], field_name="fork revision"
                    ),
                    "revision": validate_v2_counter(
                        session_state["revision"], field_name="fork revision"
                    ),
                    "source_sequence": validate_v2_counter(
                        session_state["source_sequence"],
                        field_name="fork source_sequence",
                    ),
                    "virtual_time_ms": int(cursor["virtual_time_ms"]),
                    "catalog_epoch": str(parent["catalog_epoch"]),
                    "dataset_epoch": str(parent["dataset_epoch"]),
                    "compatibility": "READY",
                    "now_ms": now_ms,
                },
            )
            self._insert_track(
                connection,
                run_id=child_run_id,
                adapter_session_id=session_id,
                source_kind=str(parent["source_kind"]),
                exchange=str(parent["exchange"]),
                market_type=str(parent["market_type"]),
                symbol=str(parent["last_symbol"]),
                settlement_asset=str(parent["settlement_asset"]),
                dataset_epoch=str(parent["dataset_epoch"]),
                cursor={
                    **cursor,
                    "revision": validate_v2_counter(
                        session_state["revision"], field_name="fork revision"
                    ),
                },
                component_state=component_state,
                now_ms=now_ms,
            )
            parent_view = connection.execute(
                "SELECT * FROM replay_training_viewer_state WHERE run_id = ?",
                (parent_run_id,),
            ).fetchone()
            self._insert_viewer_state(
                connection,
                ViewerState(
                    run_id=child_run_id,
                    selected_track_id="track-1",
                    display_interval=(
                        str(parent["display_interval"])
                        if parent_view is None
                        else str(parent_view["display_interval"])
                    ),
                    chart_type=(
                        "candles" if parent_view is None else str(parent_view["chart_type"])
                    ),
                    visible_range=None,
                    pane_layout={},
                    rail_layout={},
                    semantic_view_revision=0,
                ),
                now_ms=now_ms,
            )
            rule = json.loads(str(parent["rule_json"]))
            self._insert_rule(
                connection,
                run_id=child_run_id,
                rule=rule,
                now_ms=now_ms,
            )
            self._insert_initial_action(
                connection,
                run_id=child_run_id,
                action_type="FORK_FROM_REVIEW",
                action={
                    "schema": "replay.training.action.v2",
                    "parent_run_id": parent_run_id,
                    "parent_event_id": parent_event_id,
                    "parent_checkpoint_id": parent_checkpoint_id,
                },
                now_ms=now_ms,
            )
            self._insert_pin(
                connection,
                run_id=child_run_id,
                adapter_session_id=session_id,
                dataset_epoch=str(parent["dataset_epoch"]),
                now_ms=now_ms,
            )
            result_label = f"{parent['integrity_mode']}_FORKED_REVIEW"
            connection.execute(
                """
                INSERT INTO replay_training_integrity(
                    run_id, strict_eligible, start_time_known, revealed,
                    allowed_mutations_json, result_label, updated_at_ms
                ) VALUES (?, 0, ?, ?, ?, ?, ?)
                """,
                (
                    child_run_id,
                    int(parent["start_time_known"]),
                    int(parent["revealed"]),
                    str(parent["allowed_mutations_json"]),
                    result_label,
                    now_ms,
                ),
            )
            public_time = self._public_time(
                connection,
                session_id=session_id,
                policy=str(parent["time_disclosure_policy"]),
                revealed=bool(parent["revealed"]),
                public_time_ms=int(cursor["virtual_time_ms"]),
                sequence=validate_v2_counter(
                    session_state["source_sequence"],
                    field_name="fork source_sequence",
                ),
            )
            connection.execute(
                """
                INSERT INTO replay_run_action_event(
                    run_id, action_sequence, event_id, command_id, event_type,
                    rule_revision, public_time_json, old_value_json,
                    new_value_json, reason, state_hash_before,
                    state_hash_after, created_at_ms
                ) VALUES (?, 1, 'action-00000001', NULL, 'FORK_FROM_REVIEW', 1,
                          ?, ?, ?, 'continue from review event', ?, ?, ?)
                """,
                (
                    child_run_id,
                    canonical_json(public_time),
                    canonical_json(
                        {"parent_run_id": parent_run_id, "parent_event_id": parent_event_id}
                    ),
                    canonical_json({"result_label": result_label}),
                    session_state["state_hash"],
                    session_state["state_hash"],
                    now_ms,
                ),
            )
            connection.execute(
                """
                INSERT INTO replay_run_lineage(
                    child_run_id, parent_run_id, parent_event_id,
                    parent_checkpoint_id, dataset_epoch, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    child_run_id,
                    parent_run_id,
                    parent_event_id,
                    parent_checkpoint_id,
                    parent["dataset_epoch"],
                    now_ms,
                ),
            )
            self._upsert_equity_samples(
                connection,
                run_id=child_run_id,
                session_id=session_id,
                policy=str(parent["time_disclosure_policy"]),
                revealed=bool(parent["revealed"]),
                state=session_state,
                component_state=component_state,
                now_ms=now_ms,
            )

        def factory(
            *,
            session_id: str,
            session_state: Mapping[str, object],
            component_state: Mapping[str, object],
        ) -> Callable[[sqlite3.Connection, int], None]:
            return lambda connection, now_ms: write(
                connection,
                now_ms,
                session_id=session_id,
                session_state=session_state,
                component_state=component_state,
            )

        return factory

    async def list_runs(
        self,
        *,
        limit: int,
        cursor: str | None,
        state: str | None,
        source_kind: str | None,
        compatibility: str | None,
    ) -> dict[str, object]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= _LIST_LIMIT_MAX:
            raise TrainingRunError(
                "TRAINING_RUN_INVALID",
                f"limit must be between 1 and {_LIST_LIMIT_MAX}",
                status_code=422,
            )
        if state is not None and state not in _STATES:
            raise TrainingRunError("TRAINING_RUN_INVALID", "state filter is invalid", status_code=422)
        if source_kind is not None and source_kind not in _SOURCES:
            raise TrainingRunError("TRAINING_RUN_INVALID", "source filter is invalid", status_code=422)
        if compatibility is not None and compatibility not in _COMPATIBILITY_FILTERS:
            raise TrainingRunError(
                "TRAINING_RUN_INVALID",
                "compatibility filter is invalid",
                status_code=422,
            )
        decoded_cursor = _cursor_payload(cursor)

        def read(connection: sqlite3.Connection) -> tuple[sqlite3.Row, ...]:
            sql = _CARD_CTE + """
            SELECT * FROM cards
            WHERE (:state IS NULL OR state = :state)
              AND (:source_kind IS NULL OR source_kind = :source_kind)
              AND (:compatibility IS NULL OR compatibility = :compatibility)
              AND (
                    :cursor_updated IS NULL
                    OR updated_at_ms < :cursor_updated
                    OR (
                        updated_at_ms = :cursor_updated
                        AND (
                            run_id < :cursor_run
                            OR (run_id = :cursor_run AND kind < :cursor_kind)
                        )
                    )
              )
            ORDER BY updated_at_ms DESC, run_id DESC, kind DESC
            LIMIT :row_limit
            """
            params = {
                "state": state,
                "source_kind": source_kind,
                "compatibility": compatibility,
                "cursor_updated": None if decoded_cursor is None else decoded_cursor[0],
                "cursor_run": None if decoded_cursor is None else decoded_cursor[1],
                "cursor_kind": None if decoded_cursor is None else decoded_cursor[2],
                "row_limit": limit + 1,
            }
            return tuple(connection.execute(sql, params).fetchall())

        rows = await self.base_store.run_extension_read(read)
        visible = rows[:limit]
        items = [self._card_from_row(row) for row in visible]
        next_cursor = _encode_cursor(visible[-1]) if len(rows) > limit and visible else None
        return {
            "protocol": REPLAY_V2_PROTOCOL,
            "schema_version": TRAINING_SCHEMA_ID,
            "items": items,
            "next_cursor": next_cursor,
        }

    async def get_run(self, run_id: str) -> dict[str, object]:
        def read(connection: sqlite3.Connection) -> sqlite3.Row | None:
            return connection.execute(
                _CARD_CTE + "SELECT * FROM cards WHERE run_id = ? AND kind = 'V2'",
                (run_id,),
            ).fetchone()

        row = await self.base_store.run_extension_read(read)
        if row is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training run does not exist",
                status_code=404,
            )
        return self._card_from_row(row)

    async def migrate_legacy(
        self,
        *,
        session_id: str,
        run_id: str,
        name: str | None,
    ) -> tuple[str, bool]:
        def write(connection: sqlite3.Connection) -> tuple[str, bool]:
            existing = connection.execute(
                "SELECT run_id FROM replay_training_run WHERE adapter_session_id = ?",
                (session_id,),
            ).fetchone()
            if existing is not None:
                return str(existing["run_id"]), False
            row = connection.execute(
                """
                SELECT s.*, d.data_epoch AS dataset_epoch
                FROM replay_session AS s
                LEFT JOIN replay_dataset_ref AS d USING(session_id)
                WHERE s.session_id = ?
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                raise TrainingRunError(
                    "TRAINING_RUN_NOT_FOUND",
                    "legacy replay session does not exist",
                    status_code=404,
                )
            if row["dataset_epoch"] is None:
                raise TrainingRunError(
                    "TRAINING_RUN_UNAVAILABLE",
                    "legacy replay dataset reference is missing",
                    status_code=409,
                )
            config = json.loads(row["config_json"])
            broker = json.loads(row["broker_config_json"])
            blind = bool(config.get("blind_mode"))
            source_kind = "AGG_TRADE" if config.get("source_kind") == "agg_trade" else "BAR"
            start_mode = "RANDOM" if config.get("start_policy") == "random_eligible" else "MANUAL"
            symbol = str(config.get("symbol") or "UNKNOWN")
            run_name = _safe_name(name, fallback=f"Legacy {symbol}")
            requested_start = None if blind else config.get("requested_start_ms")
            rule = {
                "schema": "replay.training.legacy-rule.v1",
                "legacy_protocol": "replay.v1",
                "config": {**config, "requested_start_ms": requested_start},
                "broker_config": broker,
            }
            cursor = {
                "virtual_time_ms": 0,
                "source_sequence": int(row["source_sequence"]),
                "revision": int(row["revision"]),
            }
            self._insert_run(
                connection,
                {
                    "run_id": run_id,
                    "adapter_session_id": session_id,
                    "parent_legacy_session_id": session_id,
                    "name": run_name,
                    "state": str(row["state"]),
                    "source_kind": source_kind,
                    "start_mode": start_mode,
                    "integrity_mode": "CHALLENGE",
                    "time_disclosure_policy": "HIDE_ALL" if blind else "NONE",
                    "book_mode": "OFF",
                    "margin_mode": "CROSS",
                    "funding_mode": "OFF",
                    "allow_rule_changes": 0,
                    "exchange": str(config.get("exchange") or "unknown"),
                    "market_type": str(config.get("market_type") or "unknown"),
                    "last_symbol": symbol,
                    "settlement_asset": str(config.get("quote_asset") or "UNKNOWN"),
                    "base_interval": str(config.get("base_interval") or "unknown"),
                    "display_interval": str(config.get("display_interval") or "unknown"),
                    "initial_equity": str(broker.get("initial_equity") or config.get("initial_equity") or "0"),
                    "current_equity": None,
                    "summary_revision": None,
                    "revision": int(row["revision"]),
                    "source_sequence": int(row["source_sequence"]),
                    "virtual_time_ms": 0,
                    "catalog_epoch": str(row["data_epoch"]),
                    "dataset_epoch": str(row["dataset_epoch"]),
                    "compatibility": "LEGACY_ADAPTER",
                    "now_ms": self.base_store._validated_now_ms(),
                },
            )
            now_ms = self.base_store._validated_now_ms()
            self._insert_track(
                connection,
                run_id=run_id,
                adapter_session_id=session_id,
                source_kind=source_kind,
                exchange=str(config.get("exchange") or "unknown"),
                market_type=str(config.get("market_type") or "unknown"),
                symbol=symbol,
                settlement_asset=str(config.get("quote_asset") or "UNKNOWN"),
                dataset_epoch=str(row["dataset_epoch"]),
                cursor=cursor,
                component_state=None,
                now_ms=now_ms,
            )
            self._insert_viewer_state(
                connection,
                ViewerState(
                    run_id=run_id,
                    selected_track_id="track-1",
                    display_interval=str(config.get("display_interval") or "unknown"),
                    chart_type="candles",
                    visible_range=None,
                    pane_layout={},
                    rail_layout={},
                    semantic_view_revision=0,
                ),
                now_ms=now_ms,
            )
            self._insert_rule(connection, run_id=run_id, rule=rule, now_ms=now_ms)
            self._insert_initial_action(
                connection,
                run_id=run_id,
                action_type="MIGRATE_LEGACY_V1",
                action={
                    "schema": "replay.training.action.v1",
                    "parent_legacy_session_id": session_id,
                    "legacy_hash_unchanged": True,
                },
                now_ms=now_ms,
            )
            self._insert_pin(
                connection,
                run_id=run_id,
                adapter_session_id=session_id,
                dataset_epoch=str(row["dataset_epoch"]),
                now_ms=now_ms,
            )
            return run_id, True

        return await self.base_store.run_extension_write(write)

    async def run_id_for_session(self, session_id: str) -> str:
        def read(connection: sqlite3.Connection) -> str | None:
            row = connection.execute(
                """
                SELECT run_id FROM replay_training_market_track
                WHERE adapter_session_id = ?
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                row = connection.execute(
                    "SELECT run_id FROM replay_training_run WHERE adapter_session_id = ?",
                    (session_id,),
                ).fetchone()
            if row is not None:
                return str(row["run_id"])
            legacy = connection.execute(
                "SELECT 1 FROM replay_session WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            return session_id if legacy is not None else None

        run_id = await self.base_store.run_extension_read(read)
        if run_id is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training adapter session does not exist",
                status_code=404,
            )
        return run_id

    async def run_binding(self, run_id: str) -> dict[str, object]:
        def read(connection: sqlite3.Connection) -> sqlite3.Row | None:
            return connection.execute(
                """
                SELECT r.run_id, selected.adapter_session_id, r.source_kind,
                       r.base_interval, r.display_interval, r.compatibility,
                       r.exchange, r.market_type, r.settlement_asset,
                       r.catalog_epoch, r.dataset_epoch, r.initial_equity,
                       selected.track_id AS selected_track_id,
                       selected.stable_ordinal AS selected_track_ordinal,
                       s.config_json,
                       r.integrity_mode, r.time_disclosure_policy,
                       r.allow_rule_changes, r.active_rule_revision,
                       i.allowed_mutations_json, i.revealed,
                       i.strict_eligible, i.start_time_known, i.result_label,
                       dataset.actual_replay_start_ms,
                       dataset.actual_replay_end_ms,
                       dataset.synthetic_origin_ms
                FROM replay_training_run AS r
                JOIN replay_training_viewer_state AS viewer USING(run_id)
                JOIN replay_training_market_track AS selected
                  ON selected.run_id = r.run_id
                 AND selected.track_id = viewer.selected_track_id
                 AND selected.adapter_session_id IS NOT NULL
                JOIN replay_session AS s ON s.session_id = r.adapter_session_id
                JOIN replay_dataset_ref AS dataset
                  ON dataset.session_id = r.adapter_session_id
                JOIN replay_training_integrity AS i USING(run_id)
                WHERE r.run_id = ?
                """,
                (run_id,),
            ).fetchone()

        row = await self.base_store.run_extension_read(read)
        if row is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training run does not exist",
                status_code=404,
            )
        return {
            "run_id": str(row["run_id"]),
            "adapter_session_id": str(row["adapter_session_id"]),
            "source_kind": str(row["source_kind"]),
            "base_interval": str(row["base_interval"]),
            "display_interval": str(row["display_interval"]),
            "compatibility": str(row["compatibility"]),
            "adapter_config": json.loads(str(row["config_json"])),
            "exchange": str(row["exchange"]),
            "market_type": str(row["market_type"]),
            "settlement_asset": str(row["settlement_asset"]),
            "catalog_epoch": str(row["catalog_epoch"]),
            "dataset_epoch": str(row["dataset_epoch"]),
            "initial_equity": str(row["initial_equity"]),
            "selected_track_id": str(row["selected_track_id"]),
            "selected_track_ordinal": int(row["selected_track_ordinal"]),
            "actual_replay_start_ms": int(row["actual_replay_start_ms"]),
            "actual_replay_end_ms": int(row["actual_replay_end_ms"]),
            "synthetic_origin_ms": row["synthetic_origin_ms"],
            "integrity_mode": str(row["integrity_mode"]),
            "time_disclosure_policy": str(row["time_disclosure_policy"]),
            "allow_rule_changes": bool(row["allow_rule_changes"]),
            "allowed_mutations": tuple(
                json.loads(str(row["allowed_mutations_json"]))
            ),
            "revealed": bool(row["revealed"]),
            "strict_eligible": bool(row["strict_eligible"]),
            "start_time_known": bool(row["start_time_known"]),
            "result_label": str(row["result_label"]),
            "active_rule_revision": int(row["active_rule_revision"]),
        }

    async def integrity(self, run_id: str) -> dict[str, object]:
        def read(connection: sqlite3.Connection) -> dict[str, object] | None:
            row = connection.execute(
                """
                SELECT r.run_id, r.adapter_session_id, r.integrity_mode,
                       r.time_disclosure_policy, r.active_rule_revision,
                       r.virtual_time_ms, r.source_sequence,
                       i.strict_eligible, i.start_time_known, i.revealed,
                       i.allowed_mutations_json, i.result_label,
                       rule.rule_hash, rule.rule_json
                FROM replay_training_run AS r
                JOIN replay_training_integrity AS i USING(run_id)
                JOIN replay_training_rule AS rule
                  ON rule.run_id = r.run_id
                 AND rule.revision = r.active_rule_revision
                WHERE r.run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if row is None:
                return None
            actions = connection.execute(
                """
                SELECT * FROM replay_run_action_event
                WHERE run_id = ? AND event_type != 'CREATE_RUN'
                ORDER BY action_sequence
                """,
                (run_id,),
            ).fetchall()
            public_time = self._public_time(
                connection,
                session_id=str(row["adapter_session_id"]),
                policy=str(row["time_disclosure_policy"]),
                revealed=bool(row["revealed"]),
                public_time_ms=int(row["virtual_time_ms"]),
                sequence=int(row["source_sequence"]),
            )
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "run_id": str(row["run_id"]),
                "integrity_mode": str(row["integrity_mode"]),
                "configured_time_disclosure_policy": str(
                    row["time_disclosure_policy"]
                ),
                "effective_time_disclosure_policy": (
                    "NONE" if bool(row["revealed"]) else str(row["time_disclosure_policy"])
                ),
                "strict_eligible": bool(row["strict_eligible"]),
                "start_time_known": bool(row["start_time_known"]),
                "revealed": bool(row["revealed"]),
                "allowed_mutations": json.loads(str(row["allowed_mutations_json"])),
                "result_label": str(row["result_label"]),
                "active_rule_revision": int(row["active_rule_revision"]),
                "active_rule_hash": str(row["rule_hash"]),
                "active_rule": json.loads(str(row["rule_json"])),
                "public_time": public_time,
                "mutations": [self._action_from_row(action) for action in actions],
            }

        result = await self.base_store.run_extension_read(read)
        if result is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training integrity record does not exist",
                status_code=404,
            )
        return result

    async def equity(
        self,
        run_id: str,
        *,
        resolution: str,
        limit: int,
    ) -> dict[str, object]:
        if resolution not in {"AUTO", "EVENT", "1M", "15M", "1H"}:
            raise TrainingRunError(
                "TRAINING_RUN_INVALID",
                "equity resolution is unsupported",
                status_code=422,
            )
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 5_000:
            raise TrainingRunError(
                "TRAINING_RUN_INVALID",
                "equity limit must be between 1 and 5000",
                status_code=422,
            )

        def read(connection: sqlite3.Connection) -> dict[str, object] | None:
            run = connection.execute(
                "SELECT run_id FROM replay_training_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if run is None:
                return None
            selected = resolution
            if selected == "AUTO":
                selected = "1H"
                for candidate in ("EVENT", "1M", "15M", "1H"):
                    count = connection.execute(
                        """
                        SELECT COUNT(*) FROM replay_equity_sample
                        WHERE run_id = ? AND resolution = ?
                        """,
                        (run_id, candidate),
                    ).fetchone()[0]
                    if int(count) <= limit:
                        selected = candidate
                        break
            rows = connection.execute(
                """
                SELECT * FROM replay_equity_sample
                WHERE run_id = ? AND resolution = ?
                ORDER BY bucket_id DESC LIMIT ?
                """,
                (run_id, selected, limit),
            ).fetchall()
            samples = [
                {
                    "source_sequence": int(row["source_sequence"]),
                    "revision": int(row["revision"]),
                    "public_time": json.loads(str(row["public_time_json"])),
                    "equity": str(row["equity"]),
                    "cash_balance": str(row["cash_balance"]),
                    "unrealized_pnl": str(row["unrealized_pnl"]),
                    "ledger_tail_hash": str(row["ledger_tail_hash"]),
                    "state_hash": str(row["state_hash"]),
                }
                for row in reversed(rows)
            ]
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "run_id": run_id,
                "resolution": selected,
                "samples": samples,
                "bounded": True,
                "limits": {
                    item[0]: item[2] for item in _EQUITY_RESOLUTIONS
                },
            }

        result = await self.base_store.run_extension_read(read)
        if result is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training run does not exist",
                status_code=404,
            )
        return result

    async def record_view_action(
        self,
        *,
        run_id: str,
        command_id: str,
        event_type: str,
        semantic_key: str,
        value: Mapping[str, object],
        public_time_ms: int,
        source_sequence: int,
    ) -> dict[str, object]:
        value_json = canonical_json(value)

        def write(connection: sqlite3.Connection) -> dict[str, object]:
            run = connection.execute(
                """
                SELECT r.adapter_session_id, r.time_disclosure_policy,
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
            existing_command = connection.execute(
                """
                SELECT * FROM replay_run_view_event
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            if existing_command is not None:
                return self._view_action_from_row(existing_command, coalesced=True)
            public_time = self._public_time(
                connection,
                session_id=str(run["adapter_session_id"]),
                policy=str(run["time_disclosure_policy"]),
                revealed=bool(run["revealed"]),
                public_time_ms=public_time_ms,
                sequence=source_sequence,
            )
            existing = connection.execute(
                """
                SELECT * FROM replay_run_view_event
                WHERE run_id = ? AND semantic_key = ?
                """,
                (run_id, semantic_key),
            ).fetchone()
            now_ms = self.base_store._validated_now_ms()
            if existing is not None:
                connection.execute(
                    """
                    UPDATE replay_run_view_event
                    SET command_id = ?, event_type = ?, value_json = ?,
                        sample_count = sample_count + 1,
                        last_public_time_json = ?, updated_at_ms = ?
                    WHERE run_id = ? AND semantic_key = ?
                    """,
                    (
                        command_id,
                        event_type,
                        value_json,
                        canonical_json(public_time),
                        now_ms,
                        run_id,
                        semantic_key,
                    ),
                )
                row = connection.execute(
                    """
                    SELECT * FROM replay_run_view_event
                    WHERE run_id = ? AND semantic_key = ?
                    """,
                    (run_id, semantic_key),
                ).fetchone()
                return self._view_action_from_row(row, coalesced=True)
            count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM replay_run_view_event WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
            )
            if count >= _VIEW_EVENT_LIMIT:
                connection.execute(
                    """
                    DELETE FROM replay_run_view_event WHERE rowid = (
                        SELECT rowid FROM replay_run_view_event
                        WHERE run_id = ? ORDER BY updated_at_ms, view_sequence LIMIT 1
                    )
                    """,
                    (run_id,),
                )
            next_sequence = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(view_sequence), 0) + 1
                    FROM replay_run_view_event WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
            encoded_time = canonical_json(public_time)
            connection.execute(
                """
                INSERT INTO replay_run_view_event(
                    run_id, view_sequence, command_id, event_type,
                    semantic_key, value_json, sample_count,
                    first_public_time_json, last_public_time_json,
                    created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    next_sequence,
                    command_id,
                    event_type,
                    semantic_key,
                    value_json,
                    encoded_time,
                    encoded_time,
                    now_ms,
                    now_ms,
                ),
            )
            row = connection.execute(
                """
                SELECT * FROM replay_run_view_event
                WHERE run_id = ? AND semantic_key = ?
                """,
                (run_id, semantic_key),
            ).fetchone()
            return self._view_action_from_row(row, coalesced=False)

        return await self.base_store.run_extension_write(write)

    async def start_review(
        self,
        *,
        run_id: str,
        review_id: str,
        event_id: str | None,
    ) -> dict[str, object]:
        def write(connection: sqlite3.Connection) -> dict[str, object]:
            run = connection.execute(
                """
                SELECT r.adapter_session_id, r.time_disclosure_policy,
                       r.virtual_time_ms, r.source_sequence,
                       r.dataset_epoch,
                       COALESCE(i.revealed, 0) AS revealed,
                       s.state_hash
                FROM replay_training_run AS r
                JOIN replay_session AS s ON s.session_id = r.adapter_session_id
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
            checkpoints = connection.execute(
                """
                SELECT cp.checkpoint_id, cp.source_sequence,
                       cp.event_sequence, cp.state_hash,
                       mutation.kind AS mutation_kind,
                       command.command_json, command.cursor_json
                FROM replay_checkpoint AS cp
                LEFT JOIN replay_mutation_log AS mutation
                  ON mutation.mutation_id = cp.mutation_id
                LEFT JOIN replay_command_log AS command
                  ON command.session_id = cp.session_id
                 AND command.command_id = mutation.command_id
                WHERE cp.session_id = ? AND cp.active = 1
                ORDER BY cp.checkpoint_id
                """,
                (run["adapter_session_id"],),
            ).fetchall()
            if not checkpoints:
                raise TrainingRunError(
                    "REVIEW_UNAVAILABLE",
                    "training run has no durable review checkpoint",
                    status_code=409,
                )
            events: list[dict[str, object]] = []
            for checkpoint in checkpoints:
                checkpoint_event_id = f"checkpoint-{int(checkpoint['checkpoint_id'])}"
                raw_cursor = checkpoint["cursor_json"]
                if raw_cursor is None:
                    public_ms = int(run["virtual_time_ms"])
                else:
                    decoded_cursor = json.loads(str(raw_cursor))
                    public_ms = int(decoded_cursor["virtual_time_ms"])
                raw_command = checkpoint["command_json"]
                command_type = "INITIAL_CHECKPOINT"
                if raw_command is not None:
                    decoded_command = json.loads(str(raw_command))
                    command_type = str(decoded_command.get("type", "COMMAND"))
                    command_payload = decoded_command.get("payload")
                    if command_type == "_training_adjust_capital":
                        if not isinstance(command_payload, Mapping):
                            raise TrainingRunError(
                                "TRAINING_RUN_STORAGE_DEGRADED",
                                "capital review checkpoint payload is invalid",
                                status_code=503,
                            )
                        capital_kind = command_payload.get("kind")
                        if capital_kind not in {"deposit", "withdraw"}:
                            raise TrainingRunError(
                                "TRAINING_RUN_STORAGE_DEGRADED",
                                "capital review checkpoint kind is invalid",
                                status_code=503,
                            )
                        command_type = str(capital_kind).upper()
                    elif command_type == "_training_reveal_history":
                        command_type = "REVEAL_TIME"
                events.append(
                    {
                        "event_id": checkpoint_event_id,
                        "event_type": command_type,
                        "checkpoint_id": int(checkpoint["checkpoint_id"]),
                        "source_sequence": int(checkpoint["source_sequence"]),
                        "event_sequence": int(checkpoint["event_sequence"]),
                        "state_hash": str(checkpoint["state_hash"]),
                        "public_time": self._public_time(
                            connection,
                            session_id=str(run["adapter_session_id"]),
                            policy=str(run["time_disclosure_policy"]),
                            revealed=bool(run["revealed"]),
                            public_time_ms=public_ms,
                            sequence=int(checkpoint["source_sequence"]),
                        ),
                    }
                )
            selected: dict[str, object] | None = events[-1]
            if event_id is not None:
                selected = next(
                    (item for item in events if item["event_id"] == event_id),
                    None,
                )
            if selected is None:
                raise TrainingRunError(
                    "REVIEW_EVENT_NOT_FOUND",
                    "review event is not backed by an active checkpoint",
                    status_code=404,
                )
            original_cursor = {
                "virtual_time_ms": int(run["virtual_time_ms"]),
                "source_sequence": int(run["source_sequence"]),
            }
            now_ms = self.base_store._validated_now_ms()
            connection.execute(
                """
                INSERT INTO replay_review_session(
                    review_id, run_id, event_id, checkpoint_id,
                    selected_state_hash, original_state_hash,
                    original_cursor_json, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    review_id,
                    run_id,
                    selected["event_id"],
                    selected["checkpoint_id"],
                    selected["state_hash"],
                    run["state_hash"],
                    canonical_json(original_cursor),
                    now_ms,
                    now_ms,
                ),
            )
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "review_id": review_id,
                "run_id": run_id,
                "read_only": True,
                "selected_event_id": selected["event_id"],
                "selected_state_hash": selected["state_hash"],
                "original_state_hash": str(run["state_hash"]),
                "original_cursor": original_cursor,
                "dataset_epoch": str(run["dataset_epoch"]),
                "events": events,
                "jump_targets": [
                    {
                        "event_id": item["event_id"],
                        "event_type": item["event_type"],
                    }
                    for item in events
                ],
            }

        return await self.base_store.run_extension_write(write)

    async def checkpoint_for_event(
        self,
        run_id: str,
        event_id: str,
    ) -> dict[str, object]:
        if not event_id.startswith("checkpoint-"):
            raise TrainingRunError(
                "REVIEW_EVENT_NOT_FOUND",
                "review event is invalid",
                status_code=404,
            )
        try:
            checkpoint_id = int(event_id.removeprefix("checkpoint-"))
        except ValueError as exc:
            raise TrainingRunError(
                "REVIEW_EVENT_NOT_FOUND",
                "review event is invalid",
                status_code=404,
            ) from exc

        def read(connection: sqlite3.Connection) -> sqlite3.Row | None:
            return connection.execute(
                """
                SELECT r.*, cp.checkpoint_id, cp.state_hash AS checkpoint_state_hash,
                       cp.source_sequence AS checkpoint_source_sequence,
                       cp.event_sequence AS checkpoint_event_sequence
                FROM replay_training_run AS r
                JOIN replay_checkpoint AS cp
                  ON cp.session_id = r.adapter_session_id
                WHERE r.run_id = ? AND cp.checkpoint_id = ? AND cp.active = 1
                """,
                (run_id, checkpoint_id),
            ).fetchone()

        row = await self.base_store.run_extension_read(read)
        if row is None:
            raise TrainingRunError(
                "REVIEW_EVENT_NOT_FOUND",
                "review event is not backed by an active checkpoint",
                status_code=404,
            )
        return {
            "run_id": run_id,
            "adapter_session_id": str(row["adapter_session_id"]),
            "event_id": event_id,
            "checkpoint_id": checkpoint_id,
            "state_hash": str(row["checkpoint_state_hash"]),
            "source_sequence": int(row["checkpoint_source_sequence"]),
            "event_sequence": int(row["checkpoint_event_sequence"]),
            "dataset_epoch": str(row["dataset_epoch"]),
        }

    async def get_viewer_state(self, run_id: str) -> ViewerState:
        def read(connection: sqlite3.Connection) -> sqlite3.Row | None:
            return connection.execute(
                """
                SELECT * FROM replay_training_viewer_state WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()

        row = await self.base_store.run_extension_read(read)
        if row is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training viewer state does not exist",
                status_code=404,
            )
        return self._viewer_from_row(row)

    async def viewer_state_at_revision(
        self,
        run_id: str,
        revision: int,
    ) -> ViewerState:
        def read(connection: sqlite3.Connection) -> sqlite3.Row | None:
            return connection.execute(
                """
                SELECT viewer_state_json
                FROM replay_training_viewer_event
                WHERE run_id = ? AND semantic_view_revision = ?
                """,
                (run_id, revision),
            ).fetchone()

        row = await self.base_store.run_extension_read(read)
        if row is None:
            raise TrainingRunError(
                "VIEWER_REVISION_CONFLICT",
                "viewer revision is unavailable",
                status_code=409,
                details={"semantic_view_revision": revision},
            )
        return ViewerState.from_dict(json.loads(str(row["viewer_state_json"])))

    async def set_display_interval(
        self,
        *,
        run_id: str,
        display_interval: str,
        expected_revision: int,
        command_id: str,
        command: Mapping[str, object],
    ) -> ViewerState:
        request_json = canonical_json(command)

        def write(connection: sqlite3.Connection) -> ViewerState:
            replayed = connection.execute(
                """
                SELECT request_json, viewer_state_json
                FROM replay_training_viewer_event
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            if replayed is not None:
                if str(replayed["request_json"]) != request_json:
                    raise TrainingRunError(
                        "COMMAND_ID_REUSED",
                        "command_id was reused with a different viewer command",
                        status_code=409,
                    )
                return ViewerState.from_dict(
                    json.loads(str(replayed["viewer_state_json"]))
                )
            row = connection.execute(
                "SELECT * FROM replay_training_viewer_state WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if row is None:
                raise TrainingRunError(
                    "TRAINING_RUN_NOT_FOUND",
                    "training viewer state does not exist",
                    status_code=404,
                )
            current = self._viewer_from_row(row)
            if current.semantic_view_revision != expected_revision:
                raise TrainingRunError(
                    "VIEWER_REVISION_CONFLICT",
                    "viewer state revision does not match",
                    status_code=409,
                    details={
                        "expected": expected_revision,
                        "actual": current.semantic_view_revision,
                    },
                )
            updated = ViewerState(
                run_id=current.run_id,
                selected_track_id=current.selected_track_id,
                display_interval=display_interval,
                chart_type=current.chart_type,
                visible_range=current.visible_range,
                pane_layout=current.pane_layout,
                rail_layout=current.rail_layout,
                semantic_view_revision=current.semantic_view_revision + 1,
            )
            now_ms = self.base_store._validated_now_ms()
            payload_json = canonical_json(updated.to_dict())
            connection.execute(
                """
                UPDATE replay_training_viewer_state
                SET display_interval = ?, semantic_view_revision = ?, updated_at_ms = ?
                WHERE run_id = ?
                """,
                (
                    updated.display_interval,
                    updated.semantic_view_revision,
                    now_ms,
                    run_id,
                ),
            )
            connection.execute(
                """
                INSERT INTO replay_training_viewer_event(
                    run_id, semantic_view_revision, command_id, event_type,
                    request_json, viewer_state_json, created_at_ms
                ) VALUES (?, ?, ?, 'SET_DISPLAY_INTERVAL', ?, ?, ?)
                """,
                (
                    run_id,
                    updated.semantic_view_revision,
                    command_id,
                    request_json,
                    payload_json,
                    now_ms,
                ),
            )
            return updated

        return await self.base_store.run_extension_write(write)

    async def get_command_result(
        self,
        run_id: str,
        command_id: str,
        command: Mapping[str, object],
    ) -> dict[str, object] | None:
        def read(connection: sqlite3.Connection) -> sqlite3.Row | None:
            return connection.execute(
                """
                SELECT command_json, result_json
                FROM replay_training_command
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()

        row = await self.base_store.run_extension_read(read)
        if row is None:
            return None
        if str(row["command_json"]) != canonical_json(command):
            raise TrainingRunError(
                "COMMAND_ID_REUSED",
                "command_id was reused with a different replay.v2 command",
                status_code=409,
            )
        result = json.loads(str(row["result_json"]))
        if not isinstance(result, dict):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "stored replay.v2 command result is invalid",
                status_code=503,
            )
        return result

    async def save_command_result(
        self,
        *,
        run_id: str,
        command_id: str,
        command: Mapping[str, object],
        result: Mapping[str, object],
    ) -> None:
        command_json = canonical_json(command)
        result_json = canonical_json(result)

        def write(connection: sqlite3.Connection) -> None:
            existing = connection.execute(
                """
                SELECT command_json, result_json
                FROM replay_training_command
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            if existing is not None:
                if (
                    str(existing["command_json"]) != command_json
                    or str(existing["result_json"]) != result_json
                ):
                    raise TrainingRunError(
                        "COMMAND_ID_REUSED",
                        "command_id conflicts with a stored replay.v2 command",
                        status_code=409,
                    )
                return
            connection.execute(
                """
                INSERT INTO replay_training_command(
                    run_id, command_id, command_json, result_json, created_at_ms
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    command_id,
                    command_json,
                    result_json,
                    self.base_store._validated_now_ms(),
                ),
            )

        await self.base_store.run_extension_write(write)

    async def get_market_tracks(self, run_id: str) -> dict[str, object]:
        def read(
            connection: sqlite3.Connection,
        ) -> tuple[sqlite3.Row, tuple[sqlite3.Row, ...]] | None:
            run = connection.execute(
                """
                SELECT r.run_id, r.initial_equity, r.source_kind,
                       viewer.*
                FROM replay_training_run AS r
                JOIN replay_training_viewer_state AS viewer USING(run_id)
                WHERE r.run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if run is None:
                return None
            rows = tuple(
                connection.execute(
                    """
                    SELECT * FROM replay_training_market_track
                    WHERE run_id = ?
                    ORDER BY stable_ordinal, track_id
                    """,
                    (run_id,),
                ).fetchall()
            )
            return run, rows

        result = await self.base_store.run_extension_read(read)
        if result is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training run does not exist",
                status_code=404,
            )
        run, rows = result
        tracks = [self._market_track_from_row(row) for row in rows]
        viewer = self._viewer_from_row(run)
        return {
            "protocol": REPLAY_V2_PROTOCOL,
            "run_id": run_id,
            "ordering_version": GLOBAL_ORDERING_VERSION,
            "viewer_state": viewer.to_dict(),
            "tracks": tracks,
            "portfolio": self._portfolio_projection(
                initial_equity=str(run["initial_equity"]),
                tracks=tracks,
            ),
        }

    async def get_market_track(
        self,
        run_id: str,
        track_id: str,
    ) -> dict[str, object]:
        def read(connection: sqlite3.Connection) -> sqlite3.Row | None:
            return connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()

        row = await self.base_store.run_extension_read(read)
        if row is None:
            raise TrainingRunError(
                "MARKET_TRACK_NOT_FOUND",
                "training market track does not exist",
                status_code=404,
            )
        return self._market_track_from_row(row)

    async def reserve_market_track(
        self,
        *,
        run_id: str,
        exchange: str,
        market_type: str,
        symbol: str,
        settlement_asset: str,
        source_kind: str,
        subscription_tier: str,
    ) -> dict[str, object]:
        def write(connection: sqlite3.Connection) -> sqlite3.Row:
            run = connection.execute(
                "SELECT virtual_time_ms FROM replay_training_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if run is None:
                raise TrainingRunError(
                    "TRAINING_RUN_NOT_FOUND",
                    "training run does not exist",
                    status_code=404,
                )
            duplicate = connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND exchange = ? AND market_type = ? AND symbol = ?
                """,
                (run_id, exchange, market_type, symbol),
            ).fetchone()
            if duplicate is not None:
                raise TrainingRunError(
                    "MARKET_TRACK_CONFLICT",
                    "training market track already exists",
                    status_code=409,
                    details={"track_id": str(duplicate["track_id"])},
                )
            ordinal_row = connection.execute(
                """
                SELECT COALESCE(MAX(stable_ordinal), 0) + 1 AS ordinal
                FROM replay_training_market_track WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            ordinal = int(ordinal_row["ordinal"])
            track_id = f"track-{ordinal}"
            now_ms = self.base_store._validated_now_ms()
            state = "DORMANT" if subscription_tier == "NONE" else "PREPARING"
            connection.execute(
                """
                INSERT INTO replay_training_market_track(
                    run_id, track_id, stable_ordinal, adapter_session_id,
                    exchange, market_type, symbol, settlement_asset, source_kind,
                    state, subscription_tier, dataset_epoch, virtual_time_ms,
                    source_sequence, revision, forced_full_reasons_json,
                    capabilities_json, public_price, position_json, account_json,
                    open_orders_json, degraded_reason, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL,
                          NULL, '[]', ?, NULL, '{}', '{}', '[]', NULL, ?, ?)
                """,
                (
                    run_id,
                    track_id,
                    ordinal,
                    exchange,
                    market_type,
                    symbol,
                    settlement_asset,
                    source_kind,
                    state,
                    subscription_tier,
                    canonical_json(_phase1_capabilities(source_kind)),
                    now_ms,
                    now_ms,
                ),
            )
            return connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()

        try:
            row = await self.base_store.run_extension_write(write)
        except sqlite3.IntegrityError as exc:
            raise TrainingRunError(
                "MARKET_TRACK_CONFLICT",
                "training market track identity conflicts with an existing track",
                status_code=409,
            ) from exc
        return self._market_track_from_row(row)

    def attach_market_track_writer(
        self,
        *,
        run_id: str,
        track_id: str,
        requested_tier: str,
    ) -> Callable[..., Callable[[sqlite3.Connection, int], None]]:
        def extension_factory(
            *,
            session_id: str,
            session_state: Mapping[str, object],
            component_state: Mapping[str, object],
        ) -> Callable[[sqlite3.Connection, int], None]:
            def write(connection: sqlite3.Connection, now_ms: int) -> None:
                row = connection.execute(
                    """
                    SELECT * FROM replay_training_market_track
                    WHERE run_id = ? AND track_id = ?
                    """,
                    (run_id, track_id),
                ).fetchone()
                if row is None or row["adapter_session_id"] is not None:
                    raise TrainingRunError(
                        "MARKET_TRACK_CONFLICT",
                        "training market track cannot attach an adapter session",
                        status_code=409,
                    )
                cursor = session_state.get("cursor")
                if not isinstance(cursor, Mapping):
                    raise TypeError("market track adapter cursor must be an object")
                position, account, open_orders, public_price = self._track_components(
                    component_state
                )
                connection.execute(
                    """
                    UPDATE replay_training_market_track
                    SET adapter_session_id = ?, state = 'READY',
                        subscription_tier = ?, dataset_epoch = ?,
                        virtual_time_ms = ?, source_sequence = ?, revision = ?,
                        public_price = ?, position_json = ?, account_json = ?,
                        open_orders_json = ?, degraded_reason = NULL,
                        updated_at_ms = ?
                    WHERE run_id = ? AND track_id = ?
                    """,
                    (
                        session_id,
                        requested_tier,
                        str(session_state["data_epoch"]),
                        int(cursor["virtual_time_ms"]),
                        validate_v2_counter(
                            session_state["source_sequence"],
                            field_name="source_sequence",
                        ),
                        validate_v2_counter(
                            session_state["revision"],
                            field_name="revision",
                        ),
                        public_price,
                        canonical_json(position),
                        canonical_json(account),
                        canonical_json(open_orders),
                        now_ms,
                        run_id,
                        track_id,
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO replay_training_pin(
                        run_id, pin_id, dataset_epoch, pin_kind,
                        manifest_json, created_at_ms
                    ) VALUES (?, ?, ?, 'V1_DATASET_REF', ?, ?)
                    """,
                    (
                        run_id,
                        f"{track_id}-dataset",
                        str(session_state["data_epoch"]),
                        canonical_json(
                            {
                                "schema": "replay.training.rehydration.v1",
                                "adapter_session_id": session_id,
                                "owner": "replay_dataset_ref",
                            }
                        ),
                        now_ms,
                    ),
                )

            return write

        return extension_factory

    async def mark_market_track_error(
        self,
        *,
        run_id: str,
        track_id: str,
        reason: str,
        degraded: bool = False,
    ) -> None:
        state = "DEGRADED" if degraded else "ERROR"

        def write(connection: sqlite3.Connection) -> None:
            row = connection.execute(
                """
                SELECT forced_full_reasons_json
                FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()
            if row is None:
                return
            reasons = json.loads(str(row["forced_full_reasons_json"]))
            if not isinstance(reasons, list):
                reasons = []
            if degraded and "REVIEW_REQUIRED" not in reasons:
                reasons.append("REVIEW_REQUIRED")
            connection.execute(
                """
                UPDATE replay_training_market_track
                SET state = ?, degraded_reason = ?,
                    forced_full_reasons_json = ?, updated_at_ms = ?
                WHERE run_id = ? AND track_id = ?
                """,
                (
                    state,
                    reason[:500],
                    canonical_json(sorted(set(str(item) for item in reasons))),
                    self.base_store._validated_now_ms(),
                    run_id,
                    track_id,
                ),
            )

        await self.base_store.run_extension_write(write)

    async def set_market_track_tier(
        self,
        *,
        run_id: str,
        track_id: str,
        subscription_tier: str,
    ) -> dict[str, object]:
        def write(connection: sqlite3.Connection) -> sqlite3.Row:
            row = connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()
            if row is None:
                raise TrainingRunError(
                    "MARKET_TRACK_NOT_FOUND",
                    "training market track does not exist",
                    status_code=404,
                )
            reasons = json.loads(str(row["forced_full_reasons_json"]))
            if not isinstance(reasons, list):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market track force reasons are invalid",
                    status_code=503,
                )
            if reasons and subscription_tier != "FULL":
                raise TrainingRunError(
                    "MARKET_TRACK_FORCED_FULL",
                    "forced FULL market track cannot be downgraded",
                    status_code=409,
                    details={"forced_full_reasons": reasons},
                )
            if subscription_tier != "NONE" and row["adapter_session_id"] is None:
                raise TrainingRunError(
                    "MARKET_TRACK_NOT_PREPARED",
                    "market track must prepare a frozen adapter before activation",
                    status_code=409,
                )
            state = "DORMANT" if subscription_tier == "NONE" else "READY"
            connection.execute(
                """
                UPDATE replay_training_market_track
                SET subscription_tier = ?, state = ?, updated_at_ms = ?
                WHERE run_id = ? AND track_id = ?
                """,
                (
                    subscription_tier,
                    state,
                    self.base_store._validated_now_ms(),
                    run_id,
                    track_id,
                ),
            )
            return connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()

        return self._market_track_from_row(
            await self.base_store.run_extension_write(write)
        )

    async def clear_market_track_degradation(
        self,
        *,
        run_id: str,
        track_id: str,
    ) -> dict[str, object]:
        def write(connection: sqlite3.Connection) -> sqlite3.Row:
            row = connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()
            if row is None:
                raise TrainingRunError(
                    "MARKET_TRACK_NOT_FOUND",
                    "training market track does not exist",
                    status_code=404,
                )
            reasons = [
                reason
                for reason in self._reason_list(row)
                if reason != "REVIEW_REQUIRED"
            ]
            connection.execute(
                """
                UPDATE replay_training_market_track
                SET state = 'READY', degraded_reason = NULL,
                    forced_full_reasons_json = ?, updated_at_ms = ?
                WHERE run_id = ? AND track_id = ?
                """,
                (
                    canonical_json(reasons),
                    self.base_store._validated_now_ms(),
                    run_id,
                    track_id,
                ),
            )
            return connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()

        return self._market_track_from_row(
            await self.base_store.run_extension_write(write)
        )

    async def select_market_track(
        self,
        *,
        run_id: str,
        track_id: str,
        expected_viewer_revision: int,
        command_id: str,
        command: Mapping[str, object],
    ) -> ViewerState:
        request_json = canonical_json(command)

        def write(connection: sqlite3.Connection) -> ViewerState:
            replayed = connection.execute(
                """
                SELECT request_json, viewer_state_json
                FROM replay_training_viewer_event
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            if replayed is not None:
                if str(replayed["request_json"]) != request_json:
                    raise TrainingRunError(
                        "COMMAND_ID_REUSED",
                        "command_id was reused with a different viewer command",
                        status_code=409,
                    )
                return ViewerState.from_dict(json.loads(str(replayed["viewer_state_json"])))
            viewer_row = connection.execute(
                "SELECT * FROM replay_training_viewer_state WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            target = connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()
            if viewer_row is None or target is None:
                raise TrainingRunError(
                    "MARKET_TRACK_NOT_FOUND",
                    "training market track does not exist",
                    status_code=404,
                )
            current = self._viewer_from_row(viewer_row)
            if current.semantic_view_revision != expected_viewer_revision:
                raise TrainingRunError(
                    "VIEWER_REVISION_CONFLICT",
                    "viewer state revision does not match",
                    status_code=409,
                    details={
                        "expected": expected_viewer_revision,
                        "actual": current.semantic_view_revision,
                    },
                )
            if (
                target["adapter_session_id"] is None
                or target["state"] != "READY"
                or target["subscription_tier"] != "FULL"
            ):
                raise TrainingRunError(
                    "MARKET_TRACK_NOT_READY",
                    "selected market track must be an aligned FULL track",
                    status_code=409,
                )
            current_track = connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, current.selected_track_id),
            ).fetchone()
            if current_track is None or (
                int(current_track["virtual_time_ms"]) != int(target["virtual_time_ms"])
            ):
                raise TrainingRunError(
                    "GLOBAL_CLOCK_DIVERGED",
                    "market track is not aligned to the TrainingRun clock",
                    status_code=409,
                )
            if current.selected_track_id != track_id:
                old_reasons = self._reason_list(current_track)
                old_reasons = [reason for reason in old_reasons if reason != "VIEWED"]
                old_tier = str(current_track["subscription_tier"])
                if not old_reasons and old_tier == "FULL":
                    old_tier = "WARM"
                connection.execute(
                    """
                    UPDATE replay_training_market_track
                    SET subscription_tier = ?, forced_full_reasons_json = ?,
                        updated_at_ms = ?
                    WHERE run_id = ? AND track_id = ?
                    """,
                    (
                        old_tier,
                        canonical_json(old_reasons),
                        self.base_store._validated_now_ms(),
                        run_id,
                        current.selected_track_id,
                    ),
                )
            target_reasons = self._reason_list(target)
            if "VIEWED" not in target_reasons:
                target_reasons.append("VIEWED")
            now_ms = self.base_store._validated_now_ms()
            connection.execute(
                """
                UPDATE replay_training_market_track
                SET subscription_tier = 'FULL', forced_full_reasons_json = ?,
                    updated_at_ms = ?
                WHERE run_id = ? AND track_id = ?
                """,
                (canonical_json(sorted(target_reasons)), now_ms, run_id, track_id),
            )
            updated = ViewerState(
                run_id=current.run_id,
                selected_track_id=track_id,
                display_interval=current.display_interval,
                chart_type=current.chart_type,
                visible_range=current.visible_range,
                pane_layout=current.pane_layout,
                rail_layout=current.rail_layout,
                semantic_view_revision=current.semantic_view_revision + 1,
            )
            payload_json = canonical_json(updated.to_dict())
            connection.execute(
                """
                UPDATE replay_training_viewer_state
                SET selected_track_id = ?, semantic_view_revision = ?,
                    updated_at_ms = ?
                WHERE run_id = ?
                """,
                (track_id, updated.semantic_view_revision, now_ms, run_id),
            )
            connection.execute(
                """
                UPDATE replay_training_run
                SET last_symbol = ?, current_equity = json_extract(?, '$.equity'),
                    summary_revision = ?, revision = ?, source_sequence = ?,
                    virtual_time_ms = ?, updated_at_ms = ?
                WHERE run_id = ?
                """,
                (
                    target["symbol"],
                    target["account_json"],
                    target["revision"],
                    target["revision"],
                    target["source_sequence"],
                    target["virtual_time_ms"],
                    now_ms,
                    run_id,
                ),
            )
            connection.execute(
                """
                INSERT INTO replay_training_viewer_event(
                    run_id, semantic_view_revision, command_id, event_type,
                    request_json, viewer_state_json, created_at_ms
                ) VALUES (?, ?, ?, 'SELECT_TRACK', ?, ?, ?)
                """,
                (
                    run_id,
                    updated.semantic_view_revision,
                    command_id,
                    request_json,
                    payload_json,
                    now_ms,
                ),
            )
            return updated

        return await self.base_store.run_extension_write(write)

    async def record_global_events(
        self,
        run_id: str,
        events: Sequence[StableMarketEvent],
    ) -> dict[str, object]:
        ordered = stable_market_event_order(events)

        def write(connection: sqlite3.Connection) -> dict[str, object]:
            sequence_row = connection.execute(
                """
                SELECT COALESCE(MAX(global_sequence), 0) AS sequence
                FROM replay_training_global_event WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            global_sequence = int(sequence_row["sequence"])
            now_ms = self.base_store._validated_now_ms()
            inserted = 0
            for event in ordered:
                exists = connection.execute(
                    """
                    SELECT global_sequence FROM replay_training_global_event
                    WHERE run_id = ? AND track_id = ? AND source_sequence = ?
                    """,
                    (run_id, event.market_track_stable_id, event.source_sequence),
                ).fetchone()
                if exists is not None:
                    continue
                global_sequence += 1
                connection.execute(
                    """
                    INSERT INTO replay_training_global_event(
                        run_id, global_sequence, ordering_version,
                        actual_event_time_ms, event_phase, track_id,
                        source_sequence, ordering_hash, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        global_sequence,
                        GLOBAL_ORDERING_VERSION,
                        event.actual_event_time_ms,
                        event.event_phase,
                        event.market_track_stable_id,
                        event.source_sequence,
                        global_ordering_hash((event,)),
                        now_ms,
                    ),
                )
                inserted += 1
            checkpoint = self._insert_global_checkpoint(
                connection,
                run_id=run_id,
                now_ms=now_ms,
            )
            return {
                "ordering_version": GLOBAL_ORDERING_VERSION,
                "inserted": inserted,
                "global_sequence": global_sequence,
                "checkpoint": checkpoint,
            }

        return await self.base_store.run_extension_write(write)

    async def checkpoint_market_tracks(self, run_id: str) -> dict[str, object]:
        def write(connection: sqlite3.Connection) -> dict[str, object]:
            return self._insert_global_checkpoint(
                connection,
                run_id=run_id,
                now_ms=self.base_store._validated_now_ms(),
            )

        return await self.base_store.run_extension_write(write)

    async def global_events(self, run_id: str) -> list[dict[str, object]]:
        def read(connection: sqlite3.Connection) -> tuple[sqlite3.Row, ...]:
            return tuple(
                connection.execute(
                    """
                    SELECT global_sequence, ordering_version,
                           actual_event_time_ms, event_phase, track_id,
                           source_sequence, ordering_hash
                    FROM replay_training_global_event
                    WHERE run_id = ? ORDER BY global_sequence
                    """,
                    (run_id,),
                ).fetchall()
            )

        rows = await self.base_store.run_extension_read(read)
        return [dict(row) for row in rows]

    async def remove_market_track(self, run_id: str, track_id: str) -> str | None:
        def write(connection: sqlite3.Connection) -> str | None:
            viewer = connection.execute(
                "SELECT selected_track_id FROM replay_training_viewer_state WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            row = connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()
            if row is None:
                raise TrainingRunError(
                    "MARKET_TRACK_NOT_FOUND",
                    "training market track does not exist",
                    status_code=404,
                )
            reasons = self._reason_list(row)
            if viewer is not None and viewer["selected_track_id"] == track_id or reasons:
                raise TrainingRunError(
                    "MARKET_TRACK_FORCED_FULL",
                    "owned market track cannot be removed",
                    status_code=409,
                    details={"forced_full_reasons": reasons},
                )
            session_id = row["adapter_session_id"]
            connection.execute(
                "DELETE FROM replay_training_market_track WHERE run_id = ? AND track_id = ?",
                (run_id, track_id),
            )
            connection.execute(
                "DELETE FROM replay_training_pin WHERE run_id = ? AND pin_id = ?",
                (run_id, f"{track_id}-dataset"),
            )
            return None if session_id is None else str(session_id)

        return await self.base_store.run_extension_write(write)

    async def history_binding(
        self,
        *,
        session_id: str,
        track_id: str,
    ) -> dict[str, object]:
        """Read the immutable source binding and latest durable public cursor.

        This deliberately reads only replay-owned SQLite tables. Historical
        pages must never fall through to the active market-data repository.
        """

        def read(connection: sqlite3.Connection) -> sqlite3.Row | None:
            return connection.execute(
                """
                SELECT
                    r.run_id,
                    t.adapter_session_id,
                    r.base_interval,
                    r.display_interval,
                    r.time_disclosure_policy,
                    r.dataset_epoch AS run_dataset_epoch,
                    t.track_id,
                    t.exchange,
                    t.market_type,
                    t.symbol,
                    t.source_kind,
                    legacy.exchange AS legacy_exchange,
                    legacy.market_type AS legacy_market_type,
                    legacy.symbol AS legacy_symbol,
                    legacy.source_kind AS legacy_source_kind,
                    legacy.dataset_epoch AS legacy_dataset_epoch,
                    t.dataset_epoch AS track_dataset_epoch,
                    t.virtual_time_ms,
                    t.source_sequence,
                    t.revision,
                    s.config_json,
                    s.data_epoch AS session_data_epoch,
                    s.degraded_reason
                FROM replay_training_run AS r
                JOIN replay_training_market_track AS t ON t.run_id = r.run_id
                LEFT JOIN replay_training_track AS legacy
                  ON legacy.run_id = t.run_id AND legacy.track_id = t.track_id
                JOIN replay_session AS s ON s.session_id = t.adapter_session_id
                WHERE t.adapter_session_id = ? AND t.track_id = ?
                """,
                (session_id, track_id),
            ).fetchone()

        row = await self.base_store.run_extension_read(read)
        if row is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training history track does not exist",
                status_code=404,
            )
        adapter_config = json.loads(str(row["config_json"]))
        if not isinstance(adapter_config, dict):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training adapter config is invalid",
                status_code=503,
            )
        adapter_display_interval = adapter_config.get("display_interval")
        if not isinstance(adapter_display_interval, str):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training adapter display interval is invalid",
                status_code=503,
            )
        if row["legacy_symbol"] is not None and (
            str(row["legacy_exchange"]) != str(row["exchange"])
            or str(row["legacy_market_type"]) != str(row["market_type"])
            or str(row["legacy_symbol"]) != str(row["symbol"])
            or str(row["legacy_source_kind"]) != str(row["source_kind"])
            or str(row["legacy_dataset_epoch"]) != str(row["track_dataset_epoch"])
        ):
            raise TrainingRunError(
                "HISTORY_SOURCE_IDENTITY_DRIFT",
                "training history track identity changed",
                status_code=409,
            )
        return {
            "run_id": str(row["run_id"]),
            "session_id": str(row["adapter_session_id"]),
            "track_id": str(row["track_id"]),
            "exchange": str(row["exchange"]),
            "market_type": str(row["market_type"]),
            "symbol": str(row["symbol"]),
            "source_kind": str(row["source_kind"]),
            "base_interval": str(row["base_interval"]),
            # Phase 3 keeps the adapter and frozen history at the base interval.
            # Mutable display selection belongs exclusively to ViewerState.
            "display_interval": adapter_display_interval,
            "time_disclosure_policy": str(row["time_disclosure_policy"]),
            "run_dataset_epoch": str(row["run_dataset_epoch"]),
            "track_dataset_epoch": str(row["track_dataset_epoch"]),
            "session_data_epoch": str(row["session_data_epoch"]),
            "virtual_time_ms": int(row["virtual_time_ms"]),
            "source_sequence": int(row["source_sequence"]),
            "revision": int(row["revision"]),
            "config": adapter_config,
            "degraded_reason": row["degraded_reason"],
        }

    @staticmethod
    def _reason_list(row: Mapping[str, object]) -> list[str]:
        try:
            decoded = json.loads(str(row["forced_full_reasons_json"]))
        except json.JSONDecodeError as exc:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "market track force reasons are invalid",
                status_code=503,
            ) from exc
        if not isinstance(decoded, list) or any(
            not isinstance(reason, str) for reason in decoded
        ):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "market track force reasons are invalid",
                status_code=503,
            )
        return sorted(set(decoded))

    @classmethod
    def _market_track_from_row(
        cls,
        row: Mapping[str, object],
    ) -> dict[str, object]:
        def json_object(field_name: str) -> dict[str, object]:
            try:
                value = json.loads(str(row[field_name]))
            except json.JSONDecodeError as exc:
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    f"market track {field_name} is invalid",
                    status_code=503,
                ) from exc
            if not isinstance(value, dict):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    f"market track {field_name} is invalid",
                    status_code=503,
                )
            return value

        try:
            capabilities = json.loads(str(row["capabilities_json"]))
            open_orders = json.loads(str(row["open_orders_json"]))
        except json.JSONDecodeError as exc:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "market track projection JSON is invalid",
                status_code=503,
            ) from exc
        if not isinstance(capabilities, dict) or not isinstance(open_orders, list):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "market track projection JSON is invalid",
                status_code=503,
            )
        cursor = None
        if row["virtual_time_ms"] is not None:
            if row["source_sequence"] is None or row["revision"] is None:
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market track cursor is incomplete",
                    status_code=503,
                )
            cursor = {
                "virtual_time_ms": validate_v2_counter(
                    row["virtual_time_ms"], field_name="virtual_time_ms"
                ),
                "source_sequence": validate_v2_counter(
                    row["source_sequence"], field_name="source_sequence"
                ),
                "revision": validate_v2_counter(
                    row["revision"], field_name="revision"
                ),
            }
        return {
            "run_id": str(row["run_id"]),
            "track_id": str(row["track_id"]),
            "stable_ordinal": validate_v2_counter(
                row["stable_ordinal"], field_name="stable_ordinal"
            ),
            "adapter_session_id": (
                None
                if row["adapter_session_id"] is None
                else str(row["adapter_session_id"])
            ),
            "exchange": str(row["exchange"]),
            "market_type": str(row["market_type"]),
            "symbol": str(row["symbol"]),
            "settlement_asset": str(row["settlement_asset"]),
            "state": str(row["state"]),
            "source_kind": str(row["source_kind"]),
            "subscription_tier": str(row["subscription_tier"]),
            "cursor": cursor,
            "forced_full_reasons": cls._reason_list(row),
            "capabilities": capabilities,
            "public_price": row["public_price"],
            "position": json_object("position_json"),
            "open_order_count": len(open_orders),
            "degraded_reason": row["degraded_reason"],
            "account": json_object("account_json"),
        }

    @staticmethod
    def _portfolio_projection(
        *,
        initial_equity: str,
        tracks: list[dict[str, object]],
    ) -> dict[str, object]:
        try:
            initial = Decimal(initial_equity)
            equity = initial
            cash = initial
            available = initial
            reserved = Decimal(0)
            margin_used = Decimal(0)
            realized = Decimal(0)
            unrealized = Decimal(0)
            fees = Decimal(0)
            positions: list[dict[str, object]] = []
            for track in tracks:
                account = track.get("account")
                if isinstance(account, Mapping) and isinstance(
                    account.get("equity"), str
                ):
                    equity += Decimal(str(account["equity"])) - initial
                    cash += Decimal(str(account["cash_balance"])) - initial
                    available += Decimal(str(account["available_equity"])) - initial
                    reserved += Decimal(str(account["reserved_margin"]))
                    margin_used += Decimal(str(account["margin_used"]))
                    realized += Decimal(str(account["realized_pnl"]))
                    unrealized += Decimal(str(account["unrealized_pnl"]))
                    fees += Decimal(str(account["fees_paid"]))
                position = track.get("position")
                if isinstance(position, Mapping) and position.get("quantity") not in {
                    None,
                    "0",
                }:
                    positions.append(
                        {
                            "track_id": track["track_id"],
                            "symbol": track["symbol"],
                            "position": dict(position),
                        }
                    )
        except (InvalidOperation, KeyError, TypeError) as exc:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "multi-market account projection is invalid",
                status_code=503,
            ) from exc
        return {
            "schema_version": "replay.training.portfolio.v1",
            "fidelity": "PAPER_LINEAR_V1_MULTI_TRACK_ADAPTER",
            "settlement_account_shared": True,
            "initial_equity": decimal_to_string(initial, field_name="initial_equity"),
            "equity": decimal_to_string(equity, field_name="equity"),
            "cash_balance": decimal_to_string(cash, field_name="cash_balance"),
            "available_equity": decimal_to_string(
                available,
                field_name="available_equity",
            ),
            "reserved_margin": decimal_to_string(
                reserved,
                field_name="reserved_margin",
            ),
            "margin_used": decimal_to_string(margin_used, field_name="margin_used"),
            "realized_pnl": decimal_to_string(realized, field_name="realized_pnl"),
            "unrealized_pnl": decimal_to_string(
                unrealized,
                field_name="unrealized_pnl",
            ),
            "fees_paid": decimal_to_string(fees, field_name="fees_paid"),
            "positions": positions,
        }

    @classmethod
    def _insert_global_checkpoint(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        now_ms: int,
    ) -> dict[str, object]:
        rows = tuple(
            connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND subscription_tier = 'FULL'
                ORDER BY stable_ordinal, track_id
                """,
                (run_id,),
            ).fetchall()
        )
        if not rows:
            raise TrainingRunError(
                "GLOBAL_CLOCK_UNAVAILABLE",
                "TrainingRun has no FULL market track",
                status_code=409,
            )
        tracks = [cls._market_track_from_row(row) for row in rows]
        run = connection.execute(
            "SELECT initial_equity FROM replay_training_run WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if run is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training run does not exist",
                status_code=404,
            )
        portfolio = cls._portfolio_projection(
            initial_equity=str(run["initial_equity"]),
            tracks=tracks,
        )
        if any(not isinstance(track.get("cursor"), Mapping) for track in tracks):
            raise TrainingRunError(
                "GLOBAL_CLOCK_DIVERGED",
                "FULL market track cursor is unavailable",
                status_code=409,
            )
        cursor_times = {
            int(track["cursor"]["virtual_time_ms"])  # type: ignore[index]
            for track in tracks
        }
        if len(cursor_times) != 1:
            raise TrainingRunError(
                "GLOBAL_CLOCK_DIVERGED",
                "FULL market tracks do not share one VirtualTime",
                status_code=409,
            )
        virtual_time_ms = next(iter(cursor_times))
        tail = connection.execute(
            """
            SELECT COALESCE(MAX(global_sequence), 0) AS sequence
            FROM replay_training_global_event WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        checkpoint_row = connection.execute(
            """
            SELECT COALESCE(MAX(checkpoint_sequence), 0) + 1 AS sequence
            FROM replay_training_global_checkpoint WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        checkpoint_sequence = int(checkpoint_row["sequence"])
        state = {
            "ordering_version": GLOBAL_ORDERING_VERSION,
            "global_event_sequence": int(tail["sequence"]),
            "global_virtual_time_ms": virtual_time_ms,
            "tracks": tracks,
            "portfolio": portfolio,
        }
        state_hash = canonical_sha256(
            {
                "schema_version": "replay.training.global-checkpoint.v1",
                "state": state,
            }
        )
        connection.execute(
            """
            INSERT INTO replay_training_global_checkpoint(
                run_id, checkpoint_sequence, ordering_version,
                global_virtual_time_ms, global_state_hash, tracks_json,
                created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                checkpoint_sequence,
                GLOBAL_ORDERING_VERSION,
                virtual_time_ms,
                state_hash,
                canonical_json({"tracks": tracks, "portfolio": portfolio}),
                now_ms,
            ),
        )
        connection.execute(
            """
            UPDATE replay_training_run
            SET virtual_time_ms = ?, saved_at_ms = ?, updated_at_ms = ?
            WHERE run_id = ?
            """,
            (virtual_time_ms, now_ms, now_ms, run_id),
        )
        return {
            "checkpoint_sequence": checkpoint_sequence,
            "global_virtual_time_ms": virtual_time_ms,
            "global_state_hash": state_hash,
            "portfolio": portfolio,
        }

    @staticmethod
    def _insert_run(connection: sqlite3.Connection, values: Mapping[str, object]) -> None:
        connection.execute(
            """
            INSERT INTO replay_training_run(
                run_id, adapter_session_id, parent_legacy_session_id, protocol,
                schema_version, name, state, source_kind, start_mode,
                integrity_mode, time_disclosure_policy, book_mode, margin_mode,
                funding_mode, execution_model, allow_rule_changes, exchange,
                market_type, last_symbol, settlement_asset, base_interval,
                display_interval, initial_equity, current_equity, summary_revision,
                revision, source_sequence, virtual_time_ms, active_rule_revision,
                catalog_epoch, dataset_epoch, compatibility, created_at_ms,
                updated_at_ms, saved_at_ms
            ) VALUES (
                :run_id, :adapter_session_id, :parent_legacy_session_id, 'replay.v2',
                'replay.training.v1', :name, :state, :source_kind, :start_mode,
                :integrity_mode, :time_disclosure_policy, :book_mode, :margin_mode,
                :funding_mode, 'TOUCH_OR_TAPE_V2', :allow_rule_changes, :exchange,
                :market_type, :last_symbol, :settlement_asset, :base_interval,
                :display_interval, :initial_equity, :current_equity, :summary_revision,
                :revision, :source_sequence, :virtual_time_ms, 1,
                :catalog_epoch, :dataset_epoch, :compatibility, :now_ms,
                :now_ms, :now_ms
            )
            """,
            dict(values),
        )

    @staticmethod
    def _insert_track(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        adapter_session_id: str,
        source_kind: str,
        exchange: str,
        market_type: str,
        symbol: str,
        settlement_asset: str,
        dataset_epoch: str,
        cursor: Mapping[str, object],
        component_state: Mapping[str, object] | None,
        now_ms: int,
    ) -> None:
        connection.execute(
            """
            INSERT INTO replay_training_track(
                run_id, track_id, adapter_session_id, exchange, market_type,
                symbol, source_kind, state, subscription_tier, dataset_epoch,
                virtual_time_ms, source_sequence, revision,
                forced_full_reasons_json, capabilities_json,
                created_at_ms, updated_at_ms
            ) VALUES (?, 'track-1', ?, ?, ?, ?, ?, 'READY', 'FULL', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                adapter_session_id,
                exchange,
                market_type,
                symbol,
                source_kind,
                dataset_epoch,
                validate_v2_counter(
                    cursor["virtual_time_ms"], field_name="virtual_time_ms"
                ),
                validate_v2_counter(
                    cursor["source_sequence"], field_name="source_sequence"
                ),
                validate_v2_counter(cursor["revision"], field_name="revision"),
                canonical_json(["VIEWED"]),
                canonical_json(_phase1_capabilities(source_kind)),
                now_ms,
                now_ms,
            ),
        )
        position, account, open_orders, public_price = TrainingRunStore._track_components(
            component_state
        )
        connection.execute(
            """
            INSERT INTO replay_training_market_track(
                run_id, track_id, stable_ordinal, adapter_session_id,
                exchange, market_type, symbol, settlement_asset, source_kind,
                state, subscription_tier, dataset_epoch, virtual_time_ms,
                source_sequence, revision, forced_full_reasons_json,
                capabilities_json, public_price, position_json, account_json,
                open_orders_json, degraded_reason, created_at_ms, updated_at_ms
            ) VALUES (
                ?, 'track-1', 1, ?, ?, ?, ?, ?, ?, 'READY', 'FULL', ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, NULL, ?, ?
            )
            """,
            (
                run_id,
                adapter_session_id,
                exchange,
                market_type,
                symbol,
                settlement_asset,
                source_kind,
                dataset_epoch,
                validate_v2_counter(
                    cursor["virtual_time_ms"], field_name="virtual_time_ms"
                ),
                validate_v2_counter(
                    cursor["source_sequence"], field_name="source_sequence"
                ),
                validate_v2_counter(cursor["revision"], field_name="revision"),
                canonical_json(["VIEWED"]),
                canonical_json(_phase1_capabilities(source_kind)),
                public_price,
                canonical_json(position),
                canonical_json(account),
                canonical_json(open_orders),
                now_ms,
                now_ms,
            ),
        )

    @staticmethod
    def _track_components(
        component_state: Mapping[str, object] | None,
    ) -> tuple[dict[str, object], dict[str, object], list[object], str | None]:
        if not isinstance(component_state, Mapping):
            return {}, {}, [], None
        raw_position = component_state.get("position")
        raw_account = component_state.get("account")
        raw_orders = component_state.get("orders")
        position: dict[str, object] = (
            dict(cast(Mapping[str, object], raw_position))
            if isinstance(raw_position, Mapping)
            else {}
        )
        account: dict[str, object] = (
            dict(cast(Mapping[str, object], raw_account))
            if isinstance(raw_account, Mapping)
            else {}
        )
        orders: list[object] = (
            [
                dict(cast(Mapping[str, object], order))
                if isinstance(order, Mapping)
                else order
                for order in raw_orders
            ]
            if isinstance(raw_orders, (list, tuple))
            else []
        )
        mark = position.get("mark_price")
        public_price = mark if isinstance(mark, str) else None
        terminal = {"FILLED", "CANCELED", "REJECTED", "EXPIRED"}
        open_orders: list[object] = [
            order
            for order in orders
            if isinstance(order, Mapping) and order.get("status") not in terminal
        ]
        return position, account, open_orders, public_price

    @staticmethod
    def _insert_viewer_state(
        connection: sqlite3.Connection,
        viewer: ViewerState,
        *,
        now_ms: int,
    ) -> None:
        payload = viewer.to_dict()
        connection.execute(
            """
            INSERT INTO replay_training_viewer_state(
                run_id, selected_track_id, display_interval, chart_type,
                visible_range_json, pane_layout_json, rail_layout_json,
                semantic_view_revision, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                viewer.run_id,
                viewer.selected_track_id,
                viewer.display_interval,
                viewer.chart_type,
                None
                if viewer.visible_range is None
                else canonical_json(viewer.visible_range),
                canonical_json(viewer.pane_layout),
                canonical_json(viewer.rail_layout),
                viewer.semantic_view_revision,
                now_ms,
            ),
        )
        connection.execute(
            """
            INSERT INTO replay_training_viewer_event(
                run_id, semantic_view_revision, command_id, event_type,
                request_json, viewer_state_json, created_at_ms
            ) VALUES (?, ?, NULL, 'INITIAL_VIEWER_STATE', '{}', ?, ?)
            """,
            (
                viewer.run_id,
                viewer.semantic_view_revision,
                canonical_json(payload),
                now_ms,
            ),
        )

    @staticmethod
    def _viewer_from_row(row: Mapping[str, object]) -> ViewerState:
        visible_raw = row["visible_range_json"]
        return ViewerState(
            run_id=str(row["run_id"]),
            selected_track_id=str(row["selected_track_id"]),
            display_interval=str(row["display_interval"]),
            chart_type=str(row["chart_type"]),
            visible_range=(
                None if visible_raw is None else json.loads(str(visible_raw))
            ),
            pane_layout=json.loads(str(row["pane_layout_json"])),
            rail_layout=json.loads(str(row["rail_layout_json"])),
            semantic_view_revision=int(row["semantic_view_revision"]),
        )

    @staticmethod
    def _action_from_row(row: Mapping[str, object]) -> dict[str, object]:
        return {
            "action_sequence": validate_v2_counter(
                row["action_sequence"], field_name="action_sequence"
            ),
            "event_id": str(row["event_id"]),
            "command_id": row["command_id"],
            "event_type": str(row["event_type"]),
            "rule_revision": validate_v2_counter(
                row["rule_revision"], field_name="rule_revision"
            ),
            "public_time": json.loads(str(row["public_time_json"])),
            "old_value": json.loads(str(row["old_value_json"])),
            "new_value": json.loads(str(row["new_value_json"])),
            "reason": str(row["reason"]),
            "state_hash_before": row["state_hash_before"],
            "state_hash_after": str(row["state_hash_after"]),
        }

    @staticmethod
    def _view_action_from_row(
        row: Mapping[str, object],
        *,
        coalesced: bool,
    ) -> dict[str, object]:
        return {
            "view_sequence": validate_v2_counter(
                row["view_sequence"], field_name="view_sequence"
            ),
            "command_id": str(row["command_id"]),
            "event_type": str(row["event_type"]),
            "semantic_key": str(row["semantic_key"]),
            "value": json.loads(str(row["value_json"])),
            "sample_count": validate_v2_counter(
                row["sample_count"], field_name="sample_count"
            ),
            "first_public_time": json.loads(str(row["first_public_time_json"])),
            "last_public_time": json.loads(str(row["last_public_time_json"])),
            "coalesced": coalesced,
        }

    @staticmethod
    def _insert_rule(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        rule: Mapping[str, object],
        now_ms: int,
    ) -> None:
        connection.execute(
            """
            INSERT INTO replay_training_rule(
                run_id, revision, rule_json, rule_hash, created_at_ms
            ) VALUES (?, 1, ?, ?, ?)
            """,
            (run_id, canonical_json(rule), canonical_sha256(rule), now_ms),
        )

    @staticmethod
    def _insert_initial_action(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        action_type: str,
        action: Mapping[str, object],
        now_ms: int,
    ) -> None:
        connection.execute(
            """
            INSERT INTO replay_training_action(
                run_id, action_sequence, action_type, action_json, created_at_ms
            ) VALUES (?, 1, ?, ?, ?)
            """,
            (run_id, action_type, canonical_json(action), now_ms),
        )

    @staticmethod
    def _insert_pin(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        adapter_session_id: str,
        dataset_epoch: str,
        now_ms: int,
    ) -> None:
        connection.execute(
            """
            INSERT INTO replay_training_pin(
                run_id, pin_id, dataset_epoch, pin_kind, manifest_json, created_at_ms
            ) VALUES (?, 'primary-dataset', ?, 'V1_DATASET_REF', ?, ?)
            """,
            (
                run_id,
                dataset_epoch,
                canonical_json(
                    {
                        "schema": "replay.training.rehydration.v1",
                        "adapter_session_id": adapter_session_id,
                        "owner": "replay_dataset_ref",
                    }
                ),
                now_ms,
            ),
        )

    @staticmethod
    def _card_from_row(row: Mapping[str, object]) -> dict[str, object]:
        unavailable = row["compatibility"] == "UNAVAILABLE"
        if unavailable:
            status = {
                "code": "UNAVAILABLE",
                "message": "存档当前不可恢复；请检查服务端诊断或导出记录。",
            }
        elif row["kind"] == "LEGACY_V1":
            status = {
                "code": "LEGACY_V1",
                "message": "Legacy v1 存档可通过兼容运行时打开；迁移不会改写原记录。",
            }
        elif row["compatibility"] == "LEGACY_ADAPTER":
            status = {
                "code": "LEGACY_ADAPTER",
                "message": "已建立 v2 存档包装；活动训练暂由 v1 单轨 adapter 恢复。",
            }
        else:
            status = {"code": "READY", "message": "训练可继续"}
        return {
            "run_id": str(row["run_id"]),
            "kind": str(row["kind"]),
            "name": str(row["name"]),
            "state": str(row["state"]),
            "source_kind": str(row["source_kind"]),
            "integrity_mode": row["integrity_mode"],
            "time_disclosure_policy": str(row["time_disclosure_policy"]),
            "last_symbol": str(row["last_symbol"]),
            "subscribed_track_count": int(row["subscribed_track_count"]),
            "progress": {"source_sequence": int(row["progress_sequence"])},
            "equity": row["equity"],
            "equity_status": str(row["equity_status"]),
            "settlement_asset": str(row["settlement_asset"]),
            "updated_at_ms": int(row["updated_at_ms"]),
            "compatibility": str(row["compatibility"]),
            "resume_action": str(row["resume_action"]),
            "adapter_session_id": str(row["adapter_session_id"]),
            "parent_legacy_session_id": row["parent_legacy_session_id"],
            "status": status,
            "report_available": bool(row["report_available"]),
            "review_available": bool(row["review_available"]),
        }

    def _sync_session_summary(
        self,
        connection: sqlite3.Connection,
        session_id: str,
        state: Mapping[str, object],
        component_state: Mapping[str, object],
        now_ms: int,
    ) -> None:
        cursor = state.get("cursor")
        if not isinstance(cursor, Mapping):
            return
        track = connection.execute(
            """
            SELECT t.*, viewer.selected_track_id, r.time_disclosure_policy,
                   COALESCE(integrity.revealed, 0) AS revealed
            FROM replay_training_market_track AS t
            JOIN replay_training_run AS r USING(run_id)
            JOIN replay_training_viewer_state AS viewer USING(run_id)
            LEFT JOIN replay_training_integrity AS integrity USING(run_id)
            WHERE t.adapter_session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if track is None:
            return
        account = component_state.get("account")
        equity = account.get("equity") if isinstance(account, Mapping) else None
        selected = str(track["selected_track_id"]) == str(track["track_id"])
        if selected and isinstance(equity, str):
            connection.execute(
                """
                UPDATE replay_training_run
                SET state = ?, revision = ?, source_sequence = ?, virtual_time_ms = ?,
                    current_equity = ?, summary_revision = ?, updated_at_ms = ?, saved_at_ms = ?
                WHERE run_id = ?
                """,
                (
                    state["state"],
                    state["revision"],
                    state["source_sequence"],
                    cursor["virtual_time_ms"],
                    equity,
                    state["revision"],
                    now_ms,
                    now_ms,
                    track["run_id"],
                ),
            )
        elif selected:
            connection.execute(
                """
                UPDATE replay_training_run
                SET state = ?, revision = ?, source_sequence = ?, virtual_time_ms = ?,
                    updated_at_ms = ?, saved_at_ms = ?
                WHERE run_id = ?
                """,
                (
                    state["state"],
                    state["revision"],
                    state["source_sequence"],
                    cursor["virtual_time_ms"],
                    now_ms,
                    now_ms,
                    track["run_id"],
                ),
            )
        position, account_payload, open_orders, public_price = self._track_components(
            component_state
        )
        automatic_reasons = {
            "VIEWED",
            "OPEN_POSITION",
            "OPEN_ORDER",
            "CONDITIONAL_ORDER",
            "LIQUIDATION_RISK",
        }
        try:
            stored_reasons = json.loads(str(track["forced_full_reasons_json"]))
        except json.JSONDecodeError as exc:
            raise TypeError("track forced_full_reasons are invalid") from exc
        if not isinstance(stored_reasons, list) or any(
            not isinstance(reason, str) for reason in stored_reasons
        ):
            raise TypeError("track forced_full_reasons are invalid")
        reasons = {reason for reason in stored_reasons if reason not in automatic_reasons}
        if selected:
            reasons.add("VIEWED")
        quantity = position.get("quantity")
        if isinstance(quantity, str) and quantity != "0":
            reasons.update({"OPEN_POSITION", "LIQUIDATION_RISK"})
        if open_orders:
            reasons.add("OPEN_ORDER")
            if any(
                order.get("order_type") in {"STOP_MARKET", "TAKE_PROFIT_MARKET"}
                for order in open_orders
                if isinstance(order, Mapping)
            ):
                reasons.add("CONDITIONAL_ORDER")
        tier = "FULL" if reasons else str(track["subscription_tier"])
        track_state = "ERROR" if state["state"] == "ERROR" else (
            "DORMANT" if tier == "NONE" else "READY"
        )
        connection.execute(
            """
            UPDATE replay_training_market_track
            SET state = ?, subscription_tier = ?, virtual_time_ms = ?,
                source_sequence = ?, revision = ?, forced_full_reasons_json = ?,
                public_price = ?, position_json = ?, account_json = ?,
                open_orders_json = ?, degraded_reason = CASE
                    WHEN ? = 'ERROR' THEN COALESCE(degraded_reason, 'ADAPTER_ERROR')
                    ELSE NULL END,
                updated_at_ms = ?
            WHERE adapter_session_id = ?
            """,
            (
                track_state,
                tier,
                cursor["virtual_time_ms"],
                state["source_sequence"],
                state["revision"],
                canonical_json(sorted(reasons)),
                public_price,
                canonical_json(position),
                canonical_json(account_payload),
                canonical_json(open_orders),
                state["state"],
                now_ms,
                session_id,
            ),
        )
        connection.execute(
            """
            UPDATE replay_training_track
            SET state = CASE WHEN ? = 'ERROR' THEN 'ERROR' ELSE 'READY' END,
                virtual_time_ms = ?, source_sequence = ?, revision = ?, updated_at_ms = ?
            WHERE adapter_session_id = ?
            """,
            (
                state["state"],
                cursor["virtual_time_ms"],
                state["source_sequence"],
                state["revision"],
                now_ms,
                session_id,
            ),
        )

        if selected:
            self._upsert_equity_samples(
                connection,
                run_id=str(track["run_id"]),
                session_id=session_id,
                policy=str(track["time_disclosure_policy"]),
                revealed=bool(track["revealed"]),
                state=state,
                component_state=component_state,
                now_ms=now_ms,
            )

    def _sync_session_mutation(
        self,
        connection: sqlite3.Connection,
        session_id: str,
        command: Mapping[str, object],
        accepted: bool,
        result: Mapping[str, object] | None,
        state: Mapping[str, object],
        component_state: Mapping[str, object],
        now_ms: int,
    ) -> None:
        if not accepted:
            return
        command_type = command.get("type")
        if command_type not in {
            "_training_adjust_capital",
            "_training_reveal_history",
        }:
            return
        run = connection.execute(
            """
            SELECT r.run_id, r.integrity_mode, r.time_disclosure_policy,
                   r.active_rule_revision, r.current_equity,
                   i.start_time_known, i.strict_eligible, i.revealed
            FROM replay_training_run AS r
            JOIN replay_training_integrity AS i USING(run_id)
            JOIN replay_training_market_track AS track USING(run_id)
            WHERE track.adapter_session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if run is None:
            return
        payload = command.get("payload")
        if not isinstance(payload, Mapping):
            raise TypeError("training policy command payload must be an object")
        cursor = state.get("cursor")
        if not isinstance(cursor, Mapping):
            raise TypeError("training policy command cursor must be an object")
        command_id = str(command["command_id"])
        sequence_row = connection.execute(
            """
            SELECT COALESCE(MAX(action_sequence), 0) + 1 AS next_sequence
            FROM replay_run_action_event WHERE run_id = ?
            """,
            (run["run_id"],),
        ).fetchone()
        action_sequence = int(sequence_row["next_sequence"])
        previous = connection.execute(
            """
            SELECT state_hash_after FROM replay_run_action_event
            WHERE run_id = ? ORDER BY action_sequence DESC LIMIT 1
            """,
            (run["run_id"],),
        ).fetchone()
        state_hash_after = str(state["state_hash"])
        revealed = bool(run["revealed"])
        old_value: dict[str, object]
        new_value: dict[str, object]
        if command_type == "_training_adjust_capital":
            account = component_state.get("account")
            if not isinstance(account, Mapping) or not isinstance(
                account.get("equity"), str
            ):
                raise TypeError("capital adjustment account projection is missing")
            kind = str(payload.get("kind", ""))
            if kind not in {"deposit", "withdraw"}:
                raise TypeError("capital adjustment kind is invalid")
            event_type = kind.upper()
            old_value = {"equity": str(run["current_equity"])}
            new_value = {"equity": str(account["equity"])}
            reason = str(payload.get("reason", ""))
        else:
            event_type = "REVEAL_TIME"
            old_value = {
                "revealed": revealed,
                "time_disclosure_policy": str(run["time_disclosure_policy"]),
            }
            revealed = True
            new_value = {"revealed": True, "time_disclosure_policy": "NONE"}
            reason = str(payload.get("reason", "user reveal"))
            result_label = self._result_label(
                integrity_mode=str(run["integrity_mode"]),
                start_time_known=bool(run["start_time_known"]),
                strict_eligible=False,
                revealed=True,
            )
            connection.execute(
                """
                UPDATE replay_training_integrity
                SET strict_eligible = 0, revealed = 1,
                    result_label = ?, updated_at_ms = ?
                WHERE run_id = ?
                """,
                (result_label, now_ms, run["run_id"]),
            )
        public_time = self._public_time(
            connection,
            session_id=session_id,
            policy=str(run["time_disclosure_policy"]),
            revealed=revealed,
            public_time_ms=int(cursor["virtual_time_ms"]),
            sequence=validate_v2_counter(
                state["source_sequence"], field_name="source_sequence"
            ),
        )
        connection.execute(
            """
            INSERT INTO replay_run_action_event(
                run_id, action_sequence, event_id, command_id, event_type,
                rule_revision, public_time_json, old_value_json,
                new_value_json, reason, state_hash_before,
                state_hash_after, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run["run_id"],
                action_sequence,
                f"action-{action_sequence:08d}",
                command_id,
                event_type,
                int(run["active_rule_revision"]),
                canonical_json(public_time),
                canonical_json(old_value),
                canonical_json(new_value),
                reason,
                None if previous is None else str(previous["state_hash_after"]),
                state_hash_after,
                now_ms,
            ),
        )

    @staticmethod
    def _result_label(
        *,
        integrity_mode: str,
        start_time_known: bool,
        strict_eligible: bool,
        revealed: bool,
    ) -> str:
        if integrity_mode == "SANDBOX":
            return "SANDBOX_REVEALED" if revealed else "SANDBOX"
        if integrity_mode == "PRACTICE":
            return "PRACTICE_REVEALED" if revealed else "PRACTICE"
        if revealed:
            return "CHALLENGE_REVEALED"
        if start_time_known:
            return "START_TIME_KNOWN"
        if strict_eligible:
            return "STRICT_CHALLENGE"
        return "CHALLENGE_VISIBLE_TIME"

    @staticmethod
    def _public_time(
        connection: sqlite3.Connection,
        *,
        session_id: str,
        policy: str,
        revealed: bool,
        public_time_ms: int,
        sequence: int,
    ) -> dict[str, object]:
        dataset = connection.execute(
            """
            SELECT actual_replay_start_ms, synthetic_origin_ms
            FROM replay_dataset_ref WHERE session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if dataset is None:
            raise TypeError("training dataset time binding is missing")
        actual_origin = int(dataset["actual_replay_start_ms"])
        synthetic_origin = dataset["synthetic_origin_ms"]
        effective_policy = "NONE" if revealed else policy
        if policy == "NONE":
            actual_time = public_time_ms
            public_origin = actual_origin
        else:
            if synthetic_origin is None:
                raise TypeError("hidden training synthetic origin is missing")
            public_origin = int(synthetic_origin)
            actual_time = actual_origin + public_time_ms - public_origin
        return dict(
            project_public_time(
                actual_time_ms=actual_time,
                public_time_ms=(actual_time if effective_policy == "NONE" else public_time_ms),
                actual_origin_ms=actual_origin,
                public_origin_ms=(actual_origin if effective_policy == "NONE" else public_origin),
                policy=effective_policy,
                sequence=sequence,
            )
        )

    @classmethod
    def _upsert_equity_samples(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        session_id: str,
        policy: str,
        revealed: bool,
        state: Mapping[str, object],
        component_state: Mapping[str, object],
        now_ms: int,
    ) -> None:
        cursor = state.get("cursor")
        account = component_state.get("account")
        ledger = component_state.get("ledger")
        if (
            not isinstance(cursor, Mapping)
            or not isinstance(account, Mapping)
            or not isinstance(ledger, Mapping)
        ):
            return
        required_account = ("equity", "cash_balance", "unrealized_pnl")
        if any(not isinstance(account.get(key), str) for key in required_account):
            return
        ledger_hash = ledger.get("tail_hash")
        if not isinstance(ledger_hash, str):
            return
        public_ms = int(cursor["virtual_time_ms"])
        source_sequence = validate_v2_counter(
            state["source_sequence"], field_name="source_sequence"
        )
        public_time = cls._public_time(
            connection,
            session_id=session_id,
            policy=policy,
            revealed=revealed,
            public_time_ms=public_ms,
            sequence=source_sequence,
        )
        for resolution, bucket_ms, limit in _EQUITY_RESOLUTIONS:
            bucket_id = source_sequence if bucket_ms == 0 else public_ms // bucket_ms
            connection.execute(
                """
                INSERT INTO replay_equity_sample(
                    run_id, resolution, bucket_id, source_sequence, revision,
                    public_time_json, equity, cash_balance, unrealized_pnl,
                    ledger_tail_hash, state_hash, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, resolution, bucket_id) DO UPDATE SET
                    source_sequence = excluded.source_sequence,
                    revision = excluded.revision,
                    public_time_json = excluded.public_time_json,
                    equity = excluded.equity,
                    cash_balance = excluded.cash_balance,
                    unrealized_pnl = excluded.unrealized_pnl,
                    ledger_tail_hash = excluded.ledger_tail_hash,
                    state_hash = excluded.state_hash,
                    updated_at_ms = excluded.updated_at_ms
                """,
                (
                    run_id,
                    resolution,
                    bucket_id,
                    source_sequence,
                    validate_v2_counter(
                        state["revision"], field_name="revision"
                    ),
                    canonical_json(public_time),
                    account["equity"],
                    account["cash_balance"],
                    account["unrealized_pnl"],
                    ledger_hash,
                    state["state_hash"],
                    now_ms,
                    now_ms,
                ),
            )
            connection.execute(
                """
                DELETE FROM replay_equity_sample
                WHERE rowid IN (
                    SELECT rowid FROM replay_equity_sample
                    WHERE run_id = ? AND resolution = ?
                    ORDER BY bucket_id DESC
                    LIMIT -1 OFFSET ?
                )
                """,
                (run_id, resolution, limit),
            )


__all__ = ["TrainingRunStore"]
