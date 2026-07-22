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
from .account import (
    CONFIGURED_FEE_FIDELITY,
    CONTRACT_ACCOUNT_MODEL,
    CONTRACT_ACCOUNT_SCHEMA_VERSION,
    LEGACY_ACCOUNT_MODEL,
    SANDBOX_FUNDING_FIDELITY,
    InstrumentRule,
    fee_for_notional,
    initial_ledger_hash,
    instrument_rule_from_broker_config,
    ledger_chain_hash,
)
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
        broker_config: Mapping[str, object],
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
                    "funding_mode": request.funding_mode.value,
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
            self._insert_contract_account(
                connection,
                run_id=run_id,
                request=request,
                broker_config=broker_config,
                virtual_time_ms=int(cursor["virtual_time_ms"]),
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
            broker_config: Mapping[str, object],
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
            self._insert_fork_contract_account(
                connection,
                child_run_id=child_run_id,
                parent_run_id=parent_run_id,
                source_kind=str(parent["source_kind"]),
                settlement_asset=str(parent["settlement_asset"]),
                virtual_time_ms=int(cursor["virtual_time_ms"]),
                source_sequence=validate_v2_counter(
                    session_state["source_sequence"],
                    field_name="fork source_sequence",
                ),
                component_state=component_state,
                broker_config=broker_config,
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
            broker_config: Mapping[str, object],
        ) -> Callable[[sqlite3.Connection, int], None]:
            return lambda connection, now_ms: write(
                connection,
                now_ms,
                session_id=session_id,
                session_state=session_state,
                component_state=component_state,
                broker_config=broker_config,
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
                        account.account_model, account.margin_mode,
                        account.funding_mode, account.status AS account_status,
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
                JOIN replay_training_contract_account AS account USING(run_id)
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
            "account_model": str(row["account_model"]),
            "margin_mode": str(row["margin_mode"]),
            "funding_mode": str(row["funding_mode"]),
            "account_status": str(row["account_status"]),
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
        ) -> tuple[sqlite3.Row, tuple[sqlite3.Row, ...], dict[str, object]] | None:
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
            track_payloads = [self._market_track_from_row(row) for row in rows]
            portfolio = self._contract_portfolio_projection(
                connection,
                run_id=run_id,
                initial_equity=str(run["initial_equity"]),
                tracks=track_payloads,
            )
            return run, rows, portfolio

        result = await self.base_store.run_extension_read(read)
        if result is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training run does not exist",
                status_code=404,
            )
        run, rows, portfolio = result
        tracks = [self._market_track_from_row(row) for row in rows]
        viewer = self._viewer_from_row(run)
        return {
            "protocol": REPLAY_V2_PROTOCOL,
            "run_id": run_id,
            "ordering_version": GLOBAL_ORDERING_VERSION,
            "viewer_state": viewer.to_dict(),
            "tracks": tracks,
            "portfolio": portfolio,
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

    async def allocate_isolated_margin(
        self,
        *,
        run_id: str,
        track_id: str,
        amount: str,
        command_id: str,
        virtual_time_ms: int,
        source_sequence: int,
    ) -> dict[str, object]:
        target = Decimal(amount)

        def write(connection: sqlite3.Connection) -> None:
            account = connection.execute(
                """
                SELECT account.*, run.settlement_asset
                FROM replay_training_contract_account AS account
                JOIN replay_training_run AS run USING(run_id)
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if account is None or str(account["account_model"]) != CONTRACT_ACCOUNT_MODEL:
                raise TrainingRunError(
                    "CONTRACT_ACCOUNT_UNAVAILABLE",
                    "isolated margin is unavailable for this legacy run",
                    status_code=409,
                )
            if str(account["margin_mode"]) != "ISOLATED":
                raise TrainingRunError(
                    "MARGIN_MODE_MISMATCH",
                    "margin allocation requires an ISOLATED TrainingRun",
                    status_code=409,
                )
            track = connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()
            if track is None:
                raise TrainingRunError(
                    "MARKET_TRACK_NOT_FOUND",
                    "training market track does not exist",
                    status_code=404,
                )
            track_account = json.loads(str(track["account_json"]))
            if not isinstance(track_account, dict):
                raise TypeError("track account projection is invalid")
            required = Decimal(str(track_account.get("margin_used", "0"))) + Decimal(
                str(track_account.get("reserved_margin", "0"))
            )
            if target < required:
                raise TrainingRunError(
                    "ISOLATED_MARGIN_IN_USE",
                    "allocation cannot fall below active position and order margin",
                    status_code=409,
                    details={
                        "required_margin": decimal_to_string(
                            required,
                            field_name="required isolated margin",
                        )
                    },
                )
            allocations = json.loads(str(account["isolated_margin_json"]))
            if not isinstance(allocations, dict):
                raise TypeError("isolated margin allocation is invalid")
            current = Decimal(str(allocations.get(track_id, "0")))
            delta = target - current
            rows = tuple(
                connection.execute(
                    """
                    SELECT * FROM replay_training_market_track
                    WHERE run_id = ? ORDER BY stable_ordinal, track_id
                    """,
                    (run_id,),
                ).fetchall()
            )
            tracks = [self._market_track_from_row(row) for row in rows]
            run = connection.execute(
                "SELECT initial_equity FROM replay_training_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            portfolio = self._contract_portfolio_projection(
                connection,
                run_id=run_id,
                initial_equity=str(run["initial_equity"]),
                tracks=tracks,
            )
            if delta > Decimal(str(portfolio["available_equity"])):
                raise TrainingRunError(
                    "RUN_ACCOUNT_MARGIN_EXCEEDED",
                    "isolated allocation exceeds shared available equity",
                    status_code=409,
                )
            if target == 0:
                allocations.pop(track_id, None)
                kind = "MARGIN_RELEASE"
            else:
                allocations[track_id] = decimal_to_string(
                    target,
                    field_name="isolated margin allocation",
                )
                kind = "MARGIN_ALLOCATION" if delta >= 0 else "MARGIN_RELEASE"
            now_ms = self.base_store._validated_now_ms()
            connection.execute(
                """
                UPDATE replay_training_contract_account
                SET isolated_margin_json = ?, updated_at_ms = ? WHERE run_id = ?
                """,
                (canonical_json(allocations), now_ms, run_id),
            )
            rule = connection.execute(
                """
                SELECT revision FROM replay_training_instrument_rule
                WHERE run_id = ? AND track_id = ? ORDER BY revision DESC LIMIT 1
                """,
                (run_id, track_id),
            ).fetchone()
            self._append_contract_ledger(
                connection,
                run_id=run_id,
                posting_id=f"margin:{command_id}",
                track_id=track_id,
                kind=kind,
                cash_delta=Decimal(0),
                asset=str(account["settlement_asset"]),
                virtual_time_ms=virtual_time_ms,
                source_sequence=source_sequence,
                fidelity="CONFIGURED_ISOLATED_MARGIN_EXACT",
                rule_revision=int(rule["revision"]),
                reference_type="COMMAND",
                reference_id=command_id,
                metadata={
                    "old_allocation": decimal_to_string(
                        current,
                        field_name="old isolated allocation",
                    ),
                    "new_allocation": decimal_to_string(
                        target,
                        field_name="new isolated allocation",
                    ),
                },
                now_ms=now_ms,
            )

        await self.base_store.run_extension_write(write)
        return (await self.get_market_tracks(run_id))["portfolio"]  # type: ignore[return-value]

    async def revise_contract_policy(
        self,
        *,
        run_id: str,
        command_id: str,
        command_type: str,
        payload: Mapping[str, object],
        virtual_time_ms: int,
        source_sequence: int,
    ) -> dict[str, object]:
        def write(connection: sqlite3.Connection) -> dict[str, object]:
            account = connection.execute(
                """
                SELECT account.*, run.settlement_asset, run.integrity_mode
                FROM replay_training_contract_account AS account
                JOIN replay_training_run AS run USING(run_id)
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if account is None or str(account["account_model"]) != CONTRACT_ACCOUNT_MODEL:
                raise TrainingRunError(
                    "CONTRACT_ACCOUNT_UNAVAILABLE",
                    "policy revision is unavailable for this legacy run",
                    status_code=409,
                )
            now_ms = self.base_store._validated_now_ms()
            revision: int
            policy_hash: str
            if command_type == "change_fee_policy":
                revision = int(
                    connection.execute(
                        """
                        SELECT COALESCE(MAX(revision), 0) + 1
                        FROM replay_training_fee_policy WHERE run_id = ?
                        """,
                        (run_id,),
                    ).fetchone()[0]
                )
                policy = {
                    "schema_version": "replay.training.fee-policy.v1",
                    "run_id": run_id,
                    "revision": revision,
                    "effective_virtual_time_ms": virtual_time_ms,
                    "maker_fee_bps": str(payload["maker_fee_bps"]),
                    "taker_fee_bps": str(payload["taker_fee_bps"]),
                    "fidelity": CONFIGURED_FEE_FIDELITY,
                }
                policy_hash = canonical_sha256(policy)
                connection.execute(
                    """
                    INSERT INTO replay_training_fee_policy(
                        run_id, revision, effective_virtual_time_ms,
                        maker_fee_bps, taker_fee_bps, policy_hash, fidelity,
                        reason, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        revision,
                        virtual_time_ms,
                        payload["maker_fee_bps"],
                        payload["taker_fee_bps"],
                        policy_hash,
                        CONFIGURED_FEE_FIDELITY,
                        payload["reason"],
                        now_ms,
                    ),
                )
            elif command_type == "change_leverage_cap":
                revision = 0
                hashes: list[str] = []
                rows = tuple(
                    connection.execute(
                        """
                        SELECT rule.* FROM replay_training_instrument_rule AS rule
                        JOIN (
                            SELECT track_id, MAX(revision) AS revision
                            FROM replay_training_instrument_rule
                            WHERE run_id = ? GROUP BY track_id
                        ) AS active
                          ON active.track_id = rule.track_id
                         AND active.revision = rule.revision
                        WHERE rule.run_id = ? ORDER BY rule.track_id
                        """,
                        (run_id, run_id),
                    ).fetchall()
                )
                for row in rows:
                    raw = json.loads(str(row["rule_json"]))
                    if not isinstance(raw, dict):
                        raise TypeError("instrument rule is invalid")
                    raw["max_leverage"] = str(payload["max_leverage"])
                    raw["effective_virtual_time_ms"] = virtual_time_ms
                    rule = InstrumentRule.from_mapping(raw)
                    next_revision = int(row["revision"]) + 1
                    revision = max(revision, next_revision)
                    hashes.append(rule.rule_hash)
                    connection.execute(
                        """
                        INSERT INTO replay_training_instrument_rule(
                            run_id, track_id, revision, effective_virtual_time_ms,
                            rule_json, rule_hash, fidelity, created_at_ms
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            run_id,
                            row["track_id"],
                            next_revision,
                            virtual_time_ms,
                            canonical_json(rule.to_dict()),
                            rule.rule_hash,
                            rule.rule_fidelity,
                            now_ms,
                        ),
                    )
                policy_hash = canonical_sha256(
                    {
                        "command": command_type,
                        "max_leverage": payload["max_leverage"],
                        "rule_hashes": hashes,
                        "effective_virtual_time_ms": virtual_time_ms,
                    }
                )
            elif command_type == "change_funding_policy":
                revision = int(
                    connection.execute(
                        "SELECT COUNT(*) + 1 FROM replay_training_contract_ledger WHERE run_id = ? AND kind = 'POLICY_REVISION'",
                        (run_id,),
                    ).fetchone()[0]
                )
                mode = str(payload["funding_mode"])
                rate = payload.get("fixed_funding_rate")
                interval = payload.get("funding_interval_ms")
                next_time = (
                    None
                    if interval is None
                    else ((virtual_time_ms // int(interval)) + 1) * int(interval)
                )
                connection.execute(
                    """
                    UPDATE replay_training_contract_account
                    SET funding_mode = ?, fixed_funding_rate = ?,
                        funding_interval_ms = ?, next_funding_time_ms = ?,
                        updated_at_ms = ? WHERE run_id = ?
                    """,
                    (mode, rate, interval, next_time, now_ms, run_id),
                )
                policy_hash = canonical_sha256(
                    {
                        "command": command_type,
                        "funding_mode": mode,
                        "fixed_funding_rate": rate,
                        "funding_interval_ms": interval,
                        "effective_virtual_time_ms": virtual_time_ms,
                    }
                )
            else:
                raise ValueError("unsupported contract policy command")
            self._append_contract_ledger(
                connection,
                run_id=run_id,
                posting_id=f"policy:{command_id}",
                track_id=None,
                kind="POLICY_REVISION",
                cash_delta=Decimal(0),
                asset=str(account["settlement_asset"]),
                virtual_time_ms=virtual_time_ms,
                source_sequence=source_sequence,
                fidelity="CONFIGURED_POLICY_EXACT",
                rule_revision=max(1, revision),
                reference_type="COMMAND",
                reference_id=command_id,
                metadata={
                    "command_type": command_type,
                    "policy_hash": policy_hash,
                    "reason": payload["reason"],
                    "policy": {
                        key: value
                        for key, value in payload.items()
                        if key != "reason"
                    },
                },
                now_ms=now_ms,
            )
            return {"revision": revision, "policy_hash": policy_hash}

        result = await self.base_store.run_extension_write(write)
        result["portfolio"] = (await self.get_market_tracks(run_id))["portfolio"]
        return result

    async def pending_liquidations(self, run_id: str) -> tuple[dict[str, object], ...]:
        def read(connection: sqlite3.Connection) -> tuple[dict[str, object], ...]:
            rows = connection.execute(
                """
                SELECT event.*, track.adapter_session_id, track.open_orders_json
                FROM replay_training_liquidation_event AS event
                JOIN replay_training_market_track AS track
                  ON track.run_id = event.run_id AND track.track_id = event.track_id
                WHERE event.run_id = ? AND event.state = 'PENDING'
                ORDER BY track.stable_ordinal, event.liquidation_id
                """,
                (run_id,),
            ).fetchall()
            return tuple(
                {
                    **dict(row),
                    "open_orders": json.loads(str(row["open_orders_json"])),
                }
                for row in rows
            )

        return await self.base_store.run_extension_read(read)

    async def complete_liquidation(
        self,
        *,
        run_id: str,
        liquidation_id: str,
        canceled_order_ids: Sequence[str],
        close_order_id: str,
    ) -> dict[str, object]:
        def write(connection: sqlite3.Connection) -> None:
            event = connection.execute(
                """
                SELECT event.*, run.settlement_asset
                FROM replay_training_liquidation_event AS event
                JOIN replay_training_run AS run USING(run_id)
                WHERE event.run_id = ? AND event.liquidation_id = ?
                """,
                (run_id, liquidation_id),
            ).fetchone()
            if event is None:
                raise TrainingRunError(
                    "LIQUIDATION_NOT_FOUND",
                    "simulated account liquidation event does not exist",
                    status_code=404,
                )
            if str(event["state"]) == "COMPLETED":
                return
            if str(event["state"]) != "PENDING":
                raise TrainingRunError(
                    "LIQUIDATION_STATE_CONFLICT",
                    "simulated account liquidation cannot be completed",
                    status_code=409,
                )
            now_ms = self.base_store._validated_now_ms()
            fee = Decimal(str(event["liquidation_fee"]))
            account = connection.execute(
                """
                SELECT overlay_cash, isolated_margin_json
                FROM replay_training_contract_account WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            overlay = Decimal(str(account["overlay_cash"])) - fee
            allocations = json.loads(str(account["isolated_margin_json"]))
            if isinstance(allocations, dict):
                allocations.pop(str(event["track_id"]), None)
            rule = connection.execute(
                """
                SELECT revision FROM replay_training_instrument_rule
                WHERE run_id = ? AND track_id = ? ORDER BY revision DESC LIMIT 1
                """,
                (run_id, event["track_id"]),
            ).fetchone()
            self._append_contract_ledger(
                connection,
                run_id=run_id,
                posting_id=f"liquidation-fee:{liquidation_id}",
                track_id=str(event["track_id"]),
                kind="LIQUIDATION_FEE",
                cash_delta=-fee,
                asset=str(event["settlement_asset"]),
                virtual_time_ms=int(event["trigger_virtual_time_ms"]),
                source_sequence=int(event["trigger_source_sequence"]),
                fidelity=str(event["fidelity"]),
                rule_revision=int(rule["revision"]),
                reference_type="LIQUIDATION",
                reference_id=liquidation_id,
                metadata={"close_order_id": close_order_id},
                now_ms=now_ms,
            )
            connection.execute(
                """
                UPDATE replay_training_contract_account
                SET overlay_cash = ?, isolated_margin_json = ?, updated_at_ms = ?
                WHERE run_id = ?
                """,
                (
                    decimal_to_string(overlay, field_name="overlay_cash"),
                    canonical_json(allocations),
                    now_ms,
                    run_id,
                ),
            )
            run = connection.execute(
                "SELECT initial_equity FROM replay_training_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            track_rows = tuple(
                connection.execute(
                    """
                    SELECT * FROM replay_training_market_track
                    WHERE run_id = ? ORDER BY stable_ordinal, track_id
                    """,
                    (run_id,),
                ).fetchall()
            )
            if run is None:
                raise TypeError("liquidation run is missing")
            portfolio = self._contract_portfolio_projection(
                connection,
                run_id=run_id,
                initial_equity=str(run["initial_equity"]),
                tracks=[self._market_track_from_row(row) for row in track_rows],
            )
            equity_after = Decimal(str(portfolio["equity"]))
            connection.execute(
                """
                UPDATE replay_training_contract_account
                SET status = ?, updated_at_ms = ? WHERE run_id = ?
                """,
                (
                    "BANKRUPT" if equity_after < 0 else "ACTIVE",
                    now_ms,
                    run_id,
                ),
            )
            connection.execute(
                """
                UPDATE replay_training_liquidation_event
                SET state = 'COMPLETED', canceled_order_ids_json = ?,
                    close_order_id = ?, account_equity_after = ?, updated_at_ms = ?
                WHERE run_id = ? AND liquidation_id = ?
                """,
                (
                    canonical_json(list(canceled_order_ids)),
                    close_order_id,
                    decimal_to_string(
                        equity_after,
                        field_name="liquidation equity after",
                    ),
                    now_ms,
                    run_id,
                    liquidation_id,
                ),
            )

        await self.base_store.run_extension_write(write)
        return (await self.get_market_tracks(run_id))["portfolio"]  # type: ignore[return-value]

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
            broker_config: Mapping[str, object],
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
                self._insert_contract_track_rule(
                    connection,
                    run_id=run_id,
                    track_id=track_id,
                    source_kind=str(row["source_kind"]),
                    broker_config=broker_config,
                    effective_virtual_time_ms=int(cursor["virtual_time_ms"]),
                    now_ms=now_ms,
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
    def _contract_portfolio_projection(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        initial_equity: str,
        tracks: list[dict[str, object]],
    ) -> dict[str, object]:
        account = connection.execute(
            """
            SELECT * FROM replay_training_contract_account WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if account is None or str(account["account_model"]) != CONTRACT_ACCOUNT_MODEL:
            return cls._portfolio_projection(
                initial_equity=initial_equity,
                tracks=tracks,
            )
        base = cls._portfolio_projection(
            initial_equity=initial_equity,
            tracks=tracks,
        )
        try:
            overlay = Decimal(str(account["overlay_cash"]))
            cash = Decimal(str(base["cash_balance"])) + overlay
            unrealized = Decimal(str(base["unrealized_pnl"]))
            equity = cash + unrealized
            margin_used = Decimal(str(base["margin_used"]))
            reserved = Decimal(str(base["reserved_margin"]))
            isolated_raw = json.loads(str(account["isolated_margin_json"]))
            if not isinstance(isolated_raw, dict):
                raise TypeError("isolated margin allocation must be an object")
            isolated = {
                str(key): Decimal(str(value)) for key, value in isolated_raw.items()
            }
            available = (
                equity - margin_used - reserved
                if str(account["margin_mode"]) == "CROSS"
                else equity - sum(isolated.values(), Decimal(0))
            )
            risk_positions: list[dict[str, object]] = []
            total_maintenance = Decimal(0)
            for item in base["positions"]:  # type: ignore[union-attr]
                if not isinstance(item, Mapping):
                    continue
                position = item.get("position")
                if not isinstance(position, Mapping):
                    continue
                track_id = str(item["track_id"])
                rule_row = connection.execute(
                    """
                    SELECT revision, rule_json, rule_hash, fidelity
                    FROM replay_training_instrument_rule
                    WHERE run_id = ? AND track_id = ?
                    ORDER BY revision DESC LIMIT 1
                    """,
                    (run_id, track_id),
                ).fetchone()
                if rule_row is None:
                    raise TypeError("active instrument rule is missing")
                rule = InstrumentRule.from_mapping(json.loads(str(rule_row["rule_json"])))
                maintenance = rule.maintenance_margin(
                    Decimal(str(position["notional"]))
                )
                total_maintenance += maintenance
                allocation = isolated.get(track_id, Decimal(0))
                isolated_equity = allocation + Decimal(
                    str(position["unrealized_pnl"])
                )
                denominator = (
                    equity
                    if str(account["margin_mode"]) == "CROSS"
                    else isolated_equity
                )
                risk_positions.append(
                    {
                        **dict(item),
                        "maintenance_margin": decimal_to_string(
                            maintenance,
                            field_name="maintenance_margin",
                        ),
                        "isolated_margin": decimal_to_string(
                            allocation,
                            field_name="isolated_margin",
                        ),
                        "margin_equity": decimal_to_string(
                            denominator,
                            field_name="margin_equity",
                        ),
                        "risk_ratio": (
                            None
                            if maintenance == 0
                            else decimal_to_string(
                                denominator / maintenance,
                                field_name="risk_ratio",
                            )
                        ),
                        "rule_revision": int(rule_row["revision"]),
                        "rule_hash": str(rule_row["rule_hash"]),
                        "mark_fidelity": rule.mark_fidelity,
                    }
                )
        except (InvalidOperation, KeyError, TypeError, ValueError) as exc:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "contract account projection is invalid",
                status_code=503,
            ) from exc
        orders = [
            {
                **json.loads(str(row["order_json"])),
                "track_id": str(row["track_id"]),
                "rule_revision": int(row["rule_revision"]),
            }
            for row in connection.execute(
                """
                SELECT track_id, order_json, rule_revision
                FROM replay_training_contract_order
                WHERE run_id = ? ORDER BY track_id, order_id
                """,
                (run_id,),
            ).fetchall()
        ]
        fills = [
            {
                **json.loads(str(row["fill_json"])),
                "track_id": str(row["track_id"]),
                "configured_fee": str(row["configured_fee"]),
                "fee_policy_revision": int(row["fee_policy_revision"]),
                "fee_fidelity": str(row["fee_fidelity"]),
            }
            for row in connection.execute(
                """
                SELECT * FROM replay_training_contract_fill
                WHERE run_id = ? ORDER BY track_id, fill_id
                """,
                (run_id,),
            ).fetchall()
        ]
        ledger_rows = tuple(
            connection.execute(
                """
                SELECT * FROM replay_training_contract_ledger
                WHERE run_id = ? ORDER BY ledger_sequence
                """,
                (run_id,),
            ).fetchall()
        )
        ledger_total = sum(
            (Decimal(str(row["cash_delta"])) for row in ledger_rows),
            Decimal(0),
        )
        fee_total = sum(
            (Decimal(str(fill["configured_fee"])) for fill in fills),
            Decimal(0),
        )
        funding_total = sum(
            (
                Decimal(str(row["cash_delta"]))
                for row in ledger_rows
                if row["kind"] == "FUNDING_SETTLEMENT"
            ),
            Decimal(0),
        )
        liquidation_fee_total = -sum(
            (
                Decimal(str(row["cash_delta"]))
                for row in ledger_rows
                if row["kind"] == "LIQUIDATION_FEE"
            ),
            Decimal(0),
        )
        active_policy = connection.execute(
            """
            SELECT * FROM replay_training_fee_policy
            WHERE run_id = ? ORDER BY revision DESC LIMIT 1
            """,
            (run_id,),
        ).fetchone()
        rules = [
            {
                "track_id": str(row["track_id"]),
                "revision": int(row["revision"]),
                "rule_hash": str(row["rule_hash"]),
                "fidelity": str(row["fidelity"]),
                "rule": json.loads(str(row["rule_json"])),
            }
            for row in connection.execute(
                """
                SELECT rule.* FROM replay_training_instrument_rule AS rule
                JOIN (
                    SELECT track_id, MAX(revision) AS revision
                    FROM replay_training_instrument_rule
                    WHERE run_id = ? GROUP BY track_id
                ) AS active
                  ON active.track_id = rule.track_id
                 AND active.revision = rule.revision
                WHERE rule.run_id = ? ORDER BY rule.track_id
                """,
                (run_id, run_id),
            ).fetchall()
        ]
        liquidations = [
            {
                **dict(row),
                "canceled_order_ids": json.loads(
                    str(row["canceled_order_ids_json"])
                ),
            }
            for row in connection.execute(
                """
                SELECT * FROM replay_training_liquidation_event
                WHERE run_id = ? ORDER BY created_at_ms, liquidation_id
                """,
                (run_id,),
            ).fetchall()
        ]
        ledger_tail = [
            {
                "ledger_sequence": int(row["ledger_sequence"]),
                "posting_id": str(row["posting_id"]),
                "track_id": row["track_id"],
                "kind": str(row["kind"]),
                "cash_delta": str(row["cash_delta"]),
                "asset": str(row["asset"]),
                "virtual_time_ms": int(row["virtual_time_ms"]),
                "source_sequence": int(row["source_sequence"]),
                "fidelity": str(row["fidelity"]),
                "rule_revision": int(row["rule_revision"]),
                "reference_type": str(row["reference_type"]),
                "reference_id": str(row["reference_id"]),
                "metadata": json.loads(str(row["metadata_json"])),
                "previous_hash": str(row["previous_hash"]),
                "entry_hash": str(row["entry_hash"]),
            }
            for row in ledger_rows[-100:]
        ]
        return {
            "schema_version": CONTRACT_ACCOUNT_SCHEMA_VERSION,
            "account_model": CONTRACT_ACCOUNT_MODEL,
            "execution_model": "TOUCH_OR_TAPE_V2",
            "execution_fidelity": "NO_BOOK_TOUCH_OR_TAPE_APPROX",
            "settlement_account_shared": str(account["margin_mode"]) == "CROSS",
            "margin_mode": str(account["margin_mode"]),
            "funding_mode": str(account["funding_mode"]),
            "status": str(account["status"]),
            "initial_equity": initial_equity,
            "cash_balance": decimal_to_string(cash, field_name="cash_balance"),
            "equity": decimal_to_string(equity, field_name="equity"),
            "available_equity": decimal_to_string(
                available,
                field_name="available_equity",
            ),
            "reserved_margin": str(base["reserved_margin"]),
            "margin_used": str(base["margin_used"]),
            "maintenance_margin": decimal_to_string(
                total_maintenance,
                field_name="maintenance_margin",
            ),
            "realized_pnl": str(base["realized_pnl"]),
            "unrealized_pnl": str(base["unrealized_pnl"]),
            "fees_paid": decimal_to_string(fee_total, field_name="fees_paid"),
            "funding_cashflow": decimal_to_string(
                funding_total,
                field_name="funding_cashflow",
            ),
            "liquidation_fees_paid": decimal_to_string(
                liquidation_fee_total,
                field_name="liquidation_fees_paid",
            ),
            "risk_ratio": (
                None
                if total_maintenance == 0
                else decimal_to_string(
                    equity / total_maintenance,
                    field_name="risk_ratio",
                )
            ),
            "positions": risk_positions,
            "orders": orders,
            "fills": fills,
            "active_fee_policy": (
                None
                if active_policy is None
                else {
                    "revision": int(active_policy["revision"]),
                    "effective_virtual_time_ms": int(
                        active_policy["effective_virtual_time_ms"]
                    ),
                    "maker_fee_bps": str(active_policy["maker_fee_bps"]),
                    "taker_fee_bps": str(active_policy["taker_fee_bps"]),
                    "policy_hash": str(active_policy["policy_hash"]),
                    "fidelity": str(active_policy["fidelity"]),
                }
            ),
            "instrument_rules": rules,
            "isolated_allocations": {
                key: decimal_to_string(value, field_name="isolated allocation")
                for key, value in sorted(isolated.items())
            },
            "next_funding_time_ms": account["next_funding_time_ms"],
            "liquidations": liquidations,
            "ledger": {
                "chain_version": "replay.training.contract-ledger.v1",
                "entry_count": len(ledger_rows),
                "tail_hash": str(account["ledger_tail_hash"]),
                "cash_total": decimal_to_string(
                    ledger_total,
                    field_name="ledger_cash_total",
                ),
                "reconciliation_delta": decimal_to_string(
                    cash - ledger_total,
                    field_name="ledger_reconciliation_delta",
                ),
                "entries": ledger_tail,
            },
            "fidelity": {
                "instrument_rules": "AVAILABLE_APPROX_SIMULATION_RULES",
                "fees": CONFIGURED_FEE_FIDELITY,
                "funding": (
                    "OFF"
                    if str(account["funding_mode"]) == "OFF"
                    else SANDBOX_FUNDING_FIDELITY
                ),
                "mark": "REVEALED_PRICE_PROXY_NOT_HISTORICAL_MARK",
                "liquidation": "AVAILABLE_APPROX_SIMULATED_ACCOUNT",
            },
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
        portfolio = cls._contract_portfolio_projection(
            connection,
            run_id=run_id,
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

    @classmethod
    def _insert_contract_account(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        request: TrainingRunCreateRequest,
        broker_config: Mapping[str, object],
        virtual_time_ms: int,
        now_ms: int,
    ) -> None:
        interval = request.funding_interval_ms
        next_funding = (
            None
            if interval is None
            else ((virtual_time_ms // interval) + 1) * interval
        )
        root_hash = initial_ledger_hash(
            run_id=run_id,
            initial_equity=request.initial_equity,
            asset=request.settlement_asset,
        )
        connection.execute(
            """
            INSERT INTO replay_training_contract_account(
                run_id, account_model, margin_mode, funding_mode,
                fixed_funding_rate, funding_interval_ms, next_funding_time_ms,
                overlay_cash, isolated_margin_json, status, fidelity,
                ledger_tail_hash, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', '{}', 'ACTIVE', ?, ?, ?, ?)
            """,
            (
                run_id,
                CONTRACT_ACCOUNT_MODEL,
                request.margin_mode.value,
                request.funding_mode.value,
                request.fixed_funding_rate,
                interval,
                next_funding,
                "AVAILABLE_APPROX_NO_HISTORICAL_MARK_INDEX",
                root_hash,
                now_ms,
                now_ms,
            ),
        )
        cls._insert_contract_track_rule(
            connection,
            run_id=run_id,
            track_id="track-1",
            source_kind=request.source_kind.value,
            broker_config=broker_config,
            effective_virtual_time_ms=virtual_time_ms,
            now_ms=now_ms,
        )
        policy = {
            "schema_version": "replay.training.fee-policy.v1",
            "run_id": run_id,
            "revision": 1,
            "effective_virtual_time_ms": virtual_time_ms,
            "maker_fee_bps": request.maker_fee_bps,
            "taker_fee_bps": request.taker_fee_bps,
            "fidelity": CONFIGURED_FEE_FIDELITY,
        }
        connection.execute(
            """
            INSERT INTO replay_training_fee_policy(
                run_id, revision, effective_virtual_time_ms, maker_fee_bps,
                taker_fee_bps, policy_hash, fidelity, reason, created_at_ms
            ) VALUES (?, 1, ?, ?, ?, ?, ?, 'creation policy', ?)
            """,
            (
                run_id,
                virtual_time_ms,
                request.maker_fee_bps,
                request.taker_fee_bps,
                canonical_sha256(policy),
                CONFIGURED_FEE_FIDELITY,
                now_ms,
            ),
        )
        cls._append_contract_ledger(
            connection,
            run_id=run_id,
            posting_id="initial-capital",
            track_id=None,
            kind="INITIAL_CAPITAL",
            cash_delta=Decimal(request.initial_equity),
            asset=request.settlement_asset,
            virtual_time_ms=virtual_time_ms,
            source_sequence=0,
            fidelity="CONFIGURED_INITIAL_CAPITAL_EXACT",
            rule_revision=1,
            reference_type="RUN",
            reference_id=run_id,
            metadata={
                "account_model": CONTRACT_ACCOUNT_MODEL,
                "margin_mode": request.margin_mode.value,
                "funding_mode": request.funding_mode.value,
                "fixed_funding_rate": request.fixed_funding_rate,
                "funding_interval_ms": request.funding_interval_ms,
            },
            now_ms=now_ms,
        )

    @classmethod
    def _insert_fork_contract_account(
        cls,
        connection: sqlite3.Connection,
        *,
        child_run_id: str,
        parent_run_id: str,
        source_kind: str,
        settlement_asset: str,
        virtual_time_ms: int,
        source_sequence: int,
        component_state: Mapping[str, object],
        broker_config: Mapping[str, object],
        now_ms: int,
    ) -> None:
        """Rebuild the additive contract account at the selected fork cursor."""

        parent = connection.execute(
            """
            SELECT account.*, run.initial_equity
            FROM replay_training_contract_account AS account
            JOIN replay_training_run AS run USING(run_id)
            WHERE run_id = ?
            """,
            (parent_run_id,),
        ).fetchone()
        if parent is None:
            raise TypeError("parent contract account is missing")
        if str(parent["account_model"]) != CONTRACT_ACCOUNT_MODEL:
            connection.execute(
                """
                INSERT INTO replay_training_contract_account(
                    run_id, account_model, margin_mode, funding_mode,
                    fixed_funding_rate, funding_interval_ms, next_funding_time_ms,
                    overlay_cash, isolated_margin_json, status, fidelity,
                    ledger_tail_hash, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, '0', '{}', 'ACTIVE',
                          'LEGACY_FORK_NO_REINTERPRETATION', ?, ?, ?)
                """,
                (
                    child_run_id,
                    LEGACY_ACCOUNT_MODEL,
                    parent["margin_mode"],
                    parent["funding_mode"],
                    parent["ledger_tail_hash"],
                    now_ms,
                    now_ms,
                ),
            )
            return

        cutoff_sql = """
            virtual_time_ms < ?
            OR (virtual_time_ms = ? AND source_sequence <= ?)
        """
        parent_ledger = tuple(
            connection.execute(
                f"""
                SELECT * FROM replay_training_contract_ledger
                WHERE run_id = ? AND ({cutoff_sql})
                ORDER BY ledger_sequence
                """,
                (parent_run_id, virtual_time_ms, virtual_time_ms, source_sequence),
            ).fetchall()
        )
        creation_metadata: dict[str, object] = {}
        for entry in parent_ledger:
            if str(entry["kind"]) != "INITIAL_CAPITAL":
                continue
            raw = json.loads(str(entry["metadata_json"]))
            if isinstance(raw, dict):
                creation_metadata = raw
            break
        margin_mode = str(
            creation_metadata.get("margin_mode", parent["margin_mode"])
        )
        funding_mode = str(
            creation_metadata.get("funding_mode", parent["funding_mode"])
        )
        fixed_rate = creation_metadata.get(
            "fixed_funding_rate",
            parent["fixed_funding_rate"],
        )
        funding_interval = creation_metadata.get(
            "funding_interval_ms",
            parent["funding_interval_ms"],
        )
        allocations: dict[str, str] = {}
        for entry in parent_ledger:
            metadata = json.loads(str(entry["metadata_json"]))
            if not isinstance(metadata, dict):
                raise TypeError("parent contract ledger metadata is invalid")
            kind = str(entry["kind"])
            track_id = entry["track_id"]
            if kind == "POLICY_REVISION":
                policy = metadata.get("policy")
                if (
                    metadata.get("command_type") == "change_funding_policy"
                    and isinstance(policy, Mapping)
                ):
                    funding_mode = str(policy.get("funding_mode", funding_mode))
                    fixed_rate = policy.get("fixed_funding_rate")
                    funding_interval = policy.get("funding_interval_ms")
            elif kind in {"MARGIN_ALLOCATION", "MARGIN_RELEASE"} and isinstance(
                track_id,
                str,
            ):
                target = metadata.get("new_allocation")
                if target is None or Decimal(str(target)) == 0:
                    allocations.pop("track-1", None)
                else:
                    allocations["track-1"] = decimal_to_string(
                        Decimal(str(target)),
                        field_name="fork isolated allocation",
                    )

        interval_value = None if funding_interval is None else int(funding_interval)
        next_funding = (
            None
            if interval_value is None
            else ((virtual_time_ms // interval_value) + 1) * interval_value
        )
        root_hash = initial_ledger_hash(
            run_id=child_run_id,
            initial_equity=str(parent["initial_equity"]),
            asset=settlement_asset,
        )
        connection.execute(
            """
            INSERT INTO replay_training_contract_account(
                run_id, account_model, margin_mode, funding_mode,
                fixed_funding_rate, funding_interval_ms, next_funding_time_ms,
                overlay_cash, isolated_margin_json, status, fidelity,
                ledger_tail_hash, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, 'ACTIVE', ?, ?, ?, ?)
            """,
            (
                child_run_id,
                CONTRACT_ACCOUNT_MODEL,
                margin_mode,
                funding_mode,
                fixed_rate,
                interval_value,
                next_funding,
                canonical_json(allocations),
                "AVAILABLE_APPROX_NO_HISTORICAL_MARK_INDEX",
                root_hash,
                now_ms,
                now_ms,
            ),
        )

        rule_rows = tuple(
            connection.execute(
                """
                SELECT * FROM replay_training_instrument_rule
                WHERE run_id = ? AND track_id = 'track-1'
                  AND effective_virtual_time_ms <= ?
                ORDER BY revision
                """,
                (parent_run_id, virtual_time_ms),
            ).fetchall()
        )
        if not rule_rows:
            earliest_rule = connection.execute(
                """
                SELECT * FROM replay_training_instrument_rule
                WHERE run_id = ? AND track_id = 'track-1'
                ORDER BY revision LIMIT 1
                """,
                (parent_run_id,),
            ).fetchone()
            if earliest_rule is not None:
                rule_rows = (earliest_rule,)
        for row in rule_rows:
            raw_rule = json.loads(str(row["rule_json"]))
            if not isinstance(raw_rule, dict):
                raise TypeError("parent instrument rule is invalid")
            raw_rule["track_id"] = "track-1"
            rule = InstrumentRule.from_mapping(raw_rule)
            connection.execute(
                """
                INSERT INTO replay_training_instrument_rule(
                    run_id, track_id, revision, effective_virtual_time_ms,
                    rule_json, rule_hash, fidelity, created_at_ms
                ) VALUES (?, 'track-1', ?, ?, ?, ?, ?, ?)
                """,
                (
                    child_run_id,
                    int(row["revision"]),
                    min(int(row["effective_virtual_time_ms"]), virtual_time_ms),
                    canonical_json(rule.to_dict()),
                    rule.rule_hash,
                    rule.rule_fidelity,
                    now_ms,
                ),
            )
        if not rule_rows:
            cls._insert_contract_track_rule(
                connection,
                run_id=child_run_id,
                track_id="track-1",
                source_kind=source_kind,
                broker_config=broker_config,
                effective_virtual_time_ms=virtual_time_ms,
                now_ms=now_ms,
            )

        policy_rows = tuple(
            connection.execute(
                """
                SELECT * FROM replay_training_fee_policy
                WHERE run_id = ? AND effective_virtual_time_ms <= ?
                ORDER BY revision
                """,
                (parent_run_id, virtual_time_ms),
            ).fetchall()
        )
        if not policy_rows:
            earliest_policy = connection.execute(
                """
                SELECT * FROM replay_training_fee_policy
                WHERE run_id = ? ORDER BY revision LIMIT 1
                """,
                (parent_run_id,),
            ).fetchone()
            if earliest_policy is None:
                raise TypeError("parent fee policy is missing")
            policy_rows = (earliest_policy,)
        for row in policy_rows:
            effective_virtual_time_ms = min(
                int(row["effective_virtual_time_ms"]),
                virtual_time_ms,
            )
            policy = {
                "schema_version": "replay.training.fee-policy.v1",
                "run_id": child_run_id,
                "revision": int(row["revision"]),
                "effective_virtual_time_ms": effective_virtual_time_ms,
                "maker_fee_bps": str(row["maker_fee_bps"]),
                "taker_fee_bps": str(row["taker_fee_bps"]),
                "fidelity": str(row["fidelity"]),
            }
            connection.execute(
                """
                INSERT INTO replay_training_fee_policy(
                    run_id, revision, effective_virtual_time_ms, maker_fee_bps,
                    taker_fee_bps, policy_hash, fidelity, reason, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    child_run_id,
                    int(row["revision"]),
                    effective_virtual_time_ms,
                    row["maker_fee_bps"],
                    row["taker_fee_bps"],
                    canonical_sha256(policy),
                    row["fidelity"],
                    f"fork of {parent_run_id}: {row['reason']}",
                    now_ms,
                ),
            )

        cls._append_contract_ledger(
            connection,
            run_id=child_run_id,
            posting_id="initial-capital",
            track_id=None,
            kind="INITIAL_CAPITAL",
            cash_delta=Decimal(str(parent["initial_equity"])),
            asset=settlement_asset,
            virtual_time_ms=virtual_time_ms,
            source_sequence=0,
            fidelity="FORKED_INITIAL_CAPITAL_EXACT",
            rule_revision=1,
            reference_type="FORK",
            reference_id=parent_run_id,
            metadata={
                "account_model": CONTRACT_ACCOUNT_MODEL,
                "parent_run_id": parent_run_id,
                "parent_virtual_time_ms": virtual_time_ms,
            },
            now_ms=now_ms,
        )
        cls._sync_contract_components(
            connection,
            run_id=child_run_id,
            track_id="track-1",
            virtual_time_ms=virtual_time_ms,
            source_sequence=source_sequence,
            component_state=component_state,
            now_ms=now_ms,
        )

        extra_cash = Decimal(0)
        copied_kinds = {
            "FUNDING_SETTLEMENT",
            "LIQUIDATION_FEE",
            "MARGIN_ALLOCATION",
            "MARGIN_RELEASE",
            "POLICY_REVISION",
        }
        for entry in parent_ledger:
            if str(entry["kind"]) not in copied_kinds:
                continue
            metadata = json.loads(str(entry["metadata_json"]))
            if not isinstance(metadata, dict):
                raise TypeError("parent contract ledger metadata is invalid")
            metadata["fork_parent_run_id"] = parent_run_id
            sequence = cls._append_contract_ledger(
                connection,
                run_id=child_run_id,
                posting_id=f"fork:{parent_run_id}:{entry['posting_id']}",
                track_id=(None if entry["track_id"] is None else "track-1"),
                kind=str(entry["kind"]),
                cash_delta=Decimal(str(entry["cash_delta"])),
                asset=str(entry["asset"]),
                virtual_time_ms=int(entry["virtual_time_ms"]),
                source_sequence=int(entry["source_sequence"]),
                fidelity=str(entry["fidelity"]),
                rule_revision=int(entry["rule_revision"]),
                reference_type=str(entry["reference_type"]),
                reference_id=str(entry["reference_id"]),
                metadata=metadata,
                now_ms=now_ms,
            )
            if str(entry["kind"]) in {"FUNDING_SETTLEMENT", "LIQUIDATION_FEE"}:
                extra_cash += Decimal(str(entry["cash_delta"]))
            if str(entry["kind"]) == "FUNDING_SETTLEMENT":
                settlement = connection.execute(
                    """
                    SELECT * FROM replay_training_funding_settlement
                    WHERE run_id = ? AND track_id = ? AND settlement_time_ms = ?
                    """,
                    (
                        parent_run_id,
                        entry["track_id"],
                        int(entry["virtual_time_ms"]),
                    ),
                ).fetchone()
                if settlement is not None:
                    connection.execute(
                        """
                        INSERT INTO replay_training_funding_settlement(
                            run_id, track_id, settlement_time_ms, position_quantity,
                            mark_price, funding_rate, cash_delta, fidelity,
                            ledger_sequence, created_at_ms
                        ) VALUES (?, 'track-1', ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            child_run_id,
                            settlement["settlement_time_ms"],
                            settlement["position_quantity"],
                            settlement["mark_price"],
                            settlement["funding_rate"],
                            settlement["cash_delta"],
                            settlement["fidelity"],
                            sequence,
                            now_ms,
                        ),
                    )

        liquidation_rows = tuple(
            connection.execute(
                """
                SELECT * FROM replay_training_liquidation_event
                WHERE run_id = ? AND (
                    trigger_virtual_time_ms < ? OR
                    (trigger_virtual_time_ms = ? AND trigger_source_sequence <= ?)
                )
                ORDER BY created_at_ms, liquidation_id
                """,
                (parent_run_id, virtual_time_ms, virtual_time_ms, source_sequence),
            ).fetchall()
        )
        for row in liquidation_rows:
            connection.execute(
                """
                INSERT INTO replay_training_liquidation_event(
                    run_id, liquidation_id, track_id, state,
                    trigger_virtual_time_ms, trigger_source_sequence,
                    mark_price, position_quantity, position_notional,
                    maintenance_margin, account_equity_before, bankruptcy_price,
                    liquidation_fee, fidelity, canceled_order_ids_json,
                    close_order_id, account_equity_after, reason,
                    created_at_ms, updated_at_ms
                ) VALUES (?, ?, 'track-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          ?, ?, ?, ?, ?)
                """,
                (
                    child_run_id,
                    row["liquidation_id"],
                    row["state"],
                    row["trigger_virtual_time_ms"],
                    row["trigger_source_sequence"],
                    row["mark_price"],
                    row["position_quantity"],
                    row["position_notional"],
                    row["maintenance_margin"],
                    row["account_equity_before"],
                    row["bankruptcy_price"],
                    row["liquidation_fee"],
                    row["fidelity"],
                    row["canceled_order_ids_json"],
                    row["close_order_id"],
                    row["account_equity_after"],
                    row["reason"],
                    now_ms,
                    now_ms,
                ),
            )
        current = connection.execute(
            """
            SELECT overlay_cash FROM replay_training_contract_account
            WHERE run_id = ?
            """,
            (child_run_id,),
        ).fetchone()
        overlay = Decimal(str(current["overlay_cash"])) + extra_cash
        status = (
            "LIQUIDATING"
            if any(str(row["state"]) == "PENDING" for row in liquidation_rows)
            else "ACTIVE"
        )
        connection.execute(
            """
            UPDATE replay_training_contract_account
            SET overlay_cash = ?, status = ?, updated_at_ms = ? WHERE run_id = ?
            """,
            (
                decimal_to_string(overlay, field_name="fork overlay_cash"),
                status,
                now_ms,
                child_run_id,
            ),
        )

    @staticmethod
    def _insert_contract_track_rule(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        track_id: str,
        source_kind: str,
        broker_config: Mapping[str, object],
        effective_virtual_time_ms: int,
        now_ms: int,
    ) -> None:
        account = connection.execute(
            """
            SELECT account.*, run.settlement_asset
            FROM replay_training_contract_account AS account
            JOIN replay_training_run AS run USING(run_id)
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if account is None or str(account["account_model"]) != CONTRACT_ACCOUNT_MODEL:
            return
        existing = connection.execute(
            """
            SELECT 1 FROM replay_training_instrument_rule
            WHERE run_id = ? AND track_id = ?
            """,
            (run_id, track_id),
        ).fetchone()
        if existing is not None:
            return
        rule = instrument_rule_from_broker_config(
            track_id=track_id,
            source_kind=source_kind,
            broker_config=broker_config,
            effective_virtual_time_ms=effective_virtual_time_ms,
        )
        connection.execute(
            """
            INSERT INTO replay_training_instrument_rule(
                run_id, track_id, revision, effective_virtual_time_ms,
                rule_json, rule_hash, fidelity, created_at_ms
            ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                track_id,
                effective_virtual_time_ms,
                canonical_json(rule.to_dict()),
                rule.rule_hash,
                rule.rule_fidelity,
                now_ms,
            ),
        )

    @staticmethod
    def _append_contract_ledger(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        posting_id: str,
        track_id: str | None,
        kind: str,
        cash_delta: Decimal,
        asset: str,
        virtual_time_ms: int,
        source_sequence: int,
        fidelity: str,
        rule_revision: int,
        reference_type: str,
        reference_id: str,
        metadata: Mapping[str, object],
        now_ms: int,
    ) -> int:
        existing = connection.execute(
            """
            SELECT ledger_sequence FROM replay_training_contract_ledger
            WHERE run_id = ? AND posting_id = ?
            """,
            (run_id, posting_id),
        ).fetchone()
        if existing is not None:
            return int(existing["ledger_sequence"])
        account = connection.execute(
            """
            SELECT ledger_tail_hash FROM replay_training_contract_account
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if account is None:
            raise TypeError("contract account is missing")
        sequence = int(
            connection.execute(
                """
                SELECT COALESCE(MAX(ledger_sequence), 0) + 1
                FROM replay_training_contract_ledger WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()[0]
        )
        amount = decimal_to_string(cash_delta, field_name="contract cash_delta")
        posting = {
            "posting_id": posting_id,
            "track_id": track_id,
            "kind": kind,
            "cash_delta": amount,
            "asset": asset,
            "virtual_time_ms": virtual_time_ms,
            "source_sequence": source_sequence,
            "fidelity": fidelity,
            "rule_revision": rule_revision,
            "reference_type": reference_type,
            "reference_id": reference_id,
            "metadata": dict(metadata),
        }
        previous_hash = str(account["ledger_tail_hash"])
        entry_hash = ledger_chain_hash(
            previous_hash=previous_hash,
            ledger_sequence=sequence,
            posting=posting,
        )
        connection.execute(
            """
            INSERT INTO replay_training_contract_ledger(
                run_id, ledger_sequence, posting_id, track_id, kind,
                cash_delta, asset, virtual_time_ms, source_sequence, fidelity,
                rule_revision, reference_type, reference_id, metadata_json,
                previous_hash, entry_hash, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                sequence,
                posting_id,
                track_id,
                kind,
                amount,
                asset,
                virtual_time_ms,
                source_sequence,
                fidelity,
                rule_revision,
                reference_type,
                reference_id,
                canonical_json(metadata),
                previous_hash,
                entry_hash,
                now_ms,
            ),
        )
        connection.execute(
            """
            UPDATE replay_training_contract_account
            SET ledger_tail_hash = ?, updated_at_ms = ? WHERE run_id = ?
            """,
            (entry_hash, now_ms, run_id),
        )
        return sequence

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

    @classmethod
    def _sync_contract_components(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        track_id: str,
        virtual_time_ms: int,
        source_sequence: int,
        component_state: Mapping[str, object],
        now_ms: int,
    ) -> None:
        account = connection.execute(
            """
            SELECT account.*, run.settlement_asset
            FROM replay_training_contract_account AS account
            JOIN replay_training_run AS run USING(run_id)
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if account is None or str(account["account_model"]) != CONTRACT_ACCOUNT_MODEL:
            return
        rule_row = connection.execute(
            """
            SELECT revision, rule_json FROM replay_training_instrument_rule
            WHERE run_id = ? AND track_id = ?
              AND effective_virtual_time_ms <= ?
            ORDER BY effective_virtual_time_ms DESC, revision DESC LIMIT 1
            """,
            (run_id, track_id, virtual_time_ms),
        ).fetchone()
        if rule_row is None:
            raise TypeError("versioned instrument rule is missing")
        rule = InstrumentRule.from_mapping(json.loads(str(rule_row["rule_json"])))
        rule_revision = int(rule_row["revision"])
        raw_orders = component_state.get("orders")
        if isinstance(raw_orders, (list, tuple)):
            for raw in raw_orders:
                if not isinstance(raw, Mapping) or not isinstance(raw.get("order_id"), str):
                    raise TypeError("contract order projection is invalid")
                connection.execute(
                    """
                    INSERT INTO replay_training_contract_order(
                        run_id, track_id, order_id, order_json,
                        rule_revision, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(run_id, track_id, order_id) DO UPDATE SET
                        order_json = excluded.order_json,
                        rule_revision = excluded.rule_revision,
                        updated_at_ms = excluded.updated_at_ms
                    """,
                    (
                        run_id,
                        track_id,
                        raw["order_id"],
                        canonical_json(raw),
                        rule_revision,
                        now_ms,
                    ),
                )

        raw_fills = component_state.get("fills")
        overlay_delta = Decimal(0)
        if isinstance(raw_fills, (list, tuple)):
            for raw in raw_fills:
                if not isinstance(raw, Mapping) or not isinstance(raw.get("fill_id"), str):
                    raise TypeError("contract fill projection is invalid")
                fill_id = str(raw["fill_id"])
                exists = connection.execute(
                    """
                    SELECT 1 FROM replay_training_contract_fill
                    WHERE run_id = ? AND track_id = ? AND fill_id = ?
                    """,
                    (run_id, track_id, fill_id),
                ).fetchone()
                if exists is not None:
                    continue
                event_time_ms = int(raw.get("event_time_ms", virtual_time_ms))
                policy = connection.execute(
                    """
                    SELECT * FROM replay_training_fee_policy
                    WHERE run_id = ? AND effective_virtual_time_ms <= ?
                    ORDER BY effective_virtual_time_ms DESC, revision DESC LIMIT 1
                    """,
                    (run_id, event_time_ms),
                ).fetchone()
                if policy is None:
                    raise TypeError("versioned fee policy is missing")
                notional = Decimal(str(raw["notional"]))
                configured_fee = fee_for_notional(
                    notional=notional,
                    liquidity=str(raw["liquidity"]),
                    maker_bps=policy["maker_fee_bps"],
                    taker_bps=policy["taker_fee_bps"],
                    quote_step=rule.quote_step,
                )
                broker_fee = Decimal(str(raw["fee"]))
                connection.execute(
                    """
                    INSERT INTO replay_training_contract_fill(
                        run_id, track_id, fill_id, fill_json, rule_revision,
                        fee_policy_revision, configured_fee, fee_fidelity,
                        created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        track_id,
                        fill_id,
                        canonical_json(raw),
                        rule_revision,
                        int(policy["revision"]),
                        decimal_to_string(configured_fee, field_name="configured fee"),
                        str(policy["fidelity"]),
                        now_ms,
                    ),
                )
                cls._append_contract_ledger(
                    connection,
                    run_id=run_id,
                    posting_id=f"fee:{track_id}:{fill_id}",
                    track_id=track_id,
                    kind="TRADING_FEE",
                    cash_delta=-configured_fee,
                    asset=str(raw["fee_asset"]),
                    virtual_time_ms=event_time_ms,
                    source_sequence=int(raw.get("source_sequence", source_sequence)),
                    fidelity=str(policy["fidelity"]),
                    rule_revision=rule_revision,
                    reference_type="FILL",
                    reference_id=fill_id,
                    metadata={
                        "fee_policy_revision": int(policy["revision"]),
                        "broker_fee": str(raw["fee"]),
                        "liquidity": str(raw["liquidity"]),
                    },
                    now_ms=now_ms,
                )
                overlay_delta += broker_fee - configured_fee

        raw_ledger = component_state.get("ledger")
        entries = raw_ledger.get("entries") if isinstance(raw_ledger, Mapping) else None
        if isinstance(entries, list):
            for raw in entries:
                if not isinstance(raw, Mapping) or raw.get("account") != "CASH":
                    continue
                kind = str(raw.get("kind"))
                if kind in {"INITIAL_CAPITAL", "FEE"}:
                    continue
                entry_id = str(raw.get("entry_id"))
                cls._append_contract_ledger(
                    connection,
                    run_id=run_id,
                    posting_id=f"broker:{track_id}:{entry_id}",
                    track_id=track_id,
                    kind=f"BROKER_{kind}",
                    cash_delta=Decimal(str(raw["amount"])),
                    asset=str(raw["currency"]),
                    virtual_time_ms=int(raw.get("event_time_ms", virtual_time_ms)),
                    source_sequence=int(raw.get("source_sequence", source_sequence)),
                    fidelity="PAPER_BROKER_LEDGER_EXACT",
                    rule_revision=rule_revision,
                    reference_type="BROKER_ENTRY",
                    reference_id=entry_id,
                    metadata={
                        "transaction_id": raw.get("transaction_id"),
                        "order_id": raw.get("order_id"),
                        "fill_id": raw.get("fill_id"),
                    },
                    now_ms=now_ms,
                )
        if overlay_delta:
            current = connection.execute(
                """
                SELECT overlay_cash FROM replay_training_contract_account
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            adjusted = Decimal(str(current["overlay_cash"])) + overlay_delta
            connection.execute(
                """
                UPDATE replay_training_contract_account
                SET overlay_cash = ?, updated_at_ms = ? WHERE run_id = ?
                """,
                (
                    decimal_to_string(adjusted, field_name="overlay_cash"),
                    now_ms,
                    run_id,
                ),
            )
        if str(account["margin_mode"]) == "ISOLATED":
            position = component_state.get("position")
            orders = component_state.get("orders")
            terminal = {"FILLED", "CANCELED", "REJECTED", "EXPIRED"}
            has_open_order = isinstance(orders, (list, tuple)) and any(
                isinstance(order, Mapping) and order.get("status") not in terminal
                for order in orders
            )
            flat = isinstance(position, Mapping) and str(position.get("quantity")) == "0"
            allocations = json.loads(str(account["isolated_margin_json"]))
            if (
                flat
                and not has_open_order
                and isinstance(allocations, dict)
                and track_id in allocations
            ):
                released = Decimal(str(allocations.pop(track_id)))
                connection.execute(
                    """
                    UPDATE replay_training_contract_account
                    SET isolated_margin_json = ?, updated_at_ms = ? WHERE run_id = ?
                    """,
                    (canonical_json(allocations), now_ms, run_id),
                )
                cls._append_contract_ledger(
                    connection,
                    run_id=run_id,
                    posting_id=f"auto-margin-release:{track_id}:{source_sequence}",
                    track_id=track_id,
                    kind="MARGIN_RELEASE",
                    cash_delta=Decimal(0),
                    asset=str(account["settlement_asset"]),
                    virtual_time_ms=virtual_time_ms,
                    source_sequence=source_sequence,
                    fidelity="CONFIGURED_ISOLATED_MARGIN_EXACT",
                    rule_revision=rule_revision,
                    reference_type="POSITION",
                    reference_id=track_id,
                    metadata={
                        "released_margin": decimal_to_string(
                            released,
                            field_name="released isolated margin",
                        )
                    },
                    now_ms=now_ms,
                )

    @classmethod
    def _settle_contract_funding(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        now_ms: int,
    ) -> None:
        account = connection.execute(
            """
            SELECT account.*, run.settlement_asset
            FROM replay_training_contract_account AS account
            JOIN replay_training_run AS run USING(run_id)
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if (
            account is None
            or str(account["account_model"]) != CONTRACT_ACCOUNT_MODEL
            or str(account["funding_mode"]) != "SANDBOX_FIXED"
        ):
            return
        interval = account["funding_interval_ms"]
        next_time = account["next_funding_time_ms"]
        rate_value = account["fixed_funding_rate"]
        if interval is None or next_time is None or rate_value is None:
            raise TypeError("sandbox funding configuration is incomplete")
        tracks = tuple(
            connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND subscription_tier = 'FULL'
                ORDER BY stable_ordinal, track_id
                """,
                (run_id,),
            ).fetchall()
        )
        if not tracks or any(track["virtual_time_ms"] is None for track in tracks):
            return
        global_time = min(int(track["virtual_time_ms"]) for track in tracks)
        settlement_time = int(next_time)
        interval_ms = int(interval)
        rate = Decimal(str(rate_value))
        iterations = 0
        while settlement_time <= global_time:
            iterations += 1
            if iterations > 4096:
                raise TrainingRunError(
                    "FUNDING_SCAN_LIMIT_EXCEEDED",
                    "funding settlement exceeded the bounded interval budget",
                    status_code=409,
                )
            for track in tracks:
                position = json.loads(str(track["position_json"]))
                if not isinstance(position, dict):
                    raise TypeError("funding position projection is invalid")
                quantity = Decimal(str(position.get("quantity", "0")))
                mark = Decimal(str(position.get("mark_price", track["public_price"] or "0")))
                if quantity and mark <= 0:
                    raise TrainingRunError(
                        "HISTORICAL_MARK_UNAVAILABLE",
                        "funding settlement has no revealed mark proxy",
                        status_code=409,
                    )
                cash_delta = -(quantity * mark * rate)
                existing = connection.execute(
                    """
                    SELECT ledger_sequence FROM replay_training_funding_settlement
                    WHERE run_id = ? AND track_id = ? AND settlement_time_ms = ?
                    """,
                    (run_id, track["track_id"], settlement_time),
                ).fetchone()
                if existing is not None:
                    continue
                rule_row = connection.execute(
                    """
                    SELECT revision FROM replay_training_instrument_rule
                    WHERE run_id = ? AND track_id = ?
                    ORDER BY revision DESC LIMIT 1
                    """,
                    (run_id, track["track_id"]),
                ).fetchone()
                if rule_row is None:
                    raise TypeError("funding instrument rule is missing")
                sequence = cls._append_contract_ledger(
                    connection,
                    run_id=run_id,
                    posting_id=f"funding:{track['track_id']}:{settlement_time}",
                    track_id=str(track["track_id"]),
                    kind="FUNDING_SETTLEMENT",
                    cash_delta=cash_delta,
                    asset=str(account["settlement_asset"]),
                    virtual_time_ms=settlement_time,
                    source_sequence=int(track["source_sequence"] or 0),
                    fidelity=SANDBOX_FUNDING_FIDELITY,
                    rule_revision=int(rule_row["revision"]),
                    reference_type="FUNDING_BOUNDARY",
                    reference_id=f"funding-{settlement_time}",
                    metadata={"rate": str(rate_value), "mark_price": str(mark)},
                    now_ms=now_ms,
                )
                connection.execute(
                    """
                    INSERT INTO replay_training_funding_settlement(
                        run_id, track_id, settlement_time_ms, position_quantity,
                        mark_price, funding_rate, cash_delta, fidelity,
                        ledger_sequence, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        track["track_id"],
                        settlement_time,
                        decimal_to_string(quantity, field_name="funding quantity"),
                        decimal_to_string(mark, field_name="funding mark"),
                        str(rate_value),
                        decimal_to_string(cash_delta, field_name="funding cash_delta"),
                        SANDBOX_FUNDING_FIDELITY,
                        sequence,
                        now_ms,
                    ),
                )
                overlay = Decimal(str(account["overlay_cash"])) + cash_delta
                connection.execute(
                    """
                    UPDATE replay_training_contract_account
                    SET overlay_cash = ?, updated_at_ms = ? WHERE run_id = ?
                    """,
                    (
                        decimal_to_string(overlay, field_name="overlay_cash"),
                        now_ms,
                        run_id,
                    ),
                )
                account = connection.execute(
                    """
                    SELECT account.*, run.settlement_asset
                    FROM replay_training_contract_account AS account
                    JOIN replay_training_run AS run USING(run_id)
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()
            settlement_time += interval_ms
        connection.execute(
            """
            UPDATE replay_training_contract_account
            SET next_funding_time_ms = ?, updated_at_ms = ? WHERE run_id = ?
            """,
            (settlement_time, now_ms, run_id),
        )

    @classmethod
    def _detect_contract_liquidations(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        now_ms: int,
    ) -> None:
        account = connection.execute(
            """
            SELECT account.*, run.initial_equity
            FROM replay_training_contract_account AS account
            JOIN replay_training_run AS run USING(run_id)
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if account is None or str(account["account_model"]) != CONTRACT_ACCOUNT_MODEL:
            return
        tracks = tuple(
            connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND subscription_tier = 'FULL'
                ORDER BY stable_ordinal, track_id
                """,
                (run_id,),
            ).fetchall()
        )
        initial = Decimal(str(account["initial_equity"]))
        equity = initial + Decimal(str(account["overlay_cash"]))
        positions: list[tuple[sqlite3.Row, dict[str, object], InstrumentRule, Decimal]] = []
        total_maintenance = Decimal(0)
        for track in tracks:
            track_account = json.loads(str(track["account_json"]))
            position = json.loads(str(track["position_json"]))
            if isinstance(track_account, dict) and "equity" in track_account:
                equity += Decimal(str(track_account["equity"])) - initial
            if not isinstance(position, dict):
                continue
            quantity = Decimal(str(position.get("quantity", "0")))
            if quantity == 0:
                continue
            rule_row = connection.execute(
                """
                SELECT rule_json FROM replay_training_instrument_rule
                WHERE run_id = ? AND track_id = ? ORDER BY revision DESC LIMIT 1
                """,
                (run_id, track["track_id"]),
            ).fetchone()
            if rule_row is None:
                raise TypeError("liquidation instrument rule is missing")
            rule = InstrumentRule.from_mapping(json.loads(str(rule_row["rule_json"])))
            maintenance = rule.maintenance_margin(Decimal(str(position["notional"])))
            total_maintenance += maintenance
            positions.append((track, position, rule, maintenance))
        if not positions:
            pending = connection.execute(
                """
                SELECT 1 FROM replay_training_liquidation_event
                WHERE run_id = ? AND state = 'PENDING' LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            if str(account["status"]) == "LIQUIDATING" and pending is None:
                connection.execute(
                    """
                    UPDATE replay_training_contract_account
                    SET status = 'ACTIVE', updated_at_ms = ? WHERE run_id = ?
                    """,
                    (now_ms, run_id),
                )
            return
        isolated = json.loads(str(account["isolated_margin_json"]))
        if not isinstance(isolated, dict):
            raise TypeError("isolated margin allocation is invalid")
        affected: list[tuple[sqlite3.Row, dict[str, object], InstrumentRule, Decimal]] = []
        if str(account["margin_mode"]) == "CROSS":
            if equity <= total_maintenance:
                affected = positions
        else:
            for item in positions:
                track, position, _rule, maintenance = item
                allocated = Decimal(str(isolated.get(str(track["track_id"]), "0")))
                isolated_equity = allocated + Decimal(str(position["unrealized_pnl"]))
                if isolated_equity <= maintenance:
                    affected.append(item)
        for track, position, rule, maintenance in affected:
            sequence = int(track["source_sequence"] or 0)
            liquidation_id = f"liq-{track['track_id']}-{sequence:010d}"
            quantity = Decimal(str(position["quantity"]))
            entry = Decimal(str(position["entry_price"]))
            notional = Decimal(str(position["notional"]))
            allocation = (
                equity
                if str(account["margin_mode"]) == "CROSS"
                else Decimal(str(isolated.get(str(track["track_id"]), "0")))
            )
            bankruptcy = entry - (allocation / abs(quantity)) * (
                Decimal(1) if quantity > 0 else Decimal(-1)
            )
            bankruptcy = max(Decimal(0), bankruptcy)
            fee = rule.liquidation_fee(notional)
            connection.execute(
                """
                INSERT OR IGNORE INTO replay_training_liquidation_event(
                    run_id, liquidation_id, track_id, state,
                    trigger_virtual_time_ms, trigger_source_sequence,
                    mark_price, position_quantity, position_notional,
                    maintenance_margin, account_equity_before, bankruptcy_price,
                    liquidation_fee, fidelity, canceled_order_ids_json,
                    close_order_id, account_equity_after, reason,
                    created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          '[]', NULL, NULL, 'MAINTENANCE_MARGIN_BREACH', ?, ?)
                """,
                (
                    run_id,
                    liquidation_id,
                    track["track_id"],
                    int(track["virtual_time_ms"] or 0),
                    sequence,
                    position["mark_price"],
                    position["quantity"],
                    position["notional"],
                    decimal_to_string(maintenance, field_name="maintenance margin"),
                    decimal_to_string(equity, field_name="account equity"),
                    decimal_to_string(bankruptcy, field_name="bankruptcy price"),
                    decimal_to_string(fee, field_name="liquidation fee"),
                    rule.mark_fidelity,
                    now_ms,
                    now_ms,
                ),
            )
        if affected:
            connection.execute(
                """
                UPDATE replay_training_contract_account
                SET status = 'LIQUIDATING', updated_at_ms = ? WHERE run_id = ?
                """,
                (now_ms, run_id),
            )

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

        run_id = str(track["run_id"])
        track_id = str(track["track_id"])
        self._sync_contract_components(
            connection,
            run_id=run_id,
            track_id=track_id,
            virtual_time_ms=int(cursor["virtual_time_ms"]),
            source_sequence=int(state["source_sequence"]),
            component_state=component_state,
            now_ms=now_ms,
        )
        self._settle_contract_funding(
            connection,
            run_id=run_id,
            now_ms=now_ms,
        )
        self._detect_contract_liquidations(
            connection,
            run_id=run_id,
            now_ms=now_ms,
        )
        account_model = connection.execute(
            """
            SELECT account_model FROM replay_training_contract_account
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if (
            account_model is not None
            and str(account_model["account_model"]) == CONTRACT_ACCOUNT_MODEL
        ):
            all_rows = tuple(
                connection.execute(
                    """
                    SELECT * FROM replay_training_market_track
                    WHERE run_id = ? ORDER BY stable_ordinal, track_id
                    """,
                    (run_id,),
                ).fetchall()
            )
            all_tracks = [self._market_track_from_row(row) for row in all_rows]
            run_row = connection.execute(
                """
                SELECT initial_equity FROM replay_training_run WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            portfolio = self._contract_portfolio_projection(
                connection,
                run_id=run_id,
                initial_equity=str(run_row["initial_equity"]),
                tracks=all_tracks,
            )
            connection.execute(
                """
                UPDATE replay_training_run
                SET current_equity = ?, summary_revision = ?, updated_at_ms = ?
                WHERE run_id = ?
                """,
                (portfolio["equity"], state["revision"], now_ms, run_id),
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
