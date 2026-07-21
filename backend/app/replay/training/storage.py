"""Lightweight TrainingRun metadata storage layered on the replay.v1 database."""

from __future__ import annotations

import base64
import json
import sqlite3
from collections.abc import Callable, Mapping

from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.storage.sqlite_store import ReplaySQLiteStore

from .errors import TrainingRunError
from .models import (
    CapabilityKind,
    CapabilityState,
    REPLAY_V2_PROTOCOL,
    TrainingRunCreateRequest,
    ViewerState,
)
from .schema import TRAINING_SCHEMA_ID, migrate_training_schema


_LIST_LIMIT_MAX = 100
_COMPATIBILITY_FILTERS = {"READY", "LEGACY_ADAPTER", "LEGACY_V1", "UNAVAILABLE"}
_STATES = {"PAUSED", "PLAYING", "ADVANCING", "ENDED", "ERROR"}
_SOURCES = {"BAR", "AGG_TRADE"}


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
            SELECT COUNT(*) FROM replay_training_track AS t
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
        r.adapter_session_id AS adapter_session_id,
        r.parent_legacy_session_id AS parent_legacy_session_id,
        s.degraded_reason AS degraded_reason,
        s.status_reason AS status_reason,
        EXISTS(
            SELECT 1 FROM replay_report AS report
            WHERE report.session_id = r.adapter_session_id
        ) AS report_available
    FROM replay_training_run AS r
    JOIN replay_session AS s ON s.session_id = r.adapter_session_id

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
        ) AS report_available
    FROM replay_session AS s
    WHERE NOT EXISTS(
        SELECT 1 FROM replay_training_run AS r
        WHERE r.adapter_session_id = s.session_id
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
                dataset_epoch=str(session_state["data_epoch"]),
                cursor={**cursor, "revision": int(session_state["revision"])},
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

        return write

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
                dataset_epoch=str(row["dataset_epoch"]),
                cursor=cursor,
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
                SELECT r.run_id, r.adapter_session_id, r.source_kind,
                       r.base_interval, r.compatibility, s.config_json
                FROM replay_training_run AS r
                JOIN replay_session AS s ON s.session_id = r.adapter_session_id
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
            "compatibility": str(row["compatibility"]),
            "adapter_config": json.loads(str(row["config_json"])),
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
                    r.adapter_session_id,
                    r.base_interval,
                    r.display_interval,
                    r.time_disclosure_policy,
                    r.dataset_epoch AS run_dataset_epoch,
                    t.track_id,
                    t.exchange,
                    t.market_type,
                    t.symbol,
                    t.source_kind,
                    t.dataset_epoch AS track_dataset_epoch,
                    t.virtual_time_ms,
                    t.source_sequence,
                    t.revision,
                    s.config_json,
                    s.data_epoch AS session_data_epoch,
                    s.degraded_reason
                FROM replay_training_run AS r
                JOIN replay_training_track AS t
                  ON t.run_id = r.run_id AND t.adapter_session_id = r.adapter_session_id
                JOIN replay_session AS s ON s.session_id = r.adapter_session_id
                WHERE r.adapter_session_id = ? AND t.track_id = ?
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
        dataset_epoch: str,
        cursor: Mapping[str, object],
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
                int(cursor["virtual_time_ms"]),
                int(cursor["source_sequence"]),
                int(cursor["revision"]),
                canonical_json(["PRIMARY_TRACK"]),
                canonical_json(_phase1_capabilities(source_kind)),
                now_ms,
                now_ms,
            ),
        )

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
            "review_available": False,
        }

    @staticmethod
    def _sync_session_summary(
        connection: sqlite3.Connection,
        session_id: str,
        state: Mapping[str, object],
        component_state: Mapping[str, object],
        now_ms: int,
    ) -> None:
        cursor = state.get("cursor")
        if not isinstance(cursor, Mapping):
            return
        account = component_state.get("account")
        equity = account.get("equity") if isinstance(account, Mapping) else None
        if isinstance(equity, str):
            connection.execute(
                """
                UPDATE replay_training_run
                SET state = ?, revision = ?, source_sequence = ?, virtual_time_ms = ?,
                    current_equity = ?, summary_revision = ?, updated_at_ms = ?, saved_at_ms = ?
                WHERE adapter_session_id = ?
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
                    session_id,
                ),
            )
        else:
            connection.execute(
                """
                UPDATE replay_training_run
                SET state = ?, revision = ?, source_sequence = ?, virtual_time_ms = ?,
                    updated_at_ms = ?, saved_at_ms = ?
                WHERE adapter_session_id = ?
                """,
                (
                    state["state"],
                    state["revision"],
                    state["source_sequence"],
                    cursor["virtual_time_ms"],
                    now_ms,
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


__all__ = ["TrainingRunStore"]
