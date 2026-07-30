"""Lightweight TrainingRun metadata storage layered on the replay.v1 database."""

from __future__ import annotations

import base64
import json
import sqlite3
from collections.abc import Callable, Mapping, Sequence
from decimal import Decimal, InvalidOperation, localcontext
from typing import cast

from app.replay.canonical import canonical_json, canonical_sha256
from app.replay.broker.models import decimal_to_string
from app.replay.period_summary import (
    EncodedPeriodSummaryCandidate,
    MAX_PERIOD_SUMMARY_CANDIDATES,
    MAX_PERIOD_SUMMARY_TOTAL_COMPRESSED_BYTES,
    PERIOD_SUMMARY_ALGORITHM_VERSION,
    ReplayPeriodSummary,
    decode_component_state,
)
from app.replay.storage.sqlite_store import ReplaySQLiteStore
from app.data_engine.interval_policy import parse_interval_ms

from .errors import TrainingRunError
from .account_history import (
    ACCOUNT_AUDIT_SCHEMA_VERSION,
    AccountHistoryEvent,
    PreparedAccountHistoryBinding,
    account_rule_component_hash,
    bind_account_history_archive,
    runtime_instrument_rule,
)
from .historical_book import (
    BOOK_EXECUTION_FIDELITY,
    PreparedHistoricalBookBinding,
    bind_historical_book_archive,
)
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
    round_to_step,
)
from .anchor_codec import (
    ANCHOR_PAYLOAD_ENCODING_RAW,
    decode_anchor_payload,
)
from .models import (
    CapabilityKind,
    CapabilityState,
    REPLAY_V2_PROTOCOL,
    ReplayLaunchContext,
    TrainingRunCreateRequest,
    VisibleHistoryMode,
    ViewerState,
    validate_v2_counter,
)
from .multitrack import (
    GLOBAL_ORDERING_VERSION,
    StableMarketEvent,
    global_ordering_hash,
    stable_market_event_order,
)
from .schema import (
    ADVANCE_INTENT_SCHEMA_VERSION,
    DATA_POLICY_SCHEMA_VERSION,
    PERIOD_SUMMARY_SET_SCHEMA_VERSION,
    REVIEW_TIMELINE_SCHEMA_VERSION,
    RUN_RULES_SCHEMA_VERSION,
    START_SELECTION_SCHEMA_VERSION,
    TRAINING_SCHEMA_ID,
    data_policy_hash,
    migrate_training_schema,
    start_selection_hash,
)
from .review import (
    REVIEW_ARTIFACT_BYTES_LIMIT,
    ReviewRecorder,
    validate_drawing_document,
)
from .segments import (
    ResolvedHistoryPolicy,
    backfill_archive_segments,
    register_archive_segment,
)


_LIST_LIMIT_MAX = 100
_COMPATIBILITY_FILTERS = {"READY", "LEGACY_ADAPTER", "LEGACY_V1", "UNAVAILABLE"}
_STATES = {"PAUSED", "PLAYING", "ADVANCING", "ENDED", "ERROR"}
_SOURCES = {"BAR", "AGG_TRADE"}
_VIEW_EVENT_LIMIT = 2_048
_PUBLIC_TIME_BATCH_LIMIT = 20_000
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
        self._review = ReviewRecorder(self)

    async def start(self) -> None:
        now = self.base_store._validated_now_ms()
        def migrate(connection: sqlite3.Connection) -> None:
            migrate_training_schema(connection, now_ms=now)
            connection.execute(
                """
                INSERT OR IGNORE INTO replay_training_account_history(
                    run_id, account_data_mode, status, fidelity,
                    archive_proof_hash, degraded_reason, auditor_status,
                    auditor_proof_hash, auditor_differences_json,
                    created_at_ms, updated_at_ms
                )
                SELECT run_id, 'APPROX_PROXY', 'ACTIVE',
                       'REVEALED_PRICE_PROXY_MODELLED_ACCOUNT',
                       NULL, NULL, 'NOT_RUN', NULL, '[]', ?, ?
                FROM replay_training_run
                """,
                (now, now),
            )
            connection.execute(
                """
                UPDATE replay_training_fast_forward_summary_set
                SET status = 'FAILED', active = 0,
                    error_code = 'PROCESS_RESTARTED',
                    error_message = 'summary preparation was interrupted by restart',
                    updated_at_ms = ?
                WHERE status = 'PREPARING'
                """,
                (now,),
            )
            backfill_archive_segments(connection, now_ms=now)
            self._review.backfill(connection, now_ms=now)

        await self.base_store.run_extension_write(migrate)
        self.base_store.register_session_summary_writer(self._sync_session_summary)
        self.base_store.register_session_mutation_writer(self._sync_session_mutation)
        self.base_store.register_session_review_writer(self._sync_review_event)

    def _sync_review_event(
        self,
        connection: sqlite3.Connection,
        session_id: str,
        context: Mapping[str, object],
        state: Mapping[str, object],
        component_state: Mapping[str, object],
        checkpoint: bytes | None,
        now_ms: int,
    ) -> None:
        self._review.sync(
            connection,
            session_id,
            context,
            state,
            component_state,
            checkpoint,
            now_ms,
        )

    def _append_review_timeline_event(
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
        return self._review.append(
            connection,
            run_id=run_id,
            session_id=session_id,
            context=context,
            state=state,
            checkpoint=checkpoint,
            now_ms=now_ms,
        )

    def initial_run_writer(
        self,
        *,
        run_id: str,
        request: TrainingRunCreateRequest,
        adapter_session_id: str,
        session_state: Mapping[str, object],
        component_state: Mapping[str, object],
        broker_config: Mapping[str, object],
        dataset_ref: Mapping[str, object],
        dataset_blob: Mapping[str, object],
        actual_replay_start_ms: int,
        actual_replay_end_ms: int,
        history_policy: ResolvedHistoryPolicy,
        historical_book_binding: PreparedHistoricalBookBinding | None = None,
        account_history_binding: PreparedAccountHistoryBinding | None = None,
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
            self._insert_launch_context(
                connection,
                run_id=run_id,
                context=request.resolved_launch_context(),
                now_ms=now_ms,
            )
            self._insert_start_selection(
                connection,
                run_id=run_id,
                start_mode=request.start_mode.value,
                seed_source=(
                    "SERVER" if request.start_mode.value == "RANDOM" else "MANUAL"
                ),
                random_seed=request.random_seed,
                actual_start_ms=actual_replay_start_ms,
                actual_end_ms=actual_replay_end_ms,
                dataset_epoch=str(session_state["data_epoch"]),
                parent_selection_hash=None,
                now_ms=now_ms,
            )
            self._insert_data_policy(
                connection,
                run_id=run_id,
                policy=history_policy,
                actual_replay_start_ms=actual_replay_start_ms,
                now_ms=now_ms,
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
            if request.account_data_mode.value == "HISTORICAL_EXACT":
                if account_history_binding is None:
                    raise TypeError(
                        "exact account run is missing its verified archive binding"
                    )
                bind_account_history_archive(
                    connection,
                    run_id=run_id,
                    track_id="track-1",
                    binding=account_history_binding,
                    bound_range_start_ms=actual_replay_start_ms,
                    bound_range_end_ms=actual_replay_end_ms,
                    source_kind=request.source_kind.value,
                    now_ms=now_ms,
                )
            else:
                self._insert_approx_account_history(
                    connection,
                    run_id=run_id,
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
            if request.account_data_mode.value == "HISTORICAL_EXACT":
                self._apply_exact_mark_projection(
                    connection,
                    run_id=run_id,
                    track_id="track-1",
                    now_ms=now_ms,
                )
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
            register_archive_segment(
                connection,
                run_id=run_id,
                track_id="track-1",
                adapter_session_id=adapter_session_id,
                source_kind=request.source_kind.value,
                dataset_ref=dataset_ref,
                dataset_blob=dataset_blob,
                actual_replay_start_ms=actual_replay_start_ms,
                actual_replay_end_ms=actual_replay_end_ms,
                history_policy=history_policy,
                now_ms=now_ms,
            )
            if request.book_mode.value == "BOOK_ASSISTED_REQUIRED":
                if historical_book_binding is None:
                    raise TypeError("book-assisted run is missing its verified L2 binding")
                bind_historical_book_archive(
                    connection,
                    run_id=run_id,
                    track_id="track-1",
                    binding=historical_book_binding,
                    bound_range_start_ms=actual_replay_start_ms,
                    bound_range_end_ms=actual_replay_end_ms,
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

    @staticmethod
    def _insert_approx_account_history(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        now_ms: int,
    ) -> None:
        connection.execute(
            """
            INSERT INTO replay_training_account_history(
                run_id, account_data_mode, status, fidelity,
                archive_proof_hash, degraded_reason, auditor_status,
                auditor_proof_hash, auditor_differences_json,
                created_at_ms, updated_at_ms
            ) VALUES (?, 'APPROX_PROXY', 'ACTIVE',
                      'REVEALED_PRICE_PROXY_MODELLED_ACCOUNT',
                      NULL, NULL, 'NOT_RUN', NULL, '[]', ?, ?)
            ON CONFLICT(run_id) DO NOTHING
            """,
            (run_id, now_ms, now_ms),
        )

    @classmethod
    def _apply_exact_mark_projection(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        track_id: str,
        now_ms: int,
    ) -> None:
        """Overlay the pinned mark without mutating the replay.v1 broker kernel."""

        projection = connection.execute(
            """
            SELECT projection.*, history.status AS history_status,
                   history.account_data_mode
            FROM replay_account_history_projection AS projection
            JOIN replay_training_account_history AS history USING(run_id)
            WHERE projection.run_id = ? AND projection.track_id = ?
            """,
            (run_id, track_id),
        ).fetchone()
        if (
            projection is None
            or projection["account_data_mode"] != "HISTORICAL_EXACT"
        ):
            return
        if (
            projection["history_status"] != "ACTIVE"
            or projection["status"] != "READY"
            or projection["mark_price"] is None
        ):
            raise TrainingRunError(
                "ACCOUNT_HISTORY_ARCHIVE_DEGRADED",
                "authoritative account mark is unavailable",
                status_code=409,
                details={"track_id": track_id, "fallback_applied": False},
            )
        track = connection.execute(
            """
            SELECT * FROM replay_training_market_track
            WHERE run_id = ? AND track_id = ?
            """,
            (run_id, track_id),
        ).fetchone()
        if track is None:
            raise TypeError("exact account market track is missing")
        rule_row = connection.execute(
            """
            SELECT revision, rule_json FROM replay_training_instrument_rule
            WHERE run_id = ? AND track_id = ?
              AND effective_virtual_time_ms <= COALESCE(?, 0)
            ORDER BY effective_virtual_time_ms DESC, revision DESC LIMIT 1
            """,
            (run_id, track_id, track["virtual_time_ms"]),
        ).fetchone()
        if rule_row is None:
            raise TypeError("exact account instrument rule is missing")
        rule = InstrumentRule.from_mapping(json.loads(str(rule_row["rule_json"])))
        try:
            position = json.loads(str(track["position_json"]))
            account = json.loads(str(track["account_json"]))
            open_orders = json.loads(str(track["open_orders_json"]))
        except json.JSONDecodeError as exc:
            raise TypeError("exact account track projection JSON is invalid") from exc
        if (
            not isinstance(position, dict)
            or not isinstance(account, dict)
            or not isinstance(open_orders, list)
        ):
            raise TypeError("exact account track projection is invalid")
        try:
            mark = Decimal(str(projection["mark_price"]))
            quantity = Decimal(str(position.get("quantity", "0")))
            contract_size = Decimal(rule.contract_size)
            run_row = connection.execute(
                """
                SELECT initial_equity FROM replay_training_run WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if run_row is None:
                raise TypeError("exact account training run is missing")
            exact_realized = sum(
                (
                    Decimal(str(row["cash_delta"]))
                    for row in connection.execute(
                        """
                        SELECT cash_delta
                        FROM replay_training_contract_ledger
                        WHERE run_id = ? AND track_id = ?
                          AND kind = 'BROKER_REALIZED_PNL'
                        """,
                        (run_id, track_id),
                    ).fetchall()
                ),
                Decimal(0),
            )
            broker_fees = Decimal(0)
            for fill_row in connection.execute(
                """
                SELECT fill_json FROM replay_training_contract_fill
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchall():
                fill = json.loads(str(fill_row["fill_json"]))
                if not isinstance(fill, Mapping):
                    raise TypeError("exact account fill projection is invalid")
                broker_fees += Decimal(str(fill["fee"]))
            entry_raw = position.get("entry_price")
            entry = None if entry_raw is None else Decimal(str(entry_raw))
            notional = abs(quantity) * mark * contract_size
            unrealized = (
                Decimal(0)
                if quantity == 0 or entry is None
                else (mark - entry) * quantity * contract_size
            )
            policy_row = connection.execute(
                """
                SELECT max_leverage
                FROM replay_training_leverage_policy
                WHERE run_id = ? AND effective_virtual_time_ms <= ?
                ORDER BY effective_virtual_time_ms DESC, source_sequence DESC,
                         revision DESC LIMIT 1
                """,
                (run_id, int(track["virtual_time_ms"] or 0)),
            ).fetchone()
            if policy_row is None:
                raise TypeError("training leverage policy is missing")
            configured_max = Decimal(str(policy_row["max_leverage"]))
            leverage = min(configured_max, Decimal(rule.max_leverage))
            if leverage <= 0:
                raise ValueError("effective leverage must be positive")
            margin_used = notional / leverage
            reserved = Decimal(0)
            terminal = {"FILLED", "CANCELED", "REJECTED", "EXPIRED"}
            for raw in open_orders:
                if not isinstance(raw, Mapping) or raw.get("status") in terminal:
                    continue
                order_quantity = Decimal(str(raw.get("remaining_quantity") or raw.get("quantity") or "0"))
                reference = raw.get("limit_price") or raw.get("stop_price") or mark
                reserved += (
                    abs(order_quantity)
                    * Decimal(str(reference))
                    * contract_size
                    / leverage
                )
            cash = (
                Decimal(str(run_row["initial_equity"]))
                + exact_realized
                - broker_fees
            )
            equity = cash + unrealized
            available = equity - margin_used - reserved
        except (InvalidOperation, KeyError, TypeError, ValueError) as exc:
            raise TrainingRunError(
                "ACCOUNT_HISTORY_PROJECTION_INVALID",
                "authoritative mark could not reconcile the modelled account",
                status_code=409,
                details={"track_id": track_id, "fallback_applied": False},
            ) from exc
        position.update(
            {
                "mark_price": decimal_to_string(mark, field_name="exact mark"),
                "notional": decimal_to_string(
                    notional, field_name="exact position notional"
                ),
                "realized_pnl": decimal_to_string(
                    exact_realized, field_name="exact realized pnl"
                ),
                "unrealized_pnl": decimal_to_string(
                    unrealized, field_name="exact unrealized pnl"
                ),
            }
        )
        account.update(
            {
                "cash_balance": decimal_to_string(
                    cash, field_name="exact account cash"
                ),
                "equity": decimal_to_string(
                    equity, field_name="exact account equity"
                ),
                "available_equity": decimal_to_string(
                    available, field_name="exact account available"
                ),
                "margin_used": decimal_to_string(
                    margin_used, field_name="exact margin used"
                ),
                "reserved_margin": decimal_to_string(
                    reserved, field_name="exact reserved margin"
                ),
                "realized_pnl": decimal_to_string(
                    exact_realized, field_name="exact account realized pnl"
                ),
                "unrealized_pnl": decimal_to_string(
                    unrealized, field_name="exact account unrealized pnl"
                ),
                "fees_paid": decimal_to_string(
                    broker_fees, field_name="exact broker fees"
                ),
            }
        )
        capabilities = json.loads(str(track["capabilities_json"]))
        if not isinstance(capabilities, dict):
            raise TypeError("exact account capabilities are invalid")
        capabilities.update(
            {
                "HISTORICAL_MARK_INDEX": "AVAILABLE_EXACT",
                "HISTORICAL_INSTRUMENT_RULE": "AVAILABLE_EXACT",
                "SIMULATED_LIQUIDATION": "AVAILABLE_EXACT_INPUTS_MODELLED_ACCOUNT",
            }
        )
        connection.execute(
            """
            UPDATE replay_training_market_track
            SET position_json = ?, account_json = ?, capabilities_json = ?,
                updated_at_ms = ?
            WHERE run_id = ? AND track_id = ?
            """,
            (
                canonical_json(position),
                canonical_json(account),
                canonical_json(capabilities),
                now_ms,
                run_id,
                track_id,
            ),
        )

    async def apply_account_history_events(
        self,
        run_id: str,
        *,
        events: Sequence[tuple[str, AccountHistoryEvent]],
        virtual_time_ms: int,
    ) -> tuple[StableMarketEvent, ...]:
        """Apply one ordered account-input phase with durable idempotency."""

        materialized = tuple(events)
        if not materialized:
            return ()

        def write(connection: sqlite3.Connection) -> tuple[StableMarketEvent, ...]:
            mode = connection.execute(
                """
                SELECT * FROM replay_training_account_history WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if (
                mode is None
                or mode["account_data_mode"] != "HISTORICAL_EXACT"
                or mode["status"] != "ACTIVE"
            ):
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_ARCHIVE_DEGRADED",
                    "exact account history is not active",
                    status_code=409,
                    details={"fallback_applied": False},
                )
            now_ms = self.base_store._validated_now_ms()
            stable: list[StableMarketEvent] = []
            for track_id, event in materialized:
                stable_event = StableMarketEvent(
                    actual_event_time_ms=event.event_time_ms,
                    event_phase=event.event_phase,
                    market_track_stable_id=f"account:{track_id}",
                    source_sequence=event.event_sequence,
                )
                stable.append(stable_event)
                existing = connection.execute(
                    """
                    SELECT 1 FROM replay_account_history_applied_event
                    WHERE run_id = ? AND track_id = ?
                      AND archive_event_sequence = ?
                    """,
                    (run_id, track_id, event.event_sequence),
                ).fetchone()
                if existing is not None:
                    continue
                projection = connection.execute(
                    """
                    SELECT projection.*, track.source_kind,
                           track.source_sequence,
                           ref.bound_range_start_ms,
                           ref.bound_range_end_ms
                    FROM replay_account_history_projection AS projection
                    JOIN replay_training_market_track AS track
                      ON track.run_id = projection.run_id
                     AND track.track_id = projection.track_id
                    JOIN replay_account_history_ref AS ref
                      ON ref.run_id = projection.run_id
                     AND ref.track_id = projection.track_id
                     AND ref.archive_id = projection.archive_id
                     AND ref.active = 1
                    WHERE projection.run_id = ? AND projection.track_id = ?
                    """,
                    (run_id, track_id),
                ).fetchone()
                if projection is None or projection["status"] != "READY":
                    raise TrainingRunError(
                        "ACCOUNT_HISTORY_BINDING_MISSING",
                        "exact account projection is missing",
                        status_code=409,
                        details={
                            "track_id": track_id,
                            "fallback_applied": False,
                        },
                    )
                expected_sequence = int(projection["last_event_sequence"]) + 1
                if event.event_sequence != expected_sequence:
                    raise TrainingRunError(
                        "ACCOUNT_HISTORY_EVENT_GAP",
                        "account event sequence is not contiguous",
                        status_code=409,
                        details={
                            "track_id": track_id,
                            "expected_sequence": expected_sequence,
                            "actual_sequence": event.event_sequence,
                            "fallback_applied": False,
                        },
                    )
                if event.previous_hash != projection["input_chain_hash"]:
                    raise TrainingRunError(
                        "ACCOUNT_HISTORY_EVENT_CHAIN_MISMATCH",
                        "account event no longer follows the pinned input chain",
                        status_code=409,
                        details={"track_id": track_id, "fallback_applied": False},
                    )
                if event.event_kind == "RULE":
                    runtime_rule = runtime_instrument_rule(
                        event.payload,
                        track_id=track_id,
                        source_kind=str(projection["source_kind"]),
                        actual_replay_start_ms=event.event_time_ms,
                        virtual_replay_start_ms=virtual_time_ms,
                    )
                    revision = int(
                        connection.execute(
                            """
                            SELECT COALESCE(MAX(revision), 0) + 1
                            FROM replay_training_instrument_rule
                            WHERE run_id = ? AND track_id = ?
                            """,
                            (run_id, track_id),
                        ).fetchone()[0]
                    )
                    connection.execute(
                        """
                        INSERT INTO replay_training_instrument_rule(
                            run_id, track_id, revision,
                            effective_virtual_time_ms, rule_json, rule_hash,
                            fidelity, created_at_ms
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            run_id,
                            track_id,
                            revision,
                            virtual_time_ms,
                            canonical_json(runtime_rule),
                            canonical_sha256(runtime_rule),
                            "HISTORICAL_EXACT_VERSIONED_EXCHANGE_RULE",
                            now_ms,
                        ),
                    )
                elif event.event_kind == "MARK_INDEX":
                    pass
                elif event.event_kind == "FUNDING":
                    account = connection.execute(
                        """
                        SELECT account.*, run.settlement_asset
                        FROM replay_training_contract_account AS account
                        JOIN replay_training_run AS run USING(run_id)
                        WHERE run_id = ?
                        """,
                        (run_id,),
                    ).fetchone()
                    if account is None:
                        raise TypeError("contract account is missing")
                    if account["funding_mode"] == "HISTORICAL_EXACT":
                        self._settle_exact_funding_event(
                            connection,
                            run_id=run_id,
                            track_id=track_id,
                            event=event,
                            virtual_time_ms=virtual_time_ms,
                            source_sequence=int(
                                projection["source_sequence"] or 0
                            ),
                            settlement_asset=str(account["settlement_asset"]),
                            now_ms=now_ms,
                        )
                else:
                    raise TrainingRunError(
                        "ACCOUNT_HISTORY_EVENT_UNSUPPORTED",
                        "account archive event kind is unsupported",
                        status_code=409,
                    )
                last_rule = (
                    event.component_sequence
                    if event.event_kind == "RULE"
                    else int(projection["last_rule_sequence"])
                )
                last_mark = (
                    event.component_sequence
                    if event.event_kind == "MARK_INDEX"
                    else int(projection["last_mark_sequence"])
                )
                last_funding = (
                    event.component_sequence
                    if event.event_kind == "FUNDING"
                    else int(projection["last_funding_sequence"])
                )
                rule_json = (
                    canonical_json(event.payload)
                    if event.event_kind == "RULE"
                    else projection["current_rule_json"]
                )
                rule_hash = (
                    account_rule_component_hash(event.payload)
                    if event.event_kind == "RULE"
                    else projection["current_rule_hash"]
                )
                mark_price = (
                    event.payload["mark_price"]
                    if event.event_kind == "MARK_INDEX"
                    else projection["mark_price"]
                )
                index_price = (
                    event.payload["index_price"]
                    if event.event_kind == "MARK_INDEX"
                    else projection["index_price"]
                )
                connection.execute(
                    """
                    UPDATE replay_account_history_projection
                    SET last_event_sequence = ?, last_rule_sequence = ?,
                        last_mark_sequence = ?, last_funding_sequence = ?,
                        as_of_actual_time_ms = ?, as_of_virtual_time_ms = ?,
                        current_rule_json = ?, current_rule_hash = ?,
                        mark_price = ?, index_price = ?, input_chain_hash = ?,
                        status = 'READY', degraded_reason = NULL,
                        updated_at_ms = ?
                    WHERE run_id = ? AND track_id = ?
                    """,
                    (
                        event.event_sequence,
                        last_rule,
                        last_mark,
                        last_funding,
                        event.event_time_ms,
                        virtual_time_ms,
                        rule_json,
                        rule_hash,
                        mark_price,
                        index_price,
                        event.event_hash,
                        now_ms,
                        run_id,
                        track_id,
                    ),
                )
                applied_hash = canonical_sha256(
                    {
                        "run_id": run_id,
                        "track_id": track_id,
                        "virtual_time_ms": virtual_time_ms,
                        "event": {
                            "archive_id": event.archive_id,
                            "event_sequence": event.event_sequence,
                            "event_time_ms": event.event_time_ms,
                            "event_phase": event.event_phase,
                            "event_kind": event.event_kind,
                            "component_sequence": event.component_sequence,
                            "event_hash": event.event_hash,
                            "payload": dict(event.payload),
                        },
                    }
                )
                connection.execute(
                    """
                    INSERT INTO replay_account_history_applied_event(
                        run_id, track_id, archive_id, archive_event_sequence,
                        event_time_ms, event_phase, event_kind,
                        component_sequence, archive_event_hash,
                        applied_payload_hash, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        track_id,
                        event.archive_id,
                        event.event_sequence,
                        event.event_time_ms,
                        event.event_phase,
                        event.event_kind,
                        event.component_sequence,
                        event.event_hash,
                        applied_hash,
                        now_ms,
                    ),
                )
            return stable_market_event_order(stable)

        return await self.base_store.run_extension_write(write)

    @classmethod
    def _settle_exact_funding_event(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        track_id: str,
        event: AccountHistoryEvent,
        virtual_time_ms: int,
        source_sequence: int,
        settlement_asset: str,
        now_ms: int,
    ) -> None:
        existing = connection.execute(
            """
            SELECT 1 FROM replay_training_funding_settlement
            WHERE run_id = ? AND track_id = ? AND settlement_time_ms = ?
            """,
            (run_id, track_id, virtual_time_ms),
        ).fetchone()
        if existing is not None:
            return
        track = connection.execute(
            """
            SELECT position_json FROM replay_training_market_track
            WHERE run_id = ? AND track_id = ?
            """,
            (run_id, track_id),
        ).fetchone()
        rule_row = connection.execute(
            """
            SELECT revision, rule_json FROM replay_training_instrument_rule
            WHERE run_id = ? AND track_id = ?
              AND effective_virtual_time_ms <= ?
            ORDER BY effective_virtual_time_ms DESC, revision DESC LIMIT 1
            """,
            (run_id, track_id, virtual_time_ms),
        ).fetchone()
        if track is None or rule_row is None:
            raise TypeError("exact funding inputs are missing")
        position = json.loads(str(track["position_json"]))
        if not isinstance(position, dict):
            raise TypeError("exact funding position is invalid")
        rule = InstrumentRule.from_mapping(json.loads(str(rule_row["rule_json"])))
        quantity = Decimal(str(position.get("quantity", "0")))
        mark = Decimal(str(event.payload["mark_price"]))
        rate = Decimal(str(event.payload["funding_rate"]))
        raw = -(quantity * mark * Decimal(rule.contract_size) * rate)
        rounded = round_to_step(
            abs(raw),
            Decimal(rule.quote_step),
            upward=True,
        )
        cash_delta = rounded.copy_sign(raw) if raw else Decimal(0)
        ledger_sequence = cls._append_contract_ledger(
            connection,
            run_id=run_id,
            posting_id=f"exact-funding:{track_id}:{event.event_time_ms}",
            track_id=track_id,
            kind="FUNDING_SETTLEMENT",
            cash_delta=cash_delta,
            asset=settlement_asset,
            virtual_time_ms=virtual_time_ms,
            source_sequence=source_sequence,
            fidelity="HISTORICAL_EXACT_ARCHIVE_FUNDING",
            rule_revision=int(rule_row["revision"]),
            reference_type="ACCOUNT_ARCHIVE_EVENT",
            reference_id=f"{event.archive_id}:{event.event_sequence}",
            metadata={
                "archive_id": event.archive_id,
                "archive_event_sequence": event.event_sequence,
                "actual_settlement_time_ms": event.event_time_ms,
                "rate": str(event.payload["funding_rate"]),
                "mark_price": str(event.payload["mark_price"]),
                "contract_size": rule.contract_size,
                "rounding": "ABS_CEILING_QUOTE_STEP_THEN_SIGN",
            },
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
                track_id,
                virtual_time_ms,
                decimal_to_string(quantity, field_name="funding quantity"),
                str(event.payload["mark_price"]),
                str(event.payload["funding_rate"]),
                decimal_to_string(cash_delta, field_name="funding cash delta"),
                "HISTORICAL_EXACT_ARCHIVE_FUNDING",
                ledger_sequence,
                now_ms,
            ),
        )
        account = connection.execute(
            """
            SELECT overlay_cash FROM replay_training_contract_account
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        overlay = Decimal(str(account["overlay_cash"])) + cash_delta
        connection.execute(
            """
            UPDATE replay_training_contract_account
            SET overlay_cash = ?, updated_at_ms = ? WHERE run_id = ?
            """,
            (
                decimal_to_string(overlay, field_name="overlay cash"),
                now_ms,
                run_id,
            ),
        )

    async def pending_account_global_events(
        self,
        run_id: str,
    ) -> tuple[StableMarketEvent, ...]:
        def read(connection: sqlite3.Connection) -> tuple[StableMarketEvent, ...]:
            rows = connection.execute(
                """
                SELECT applied.track_id, applied.archive_event_sequence,
                       applied.event_time_ms, applied.event_phase
                FROM replay_account_history_applied_event AS applied
                LEFT JOIN replay_training_global_event AS global_event
                  ON global_event.run_id = applied.run_id
                 AND global_event.track_id = 'account:' || applied.track_id
                 AND global_event.source_sequence =
                     applied.archive_event_sequence
                WHERE applied.run_id = ? AND global_event.global_sequence IS NULL
                ORDER BY applied.event_time_ms, applied.event_phase,
                         applied.track_id, applied.archive_event_sequence
                """,
                (run_id,),
            ).fetchall()
            return tuple(
                StableMarketEvent(
                    actual_event_time_ms=int(row["event_time_ms"]),
                    event_phase=int(row["event_phase"]),
                    market_track_stable_id=f"account:{row['track_id']}",
                    source_sequence=int(row["archive_event_sequence"]),
                )
                for row in rows
            )

        return await self.base_store.run_extension_read(read)

    async def audit_account(
        self,
        run_id: str,
        *,
        authoritative_projections: (
            Mapping[str, Mapping[str, object]] | None
        ) = None,
    ) -> dict[str, object]:
        def write(connection: sqlite3.Connection) -> dict[str, object]:
            return self._write_account_audit(
                connection,
                run_id=run_id,
                now_ms=self.base_store._validated_now_ms(),
                authoritative_projections=authoritative_projections,
            )

        return await self.base_store.run_extension_write(write)

    async def finalize_account_history(
        self,
        run_id: str,
        *,
        write_audit: bool = True,
        risk_virtual_time_ms: int | None = None,
    ) -> dict[str, object] | None:
        """Reapply authoritative marks, run risk, and emit an independent audit."""

        def write(connection: sqlite3.Connection) -> dict[str, object] | None:
            history = connection.execute(
                """
                SELECT account_data_mode, status
                FROM replay_training_account_history WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if history is None or history["account_data_mode"] != "HISTORICAL_EXACT":
                return None
            if history["status"] != "ACTIVE":
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_ARCHIVE_DEGRADED",
                    "exact account history is not active",
                    status_code=409,
                    details={"fallback_applied": False},
                )
            now_ms = self.base_store._validated_now_ms()
            rows = connection.execute(
                """
                SELECT track_id FROM replay_training_market_track
                WHERE run_id = ? AND subscription_tier = 'FULL'
                ORDER BY stable_ordinal, track_id
                """,
                (run_id,),
            ).fetchall()
            for row in rows:
                self._apply_exact_mark_projection(
                    connection,
                    run_id=run_id,
                    track_id=str(row["track_id"]),
                    now_ms=now_ms,
                )
            self._detect_contract_liquidations(
                connection,
                run_id=run_id,
                now_ms=now_ms,
                trigger_virtual_time_ms=risk_virtual_time_ms,
            )
            self._refresh_contract_current_equity(
                connection,
                run_id=run_id,
                now_ms=now_ms,
            )
            if not write_audit:
                return None
            return self._write_account_audit(
                connection,
                run_id=run_id,
                now_ms=now_ms,
            )

        return await self.base_store.run_extension_write(write)

    @classmethod
    def _audit_exact_account_state(
        cls,
        connection: sqlite3.Connection,
        *,
        run: sqlite3.Row,
        account: sqlite3.Row,
        ledger_rows: Sequence[sqlite3.Row],
        portfolio: Mapping[str, object],
        differences: list[dict[str, object]],
    ) -> dict[str, object]:
        """Independently rebuild exact account state from immutable source records."""

        run_id = str(run["run_id"])

        def add_difference(
            field: str,
            expected: object,
            actual: object,
        ) -> None:
            differences.append(
                {
                    "field": field,
                    "expected": expected,
                    "actual": actual,
                }
            )

        def compare_decimal(
            field: str,
            expected: Decimal,
            actual: object,
        ) -> None:
            expected_value = decimal_to_string(expected, field_name=field)
            try:
                actual_decimal = Decimal(str(actual))
            except (InvalidOperation, TypeError, ValueError):
                add_difference(field, expected_value, actual)
                return
            if actual_decimal != expected:
                add_difference(field, expected_value, actual)

        rule_rows = connection.execute(
            """
            SELECT * FROM replay_training_instrument_rule
            WHERE run_id = ? ORDER BY track_id, revision
            """,
            (run_id,),
        ).fetchall()
        rules: dict[tuple[str, int], InstrumentRule] = {}
        rule_times: dict[tuple[str, int], int] = {}
        for row in rule_rows:
            key = (str(row["track_id"]), int(row["revision"]))
            try:
                rule = InstrumentRule.from_mapping(
                    json.loads(str(row["rule_json"]))
                )
            except (json.JSONDecodeError, TypeError, ValueError) as exc:
                add_difference(
                    f"instrument_rule[{key[0]}:{key[1]}]",
                    "VALID_VERSIONED_RULE",
                    f"INVALID:{type(exc).__name__}",
                )
                continue
            rules[key] = rule
            rule_times[key] = int(row["effective_virtual_time_ms"])
            if rule.rule_hash != row["rule_hash"]:
                add_difference(
                    f"instrument_rule[{key[0]}:{key[1]}].rule_hash",
                    rule.rule_hash,
                    row["rule_hash"],
                )

        policy_rows = connection.execute(
            """
            SELECT * FROM replay_training_fee_policy
            WHERE run_id = ? ORDER BY revision
            """,
            (run_id,),
        ).fetchall()
        policies: dict[int, sqlite3.Row] = {}
        for row in policy_rows:
            revision = int(row["revision"])
            policies[revision] = row
            policy_payload = {
                "schema_version": "replay.training.fee-policy.v1",
                "run_id": run_id,
                "revision": revision,
                "effective_virtual_time_ms": int(
                    row["effective_virtual_time_ms"]
                ),
                "maker_fee_bps": str(row["maker_fee_bps"]),
                "taker_fee_bps": str(row["taker_fee_bps"]),
                "fidelity": str(row["fidelity"]),
            }
            policy_hash = canonical_sha256(policy_payload)
            if policy_hash != row["policy_hash"]:
                add_difference(
                    f"fee_policy[{revision}].policy_hash",
                    policy_hash,
                    row["policy_hash"],
                )

        ledger_by_posting = {
            str(row["posting_id"]): row for row in ledger_rows
        }
        ledger_by_sequence = {
            int(row["ledger_sequence"]): row for row in ledger_rows
        }
        expected_postings: set[str] = set()
        initial = Decimal(str(run["initial_equity"]))
        settlement_asset = str(run["settlement_asset"])
        initial_posting = ledger_by_posting.get("initial-capital")
        if initial_posting is None:
            add_difference("ledger.initial-capital", "PRESENT", "MISSING")
        else:
            expected_postings.add("initial-capital")
            compare_decimal(
                "ledger.initial-capital.cash_delta",
                initial,
                initial_posting["cash_delta"],
            )
            if initial_posting["asset"] != settlement_asset:
                add_difference(
                    "ledger.initial-capital.asset",
                    settlement_asset,
                    initial_posting["asset"],
                )

        fill_rows = connection.execute(
            """
            SELECT * FROM replay_training_contract_fill
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchall()
        fills: list[tuple[sqlite3.Row, Mapping[str, object]]] = []
        for row in fill_rows:
            try:
                raw = json.loads(str(row["fill_json"]))
            except json.JSONDecodeError as exc:
                add_difference(
                    f"fill[{row['track_id']}:{row['fill_id']}].json",
                    "VALID_JSON_OBJECT",
                    f"INVALID:{type(exc).__name__}",
                )
                continue
            if not isinstance(raw, Mapping):
                add_difference(
                    f"fill[{row['track_id']}:{row['fill_id']}].json",
                    "JSON_OBJECT",
                    type(raw).__name__,
                )
                continue
            fills.append((row, raw))
        fills.sort(
            key=lambda item: (
                int(item[1].get("event_time_ms", 0)),
                int(item[1].get("source_sequence", 0)),
                str(item[0]["track_id"]),
                str(item[0]["fill_id"]),
            )
        )

        position_state: dict[str, dict[str, Decimal | None]] = {}
        broker_fees_by_track: dict[str, Decimal] = {}
        configured_fees = Decimal(0)
        realized_total = Decimal(0)
        realized_by_fill: dict[tuple[str, str], Decimal] = {}

        def apply_fill(
            *,
            state: dict[str, Decimal | None],
            side: str,
            quantity: Decimal,
            price: Decimal,
            contract_size: Decimal,
        ) -> Decimal:
            old_quantity = cast(Decimal, state["quantity"])
            old_entry = cast(Decimal | None, state["entry_price"])
            delta = quantity if side == "BUY" else -quantity
            new_quantity = old_quantity + delta
            realized = Decimal(0)
            with localcontext() as context:
                context.prec = 60
                if old_quantity == 0:
                    new_entry: Decimal | None = price
                elif old_quantity * delta > 0:
                    if old_entry is None:
                        raise TypeError("non-flat audited position has no entry")
                    new_entry = (
                        abs(old_quantity) * old_entry + abs(delta) * price
                    ) / abs(new_quantity)
                else:
                    if old_entry is None:
                        raise TypeError("non-flat audited position has no entry")
                    closed = min(abs(old_quantity), abs(delta))
                    realized = (
                        (price - old_entry)
                        * closed
                        * (Decimal(1) if old_quantity > 0 else Decimal(-1))
                        * contract_size
                    )
                    if new_quantity == 0:
                        new_entry = None
                    elif old_quantity * new_quantity > 0:
                        new_entry = old_entry
                    else:
                        new_entry = price
            state["quantity"] = new_quantity
            state["entry_price"] = new_entry
            state["realized_pnl"] = (
                cast(Decimal, state["realized_pnl"]) + realized
            )
            return realized

        for row, raw in fills:
            track_id = str(row["track_id"])
            fill_id = str(row["fill_id"])
            field_prefix = f"fill[{track_id}:{fill_id}]"
            rule_revision = int(row["rule_revision"])
            fee_revision = int(row["fee_policy_revision"])
            rule = rules.get((track_id, rule_revision))
            policy = policies.get(fee_revision)
            if rule is None:
                add_difference(
                    f"{field_prefix}.rule_revision",
                    "EXISTING_RULE",
                    rule_revision,
                )
                continue
            if policy is None:
                add_difference(
                    f"{field_prefix}.fee_policy_revision",
                    "EXISTING_POLICY",
                    fee_revision,
                )
                continue
            try:
                quantity = Decimal(str(raw["quantity"]))
                price = Decimal(str(raw["price"]))
                broker_notional = Decimal(str(raw["notional"]))
                contract_size = Decimal(rule.contract_size)
                account_notional = quantity * price * contract_size
                if broker_notional != quantity * price:
                    compare_decimal(
                        f"{field_prefix}.notional",
                        quantity * price,
                        raw["notional"],
                    )
                compare_decimal(
                    f"{field_prefix}.account_notional",
                    account_notional,
                    raw.get("account_notional"),
                )
                if raw.get("contract_size") != rule.contract_size:
                    add_difference(
                        f"{field_prefix}.contract_size",
                        rule.contract_size,
                        raw.get("contract_size"),
                    )
                configured_fee = fee_for_notional(
                    notional=account_notional,
                    liquidity=str(raw["liquidity"]),
                    maker_bps=str(policy["maker_fee_bps"]),
                    taker_bps=str(policy["taker_fee_bps"]),
                    quote_step=rule.quote_step,
                )
                compare_decimal(
                    f"{field_prefix}.configured_fee",
                    configured_fee,
                    row["configured_fee"],
                )
                configured_fees += configured_fee
                broker_fee = Decimal(str(raw["fee"]))
                broker_fees_by_track[track_id] = (
                    broker_fees_by_track.get(track_id, Decimal(0))
                    + broker_fee
                )
                state = position_state.setdefault(
                    track_id,
                    {
                        "quantity": Decimal(0),
                        "entry_price": None,
                        "realized_pnl": Decimal(0),
                    },
                )
                realized = apply_fill(
                    state=state,
                    side=str(raw["side"]),
                    quantity=quantity,
                    price=price,
                    contract_size=contract_size,
                )
                realized_total += realized
                realized_by_fill[(track_id, fill_id)] = realized
            except (InvalidOperation, KeyError, TypeError, ValueError) as exc:
                add_difference(
                    field_prefix,
                    "VALID_REPLAY_FILL",
                    f"INVALID:{type(exc).__name__}",
                )
                continue

            fee_posting_id = f"fee:{track_id}:{fill_id}"
            fee_posting = ledger_by_posting.get(fee_posting_id)
            if fee_posting is None:
                add_difference(
                    f"ledger[{fee_posting_id}]",
                    "PRESENT",
                    "MISSING",
                )
            else:
                expected_postings.add(fee_posting_id)
                compare_decimal(
                    f"ledger[{fee_posting_id}].cash_delta",
                    -configured_fee,
                    fee_posting["cash_delta"],
                )
                if int(fee_posting["rule_revision"]) != rule_revision:
                    add_difference(
                        f"ledger[{fee_posting_id}].rule_revision",
                        rule_revision,
                        int(fee_posting["rule_revision"]),
                    )

        realized_ledger_by_fill: dict[
            tuple[str, str], list[sqlite3.Row]
        ] = {}
        for row in ledger_rows:
            if row["kind"] != "BROKER_REALIZED_PNL":
                continue
            try:
                metadata = json.loads(str(row["metadata_json"]))
            except json.JSONDecodeError:
                metadata = None
            fill_id = (
                metadata.get("fill_id")
                if isinstance(metadata, Mapping)
                else None
            )
            if isinstance(fill_id, str) and isinstance(row["track_id"], str):
                realized_ledger_by_fill.setdefault(
                    (str(row["track_id"]), fill_id),
                    [],
                ).append(row)
        for key, realized in realized_by_fill.items():
            postings = realized_ledger_by_fill.get(key, [])
            if realized == 0:
                if postings:
                    add_difference(
                        f"realized_ledger[{key[0]}:{key[1]}].count",
                        0,
                        len(postings),
                    )
                continue
            if len(postings) != 1:
                add_difference(
                    f"realized_ledger[{key[0]}:{key[1]}].count",
                    1,
                    len(postings),
                )
                continue
            posting = postings[0]
            posting_id = str(posting["posting_id"])
            expected_postings.add(posting_id)
            compare_decimal(
                f"ledger[{posting_id}].cash_delta",
                realized,
                posting["cash_delta"],
            )

        funding_total = Decimal(0)
        funding_rows = connection.execute(
            """
            SELECT * FROM replay_training_funding_settlement
            WHERE run_id = ? ORDER BY settlement_time_ms, track_id
            """,
            (run_id,),
        ).fetchall()
        for row in funding_rows:
            track_id = str(row["track_id"])
            field_prefix = (
                f"funding[{track_id}:{int(row['settlement_time_ms'])}]"
            )
            ledger = ledger_by_sequence.get(int(row["ledger_sequence"]))
            if ledger is None:
                add_difference(
                    f"{field_prefix}.ledger_sequence",
                    "LINKED_LEDGER_ENTRY",
                    int(row["ledger_sequence"]),
                )
                continue
            posting_id = str(ledger["posting_id"])
            expected_postings.add(posting_id)
            rule = rules.get((track_id, int(ledger["rule_revision"])))
            if rule is None:
                add_difference(
                    f"{field_prefix}.rule_revision",
                    "EXISTING_RULE",
                    int(ledger["rule_revision"]),
                )
                continue
            try:
                quantity = Decimal(str(row["position_quantity"]))
                mark = Decimal(str(row["mark_price"]))
                rate = Decimal(str(row["funding_rate"]))
                raw_delta = (
                    -quantity * mark * Decimal(rule.contract_size) * rate
                )
                rounded = round_to_step(
                    abs(raw_delta),
                    Decimal(rule.quote_step),
                    upward=True,
                )
                expected_delta = (
                    rounded.copy_sign(raw_delta)
                    if raw_delta
                    else Decimal(0)
                )
            except (InvalidOperation, TypeError, ValueError) as exc:
                add_difference(
                    field_prefix,
                    "VALID_EXACT_FUNDING",
                    f"INVALID:{type(exc).__name__}",
                )
                continue
            compare_decimal(
                f"{field_prefix}.cash_delta",
                expected_delta,
                row["cash_delta"],
            )
            compare_decimal(
                f"ledger[{posting_id}].cash_delta",
                expected_delta,
                ledger["cash_delta"],
            )
            if ledger["kind"] != "FUNDING_SETTLEMENT":
                add_difference(
                    f"ledger[{posting_id}].kind",
                    "FUNDING_SETTLEMENT",
                    ledger["kind"],
                )
            funding_total += expected_delta

        allocation_state: dict[str, Decimal] = {}
        for row in ledger_rows:
            if row["kind"] not in {"MARGIN_ALLOCATION", "MARGIN_RELEASE"}:
                continue
            expected_postings.add(str(row["posting_id"]))
            compare_decimal(
                f"ledger[{row['posting_id']}].cash_delta",
                Decimal(0),
                row["cash_delta"],
            )
            track_id = row["track_id"]
            if not isinstance(track_id, str):
                add_difference(
                    f"ledger[{row['posting_id']}].track_id",
                    "TRACK_ID",
                    track_id,
                )
                continue
            try:
                metadata = json.loads(str(row["metadata_json"]))
            except json.JSONDecodeError:
                metadata = None
            target = (
                metadata.get("new_allocation")
                if isinstance(metadata, Mapping)
                else None
            )
            if target is None:
                allocation_state.pop(track_id, None)
                continue
            try:
                amount = Decimal(str(target))
            except (InvalidOperation, TypeError, ValueError):
                add_difference(
                    f"ledger[{row['posting_id']}].new_allocation",
                    "DECIMAL",
                    target,
                )
                continue
            if amount == 0:
                allocation_state.pop(track_id, None)
            else:
                allocation_state[track_id] = amount

        liquidation_total = Decimal(0)
        liquidation_rows = connection.execute(
            """
            SELECT * FROM replay_training_liquidation_event
            WHERE run_id = ? ORDER BY trigger_virtual_time_ms, liquidation_id
            """,
            (run_id,),
        ).fetchall()
        pending_liquidations = 0
        bankrupt = False
        for row in liquidation_rows:
            liquidation_id = str(row["liquidation_id"])
            track_id = str(row["track_id"])
            field_prefix = f"liquidation[{liquidation_id}]"
            rule_candidates = [
                (key, rule)
                for key, rule in rules.items()
                if key[0] == track_id
                and rule_times[key] <= int(row["trigger_virtual_time_ms"])
            ]
            rule = (
                None
                if not rule_candidates
                else max(
                    rule_candidates,
                    key=lambda item: (rule_times[item[0]], item[0][1]),
                )[1]
            )
            if rule is None:
                add_difference(
                    f"{field_prefix}.rule",
                    "ACTIVE_RULE",
                    "MISSING",
                )
                continue
            try:
                notional = Decimal(str(row["position_notional"]))
                expected_maintenance = rule.maintenance_margin(notional)
                expected_fee = rule.liquidation_fee(notional)
            except (InvalidOperation, TypeError, ValueError) as exc:
                add_difference(
                    field_prefix,
                    "VALID_LIQUIDATION_INPUTS",
                    f"INVALID:{type(exc).__name__}",
                )
                continue
            compare_decimal(
                f"{field_prefix}.maintenance_margin",
                expected_maintenance,
                row["maintenance_margin"],
            )
            compare_decimal(
                f"{field_prefix}.liquidation_fee",
                expected_fee,
                row["liquidation_fee"],
            )
            try:
                trigger_state: dict[str, Decimal | None] = {
                    "quantity": Decimal(0),
                    "entry_price": None,
                    "realized_pnl": Decimal(0),
                }
                close_order_id = row["close_order_id"]
                for fill_row, raw_fill in fills:
                    if str(fill_row["track_id"]) != track_id:
                        continue
                    if (
                        isinstance(close_order_id, str)
                        and raw_fill.get("order_id") == close_order_id
                    ):
                        continue
                    if int(raw_fill.get("event_time_ms", 0)) > int(
                        row["trigger_virtual_time_ms"]
                    ):
                        continue
                    fill_rule = rules.get(
                        (track_id, int(fill_row["rule_revision"]))
                    )
                    if fill_rule is None:
                        raise TypeError("liquidation fill rule is missing")
                    apply_fill(
                        state=trigger_state,
                        side=str(raw_fill["side"]),
                        quantity=Decimal(str(raw_fill["quantity"])),
                        price=Decimal(str(raw_fill["price"])),
                        contract_size=Decimal(fill_rule.contract_size),
                    )
                trigger_quantity = cast(
                    Decimal, trigger_state["quantity"]
                )
                trigger_entry = cast(
                    Decimal | None, trigger_state["entry_price"]
                )
                if trigger_quantity == 0 or trigger_entry is None:
                    raise ValueError(
                        "liquidation trigger has no reconstructed position"
                    )
                compare_decimal(
                    f"{field_prefix}.position_quantity",
                    trigger_quantity,
                    row["position_quantity"],
                )
                trigger_mark = Decimal(str(row["mark_price"]))
                trigger_notional = (
                    abs(trigger_quantity)
                    * trigger_mark
                    * Decimal(rule.contract_size)
                )
                compare_decimal(
                    f"{field_prefix}.position_notional",
                    trigger_notional,
                    row["position_notional"],
                )
                if account["margin_mode"] == "CROSS":
                    liquidation_allocation = Decimal(
                        str(row["account_equity_before"])
                    )
                else:
                    liquidation_allocation = Decimal(0)
                    for ledger_row in ledger_rows:
                        if (
                            ledger_row["track_id"] != track_id
                            or ledger_row["kind"]
                            not in {"MARGIN_ALLOCATION", "MARGIN_RELEASE"}
                            or int(ledger_row["virtual_time_ms"])
                            > int(row["trigger_virtual_time_ms"])
                        ):
                            continue
                        metadata = json.loads(
                            str(ledger_row["metadata_json"])
                        )
                        target = (
                            metadata.get("new_allocation")
                            if isinstance(metadata, Mapping)
                            else None
                        )
                        liquidation_allocation = (
                            Decimal(0)
                            if target is None
                            else Decimal(str(target))
                        )
                expected_bankruptcy = trigger_entry - (
                    liquidation_allocation
                    / (
                        abs(trigger_quantity)
                        * Decimal(rule.contract_size)
                    )
                ) * (
                    Decimal(1)
                    if trigger_quantity > 0
                    else Decimal(-1)
                )
                expected_bankruptcy = max(
                    Decimal(0), expected_bankruptcy
                )
                compare_decimal(
                    f"{field_prefix}.bankruptcy_price",
                    expected_bankruptcy,
                    row["bankruptcy_price"],
                )
            except (
                InvalidOperation,
                json.JSONDecodeError,
                KeyError,
                TypeError,
                ValueError,
            ) as exc:
                add_difference(
                    f"{field_prefix}.bankruptcy_reconstruction",
                    "RECONSTRUCTABLE_FROM_FILLS_AND_MARGIN",
                    f"INVALID:{type(exc).__name__}",
                )
            if row["state"] == "PENDING":
                pending_liquidations += 1
            elif row["state"] == "COMPLETED":
                posting_id = f"liquidation-fee:{liquidation_id}"
                posting = ledger_by_posting.get(posting_id)
                if posting is None:
                    add_difference(
                        f"ledger[{posting_id}]",
                        "PRESENT",
                        "MISSING",
                    )
                else:
                    expected_postings.add(posting_id)
                    compare_decimal(
                        f"ledger[{posting_id}].cash_delta",
                        -expected_fee,
                        posting["cash_delta"],
                    )
                liquidation_total -= expected_fee
                try:
                    bankrupt = bankrupt or (
                        row["account_equity_after"] is not None
                        and Decimal(str(row["account_equity_after"])) < 0
                    )
                except (InvalidOperation, TypeError, ValueError):
                    add_difference(
                        f"{field_prefix}.account_equity_after",
                        "DECIMAL_OR_NULL",
                        row["account_equity_after"],
                    )

        for row in ledger_rows:
            posting_id = str(row["posting_id"])
            if row["kind"] == "POLICY_REVISION":
                expected_postings.add(posting_id)
                compare_decimal(
                    f"ledger[{posting_id}].cash_delta",
                    Decimal(0),
                    row["cash_delta"],
                )
            if posting_id not in expected_postings and Decimal(
                str(row["cash_delta"])
            ) != 0:
                add_difference(
                    f"ledger[{posting_id}].source_link",
                    "SOURCE_BACKED_POSTING",
                    str(row["kind"]),
                )

        raw_tracks = connection.execute(
            """
            SELECT * FROM replay_training_market_track
            WHERE run_id = ? ORDER BY stable_ordinal, track_id
            """,
            (run_id,),
        ).fetchall()
        projections = {
            str(row["track_id"]): row
            for row in connection.execute(
                """
                SELECT * FROM replay_account_history_projection
                WHERE run_id = ?
                """,
                (run_id,),
            ).fetchall()
        }
        active_rule_policy = connection.execute(
            """
            SELECT max_leverage
            FROM replay_training_leverage_policy
            WHERE run_id = ?
            ORDER BY effective_virtual_time_ms DESC, source_sequence DESC,
                     revision DESC LIMIT 1
            """,
            (run_id,),
        ).fetchone()
        if active_rule_policy is None:
            raise TypeError("training leverage policy is missing")
        configured_max_leverage = Decimal(str(active_rule_policy["max_leverage"]))
        expected_unrealized = Decimal(0)
        expected_margin = Decimal(0)
        expected_reserved = Decimal(0)
        expected_maintenance = Decimal(0)
        per_track: list[dict[str, object]] = []
        for track in raw_tracks:
            track_id = str(track["track_id"])
            if track["subscription_tier"] != "FULL":
                continue
            state = position_state.get(
                track_id,
                {
                    "quantity": Decimal(0),
                    "entry_price": None,
                    "realized_pnl": Decimal(0),
                },
            )
            quantity = cast(Decimal, state["quantity"])
            entry = cast(Decimal | None, state["entry_price"])
            realized = cast(Decimal, state["realized_pnl"])
            current_rules = [
                (key, rule)
                for key, rule in rules.items()
                if key[0] == track_id
                and rule_times[key] <= int(track["virtual_time_ms"] or 0)
            ]
            active_rule = (
                None
                if not current_rules
                else max(
                    current_rules,
                    key=lambda item: (rule_times[item[0]], item[0][1]),
                )[1]
            )
            projection = projections.get(track_id)
            if active_rule is None or projection is None:
                add_difference(
                    f"track[{track_id}].exact_inputs",
                    "ACTIVE_RULE_AND_MARK_PROJECTION",
                    "MISSING",
                )
                continue
            if projection["status"] != "READY" or projection["mark_price"] is None:
                add_difference(
                    f"track[{track_id}].mark",
                    "READY_AUTHORITATIVE_MARK",
                    f"{projection['status']}:{projection['mark_price']}",
                )
                continue
            mark = Decimal(str(projection["mark_price"]))
            contract_size = Decimal(active_rule.contract_size)
            notional = abs(quantity) * mark * contract_size
            unrealized = (
                Decimal(0)
                if quantity == 0 or entry is None
                else (mark - entry) * quantity * contract_size
            )
            leverage = min(
                configured_max_leverage,
                Decimal(active_rule.max_leverage),
            )
            margin = notional / leverage
            maintenance = active_rule.maintenance_margin(notional)
            open_orders = json.loads(str(track["open_orders_json"]))
            reserved = Decimal(0)
            if not isinstance(open_orders, list):
                add_difference(
                    f"track[{track_id}].open_orders",
                    "JSON_ARRAY",
                    type(open_orders).__name__,
                )
                open_orders = []
            for order in open_orders:
                if not isinstance(order, Mapping) or order.get("status") in {
                    "FILLED",
                    "CANCELED",
                    "REJECTED",
                    "EXPIRED",
                }:
                    continue
                order_quantity = Decimal(
                    str(
                        order.get("remaining_quantity")
                        or order.get("quantity")
                        or "0"
                    )
                )
                reference = (
                    order.get("limit_price")
                    or order.get("stop_price")
                    or mark
                )
                reserved += (
                    abs(order_quantity)
                    * Decimal(str(reference))
                    * contract_size
                    / leverage
                )
            expected_unrealized += unrealized
            expected_margin += margin
            expected_reserved += reserved
            expected_maintenance += maintenance
            expected_track_cash = (
                initial
                + realized
                - broker_fees_by_track.get(track_id, Decimal(0))
            )
            position = json.loads(str(track["position_json"]))
            track_account = json.loads(str(track["account_json"]))
            if not isinstance(position, Mapping) or not isinstance(
                track_account, Mapping
            ):
                add_difference(
                    f"track[{track_id}].projection",
                    "POSITION_AND_ACCOUNT_OBJECTS",
                    "INVALID",
                )
                continue
            compare_decimal(
                f"track[{track_id}].position.quantity",
                quantity,
                position.get("quantity"),
            )
            expected_entry = (
                None
                if entry is None
                else decimal_to_string(entry, field_name="audited entry")
            )
            if (
                position.get("entry_price") is not None
                or expected_entry is not None
            ) and str(position.get("entry_price")) != str(expected_entry):
                add_difference(
                    f"track[{track_id}].position.entry_price",
                    expected_entry,
                    position.get("entry_price"),
                )
            for field, expected, actual in (
                ("mark_price", mark, position.get("mark_price")),
                ("notional", notional, position.get("notional")),
                ("realized_pnl", realized, position.get("realized_pnl")),
                (
                    "unrealized_pnl",
                    unrealized,
                    position.get("unrealized_pnl"),
                ),
                (
                    "cash_balance",
                    expected_track_cash,
                    track_account.get("cash_balance"),
                ),
                (
                    "equity",
                    expected_track_cash + unrealized,
                    track_account.get("equity"),
                ),
                ("margin_used", margin, track_account.get("margin_used")),
                (
                    "reserved_margin",
                    reserved,
                    track_account.get("reserved_margin"),
                ),
                (
                    "available_equity",
                    expected_track_cash + unrealized - margin - reserved,
                    track_account.get("available_equity"),
                ),
                (
                    "realized_pnl",
                    realized,
                    track_account.get("realized_pnl"),
                ),
                (
                    "unrealized_pnl",
                    unrealized,
                    track_account.get("unrealized_pnl"),
                ),
                (
                    "fees_paid",
                    broker_fees_by_track.get(track_id, Decimal(0)),
                    track_account.get("fees_paid"),
                ),
            ):
                compare_decimal(
                    f"track[{track_id}].{field}",
                    expected,
                    actual,
                )
            per_track.append(
                {
                    "track_id": track_id,
                    "quantity": decimal_to_string(
                        quantity, field_name="audited quantity"
                    ),
                    "entry_price": expected_entry,
                    "mark_price": decimal_to_string(
                        mark, field_name="audited mark"
                    ),
                    "realized_pnl": decimal_to_string(
                        realized, field_name="audited realized pnl"
                    ),
                    "unrealized_pnl": decimal_to_string(
                        unrealized, field_name="audited unrealized pnl"
                    ),
                    "notional": decimal_to_string(
                        notional, field_name="audited notional"
                    ),
                    "margin_used": decimal_to_string(
                        margin, field_name="audited margin"
                    ),
                    "maintenance_margin": decimal_to_string(
                        maintenance, field_name="audited maintenance"
                    ),
                }
            )

        expected_cash = (
            initial
            + realized_total
            - configured_fees
            + funding_total
            + liquidation_total
        )
        expected_equity = expected_cash + expected_unrealized
        expected_available = (
            expected_equity - expected_margin - expected_reserved
            if account["margin_mode"] == "CROSS"
            else expected_equity
            - sum(allocation_state.values(), Decimal(0))
        )
        expected_overlay = (
            sum(broker_fees_by_track.values(), Decimal(0))
            - configured_fees
            + funding_total
            + liquidation_total
        )
        expected_status = (
            "LIQUIDATING"
            if pending_liquidations
            else "BANKRUPT"
            if bankrupt
            else "ACTIVE"
        )
        compare_decimal(
            "contract_account.overlay_cash",
            expected_overlay,
            account["overlay_cash"],
        )
        expected_allocations = {
            key: decimal_to_string(value, field_name="audited allocation")
            for key, value in sorted(allocation_state.items())
        }
        try:
            actual_allocations = json.loads(str(account["isolated_margin_json"]))
        except json.JSONDecodeError:
            actual_allocations = "INVALID_JSON"
        if expected_allocations != actual_allocations:
            add_difference(
                "contract_account.isolated_margin",
                expected_allocations,
                actual_allocations,
            )
        if account["status"] != expected_status:
            add_difference(
                "contract_account.status",
                expected_status,
                account["status"],
            )
        for field, expected in (
            ("cash_balance", expected_cash),
            ("equity", expected_equity),
            ("available_equity", expected_available),
            ("reserved_margin", expected_reserved),
            ("margin_used", expected_margin),
            ("maintenance_margin", expected_maintenance),
            ("realized_pnl", realized_total),
            ("unrealized_pnl", expected_unrealized),
            ("fees_paid", configured_fees),
            ("funding_cashflow", funding_total),
            ("liquidation_fees_paid", -liquidation_total),
        ):
            compare_decimal(
                f"portfolio.{field}",
                expected,
                portfolio.get(field),
            )
        if portfolio.get("status") != expected_status:
            add_difference(
                "portfolio.status",
                expected_status,
                portfolio.get("status"),
            )
        return {
            "initial_equity": decimal_to_string(
                initial, field_name="audited initial equity"
            ),
            "cash_balance": decimal_to_string(
                expected_cash, field_name="audited cash balance"
            ),
            "equity": decimal_to_string(
                expected_equity, field_name="audited equity"
            ),
            "available_equity": decimal_to_string(
                expected_available, field_name="audited available equity"
            ),
            "reserved_margin": decimal_to_string(
                expected_reserved, field_name="audited reserved margin"
            ),
            "margin_used": decimal_to_string(
                expected_margin, field_name="audited margin used"
            ),
            "maintenance_margin": decimal_to_string(
                expected_maintenance,
                field_name="audited maintenance margin",
            ),
            "realized_pnl": decimal_to_string(
                realized_total, field_name="audited realized pnl"
            ),
            "unrealized_pnl": decimal_to_string(
                expected_unrealized, field_name="audited unrealized pnl"
            ),
            "configured_fees": decimal_to_string(
                configured_fees, field_name="audited configured fees"
            ),
            "funding_cashflow": decimal_to_string(
                funding_total, field_name="audited funding"
            ),
            "liquidation_fees_paid": decimal_to_string(
                -liquidation_total, field_name="audited liquidation fees"
            ),
            "status": expected_status,
            "isolated_allocations": expected_allocations,
            "positions": per_track,
            "source_counts": {
                "fills": len(fills),
                "funding_settlements": len(funding_rows),
                "liquidations": len(liquidation_rows),
                "instrument_rules": len(rule_rows),
                "fee_policies": len(policy_rows),
                "ledger_entries": len(ledger_rows),
            },
        }

    @classmethod
    def _write_account_audit(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        now_ms: int,
        authoritative_projections: (
            Mapping[str, Mapping[str, object]] | None
        ) = None,
    ) -> dict[str, object]:
        run = connection.execute(
            """
            SELECT run.*, history.account_data_mode, history.status AS history_status
            FROM replay_training_run AS run
            JOIN replay_training_account_history AS history USING(run_id)
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        account = connection.execute(
            """
            SELECT * FROM replay_training_contract_account WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if run is None or account is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training account does not exist",
                status_code=404,
            )
        differences: list[dict[str, object]] = []
        ledger_rows = connection.execute(
            """
            SELECT * FROM replay_training_contract_ledger
            WHERE run_id = ? ORDER BY ledger_sequence
            """,
            (run_id,),
        ).fetchall()
        previous = initial_ledger_hash(
            run_id=run_id,
            initial_equity=str(run["initial_equity"]),
            asset=str(run["settlement_asset"]),
        )
        ledger_total = Decimal(0)
        for expected, row in enumerate(ledger_rows, 1):
            posting = {
                "posting_id": row["posting_id"],
                "track_id": row["track_id"],
                "kind": row["kind"],
                "cash_delta": row["cash_delta"],
                "asset": row["asset"],
                "virtual_time_ms": row["virtual_time_ms"],
                "source_sequence": row["source_sequence"],
                "fidelity": row["fidelity"],
                "rule_revision": row["rule_revision"],
                "reference_type": row["reference_type"],
                "reference_id": row["reference_id"],
                "metadata": json.loads(str(row["metadata_json"])),
            }
            expected_hash = ledger_chain_hash(
                previous_hash=previous,
                ledger_sequence=expected,
                posting=posting,
            )
            if int(row["ledger_sequence"]) != expected:
                differences.append(
                    {
                        "field": "ledger_sequence",
                        "expected": expected,
                        "actual": int(row["ledger_sequence"]),
                    }
                )
            if row["previous_hash"] != previous:
                differences.append(
                    {
                        "field": f"ledger[{expected}].previous_hash",
                        "expected": previous,
                        "actual": row["previous_hash"],
                    }
                )
            if row["entry_hash"] != expected_hash:
                differences.append(
                    {
                        "field": f"ledger[{expected}].entry_hash",
                        "expected": expected_hash,
                        "actual": row["entry_hash"],
                    }
                )
            previous = str(row["entry_hash"])
            ledger_total += Decimal(str(row["cash_delta"]))
        if previous != account["ledger_tail_hash"]:
            differences.append(
                {
                    "field": "ledger_tail_hash",
                    "expected": previous,
                    "actual": account["ledger_tail_hash"],
                }
            )
        tracks = [
            cls._market_track_from_row(row)
            for row in connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? ORDER BY stable_ordinal, track_id
                """,
                (run_id,),
            ).fetchall()
        ]
        portfolio = cls._contract_portfolio_projection(
            connection,
            run_id=run_id,
            initial_equity=str(run["initial_equity"]),
            tracks=tracks,
        )
        if Decimal(str(portfolio["cash_balance"])) != ledger_total:
            differences.append(
                {
                    "field": "cash_balance",
                    "expected": decimal_to_string(
                        ledger_total, field_name="audited cash"
                    ),
                    "actual": portfolio["cash_balance"],
                }
            )
        independent_state: dict[str, object] | None = None
        projection_verification = "NOT_APPLICABLE"
        if run["account_data_mode"] == "HISTORICAL_EXACT":
            projection_verification = (
                "VERIFIED_PINNED_ARCHIVE"
                if authoritative_projections is not None
                else "IN_PROCESS_HASH_CHAIN"
            )
            projections = connection.execute(
                """
                SELECT projection.*, ref.event_chain_tail,
                       archive.proof_hash, archive.health
                FROM replay_account_history_projection AS projection
                JOIN replay_account_history_ref AS ref
                  ON ref.run_id = projection.run_id
                 AND ref.track_id = projection.track_id
                 AND ref.archive_id = projection.archive_id
                 AND ref.active = 1
                JOIN replay_account_history_archive AS archive
                  ON archive.archive_id = projection.archive_id
                WHERE projection.run_id = ?
                ORDER BY projection.track_id
                """,
                (run_id,),
            ).fetchall()
            full_count = sum(
                1 for track in tracks if track["subscription_tier"] == "FULL"
            )
            if len(projections) != full_count:
                differences.append(
                    {
                        "field": "exact_projection_count",
                        "expected": full_count,
                        "actual": len(projections),
                    }
                )
            for projection in projections:
                if (
                    projection["status"] != "READY"
                    or projection["health"] != "READY"
                ):
                    differences.append(
                        {
                            "field": f"projection[{projection['track_id']}].status",
                            "expected": "READY",
                            "actual": (
                                f"{projection['status']}/{projection['health']}"
                            ),
                        }
                    )
                if authoritative_projections is not None:
                    expected = authoritative_projections.get(
                        str(projection["track_id"])
                    )
                    if expected is None:
                        differences.append(
                            {
                                "field": (
                                    f"projection[{projection['track_id']}]."
                                    "authoritative_archive"
                                ),
                                "expected": "PINNED_ARCHIVE_PROJECTION",
                                "actual": "MISSING",
                            }
                        )
                    else:
                        for field in (
                            "archive_id",
                            "archive_generation",
                            "last_event_sequence",
                            "last_rule_sequence",
                            "last_mark_sequence",
                            "last_funding_sequence",
                            "as_of_actual_time_ms",
                            "as_of_virtual_time_ms",
                            "current_rule_json",
                            "current_rule_hash",
                            "mark_price",
                            "index_price",
                            "input_chain_hash",
                        ):
                            if projection[field] != expected.get(field):
                                differences.append(
                                    {
                                        "field": (
                                            f"projection[{projection['track_id']}]."
                                            f"{field}"
                                        ),
                                        "expected": expected.get(field),
                                        "actual": projection[field],
                                    }
                                )
                applied = connection.execute(
                    """
                    SELECT event_hash FROM (
                        SELECT archive_event_hash AS event_hash,
                               archive_event_sequence
                        FROM replay_account_history_applied_event
                        WHERE run_id = ? AND track_id = ?
                    ) ORDER BY archive_event_sequence DESC LIMIT 1
                    """,
                    (run_id, projection["track_id"]),
                ).fetchone()
                if (
                    applied is not None
                    and applied["event_hash"] != projection["input_chain_hash"]
                ):
                    differences.append(
                        {
                            "field": (
                                f"projection[{projection['track_id']}]."
                                "input_chain_hash"
                            ),
                            "expected": applied["event_hash"],
                            "actual": projection["input_chain_hash"],
                        }
                    )
            if (
                authoritative_projections is not None
                and len(authoritative_projections) != len(projections)
            ):
                differences.append(
                    {
                        "field": "authoritative_projection_count",
                        "expected": len(projections),
                        "actual": len(authoritative_projections),
                    }
                )
            independent_state = cls._audit_exact_account_state(
                connection,
                run=run,
                account=account,
                ledger_rows=ledger_rows,
                portfolio=portfolio,
                differences=differences,
            )
        funding_orphans = int(
            connection.execute(
                """
                SELECT COUNT(*) FROM replay_training_funding_settlement AS funding
                LEFT JOIN replay_training_contract_ledger AS ledger
                  ON ledger.run_id = funding.run_id
                 AND ledger.ledger_sequence = funding.ledger_sequence
                WHERE funding.run_id = ? AND (
                    ledger.ledger_sequence IS NULL
                    OR ledger.kind != 'FUNDING_SETTLEMENT'
                    OR ledger.cash_delta != funding.cash_delta
                )
                """,
                (run_id,),
            ).fetchone()[0]
        )
        if funding_orphans:
            differences.append(
                {
                    "field": "funding_ledger_links",
                    "expected": 0,
                    "actual": funding_orphans,
                }
            )
        snapshot = {
            "schema_version": ACCOUNT_AUDIT_SCHEMA_VERSION,
            "run_id": run_id,
            "account_data_mode": str(run["account_data_mode"]),
            "history_status": str(run["history_status"]),
            "ledger_entry_count": len(ledger_rows),
            "ledger_tail_hash": str(account["ledger_tail_hash"]),
            "ledger_cash_total": decimal_to_string(
                ledger_total, field_name="ledger cash total"
            ),
            "portfolio": {
                key: portfolio[key]
                for key in (
                    "cash_balance",
                    "equity",
                    "available_equity",
                    "margin_used",
                    "maintenance_margin",
                    "funding_cashflow",
                    "liquidation_fees_paid",
                    "status",
                )
            },
            "authoritative_projection_verification": projection_verification,
            "independent_exact_state": independent_state,
            "differences": differences,
        }
        status = "PASS" if not differences else "FAIL"
        proof_hash = canonical_sha256(snapshot)
        sequence = int(
            connection.execute(
                """
                SELECT COALESCE(MAX(audit_sequence), 0) + 1
                FROM replay_account_history_audit WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()[0]
        )
        connection.execute(
            """
            INSERT INTO replay_account_history_audit(
                run_id, audit_sequence, schema_version, status, proof_hash,
                differences_json, snapshot_json, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                sequence,
                ACCOUNT_AUDIT_SCHEMA_VERSION,
                status,
                proof_hash,
                canonical_json(differences),
                canonical_json(snapshot),
                now_ms,
            ),
        )
        connection.execute(
            """
            UPDATE replay_training_account_history
            SET auditor_status = ?, auditor_proof_hash = ?,
                auditor_differences_json = ?, updated_at_ms = ?
            WHERE run_id = ?
            """,
            (
                status,
                proof_hash,
                canonical_json(differences),
                now_ms,
                run_id,
            ),
        )
        return {
            "schema_version": ACCOUNT_AUDIT_SCHEMA_VERSION,
            "status": status,
            "proof_hash": proof_hash,
            "differences": differences,
            "snapshot": snapshot,
        }

    def fork_run_writer(
        self,
        *,
        child_run_id: str,
        parent_run_id: str,
        parent_event_id: str,
        parent_checkpoint_id: int,
        parent_timeline_sequence: int | None = None,
        parent_anchor_set_hash: str | None = None,
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
            dataset_ref: Mapping[str, object],
            dataset_blob: Mapping[str, object],
            actual_replay_start_ms: int,
            actual_replay_end_ms: int,
        ) -> None:
            parent = connection.execute(
                """
                SELECT r.*, i.strict_eligible, i.start_time_known, i.revealed,
                       i.allowed_mutations_json, i.result_label,
                       rule.rule_json, rule.rule_hash,
                       history.account_data_mode, history.fidelity AS history_fidelity,
                       history.archive_proof_hash
                FROM replay_training_run AS r
                JOIN replay_training_integrity AS i USING(run_id)
                JOIN replay_training_rule AS rule
                  ON rule.run_id = r.run_id
                 AND rule.revision = r.active_rule_revision
                JOIN replay_training_account_history AS history USING(run_id)
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
                SELECT state_hash FROM replay_review_actor_anchor
                WHERE run_id = ? AND checkpoint_id = ?
                  AND adapter_session_id = ?
                """,
                (
                    parent_run_id,
                    parent_checkpoint_id,
                    parent["adapter_session_id"],
                ),
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
            if str(parent["account_data_mode"]) == "HISTORICAL_EXACT":
                connection.execute(
                    """
                    INSERT INTO replay_training_account_history(
                        run_id, account_data_mode, status, fidelity,
                        archive_proof_hash, degraded_reason, auditor_status,
                        auditor_proof_hash, auditor_differences_json,
                        created_at_ms, updated_at_ms
                    ) VALUES (?, 'HISTORICAL_EXACT', 'ACTIVE', ?, ?, NULL,
                              'NOT_RUN', NULL, '[]', ?, ?)
                    """,
                    (
                        child_run_id,
                        parent["history_fidelity"],
                        parent["archive_proof_hash"],
                        now_ms,
                        now_ms,
                    ),
                )
            else:
                self._insert_approx_account_history(
                    connection,
                    run_id=child_run_id,
                    now_ms=now_ms,
                )
            self._copy_launch_context(
                connection,
                parent_run_id=parent_run_id,
                child_run_id=child_run_id,
                now_ms=now_ms,
            )
            self._copy_start_selection(
                connection,
                parent_run_id=parent_run_id,
                child_run_id=child_run_id,
                actual_start_ms=actual_replay_start_ms,
                actual_end_ms=actual_replay_end_ms,
                dataset_epoch=str(parent["dataset_epoch"]),
                now_ms=now_ms,
            )
            history_policy = self._copy_data_policy(
                connection,
                parent_run_id=parent_run_id,
                child_run_id=child_run_id,
                actual_replay_start_ms=actual_replay_start_ms,
                now_ms=now_ms,
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
            if str(parent["book_mode"]) == "BOOK_ASSISTED_REQUIRED":
                self._copy_review_book_inputs(
                    connection,
                    child_run_id=child_run_id,
                    parent_run_id=parent_run_id,
                    parent_event_id=parent_event_id,
                    track_mapping={"track-1": "track-1"},
                    now_ms=now_ms,
                )
            self._insert_fork_contract_account(
                connection,
                child_run_id=child_run_id,
                parent_run_id=parent_run_id,
                parent_event_id=parent_event_id,
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
            self._copy_review_rule_policies(
                connection,
                child_run_id=child_run_id,
                parent_run_id=parent_run_id,
                parent_event_id=parent_event_id,
                virtual_time_ms=int(cursor["virtual_time_ms"]),
                source_sequence=validate_v2_counter(
                    session_state["source_sequence"],
                    field_name="fork source_sequence",
                ),
                now_ms=now_ms,
            )
            if str(parent["account_data_mode"]) == "HISTORICAL_EXACT":
                self._copy_exact_review_fork_inputs(
                    connection,
                    child_run_id=child_run_id,
                    parent_run_id=parent_run_id,
                    parent_event_id=parent_event_id,
                    track_mapping={"track-1": "track-1"},
                    now_ms=now_ms,
                )
                self._apply_exact_mark_projection(
                    connection,
                    run_id=child_run_id,
                    track_id="track-1",
                    now_ms=now_ms,
                )
            parent_view = connection.execute(
                "SELECT * FROM replay_training_viewer_state WHERE run_id = ?",
                (parent_run_id,),
            ).fetchone()
            review_event = connection.execute(
                """
                SELECT projection_json FROM replay_review_timeline_event
                WHERE run_id = ? AND event_id = ?
                """,
                (parent_run_id, parent_event_id),
            ).fetchone()
            review_view: Mapping[str, object] | None = None
            if review_event is not None:
                review_projection = json.loads(str(review_event["projection_json"]))
                if isinstance(review_projection, Mapping) and isinstance(
                    review_projection.get("viewer_state"), Mapping
                ):
                    review_view = cast(
                        Mapping[str, object],
                        review_projection["viewer_state"],
                    )
            self._insert_viewer_state(
                connection,
                ViewerState(
                    run_id=child_run_id,
                    selected_track_id=(
                        "track-1"
                        if review_view is None
                        else str(review_view["selected_track_id"])
                    ),
                    display_interval=(
                        str(parent["display_interval"])
                        if review_view is None
                        else str(review_view["display_interval"])
                    ),
                    chart_type=(
                        (
                            "candles"
                            if parent_view is None
                            else str(parent_view["chart_type"])
                        )
                        if review_view is None
                        else str(review_view["chart_type"])
                    ),
                    visible_range=(
                        None
                        if review_view is None
                        else cast(
                            Mapping[str, object] | None,
                            review_view.get("visible_range"),
                        )
                    ),
                    pane_layout=(
                        {}
                        if review_view is None
                        else cast(
                            Mapping[str, object],
                            review_view["pane_layout"],
                        )
                    ),
                    rail_layout=(
                        {}
                        if review_view is None
                        else cast(
                            Mapping[str, object],
                            review_view["rail_layout"],
                        )
                    ),
                    semantic_view_revision=(
                        0
                        if review_view is None
                        else int(review_view["semantic_view_revision"])
                    ),
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
            register_archive_segment(
                connection,
                run_id=child_run_id,
                track_id="track-1",
                adapter_session_id=session_id,
                source_kind=str(parent["source_kind"]),
                dataset_ref=dataset_ref,
                dataset_blob=dataset_blob,
                actual_replay_start_ms=actual_replay_start_ms,
                actual_replay_end_ms=actual_replay_end_ms,
                history_policy=history_policy,
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
            event = connection.execute(
                """
                SELECT timeline_sequence, anchor_set_hash, projection_json
                FROM replay_review_timeline_event
                WHERE run_id = ? AND event_id = ?
                """,
                (parent_run_id, parent_event_id),
            ).fetchone()
            if event is None:
                raise TypeError("review fork event is missing")
            effective_timeline = (
                int(event["timeline_sequence"])
                if parent_timeline_sequence is None
                else parent_timeline_sequence
            )
            effective_anchor_set_hash = (
                str(event["anchor_set_hash"])
                if parent_anchor_set_hash is None
                else parent_anchor_set_hash
            )
            if (
                effective_timeline != int(event["timeline_sequence"])
                or effective_anchor_set_hash != str(event["anchor_set_hash"])
            ):
                raise TrainingRunError(
                    "REVIEW_FORK_MISMATCH",
                    "review lineage changed before fork commit",
                    status_code=409,
                )
            connection.execute(
                """
                INSERT INTO replay_review_fork_lineage(
                    child_run_id, parent_run_id, parent_event_id,
                    parent_timeline_sequence, anchor_set_hash,
                    parent_projection_hash, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    child_run_id,
                    parent_run_id,
                    parent_event_id,
                    effective_timeline,
                    effective_anchor_set_hash,
                    canonical_sha256(
                        json.loads(str(event["projection_json"]))
                    ),
                    now_ms,
                ),
            )
            drawing = connection.execute(
                """
                SELECT document.* FROM replay_review_drawing_document AS document
                JOIN replay_review_timeline_event AS event
                  ON event.run_id = document.run_id
                 AND json_extract(
                     event.projection_json, '$.drawing_document_hash'
                 ) = document.document_hash
                WHERE event.run_id = ? AND event.event_id = ?
                """,
                (parent_run_id, parent_event_id),
            ).fetchone()
            if drawing is not None:
                connection.execute(
                    """
                    INSERT INTO replay_review_drawing_document(
                        run_id, document_hash, revision, command_id,
                        document_json, document_bytes, entity_count,
                        virtual_time_ms, source_sequence, created_at_ms
                    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        child_run_id,
                        drawing["document_hash"],
                        f"fork-drawing-{child_run_id}",
                        drawing["document_json"],
                        drawing["document_bytes"],
                        drawing["entity_count"],
                        cursor["virtual_time_ms"],
                        session_state["source_sequence"],
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
            dataset_ref: Mapping[str, object],
            dataset_blob: Mapping[str, object],
            actual_replay_start_ms: int,
            actual_replay_end_ms: int,
        ) -> Callable[[sqlite3.Connection, int], None]:
            return lambda connection, now_ms: write(
                connection,
                now_ms,
                session_id=session_id,
                session_state=session_state,
                component_state=component_state,
                broker_config=broker_config,
                dataset_ref=dataset_ref,
                dataset_blob=dataset_blob,
                actual_replay_start_ms=actual_replay_start_ms,
                actual_replay_end_ms=actual_replay_end_ms,
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
                SELECT s.*, d.data_epoch AS dataset_epoch,
                       d.actual_replay_start_ms, d.actual_replay_end_ms
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
            public_config = {
                **config,
                "requested_start_ms": requested_start,
                "random_seed": (
                    None if blind else config.get("random_seed")
                ),
            }
            rule = {
                "schema": "replay.training.legacy-rule.v1",
                "legacy_protocol": "replay.v1",
                "config": public_config,
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
            self._insert_approx_account_history(
                connection,
                run_id=run_id,
                now_ms=now_ms,
            )
            self._insert_launch_context(
                connection,
                run_id=run_id,
                context=ReplayLaunchContext.direct_hub(
                    exchange=str(config.get("exchange") or "unknown"),
                    market_type=str(config.get("market_type") or "unknown"),
                    symbol=symbol,
                    display_interval=str(config.get("display_interval") or "unknown"),
                ),
                now_ms=now_ms,
            )
            self._insert_start_selection(
                connection,
                run_id=run_id,
                start_mode=start_mode,
                seed_source=(
                    "LEGACY_CLIENT" if start_mode == "RANDOM" else "MANUAL"
                ),
                random_seed=(
                    int(config["random_seed"])
                    if start_mode == "RANDOM"
                    and config.get("random_seed") is not None
                    else None
                ),
                actual_start_ms=int(row["actual_replay_start_ms"]),
                actual_end_ms=int(row["actual_replay_end_ms"]),
                dataset_epoch=str(row["dataset_epoch"]),
                parent_selection_hash=None,
                now_ms=now_ms,
            )
            interval_ms = parse_interval_ms(str(config.get("base_interval", "")))
            if interval_ms is None:
                raise TrainingRunError(
                    "TRAINING_RUN_UNAVAILABLE",
                    "legacy replay base interval is unsupported",
                    status_code=409,
                )
            legacy_warmup = int(config["warmup_bars"])
            legacy_start_ms = int(row["actual_replay_start_ms"])
            self._insert_data_policy(
                connection,
                run_id=run_id,
                policy=ResolvedHistoryPolicy(
                    indicator_warmup_bars=legacy_warmup,
                    visible_history_mode=VisibleHistoryMode.DURATION,
                    visible_history_lookback_ms=legacy_warmup * interval_ms,
                    visible_history_rows=legacy_warmup,
                    actual_visible_history_start_ms=(
                        legacy_start_ms - legacy_warmup * interval_ms
                    ),
                    actual_replay_start_ms=legacy_start_ms,
                    effective_warmup_bars=legacy_warmup,
                    forward_cache_ms=int(config["horizon_ms"]),
                    interval_ms=interval_ms,
                ),
                actual_replay_start_ms=legacy_start_ms,
                now_ms=now_ms,
            )
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
                       r.book_mode,
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
                       history.account_data_mode,
                       history.status AS account_history_status,
                       history.archive_proof_hash,
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
                JOIN replay_training_account_history AS history USING(run_id)
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
            "book_mode": str(row["book_mode"]),
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
            "account_data_mode": str(row["account_data_mode"]),
            "account_history_status": str(row["account_history_status"]),
            "account_archive_proof_hash": row["archive_proof_hash"],
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
                       rule.rule_hash, rule.rule_json,
                       selection.schema_version AS selection_schema_version,
                       selection.start_mode AS selection_start_mode,
                       selection.seed_source AS selection_seed_source,
                       selection.random_seed AS selection_random_seed,
                       selection.actual_start_ms AS selection_actual_start_ms,
                       selection.actual_end_ms AS selection_actual_end_ms,
                       selection.dataset_epoch AS selection_dataset_epoch,
                       selection.parent_selection_hash,
                       selection.selection_hash
                FROM replay_training_run AS r
                JOIN replay_training_integrity AS i USING(run_id)
                JOIN replay_training_rule AS rule
                  ON rule.run_id = r.run_id
                 AND rule.revision = r.active_rule_revision
                JOIN replay_training_start_selection AS selection USING(run_id)
                WHERE r.run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if row is None:
                return None
            expected_selection_hash = start_selection_hash(
                run_id=str(row["run_id"]),
                start_mode=str(row["selection_start_mode"]),
                seed_source=str(row["selection_seed_source"]),
                random_seed=(
                    None
                    if row["selection_random_seed"] is None
                    else int(row["selection_random_seed"])
                ),
                actual_start_ms=int(row["selection_actual_start_ms"]),
                actual_end_ms=int(row["selection_actual_end_ms"]),
                dataset_epoch=str(row["selection_dataset_epoch"]),
                parent_selection_hash=(
                    None
                    if row["parent_selection_hash"] is None
                    else str(row["parent_selection_hash"])
                ),
            )
            if expected_selection_hash != str(row["selection_hash"]):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "training start selection commitment failed validation",
                    status_code=503,
                )
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
            revealed = bool(row["revealed"])
            configured_policy = str(row["time_disclosure_policy"])
            active_rule = self._redact_active_rule(
                json.loads(str(row["rule_json"])),
                hidden=configured_policy != "NONE" and not revealed,
            )
            start_public_time, end_public_time = self._selection_public_bounds(
                connection,
                session_id=str(row["adapter_session_id"]),
                policy=configured_policy,
                revealed=revealed,
                actual_start_ms=int(row["selection_actual_start_ms"]),
                actual_end_ms=int(row["selection_actual_end_ms"]),
            )
            disclose_seed = (
                row["selection_random_seed"] is not None
                and (configured_policy == "NONE" or revealed)
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
                "active_rule": active_rule,
                "start_selection": {
                    "schema_version": str(row["selection_schema_version"]),
                    "start_mode": str(row["selection_start_mode"]),
                    "seed_source": str(row["selection_seed_source"]),
                    "seed_disclosed": disclose_seed,
                    "random_seed": (
                        int(row["selection_random_seed"])
                        if disclose_seed
                        else None
                    ),
                    "dataset_epoch": str(row["selection_dataset_epoch"]),
                    "parent_selection_hash": row["parent_selection_hash"],
                    "selection_hash": str(row["selection_hash"]),
                    "public_start": start_public_time,
                    "public_end": end_public_time,
                },
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

    async def public_times(
        self,
        run_id: str,
        *,
        timeline_ms: tuple[int, ...],
        max_items: int,
    ) -> dict[str, object]:
        if (
            isinstance(max_items, bool)
            or not isinstance(max_items, int)
            or not 1 <= max_items <= _PUBLIC_TIME_BATCH_LIMIT
        ):
            raise TypeError("max_items is outside the public-time storage bound")
        if not isinstance(timeline_ms, tuple) or not 1 <= len(timeline_ms) <= max_items:
            raise TrainingRunError(
                "TRAINING_RUN_INVALID",
                f"public time batch must contain between 1 and {max_items} values",
                status_code=422,
            )
        normalized: list[int] = []
        for index, value in enumerate(timeline_ms):
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or value < 0
                or value > 253_402_300_799_999
            ):
                raise TrainingRunError(
                    "TRAINING_RUN_INVALID",
                    f"timeline_ms[{index}] is not a valid timestamp",
                    status_code=422,
                )
            normalized.append(value)

        def read(connection: sqlite3.Connection) -> dict[str, object] | None:
            row = connection.execute(
                """
                SELECT r.adapter_session_id, r.time_disclosure_policy,
                       r.base_interval, r.display_interval, i.revealed,
                       d.actual_replay_start_ms, d.actual_replay_end_ms,
                       d.synthetic_origin_ms,
                       policy.effective_warmup_bars,
                       policy.interval_ms AS policy_interval_ms
                FROM replay_training_run AS r
                JOIN replay_training_integrity AS i USING(run_id)
                JOIN replay_dataset_ref AS d
                  ON d.session_id = r.adapter_session_id
                JOIN replay_training_data_policy AS policy USING(run_id)
                WHERE r.run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if row is None:
                return None
            policy = str(row["time_disclosure_policy"])
            revealed = bool(row["revealed"])
            actual_origin = int(row["actual_replay_start_ms"])
            public_origin = (
                actual_origin
                if policy == "NONE"
                else self._required_synthetic_origin(row["synthetic_origin_ms"])
            )
            warmup = int(row["effective_warmup_bars"])
            interval_ms = parse_interval_ms(str(row["base_interval"]))
            display_interval_ms = parse_interval_ms(str(row["display_interval"]))
            if (
                warmup < 1
                or interval_ms is None
                or interval_ms != int(row["policy_interval_ms"])
                or display_interval_ms is None
                or display_interval_ms < interval_ms
            ):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "training time bounds are invalid",
                    status_code=503,
                )
            lower = (
                public_origin
                - warmup * interval_ms
                - (display_interval_ms - interval_ms)
            )
            # Dataset refs pin BAR replay bounds by base-bar open time.  Public
            # chart timestamps also include the final bar's close time, so the
            # valid closed interval ends one base interval after the last open
            # (exclusive) rather than at the last open itself.
            upper = (
                public_origin
                + int(row["actual_replay_end_ms"])
                - actual_origin
                + interval_ms
                - 1
            )
            if lower < 0 or any(value < lower or value > upper for value in normalized):
                raise TrainingRunError(
                    "TRAINING_RUN_INVALID",
                    "public time request is outside the pinned training dataset",
                    status_code=422,
                )
            items = [
                {
                    "input_timeline_ms": value,
                    "public_time": self._project_public_time(
                        actual_origin_ms=actual_origin,
                        public_origin_ms=public_origin,
                        policy=policy,
                        revealed=revealed,
                        public_time_ms=value,
                        sequence=index,
                    ),
                }
                for index, value in enumerate(normalized)
            ]
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "run_id": run_id,
                "policy": "NONE" if revealed else policy,
                "items": items,
            }

        result = await self.base_store.run_extension_read(read)
        if result is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training run does not exist",
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
            self._review.record_viewport(
                connection,
                run_id=run_id,
                bucket_key=semantic_key,
                event_type=event_type,
                value=value,
                public_time=public_time,
                now_ms=self.base_store._validated_now_ms(),
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

    async def run_rules(self, run_id: str) -> dict[str, object]:
        def read(connection: sqlite3.Connection) -> dict[str, object]:
            return self._review.rules_projection(
                connection,
                run_id=run_id,
                include_history=True,
            )

        return await self.base_store.run_extension_read(read)

    async def current_drawing_document(self, run_id: str) -> dict[str, object]:
        def read(connection: sqlite3.Connection) -> dict[str, object]:
            exists = connection.execute(
                "SELECT 1 FROM replay_training_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if exists is None:
                raise TrainingRunError(
                    "TRAINING_RUN_NOT_FOUND",
                    "training run does not exist",
                    status_code=404,
                )
            row = connection.execute(
                """
                SELECT document_hash, revision, document_json, entity_count
                FROM replay_review_drawing_document
                WHERE run_id = ? ORDER BY revision DESC LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "schema_version": "replay.review.drawing-current.v1",
                "run_id": run_id,
                "document_hash": (
                    None if row is None else str(row["document_hash"])
                ),
                "revision": 0 if row is None else int(row["revision"]),
                "entity_count": 0 if row is None else int(row["entity_count"]),
                "document": (
                    None
                    if row is None
                    else json.loads(str(row["document_json"]))
                ),
                "budget": self._review_budget(connection, run_id),
            }

        return await self.base_store.run_extension_read(read)

    async def record_drawing_document(
        self,
        *,
        run_id: str,
        command_id: str,
        document_hash: str,
        document: Mapping[str, object],
        entity_count: int,
    ) -> dict[str, object]:
        document_json, calculated_hash = validate_drawing_document(
            document,
            run_id=run_id,
            entity_count=entity_count,
        )
        document_bytes = len(document_json.encode("utf-8"))
        if calculated_hash != document_hash:
            raise TrainingRunError(
                "REVIEW_DRAWING_HASH_MISMATCH",
                "drawing document hash does not match canonical content",
                status_code=409,
                details={
                    "expected": calculated_hash,
                    "actual": document_hash,
                },
            )

        def write(connection: sqlite3.Connection) -> dict[str, object]:
            replayed = connection.execute(
                """
                SELECT * FROM replay_review_drawing_document
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            if replayed is not None:
                if str(replayed["document_hash"]) != document_hash:
                    raise TrainingRunError(
                        "COMMAND_ID_REUSED",
                        "command_id was reused with a different drawing document",
                        status_code=409,
                    )
                return {
                    "protocol": REPLAY_V2_PROTOCOL,
                    "schema_version": "replay.review.drawing-document.v1",
                    "run_id": run_id,
                    "document_hash": document_hash,
                    "revision": int(replayed["revision"]),
                    "entity_count": int(replayed["entity_count"]),
                    "deduplicated": True,
                    "budget": self._review_budget(connection, run_id),
                }
            by_hash = connection.execute(
                """
                SELECT * FROM replay_review_drawing_document
                WHERE run_id = ? AND document_hash = ?
                """,
                (run_id, document_hash),
            ).fetchone()
            if by_hash is not None:
                return {
                    "protocol": REPLAY_V2_PROTOCOL,
                    "schema_version": "replay.review.drawing-document.v1",
                    "run_id": run_id,
                    "document_hash": document_hash,
                    "revision": int(by_hash["revision"]),
                    "entity_count": int(by_hash["entity_count"]),
                    "deduplicated": True,
                    "budget": self._review_budget(connection, run_id),
                }
            run = connection.execute(
                """
                SELECT r.adapter_session_id, r.virtual_time_ms, r.source_sequence
                FROM replay_training_run AS r WHERE r.run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if run is None:
                raise TrainingRunError(
                    "TRAINING_RUN_NOT_FOUND",
                    "training run does not exist",
                    status_code=404,
                )
            budget = self._review_budget(connection, run_id)
            if int(budget["artifact_used_bytes"]) + document_bytes > int(
                budget["artifact_limit_bytes"]
            ):
                raise TrainingRunError(
                    "REVIEW_ARTIFACT_BUDGET_EXCEEDED",
                    "review drawing artifact budget is exhausted",
                    status_code=409,
                    details={
                        **budget,
                        "offered_bytes": document_bytes,
                        "event_dropped": False,
                    },
                )
            revision = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(revision), 0) + 1
                    FROM replay_review_drawing_document WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
            now_ms = self.base_store._validated_now_ms()
            connection.execute(
                """
                INSERT INTO replay_review_drawing_document(
                    run_id, document_hash, revision, command_id,
                    document_json, document_bytes, entity_count,
                    virtual_time_ms, source_sequence, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    document_hash,
                    revision,
                    command_id,
                    document_json,
                    document_bytes,
                    entity_count,
                    run["virtual_time_ms"],
                    run["source_sequence"],
                    now_ms,
                ),
            )
            self._append_review_timeline_event(
                connection,
                run_id=run_id,
                session_id=str(run["adapter_session_id"]),
                context={
                    "kind": "DIRECT",
                    "category": "DRAWING",
                    "event_type": "DRAWING_DOCUMENT",
                    "command_id": command_id,
                },
                state=None,
                checkpoint=None,
                now_ms=now_ms,
            )
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "schema_version": "replay.review.drawing-document.v1",
                "run_id": run_id,
                "document_hash": document_hash,
                "revision": revision,
                "entity_count": entity_count,
                "deduplicated": False,
                "budget": self._review_budget(connection, run_id),
            }

        return await self.base_store.run_extension_write(write)

    async def record_review_marker(
        self,
        *,
        run_id: str,
        command_id: str,
        text: str,
    ) -> dict[str, object]:
        normalized_text = text.strip()
        if not normalized_text or len(normalized_text) > 500:
            raise TrainingRunError(
                "REVIEW_MARKER_INVALID",
                "review marker text must contain 1 to 500 characters",
                status_code=422,
            )
        content_hash = canonical_sha256(
            {
                "schema_version": "replay.review.marker.v1",
                "run_id": run_id,
                "text": normalized_text,
            }
        )

        def write(connection: sqlite3.Connection) -> dict[str, object]:
            existing = connection.execute(
                """
                SELECT marker.*, event.event_id, event.timeline_sequence
                FROM replay_review_marker AS marker
                LEFT JOIN replay_review_timeline_event AS event
                  ON event.run_id = marker.run_id
                 AND event.command_id = marker.command_id
                 AND event.category = 'MARKER'
                WHERE marker.run_id = ? AND marker.command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            if existing is not None:
                if str(existing["content_hash"]) != content_hash:
                    raise TrainingRunError(
                        "COMMAND_ID_REUSED",
                        "command_id was reused with different marker content",
                        status_code=409,
                    )
                return {
                    "protocol": REPLAY_V2_PROTOCOL,
                    "schema_version": "replay.review.marker.v1",
                    "run_id": run_id,
                    "marker_id": str(existing["marker_id"]),
                    "command_id": command_id,
                    "text": normalized_text,
                    "content_hash": content_hash,
                    "event_id": existing["event_id"],
                    "timeline_sequence": existing["timeline_sequence"],
                    "deduplicated": True,
                    "budget": self._review_budget(connection, run_id),
                }
            run = connection.execute(
                """
                SELECT adapter_session_id, virtual_time_ms, source_sequence
                FROM replay_training_run WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if run is None:
                raise TrainingRunError(
                    "TRAINING_RUN_NOT_FOUND",
                    "training run does not exist",
                    status_code=404,
                )
            ordinal = int(
                connection.execute(
                    "SELECT COUNT(*) + 1 FROM replay_review_marker WHERE run_id = ?",
                    (run_id,),
                ).fetchone()[0]
            )
            marker_id = f"marker-{ordinal:08d}"
            now_ms = self.base_store._validated_now_ms()
            connection.execute(
                """
                INSERT INTO replay_review_marker(
                    run_id, marker_id, command_id, text, content_hash,
                    virtual_time_ms, source_sequence, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    marker_id,
                    command_id,
                    normalized_text,
                    content_hash,
                    run["virtual_time_ms"],
                    run["source_sequence"],
                    now_ms,
                ),
            )
            created = self._append_review_timeline_event(
                connection,
                run_id=run_id,
                session_id=str(run["adapter_session_id"]),
                context={
                    "kind": "DIRECT",
                    "category": "MARKER",
                    "event_type": "USER_MARKER",
                    "command_id": command_id,
                },
                state=None,
                checkpoint=None,
                now_ms=now_ms,
            )
            if len(created) != 1:
                raise TypeError("review marker did not create exactly one timeline event")
            event = connection.execute(
                """
                SELECT timeline_sequence FROM replay_review_timeline_event
                WHERE run_id = ? AND event_id = ?
                """,
                (run_id, created[0]),
            ).fetchone()
            if event is None:
                raise TypeError("review marker timeline event is missing")
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "schema_version": "replay.review.marker.v1",
                "run_id": run_id,
                "marker_id": marker_id,
                "command_id": command_id,
                "text": normalized_text,
                "content_hash": content_hash,
                "event_id": created[0],
                "timeline_sequence": int(event["timeline_sequence"]),
                "deduplicated": False,
                "budget": self._review_budget(connection, run_id),
            }

        return await self.base_store.run_extension_write(write)

    @staticmethod
    def _review_budget(
        connection: sqlite3.Connection,
        run_id: str,
    ) -> dict[str, object]:
        row = connection.execute(
            """
            SELECT
                (SELECT COUNT(*) FROM replay_review_timeline_event
                 WHERE run_id = ?) AS critical_events,
                (SELECT COUNT(*) FROM replay_review_viewport_sample
                 WHERE run_id = ?) AS viewport_samples,
                COALESCE((SELECT SUM(
                              CASE WHEN stored_bytes > 0 THEN stored_bytes
                                   ELSE length(payload) END
                          )
                          FROM replay_review_actor_anchor
                          WHERE run_id = ?), 0) AS anchor_bytes,
                COALESCE((SELECT SUM(length(CAST(projection_json AS BLOB)))
                          FROM replay_review_timeline_event
                          WHERE run_id = ?), 0)
                    + COALESCE((SELECT SUM(document_bytes)
                                FROM replay_review_drawing_document
                                WHERE run_id = ?), 0)
                    + COALESCE((SELECT SUM(length(CAST(text AS BLOB)))
                                FROM replay_review_marker
                                WHERE run_id = ?), 0) AS artifact_bytes
            """,
            (run_id, run_id, run_id, run_id, run_id, run_id),
        ).fetchone()
        return {
            "critical_events": int(row["critical_events"]),
            "critical_event_limit": 8_192,
            "viewport_samples": int(row["viewport_samples"]),
            "viewport_sample_limit": 2_048,
            "anchor_used_bytes": int(row["anchor_bytes"]),
            "anchor_limit_bytes": 512 * 1024 * 1024,
            "artifact_used_bytes": int(row["artifact_bytes"]),
            "artifact_limit_bytes": REVIEW_ARTIFACT_BYTES_LIMIT,
        }

    @staticmethod
    def _public_review_projection(
        projection: Mapping[str, object],
    ) -> dict[str, object]:
        public = json.loads(canonical_json(projection))
        if not isinstance(public, dict):
            raise TypeError("review projection is invalid")
        public.pop("_account_history_internal", None)
        public.pop("_book_history_internal", None)

        blocked = {
            "archive_id",
            "as_of_actual_ms",
            "actual_time_ms",
            "actual_replay_start_ms",
            "actual_visible_history_start_ms",
        }

        def assert_public(value: object, field: str) -> None:
            if isinstance(value, list):
                for index, item in enumerate(value):
                    assert_public(item, f"{field}[{index}]")
                return
            if not isinstance(value, dict):
                return
            for key, item in value.items():
                if str(key).startswith("_") or key in blocked:
                    raise TrainingRunError(
                        "REVIEW_DISCLOSURE_VIOLATION",
                        "review projection crosses the public disclosure boundary",
                        status_code=503,
                        details={"field": f"{field}.{key}"},
                    )
                assert_public(item, f"{field}.{key}")

        assert_public(public, "projection")
        return public

    @staticmethod
    def _review_event_detail(
        connection: sqlite3.Connection,
        event: sqlite3.Row,
    ) -> dict[str, object] | None:
        command_id = event["command_id"]
        if command_id is None:
            return None
        if str(event["category"]) == "MARKER":
            marker = connection.execute(
                """
                SELECT marker_id, text, content_hash
                FROM replay_review_marker
                WHERE run_id = ? AND command_id = ?
                """,
                (event["run_id"], command_id),
            ).fetchone()
            if marker is not None:
                return {
                    "marker_id": str(marker["marker_id"]),
                    "text": str(marker["text"]),
                    "content_hash": str(marker["content_hash"]),
                }
        return None

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
                       s.state_hash, account.ledger_tail_hash,
                       viewer.semantic_view_revision
                FROM replay_training_run AS r
                JOIN replay_session AS s ON s.session_id = r.adapter_session_id
                JOIN replay_training_contract_account AS account USING(run_id)
                JOIN replay_training_viewer_state AS viewer USING(run_id)
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
            self._assert_run_segments_ready(
                connection,
                run_id=run_id,
                operation="review",
            )
            rows = connection.execute(
                """
                SELECT event.*, anchor.checkpoint_id
                FROM replay_review_timeline_event AS event
                JOIN replay_review_event_anchor AS link
                  ON link.run_id = event.run_id
                 AND link.timeline_sequence = event.timeline_sequence
                 AND link.track_id = event.track_id
                JOIN replay_review_actor_anchor AS anchor
                  ON anchor.run_id = link.run_id
                 AND anchor.anchor_id = link.anchor_id
                WHERE event.run_id = ?
                ORDER BY event.timeline_sequence
                """,
                (run_id,),
            ).fetchall()
            if not rows:
                raise TrainingRunError(
                    "REVIEW_UNAVAILABLE",
                    "training run has no immutable review timeline",
                    status_code=409,
                )
            events = [
                {
                    "event_id": str(row["event_id"]),
                    "event_type": str(row["event_type"]),
                    "category": str(row["category"]),
                    "timeline_sequence": int(row["timeline_sequence"]),
                    "checkpoint_id": int(row["checkpoint_id"]),
                    "source_sequence": int(row["source_sequence"]),
                    "event_sequence": int(row["event_sequence"]),
                    "state_hash": str(row["state_hash"]),
                    "account_hash": str(row["account_hash"]),
                    "ledger_tail_hash": str(row["ledger_tail_hash"]),
                    "viewer_revision": int(row["viewer_revision"]),
                    "anchor_set_hash": str(row["anchor_set_hash"]),
                    "event_hash": str(row["event_hash"]),
                    "public_time": json.loads(str(row["public_time_json"])),
                    "detail": self._review_event_detail(connection, row),
                }
                for row in rows
            ]
            selected: dict[str, object] | None = events[-1]
            if event_id is not None:
                selected = next(
                    (item for item in events if item["event_id"] == event_id),
                    None,
                )
            if selected is None:
                raise TrainingRunError(
                    "REVIEW_EVENT_NOT_FOUND",
                    "review event is not in the immutable timeline",
                    status_code=404,
                )
            original_cursor = {
                "virtual_time_ms": int(run["virtual_time_ms"]),
                "source_sequence": int(run["source_sequence"]),
            }
            current_projection = self._review.projection(
                connection,
                run_id=run_id,
                virtual_time_ms=int(run["virtual_time_ms"]),
                source_sequence=int(run["source_sequence"]),
            )
            selected_row = next(
                row
                for row in rows
                if str(row["event_id"]) == selected["event_id"]
            )
            selected_projection = json.loads(str(selected_row["projection_json"]))
            if not isinstance(selected_projection, dict):
                raise TypeError("review projection is invalid")
            drawing_document = None
            drawing_hash = selected_projection.get("drawing_document_hash")
            if isinstance(drawing_hash, str):
                drawing_row = connection.execute(
                    """
                    SELECT document_json FROM replay_review_drawing_document
                    WHERE run_id = ? AND document_hash = ?
                    """,
                    (run_id, drawing_hash),
                ).fetchone()
                if drawing_row is None:
                    raise TrainingRunError(
                        "REVIEW_DRAWING_UNAVAILABLE",
                        "review drawing content is missing",
                        status_code=503,
                    )
                drawing_document = json.loads(str(drawing_row["document_json"]))
            now_ms = self.base_store._validated_now_ms()
            existing_review = connection.execute(
                """
                SELECT session.review_id, cursor.cursor_revision
                FROM replay_review_session AS session
                JOIN replay_review_cursor AS cursor USING(review_id)
                WHERE session.run_id = ?
                ORDER BY session.updated_at_ms DESC, session.review_id DESC
                LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            effective_review_id = (
                review_id
                if existing_review is None
                else str(existing_review["review_id"])
            )
            cursor_revision = (
                1
                if existing_review is None
                else int(existing_review["cursor_revision"]) + 1
            )
            if existing_review is None:
                connection.execute(
                    """
                    INSERT INTO replay_review_session(
                        review_id, run_id, event_id, checkpoint_id,
                        selected_state_hash, original_state_hash,
                        original_cursor_json, created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        effective_review_id,
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
                connection.execute(
                    """
                    INSERT INTO replay_review_cursor(
                        review_id, timeline_sequence, playback_state,
                        playback_rate, original_account_hash,
                        original_ledger_tail_hash, original_viewer_revision,
                        original_viewer_hash, cursor_revision, updated_at_ms
                    ) VALUES (?, ?, 'PAUSED', '1', ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        effective_review_id,
                        selected["timeline_sequence"],
                        current_projection["account_hash"],
                        run["ledger_tail_hash"],
                        run["semantic_view_revision"],
                        current_projection["viewer_hash"],
                        cursor_revision,
                        now_ms,
                    ),
                )
            else:
                connection.execute(
                    """
                    UPDATE replay_review_session
                    SET event_id = ?, checkpoint_id = ?,
                        selected_state_hash = ?, original_state_hash = ?,
                        original_cursor_json = ?, updated_at_ms = ?
                    WHERE review_id = ? AND run_id = ?
                    """,
                    (
                        selected["event_id"],
                        selected["checkpoint_id"],
                        selected["state_hash"],
                        run["state_hash"],
                        canonical_json(original_cursor),
                        now_ms,
                        effective_review_id,
                        run_id,
                    ),
                )
                connection.execute(
                    """
                    UPDATE replay_review_cursor
                    SET timeline_sequence = ?, playback_state = 'PAUSED',
                        playback_rate = '1', original_account_hash = ?,
                        original_ledger_tail_hash = ?,
                        original_viewer_revision = ?, original_viewer_hash = ?,
                        cursor_revision = ?, updated_at_ms = ?
                    WHERE review_id = ?
                    """,
                    (
                        selected["timeline_sequence"],
                        current_projection["account_hash"],
                        run["ledger_tail_hash"],
                        run["semantic_view_revision"],
                        current_projection["viewer_hash"],
                        cursor_revision,
                        now_ms,
                        effective_review_id,
                    ),
                )
            connection.execute(
                """
                UPDATE replay_data_segment_ref
                SET active = 0, released_at_ms = ?
                WHERE run_id = ? AND owner_kind = 'REVIEW'
                  AND owner_id != ? AND active = 1
                """,
                (now_ms, run_id, effective_review_id),
            )
            connection.execute(
                """
                DELETE FROM replay_review_session
                WHERE run_id = ? AND review_id != ?
                """,
                (run_id, effective_review_id),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO replay_data_segment_ref(
                    segment_id, run_id, track_id, owner_kind, owner_id,
                    active, created_at_ms, released_at_ms
                )
                SELECT segment_id, run_id, track_id, 'REVIEW', ?, 1, ?, NULL
                FROM replay_data_segment_ref
                WHERE run_id = ? AND owner_kind = 'RUN_ARCHIVE'
                """,
                (effective_review_id, now_ms, run_id),
            )
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "schema_version": REVIEW_TIMELINE_SCHEMA_VERSION,
                "review_id": effective_review_id,
                "run_id": run_id,
                "read_only": True,
                "selected_event_id": selected["event_id"],
                "selected_timeline_sequence": selected["timeline_sequence"],
                "selected_state_hash": selected["state_hash"],
                "original_state_hash": str(run["state_hash"]),
                "original_cursor": original_cursor,
                "dataset_epoch": str(run["dataset_epoch"]),
                "cursor_revision": cursor_revision,
                "playback_state": "PAUSED",
                "playback_rate": "1",
                "projection": self._public_review_projection(selected_projection),
                "drawing_document": drawing_document,
                "immutability_proof": {
                    "original_account_hash": current_projection["account_hash"],
                    "original_ledger_tail_hash": str(run["ledger_tail_hash"]),
                    "original_viewer_revision": int(
                        run["semantic_view_revision"]
                    ),
                    "original_viewer_hash": current_projection["viewer_hash"],
                    "verified": True,
                },
                "budget": self._review_budget(connection, run_id),
                "events": events,
                "jump_targets": [
                    {
                        "event_id": item["event_id"],
                        "event_type": item["event_type"],
                        "category": item["category"],
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
        def read(connection: sqlite3.Connection) -> tuple[sqlite3.Row, tuple[sqlite3.Row, ...]] | None:
            event = connection.execute(
                """
                SELECT event.*, run.dataset_epoch, run.adapter_session_id
                FROM replay_review_timeline_event AS event
                JOIN replay_training_run AS run USING(run_id)
                WHERE event.run_id = ? AND event.event_id = ?
                """,
                (run_id, event_id),
            ).fetchone()
            if event is None:
                return None
            anchors = tuple(
                connection.execute(
                    """
                    SELECT link.track_id, anchor.*
                    FROM replay_review_event_anchor AS link
                    JOIN replay_review_actor_anchor AS anchor
                      ON anchor.run_id = link.run_id
                     AND anchor.anchor_id = link.anchor_id
                    WHERE link.run_id = ? AND link.timeline_sequence = ?
                    ORDER BY link.track_id
                    """,
                    (run_id, event["timeline_sequence"]),
                ).fetchall()
            )
            return event, anchors

        result = await self.base_store.run_extension_read(read)
        if result is None:
            raise TrainingRunError(
                "REVIEW_EVENT_NOT_FOUND",
                "review event is not backed by immutable actor anchors",
                status_code=404,
            )
        row, anchors = result
        if not anchors:
            raise TrainingRunError(
                "REVIEW_ANCHOR_UNAVAILABLE",
                "review event has no actor anchors",
                status_code=503,
            )
        decoded_payloads: dict[str, bytes] = {}
        for anchor in anchors:
            stored_payload = bytes(anchor["payload"])
            encoding = str(anchor["payload_encoding"])
            stored_bytes = int(anchor["stored_bytes"])
            if stored_bytes == 0 and encoding == ANCHOR_PAYLOAD_ENCODING_RAW:
                stored_bytes = len(stored_payload)
            try:
                decoded_payloads[str(anchor["anchor_id"])] = decode_anchor_payload(
                    stored_payload,
                    encoding=encoding,
                    raw_bytes=int(anchor["payload_bytes"]),
                    stored_bytes=stored_bytes,
                    raw_sha256=str(anchor["payload_sha256"]),
                )
            except (TypeError, ValueError) as exc:
                raise TrainingRunError(
                    "REVIEW_ANCHOR_CORRUPT",
                    "review event actor anchor failed integrity validation",
                    status_code=503,
                    details={
                        "anchor_id": str(anchor["anchor_id"]),
                        "track_id": str(anchor["track_id"]),
                    },
                ) from exc
        primary = next(
            (
                anchor
                for anchor in anchors
                if str(anchor["track_id"]) == "track-1"
            ),
            anchors[0],
        )
        return {
            "run_id": run_id,
            "adapter_session_id": str(primary["adapter_session_id"]),
            "event_id": event_id,
            "timeline_sequence": int(row["timeline_sequence"]),
            "checkpoint_id": int(primary["checkpoint_id"]),
            "state_hash": str(row["state_hash"]),
            "primary_state_hash": str(primary["state_hash"]),
            "source_sequence": int(row["source_sequence"]),
            "event_sequence": int(row["event_sequence"]),
            "dataset_epoch": str(row["dataset_epoch"]),
            "anchor_set_hash": str(row["anchor_set_hash"]),
            "projection": json.loads(str(row["projection_json"])),
            "anchors": [
                {
                    "track_id": str(anchor["track_id"]),
                    "anchor_id": str(anchor["anchor_id"]),
                    "adapter_session_id": str(anchor["adapter_session_id"]),
                    "checkpoint_id": int(anchor["checkpoint_id"]),
                    "state_hash": str(anchor["state_hash"]),
                    "source_sequence": int(anchor["source_sequence"]),
                    "event_sequence": int(anchor["event_sequence"]),
                    "virtual_time_ms": int(anchor["virtual_time_ms"]),
                    "dataset_epoch": str(anchor["dataset_epoch"]),
                    "payload": decoded_payloads[str(anchor["anchor_id"])],
                    "payload_sha256": str(anchor["payload_sha256"]),
                }
                for anchor in anchors
            ],
        }

    async def control_review(
        self,
        *,
        run_id: str,
        review_id: str,
        action: str,
        event_id: str | None,
        expected_cursor_revision: int,
        playback_rate: str | None,
    ) -> dict[str, object]:
        def write(connection: sqlite3.Connection) -> dict[str, object]:
            review = connection.execute(
                """
                SELECT session.*, cursor.timeline_sequence,
                       cursor.playback_state, cursor.playback_rate,
                       cursor.original_account_hash,
                       cursor.original_ledger_tail_hash,
                       cursor.original_viewer_revision,
                       cursor.original_viewer_hash,
                       cursor.cursor_revision,
                       run.virtual_time_ms, run.source_sequence,
                       run.dataset_epoch, actor.state_hash AS current_state_hash,
                       account.ledger_tail_hash,
                       viewer.semantic_view_revision
                FROM replay_review_session AS session
                JOIN replay_review_cursor AS cursor USING(review_id)
                JOIN replay_training_run AS run USING(run_id)
                JOIN replay_session AS actor
                  ON actor.session_id = run.adapter_session_id
                JOIN replay_training_contract_account AS account USING(run_id)
                JOIN replay_training_viewer_state AS viewer USING(run_id)
                WHERE session.review_id = ? AND session.run_id = ?
                """,
                (review_id, run_id),
            ).fetchone()
            if review is None:
                raise TrainingRunError(
                    "REVIEW_SESSION_NOT_FOUND",
                    "review session does not exist",
                    status_code=404,
                )
            if int(review["cursor_revision"]) != expected_cursor_revision:
                raise TrainingRunError(
                    "REVIEW_CURSOR_CONFLICT",
                    "review cursor revision does not match",
                    status_code=409,
                    details={
                        "expected": expected_cursor_revision,
                        "actual": int(review["cursor_revision"]),
                    },
                )
            original_cursor = json.loads(str(review["original_cursor_json"]))
            current_projection = self._review.projection(
                connection,
                run_id=run_id,
                virtual_time_ms=int(review["virtual_time_ms"]),
                source_sequence=int(review["source_sequence"]),
            )
            unchanged = (
                str(review["current_state_hash"]) == str(review["original_state_hash"])
                and int(review["virtual_time_ms"])
                == int(original_cursor["virtual_time_ms"])
                and int(review["source_sequence"])
                == int(original_cursor["source_sequence"])
                and str(current_projection["account_hash"])
                == str(review["original_account_hash"])
                and str(review["ledger_tail_hash"])
                == str(review["original_ledger_tail_hash"])
                and int(review["semantic_view_revision"])
                == int(review["original_viewer_revision"])
                and str(current_projection["viewer_hash"])
                == str(review["original_viewer_hash"])
            )
            if not unchanged:
                raise TrainingRunError(
                    "REVIEW_ORIGINAL_RUN_CHANGED",
                    "original run changed while ReviewMode was active",
                    status_code=409,
                    details={"review_mutated_original": False},
                )
            current_sequence = int(review["timeline_sequence"])
            target_sequence = current_sequence
            state = str(review["playback_state"])
            rate = str(review["playback_rate"])
            if action == "JUMP":
                target = connection.execute(
                    """
                    SELECT timeline_sequence
                    FROM replay_review_timeline_event
                    WHERE run_id = ? AND event_id = ?
                    """,
                    (run_id, event_id),
                ).fetchone()
                if target is None:
                    raise TrainingRunError(
                        "REVIEW_EVENT_NOT_FOUND",
                        "review event is not in the immutable timeline",
                        status_code=404,
                    )
                target_sequence = int(target["timeline_sequence"])
                state = "PAUSED"
            elif action in {"NEXT", "PREVIOUS"}:
                operator = ">" if action == "NEXT" else "<"
                direction = "ASC" if action == "NEXT" else "DESC"
                target = connection.execute(
                    f"""
                    SELECT timeline_sequence
                    FROM replay_review_timeline_event
                    WHERE run_id = ? AND timeline_sequence {operator} ?
                    ORDER BY timeline_sequence {direction} LIMIT 1
                    """,
                    (run_id, current_sequence),
                ).fetchone()
                if target is not None:
                    target_sequence = int(target["timeline_sequence"])
                state = (
                    "PLAYING"
                    if action == "NEXT"
                    and state == "PLAYING"
                    and target is not None
                    else "PAUSED"
                )
            elif action == "PLAY":
                if playback_rate not in {"0.25", "0.5", "1", "2", "4", "8"}:
                    raise TrainingRunError(
                        "REVIEW_CONTROL_INVALID",
                        "review playback rate is unsupported",
                        status_code=422,
                    )
                state = "PLAYING"
                rate = str(playback_rate)
            elif action == "PAUSE":
                state = "PAUSED"
            else:
                raise TrainingRunError(
                    "REVIEW_CONTROL_INVALID",
                    "review control action is unsupported",
                    status_code=422,
                )
            selected = connection.execute(
                """
                SELECT * FROM replay_review_timeline_event
                WHERE run_id = ? AND timeline_sequence = ?
                """,
                (run_id, target_sequence),
            ).fetchone()
            if selected is None:
                raise TypeError("review cursor target is missing")
            next_revision = int(review["cursor_revision"]) + 1
            now_ms = self.base_store._validated_now_ms()
            connection.execute(
                """
                UPDATE replay_review_cursor
                SET timeline_sequence = ?, playback_state = ?,
                    playback_rate = ?, cursor_revision = ?, updated_at_ms = ?
                WHERE review_id = ?
                """,
                (
                    target_sequence,
                    state,
                    rate,
                    next_revision,
                    now_ms,
                    review_id,
                ),
            )
            connection.execute(
                """
                UPDATE replay_review_session
                SET event_id = ?, selected_state_hash = ?, updated_at_ms = ?
                WHERE review_id = ?
                """,
                (
                    selected["event_id"],
                    selected["state_hash"],
                    now_ms,
                    review_id,
                ),
            )
            projection = json.loads(str(selected["projection_json"]))
            if not isinstance(projection, dict):
                raise TypeError("review projection is invalid")
            drawing = None
            drawing_hash = projection.get("drawing_document_hash")
            if isinstance(drawing_hash, str):
                row = connection.execute(
                    """
                    SELECT document_json FROM replay_review_drawing_document
                    WHERE run_id = ? AND document_hash = ?
                    """,
                    (run_id, drawing_hash),
                ).fetchone()
                if row is None:
                    raise TypeError("review drawing document is missing")
                drawing = json.loads(str(row["document_json"]))
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "schema_version": REVIEW_TIMELINE_SCHEMA_VERSION,
                "review_id": review_id,
                "run_id": run_id,
                "read_only": True,
                "selected_event_id": str(selected["event_id"]),
                "selected_timeline_sequence": target_sequence,
                "selected_state_hash": str(selected["state_hash"]),
                "original_state_hash": str(review["original_state_hash"]),
                "cursor_revision": next_revision,
                "playback_state": state,
                "playback_rate": rate,
                "selected_event": {
                    "event_id": str(selected["event_id"]),
                    "event_type": str(selected["event_type"]),
                    "category": str(selected["category"]),
                    "timeline_sequence": int(selected["timeline_sequence"]),
                    "public_time": json.loads(str(selected["public_time_json"])),
                    "detail": self._review_event_detail(connection, selected),
                },
                "projection": self._public_review_projection(projection),
                "drawing_document": drawing,
                "immutability_proof": {
                    "original_account_hash": str(
                        review["original_account_hash"]
                    ),
                    "original_ledger_tail_hash": str(
                        review["original_ledger_tail_hash"]
                    ),
                    "original_viewer_revision": int(
                        review["original_viewer_revision"]
                    ),
                    "original_viewer_hash": str(
                        review["original_viewer_hash"]
                    ),
                    "verified": True,
                },
                "budget": self._review_budget(connection, run_id),
            }

        return await self.base_store.run_extension_write(write)

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
            run = connection.execute(
                "SELECT adapter_session_id FROM replay_training_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if run is None:
                raise TypeError("viewer run is missing")
            self._append_review_timeline_event(
                connection,
                run_id=run_id,
                session_id=str(run["adapter_session_id"]),
                context={
                    "kind": "DIRECT",
                    "category": "VIEWER",
                    "event_type": "SET_DISPLAY_INTERVAL",
                    "command_id": command_id,
                },
                state=None,
                checkpoint=None,
                now_ms=now_ms,
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

    async def begin_period_summary_build(
        self,
        *,
        run_id: str,
        set_id: str,
    ) -> dict[str, object]:
        """Persist a visible single-flight marker without publishing candidates."""

        now_ms = self.base_store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> dict[str, object]:
            exists = connection.execute(
                "SELECT 1 FROM replay_training_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if exists is None:
                raise TrainingRunError(
                    "TRAINING_RUN_NOT_FOUND",
                    "training run does not exist",
                    status_code=404,
                )
            active = connection.execute(
                """
                SELECT set_id FROM replay_training_fast_forward_summary_set
                WHERE run_id = ? AND status = 'PREPARING'
                """,
                (run_id,),
            ).fetchone()
            if active is not None:
                raise TrainingRunError(
                    "PERIOD_SUMMARY_BUILD_ACTIVE",
                    "a period-summary build is already active for this run",
                    status_code=409,
                    details={"set_id": str(active["set_id"])},
                )
            connection.execute(
                """
                INSERT INTO replay_training_fast_forward_summary_set(
                    set_id, run_id, schema_version, algorithm_version,
                    status, active, metadata_json, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, 'PREPARING', 0, '{}', ?, ?)
                """,
                (
                    set_id,
                    run_id,
                    PERIOD_SUMMARY_SET_SCHEMA_VERSION,
                    PERIOD_SUMMARY_ALGORITHM_VERSION,
                    now_ms,
                    now_ms,
                ),
            )
            return {
                "set_id": set_id,
                "status": "PREPARING",
                "created_at_ms": now_ms,
            }

        return await self.base_store.run_extension_write(write)

    async def finish_period_summary_build(
        self,
        *,
        run_id: str,
        set_id: str,
        metadata: Mapping[str, object],
        build_proof_hash: str,
        candidates: Sequence[EncodedPeriodSummaryCandidate],
        source_event_count: int,
        build_wall_ms: int,
        build_cpu_ms: int,
    ) -> dict[str, object]:
        """Atomically publish a complete checksum-verified summary generation."""

        if not 1 <= len(candidates) <= MAX_PERIOD_SUMMARY_CANDIDATES:
            raise ValueError("period summary candidate count is outside its budget")
        if canonical_sha256(metadata) != build_proof_hash:
            raise ValueError("period summary build proof does not match metadata")
        total_compressed = 0
        total_raw = 0
        normalized: list[
            tuple[str, int, int, int, str, str, bytes, int, str]
        ] = []
        previous_end = -1
        common_fields = (
            "run_id",
            "session_id",
            "source_kind",
            "data_epoch",
            "snapshot_ref_hash",
            "session_config_hash",
            "execution_version",
            "rule_revision",
            "rule_hash",
            "base_source_sequence",
            "base_domain_command_position",
            "base_event_chain_hash",
            "base_component_state_hash",
            "algorithm_version",
            "schema_version",
        )
        common_reference: dict[str, object] | None = None
        candidate_hashes: list[str] = []
        candidate_ids: set[str] = set()
        for candidate in candidates:
            if not isinstance(candidate, EncodedPeriodSummaryCandidate):
                raise TypeError(
                    "period summary build candidate has an incompatible type"
                )
            summary = candidate.decode()
            if summary.run_id != run_id:
                raise ValueError("period summary candidate belongs to another run")
            if summary.end_source_sequence <= previous_end:
                raise ValueError("period summary candidates are not strictly ordered")
            if summary.summary_id in candidate_ids:
                raise ValueError("period summary candidate IDs are not unique")
            observed_common = {
                field_name: getattr(summary, field_name)
                for field_name in common_fields
            }
            if common_reference is None:
                common_reference = observed_common
            elif observed_common != common_reference:
                raise ValueError(
                    "period summary candidates do not share one immutable base"
                )
            component_blob = candidate.component_blob
            raw_bytes = candidate.component_raw_bytes
            blob_hash = candidate.component_blob_hash
            total_compressed += len(component_blob)
            total_raw += raw_bytes
            if total_compressed > MAX_PERIOD_SUMMARY_TOTAL_COMPRESSED_BYTES:
                raise ValueError("period summary set exceeds its compressed byte budget")
            normalized.append(
                (
                    summary.summary_id,
                    summary.end_source_sequence,
                    summary.end_virtual_time_ms,
                    summary.event_count,
                    str(summary.summary_hash),
                    canonical_json(summary.to_dict(include_component_state=False)),
                    bytes(component_blob),
                    raw_bytes,
                    blob_hash,
                )
            )
            candidate_ids.add(summary.summary_id)
            candidate_hashes.append(str(summary.summary_hash))
            previous_end = summary.end_source_sequence
            del summary
        assert common_reference is not None
        for field_name, value in (
            ("source_event_count", source_event_count),
            ("build_wall_ms", build_wall_ms),
            ("build_cpu_ms", build_cpu_ms),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{field_name} must be a non-negative integer")
        expected_metadata = {
            "schema_version": "replay.period-summary-build-proof.v1",
            "algorithm_version": PERIOD_SUMMARY_ALGORITHM_VERSION,
            "set_id": set_id,
            "run_id": run_id,
            "session_id": common_reference["session_id"],
            "source_kind": common_reference["source_kind"],
            "data_epoch": common_reference["data_epoch"],
            "snapshot_ref_hash": common_reference["snapshot_ref_hash"],
            "session_config_hash": common_reference["session_config_hash"],
            "execution_version": common_reference["execution_version"],
            "rule_revision": common_reference["rule_revision"],
            "rule_hash": common_reference["rule_hash"],
            "base_source_sequence": common_reference[
                "base_source_sequence"
            ],
            "base_domain_command_position": (
                common_reference["base_domain_command_position"]
            ),
            "base_event_chain_hash": common_reference[
                "base_event_chain_hash"
            ],
            "base_component_state_hash": (
                common_reference["base_component_state_hash"]
            ),
            "candidate_summary_hashes": candidate_hashes,
            "source_event_count": (
                normalized[-1][1]
                - int(common_reference["base_source_sequence"])
            ),
            "candidate_count": len(normalized),
            "compressed_bytes": total_compressed,
        }
        if dict(metadata) != expected_metadata:
            raise ValueError(
                "period summary build metadata does not match its candidates"
            )
        if source_event_count != expected_metadata["source_event_count"]:
            raise ValueError(
                "period summary source event count does not match its candidates"
            )
        metadata_json = canonical_json(metadata)
        now_ms = self.base_store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> dict[str, object]:
            build = connection.execute(
                """
                SELECT status FROM replay_training_fast_forward_summary_set
                WHERE run_id = ? AND set_id = ?
                """,
                (run_id, set_id),
            ).fetchone()
            if build is None:
                raise TrainingRunError(
                    "PERIOD_SUMMARY_BUILD_NOT_FOUND",
                    "period-summary build marker does not exist",
                    status_code=404,
                )
            if str(build["status"]) != "PREPARING":
                raise TrainingRunError(
                    "PERIOD_SUMMARY_BUILD_NOT_ACTIVE",
                    "period-summary build is not preparing",
                    status_code=409,
                )
            connection.execute(
                """
                UPDATE replay_training_fast_forward_summary_set
                SET active = 0
                WHERE run_id = ? AND active = 1
                """,
                (run_id,),
            )
            for (
                summary_id,
                end_source_sequence,
                end_virtual_time_ms,
                event_count,
                summary_hash,
                summary_json,
                blob,
                raw_bytes,
                blob_hash,
            ) in normalized:
                connection.execute(
                    """
                    INSERT INTO replay_training_fast_forward_summary(
                        set_id, run_id, summary_id, end_source_sequence,
                        end_virtual_time_ms, event_count, summary_hash,
                        metadata_json, component_blob, component_raw_bytes,
                        component_blob_hash, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        set_id,
                        run_id,
                        summary_id,
                        end_source_sequence,
                        end_virtual_time_ms,
                        event_count,
                        summary_hash,
                        summary_json,
                        blob,
                        raw_bytes,
                        blob_hash,
                        now_ms,
                    ),
                )
            connection.execute(
                """
                UPDATE replay_training_fast_forward_summary_set
                SET status = 'READY', active = 1, metadata_json = ?,
                    build_proof_hash = ?, candidate_count = ?,
                    source_event_count = ?, raw_state_bytes = ?,
                    compressed_bytes = ?, build_wall_ms = ?,
                    build_cpu_ms = ?, error_code = NULL, error_message = NULL,
                    updated_at_ms = ?
                WHERE run_id = ? AND set_id = ? AND status = 'PREPARING'
                """,
                (
                    metadata_json,
                    build_proof_hash,
                    len(normalized),
                    source_event_count,
                    total_raw,
                    total_compressed,
                    build_wall_ms,
                    build_cpu_ms,
                    now_ms,
                    run_id,
                    set_id,
                ),
            )
            return {
                "set_id": set_id,
                "status": "READY",
                "candidate_count": len(normalized),
                "source_event_count": source_event_count,
                "raw_state_bytes": total_raw,
                "compressed_bytes": total_compressed,
                "build_wall_ms": build_wall_ms,
                "build_cpu_ms": build_cpu_ms,
                "build_proof_hash": build_proof_hash,
            }

        return await self.base_store.run_extension_write(write)

    async def fail_period_summary_build(
        self,
        *,
        run_id: str,
        set_id: str,
        cancelled: bool,
        error_code: str,
        error_message: str,
    ) -> None:
        now_ms = self.base_store._validated_now_ms()
        status = "CANCELLED" if cancelled else "FAILED"

        def write(connection: sqlite3.Connection) -> None:
            connection.execute(
                """
                UPDATE replay_training_fast_forward_summary_set
                SET status = ?, active = 0, error_code = ?, error_message = ?,
                    updated_at_ms = ?
                WHERE run_id = ? AND set_id = ? AND status = 'PREPARING'
                """,
                (
                    status,
                    error_code[:100],
                    error_message[:500],
                    now_ms,
                    run_id,
                    set_id,
                ),
            )

        await self.base_store.run_extension_write(write)

    async def period_summary_status(self, run_id: str) -> dict[str, object]:
        def read(
            connection: sqlite3.Connection,
        ) -> tuple[sqlite3.Row | None, sqlite3.Row | None]:
            latest = connection.execute(
                """
                SELECT * FROM replay_training_fast_forward_summary_set
                WHERE run_id = ?
                ORDER BY updated_at_ms DESC, rowid DESC
                LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            active = connection.execute(
                """
                SELECT * FROM replay_training_fast_forward_summary_set
                WHERE run_id = ? AND active = 1 AND status = 'READY'
                LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            return latest, active

        latest, active = await self.base_store.run_extension_read(read)

        def public(row: sqlite3.Row | None) -> dict[str, object] | None:
            if row is None:
                return None
            return {
                "set_id": str(row["set_id"]),
                "status": str(row["status"]),
                "active": bool(row["active"]),
                "algorithm_version": str(row["algorithm_version"]),
                "candidate_count": int(row["candidate_count"]),
                "source_event_count": int(row["source_event_count"]),
                "raw_state_bytes": int(row["raw_state_bytes"]),
                "compressed_bytes": int(row["compressed_bytes"]),
                "build_wall_ms": int(row["build_wall_ms"]),
                "build_cpu_ms": int(row["build_cpu_ms"]),
                "build_proof_hash": row["build_proof_hash"],
                "error_code": row["error_code"],
                "error_message": row["error_message"],
            }

        return {
            "schema_version": PERIOD_SUMMARY_SET_SCHEMA_VERSION,
            "latest_build": public(latest),
            "active_set": public(active),
            "limits": {
                "max_candidates": MAX_PERIOD_SUMMARY_CANDIDATES,
                "max_total_compressed_bytes": (
                    MAX_PERIOD_SUMMARY_TOTAL_COMPRESSED_BYTES
                ),
            },
        }

    async def period_summary_candidate(
        self,
        *,
        run_id: str,
        current_source_sequence: int,
        target_virtual_time_ms: int,
        identity: Mapping[str, object],
    ) -> dict[str, object]:
        """Load at most one active candidate and validate every persisted byte."""

        def read(
            connection: sqlite3.Connection,
        ) -> tuple[sqlite3.Row, tuple[sqlite3.Row, ...]] | None:
            row = connection.execute(
                """
                SELECT candidate.*, summary_set.metadata_json AS set_metadata_json,
                       summary_set.build_proof_hash,
                       summary_set.algorithm_version AS set_algorithm_version,
                       summary_set.candidate_count AS set_candidate_count,
                       summary_set.source_event_count AS set_source_event_count,
                       summary_set.raw_state_bytes AS set_raw_state_bytes,
                       summary_set.compressed_bytes AS set_compressed_bytes
                FROM replay_training_fast_forward_summary AS candidate
                JOIN replay_training_fast_forward_summary_set AS summary_set
                  ON summary_set.set_id = candidate.set_id
                WHERE candidate.run_id = ?
                  AND summary_set.run_id = candidate.run_id
                  AND summary_set.status = 'READY'
                  AND summary_set.active = 1
                  AND candidate.end_source_sequence > ?
                  AND candidate.end_virtual_time_ms <= ?
                ORDER BY candidate.end_virtual_time_ms DESC,
                         candidate.end_source_sequence DESC
                LIMIT 1
                """,
                (
                    run_id,
                    current_source_sequence,
                    target_virtual_time_ms,
                ),
            ).fetchone()
            if row is None:
                return None
            generation = tuple(
                connection.execute(
                    """
                    SELECT summary_hash, end_source_sequence,
                           length(component_blob) AS component_blob_bytes,
                           component_raw_bytes
                    FROM replay_training_fast_forward_summary
                    WHERE set_id = ? AND run_id = ?
                    ORDER BY end_source_sequence ASC, summary_id ASC
                    """,
                    (str(row["set_id"]), run_id),
                ).fetchall()
            )
            return row, generation

        loaded = await self.base_store.run_extension_read(read)
        if loaded is None:
            return {
                "status": "UNAVAILABLE",
                "reason_code": "NO_CANDIDATE_IN_RANGE",
                "summary": None,
            }
        row, generation = loaded
        try:
            set_metadata = json.loads(str(row["set_metadata_json"]))
            generation_hashes = [
                str(candidate["summary_hash"]) for candidate in generation
            ]
            generation_sequences = [
                int(candidate["end_source_sequence"])
                for candidate in generation
            ]
            generation_compressed_bytes = sum(
                int(candidate["component_blob_bytes"])
                for candidate in generation
            )
            generation_raw_bytes = sum(
                int(candidate["component_raw_bytes"])
                for candidate in generation
            )
            if (
                not isinstance(set_metadata, dict)
                or canonical_sha256(set_metadata) != str(row["build_proof_hash"])
                or str(row["set_algorithm_version"])
                != PERIOD_SUMMARY_ALGORITHM_VERSION
                or not 1
                <= int(row["set_candidate_count"])
                <= MAX_PERIOD_SUMMARY_CANDIDATES
                or len(generation) != int(row["set_candidate_count"])
                or any(
                    current <= previous
                    for previous, current in zip(
                        generation_sequences,
                        generation_sequences[1:],
                    )
                )
                or not 1
                <= int(row["set_compressed_bytes"])
                <= MAX_PERIOD_SUMMARY_TOTAL_COMPRESSED_BYTES
                or generation_compressed_bytes
                != int(row["set_compressed_bytes"])
                or generation_raw_bytes != int(row["set_raw_state_bytes"])
                or set_metadata.get("algorithm_version")
                != str(row["set_algorithm_version"])
                or set_metadata.get("set_id") != str(row["set_id"])
                or set_metadata.get("run_id") != run_id
                or set_metadata.get("candidate_count")
                != int(row["set_candidate_count"])
                or set_metadata.get("source_event_count")
                != int(row["set_source_event_count"])
                or set_metadata.get("compressed_bytes")
                != int(row["set_compressed_bytes"])
                or set_metadata.get("candidate_summary_hashes")
                != generation_hashes
            ):
                raise ValueError("period summary set proof is invalid")
            metadata = json.loads(str(row["metadata_json"]))
            if not isinstance(metadata, dict):
                raise ValueError("summary metadata is not an object")
            component_state = decode_component_state(
                bytes(row["component_blob"]),
                expected_raw_bytes=int(row["component_raw_bytes"]),
                expected_blob_hash=str(row["component_blob_hash"]),
                expected_state_hash=str(metadata["end_component_state_hash"]),
            )
            summary = ReplayPeriodSummary.from_dict(
                {**metadata, "end_component_state": component_state}
            )
            if (
                summary.summary_hash != str(row["summary_hash"])
                or summary.summary_id != str(row["summary_id"])
                or summary.end_source_sequence != int(row["end_source_sequence"])
                or summary.end_virtual_time_ms != int(row["end_virtual_time_ms"])
                or summary.event_count != int(row["event_count"])
            ):
                raise ValueError("period summary indexed fields changed")
            summary_hashes = generation_hashes
            if (
                summary.summary_hash not in summary_hashes
                or len(set(summary_hashes)) != len(summary_hashes)
            ):
                raise ValueError("period summary build proof omitted its candidate")
            set_identity = {
                "session_id": set_metadata.get("session_id"),
                "source_kind": set_metadata.get("source_kind"),
                "data_epoch": set_metadata.get("data_epoch"),
                "snapshot_ref_hash": set_metadata.get("snapshot_ref_hash"),
                "session_config_hash": set_metadata.get("session_config_hash"),
                "execution_version": set_metadata.get("execution_version"),
                "rule_revision": set_metadata.get("rule_revision"),
                "rule_hash": set_metadata.get("rule_hash"),
                "base_source_sequence": set_metadata.get(
                    "base_source_sequence"
                ),
                "base_domain_command_position": set_metadata.get(
                    "base_domain_command_position"
                ),
                "base_event_chain_hash": set_metadata.get(
                    "base_event_chain_hash"
                ),
                "base_component_state_hash": set_metadata.get(
                    "base_component_state_hash"
                ),
            }
            summary_identity = {
                "session_id": summary.session_id,
                "source_kind": summary.source_kind,
                "data_epoch": summary.data_epoch,
                "snapshot_ref_hash": summary.snapshot_ref_hash,
                "session_config_hash": summary.session_config_hash,
                "execution_version": summary.execution_version,
                "rule_revision": summary.rule_revision,
                "rule_hash": summary.rule_hash,
                "base_source_sequence": summary.base_source_sequence,
                "base_domain_command_position": (
                    summary.base_domain_command_position
                ),
                "base_event_chain_hash": summary.base_event_chain_hash,
                "base_component_state_hash": (
                    summary.base_component_state_hash
                ),
            }
            if set_identity != summary_identity:
                raise ValueError(
                    "period summary candidate does not match its set proof"
                )
            expected_identity = {
                key: identity[key]
                for key in (
                    "session_id",
                    "source_kind",
                    "data_epoch",
                    "snapshot_ref_hash",
                    "session_config_hash",
                    "execution_version",
                    "rule_revision",
                    "rule_hash",
                )
            }
            observed_identity = {
                "session_id": summary.session_id,
                "source_kind": summary.source_kind,
                "data_epoch": summary.data_epoch,
                "snapshot_ref_hash": summary.snapshot_ref_hash,
                "session_config_hash": summary.session_config_hash,
                "execution_version": summary.execution_version,
                "rule_revision": summary.rule_revision,
                "rule_hash": summary.rule_hash,
            }
            if observed_identity != expected_identity:
                return {
                    "status": "INCOMPATIBLE",
                    "reason_code": "SUMMARY_IDENTITY_MISMATCH",
                    "summary": None,
                }
            if not (
                summary.base_source_sequence
                <= current_source_sequence
                < summary.end_source_sequence
            ):
                return {
                    "status": "INCOMPATIBLE",
                    "reason_code": "SUMMARY_RANGE_MISMATCH",
                    "summary": None,
                }
        except (KeyError, TypeError, ValueError):
            return {
                "status": "CORRUPT",
                "reason_code": "SUMMARY_VALIDATION_FAILED",
                "summary": None,
            }
        return {
            "status": "READY",
            "reason_code": "EXACT_SUMMARY_CANDIDATE",
            "set_id": str(row["set_id"]),
            "build_proof_hash": str(row["build_proof_hash"]),
            "summary": summary,
        }

    async def get_advance_intent(
        self,
        *,
        run_id: str,
        command_id: str,
        command: Mapping[str, object],
    ) -> dict[str, object] | None:
        command_json = canonical_json(command)

        def read(connection: sqlite3.Connection) -> sqlite3.Row | None:
            return connection.execute(
                """
                SELECT * FROM replay_training_advance_intent
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()

        row = await self.base_store.run_extension_read(read)
        if row is None:
            return None
        if str(row["command_json"]) != command_json:
            raise TrainingRunError(
                "COMMAND_ID_REUSED",
                "command_id was reused with a different advance command",
                status_code=409,
            )
        return self._advance_intent_from_row(row)

    async def begin_advance_intent(
        self,
        *,
        run_id: str,
        command_id: str,
        command: Mapping[str, object],
        session_id: str,
        initial_cursor: Mapping[str, object],
        target_virtual_time_ms: int,
        plan: Mapping[str, object],
        summary: ReplayPeriodSummary | None,
    ) -> dict[str, object]:
        command_json = canonical_json(command)
        command_hash = canonical_sha256(command)
        cursor_json = canonical_json(initial_cursor)
        plan_json = canonical_json(plan)
        now_ms = self.base_store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> sqlite3.Row:
            existing = connection.execute(
                """
                SELECT * FROM replay_training_advance_intent
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            if existing is not None:
                if str(existing["command_json"]) != command_json:
                    raise TrainingRunError(
                        "COMMAND_ID_REUSED",
                        "command_id conflicts with a durable advance intent",
                        status_code=409,
                    )
                return existing
            connection.execute(
                """
                INSERT INTO replay_training_advance_intent(
                    run_id, command_id, schema_version, command_json,
                    command_hash, session_id, initial_cursor_json,
                    target_virtual_time_ms, plan_json, summary_id,
                    summary_hash, status, latest_cursor_json,
                    created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)
                """,
                (
                    run_id,
                    command_id,
                    ADVANCE_INTENT_SCHEMA_VERSION,
                    command_json,
                    command_hash,
                    session_id,
                    cursor_json,
                    target_virtual_time_ms,
                    plan_json,
                    summary.summary_id if summary is not None else None,
                    summary.summary_hash if summary is not None else None,
                    cursor_json,
                    now_ms,
                    now_ms,
                ),
            )
            created = connection.execute(
                """
                SELECT * FROM replay_training_advance_intent
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            assert created is not None
            return created

        return self._advance_intent_from_row(
            await self.base_store.run_extension_write(write)
        )

    async def update_advance_intent_cursor(
        self,
        *,
        run_id: str,
        command_id: str,
        cursor: Mapping[str, object],
    ) -> None:
        for field_name in ("virtual_time_ms", "source_sequence"):
            value = cursor.get(field_name)
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or value < 0
            ):
                raise ValueError(
                    f"advance intent cursor {field_name} is invalid"
                )
        cursor_json = canonical_json(cursor)
        now_ms = self.base_store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> None:
            row = connection.execute(
                """
                SELECT status, latest_cursor_json
                FROM replay_training_advance_intent
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            if row is None:
                raise TrainingRunError(
                    "ADVANCE_INTENT_NOT_FOUND",
                    "durable advance intent does not exist",
                    status_code=503,
                )
            if str(row["status"]) != "RUNNING":
                raise TrainingRunError(
                    "ADVANCE_INTENT_NOT_RUNNING",
                    "durable advance intent is not running",
                    status_code=409,
                )
            try:
                previous = json.loads(str(row["latest_cursor_json"]))
            except json.JSONDecodeError as exc:
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "durable advance latest cursor is invalid",
                    status_code=503,
                ) from exc
            if not isinstance(previous, dict):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "durable advance latest cursor is invalid",
                    status_code=503,
                )
            for field_name in ("virtual_time_ms", "source_sequence"):
                prior = previous.get(field_name)
                current = cursor[field_name]
                if (
                    isinstance(prior, bool)
                    or not isinstance(prior, int)
                    or prior < 0
                    or int(current) < prior
                ):
                    raise TrainingRunError(
                        "ADVANCE_INTENT_CURSOR_REGRESSION",
                        "durable advance cursor cannot move backward",
                        status_code=503,
                    )
            updated = connection.execute(
                """
                UPDATE replay_training_advance_intent
                SET latest_cursor_json = ?, updated_at_ms = ?
                WHERE run_id = ? AND command_id = ? AND status = 'RUNNING'
                """,
                (cursor_json, now_ms, run_id, command_id),
            )
            if updated.rowcount != 1:
                raise TrainingRunError(
                    "ADVANCE_INTENT_NOT_RUNNING",
                    "durable advance intent stopped before cursor update",
                    status_code=409,
                )

        await self.base_store.run_extension_write(write)

    async def finish_advance_intent(
        self,
        *,
        run_id: str,
        command_id: str,
        result: Mapping[str, object],
        cancelled: bool,
    ) -> None:
        result_json = canonical_json(result)
        now_ms = self.base_store._validated_now_ms()
        status = "CANCELLED" if cancelled else "COMPLETED"

        def write(connection: sqlite3.Connection) -> None:
            row = connection.execute(
                """
                SELECT status, result_json
                FROM replay_training_advance_intent
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            if row is None:
                raise TrainingRunError(
                    "ADVANCE_INTENT_NOT_FOUND",
                    "durable advance intent does not exist",
                    status_code=503,
                )
            if str(row["status"]) in {"COMPLETED", "CANCELLED"}:
                if (
                    str(row["status"]) != status
                    or str(row["result_json"]) != result_json
                ):
                    raise TrainingRunError(
                        "COMMAND_ID_REUSED",
                        "durable advance result conflicts with its prior result",
                        status_code=409,
                    )
                return
            connection.execute(
                """
                UPDATE replay_training_advance_intent
                SET status = ?, result_json = ?, updated_at_ms = ?
                WHERE run_id = ? AND command_id = ? AND status = 'RUNNING'
                """,
                (status, result_json, now_ms, run_id, command_id),
            )

        await self.base_store.run_extension_write(write)

    @staticmethod
    def _advance_intent_from_row(row: sqlite3.Row) -> dict[str, object]:
        def object_json(column: str, label: str) -> dict[str, object]:
            raw = str(row[column])
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    f"durable advance {label} JSON is invalid",
                    status_code=503,
                ) from exc
            if not isinstance(value, dict) or canonical_json(value) != raw:
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    f"durable advance {label} JSON is not canonical",
                    status_code=503,
                )
            return value

        def valid_cursor(value: Mapping[str, object]) -> bool:
            for field_name in ("virtual_time_ms", "source_sequence"):
                field = value.get(field_name)
                if (
                    isinstance(field, bool)
                    or not isinstance(field, int)
                    or field < 0
                ):
                    return False
            revision = value.get("revision")
            return (
                revision is None
                or (
                    not isinstance(revision, bool)
                    and isinstance(revision, int)
                    and revision >= 0
                )
            )

        command = object_json("command_json", "command")
        initial_cursor = object_json("initial_cursor_json", "initial cursor")
        latest_cursor = object_json("latest_cursor_json", "latest cursor")
        plan = object_json("plan_json", "plan")
        result = (
            None
            if row["result_json"] is None
            else object_json("result_json", "result")
        )
        command_hash = str(row["command_hash"])
        summary_id = row["summary_id"]
        summary_hash = row["summary_hash"]
        digest_valid = (
            len(command_hash) == 71
            and command_hash.startswith("sha256:")
            and all(value in "0123456789abcdef" for value in command_hash[7:])
        )
        summary_digest_valid = (
            summary_hash is None
            or (
                isinstance(summary_hash, str)
                and len(summary_hash) == 71
                and summary_hash.startswith("sha256:")
                and all(
                    value in "0123456789abcdef"
                    for value in summary_hash[7:]
                )
            )
        )
        decoded: dict[str, object] = {
            "schema_version": str(row["schema_version"]),
            "run_id": str(row["run_id"]),
            "command_id": str(row["command_id"]),
            "command_hash": command_hash,
            "session_id": str(row["session_id"]),
            "initial_cursor": initial_cursor,
            "target_virtual_time_ms": int(row["target_virtual_time_ms"]),
            "plan": plan,
            "summary_id": summary_id,
            "summary_hash": summary_hash,
            "status": str(row["status"]),
            "latest_cursor": latest_cursor,
            "result": result,
        }
        if (
            decoded["schema_version"] != ADVANCE_INTENT_SCHEMA_VERSION
            or not digest_valid
            or canonical_sha256(command) != command_hash
            or command.get("run_id") != decoded["run_id"]
            or command.get("command_id") != decoded["command_id"]
            or not valid_cursor(initial_cursor)
            or not valid_cursor(latest_cursor)
            or int(latest_cursor["virtual_time_ms"])
            < int(initial_cursor["virtual_time_ms"])
            or int(latest_cursor["source_sequence"])
            < int(initial_cursor["source_sequence"])
            or (summary_id is None) != (summary_hash is None)
            or (
                summary_id is not None
                and (
                    not isinstance(summary_id, str)
                    or not summary_id
                    or len(summary_id) > 200
                )
            )
            or not summary_digest_valid
            or (
                decoded["status"] in {"COMPLETED", "CANCELLED"}
                and result is None
            )
            or (
                decoded["status"] not in {"COMPLETED", "CANCELLED"}
                and result is not None
            )
        ):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "durable advance intent JSON is invalid",
                status_code=503,
            )
        return decoded

    async def get_market_tracks(self, run_id: str) -> dict[str, object]:
        def read(
            connection: sqlite3.Connection,
            ) -> tuple[
                sqlite3.Row,
                tuple[sqlite3.Row, ...],
                dict[str, object],
                dict[str, sqlite3.Row],
                dict[str, object],
            ] | None:
            run = connection.execute(
                """
                SELECT r.run_id, r.initial_equity, r.source_kind, r.book_mode,
                       launch.context_json AS launch_context_json,
                       launch.context_hash AS launch_context_hash,
                       viewer.*
                FROM replay_training_run AS r
                JOIN replay_training_viewer_state AS viewer USING(run_id)
                LEFT JOIN replay_training_launch_context AS launch USING(run_id)
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
            book_rows = {
                str(row["track_id"]): row
                for row in connection.execute(
                    """
                    SELECT * FROM replay_historical_book_projection
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchall()
            }
            for track in track_payloads:
                track["historical_book"] = self._historical_book_projection(
                    book_rows.get(str(track["track_id"])),
                    book_mode=str(run["book_mode"]),
                    subscription_tier=str(track["subscription_tier"]),
                )
            portfolio = self._contract_portfolio_projection(
                connection,
                run_id=run_id,
                initial_equity=str(run["initial_equity"]),
                tracks=track_payloads,
            )
            launch_context = self._launch_context_projection(run)
            return run, rows, portfolio, book_rows, launch_context

        result = await self.base_store.run_extension_read(read)
        if result is None:
            raise TrainingRunError(
                "TRAINING_RUN_NOT_FOUND",
                "training run does not exist",
                status_code=404,
            )
        run, rows, portfolio, book_rows, launch_context = result
        tracks = [self._market_track_from_row(row) for row in rows]
        for track in tracks:
            track["historical_book"] = self._historical_book_projection(
                book_rows.get(str(track["track_id"])),
                book_mode=str(run["book_mode"]),
                subscription_tier=str(track["subscription_tier"]),
            )
        viewer = self._viewer_from_row(run)
        return {
            "protocol": REPLAY_V2_PROTOCOL,
            "run_id": run_id,
            "ordering_version": GLOBAL_ORDERING_VERSION,
            "launch_context": launch_context,
            "viewer_state": viewer.to_dict(),
            "tracks": tracks,
            "portfolio": portfolio,
        }

    async def get_market_track(
        self,
        run_id: str,
        track_id: str,
    ) -> dict[str, object]:
        def read(
            connection: sqlite3.Connection,
        ) -> tuple[sqlite3.Row, sqlite3.Row | None, str] | None:
            row = connection.execute(
                """
                SELECT * FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()
            if row is None:
                return None
            projection = connection.execute(
                """
                SELECT * FROM replay_historical_book_projection
                WHERE run_id = ? AND track_id = ?
                """,
                (run_id, track_id),
            ).fetchone()
            run = connection.execute(
                "SELECT book_mode FROM replay_training_run WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            assert run is not None
            return row, projection, str(run["book_mode"])

        result = await self.base_store.run_extension_read(read)
        if result is None:
            raise TrainingRunError(
                "MARKET_TRACK_NOT_FOUND",
                "training market track does not exist",
                status_code=404,
            )
        row, projection, book_mode = result
        track = self._market_track_from_row(row)
        track["historical_book"] = self._historical_book_projection(
            projection,
            book_mode=book_mode,
            subscription_tier=str(track["subscription_tier"]),
        )
        return track

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
                SELECT account.*, run.settlement_asset, run.integrity_mode,
                       run.adapter_session_id, run.time_disclosure_policy,
                       run.active_rule_revision,
                       COALESCE(integrity.revealed, 0) AS revealed,
                       COALESCE(history.account_data_mode, 'APPROX_PROXY')
                           AS account_data_mode
                FROM replay_training_contract_account AS account
                JOIN replay_training_run AS run USING(run_id)
                LEFT JOIN replay_training_integrity AS integrity USING(run_id)
                LEFT JOIN replay_training_account_history AS history USING(run_id)
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
            replayed = connection.execute(
                """
                SELECT event_type, new_value_json, reason, public_time_json
                FROM replay_run_action_event
                WHERE run_id = ? AND command_id = ?
                """,
                (run_id, command_id),
            ).fetchone()
            if replayed is not None:
                new_value = json.loads(str(replayed["new_value_json"]))
                if not isinstance(new_value, Mapping):
                    raise TypeError("stored policy command result is invalid")
                expected: dict[str, object]
                table: str
                if command_type == "change_fee_policy":
                    expected = {
                        "maker_fee_bps": str(payload["maker_fee_bps"]),
                        "taker_fee_bps": str(payload["taker_fee_bps"]),
                    }
                    table = "replay_training_fee_policy"
                elif command_type == "change_leverage_cap":
                    expected = {"max_leverage": str(payload["max_leverage"])}
                    table = "replay_training_leverage_policy"
                elif command_type == "change_funding_policy":
                    expected = {
                        "funding_mode": str(payload["funding_mode"]),
                        "fixed_funding_rate": payload.get("fixed_funding_rate"),
                        "funding_interval_ms": payload.get("funding_interval_ms"),
                    }
                    table = "replay_training_funding_policy"
                else:
                    raise ValueError("unsupported contract policy command")
                if (
                    str(replayed["event_type"]) != command_type.upper()
                    or str(replayed["reason"]) != str(payload["reason"])
                    or any(new_value.get(key) != value for key, value in expected.items())
                ):
                    raise TrainingRunError(
                        "COMMAND_ID_REUSED",
                        "command_id was reused with a different policy revision",
                        status_code=409,
                    )
                policy_hash = new_value.get("policy_hash")
                revision = new_value.get("revision")
                if not isinstance(policy_hash, str) or not isinstance(revision, int):
                    raise TypeError("stored policy command identity is incomplete")
                if table == "replay_training_fee_policy":
                    policy_row = connection.execute(
                        """
                        SELECT effective_virtual_time_ms
                        FROM replay_training_fee_policy
                        WHERE run_id = ? AND revision = ? AND policy_hash = ?
                        """,
                        (run_id, revision, policy_hash),
                    ).fetchone()
                    public_time = json.loads(str(replayed["public_time_json"]))
                    replay_source_sequence = (
                        int(public_time.get("sequence", 0))
                        if isinstance(public_time, Mapping)
                        else 0
                    )
                else:
                    policy_row = connection.execute(
                        f"""
                        SELECT effective_virtual_time_ms, source_sequence
                        FROM {table}
                        WHERE run_id = ? AND revision = ? AND policy_hash = ?
                        """,
                        (run_id, revision, policy_hash),
                    ).fetchone()
                    replay_source_sequence = (
                        0
                        if policy_row is None
                        else int(policy_row["source_sequence"])
                    )
                if policy_row is None:
                    raise TypeError("stored policy command row is missing")
                return {
                    "revision": revision,
                    "policy_hash": policy_hash,
                    "effective_cursor": {
                        "virtual_time_ms": int(
                            policy_row["effective_virtual_time_ms"]
                        ),
                        "source_sequence": replay_source_sequence,
                    },
                    "deduplicated": True,
                }
            now_ms = self.base_store._validated_now_ms()
            revision: int
            policy_hash: str
            old_value: dict[str, object]
            new_value: dict[str, object]
            if command_type == "change_fee_policy":
                old_policy = connection.execute(
                    """
                    SELECT * FROM replay_training_fee_policy
                    WHERE run_id = ?
                    ORDER BY effective_virtual_time_ms DESC, revision DESC LIMIT 1
                    """,
                    (run_id,),
                ).fetchone()
                if old_policy is None:
                    raise TypeError("active fee policy is missing")
                old_value = {
                    "maker_fee_bps": str(old_policy["maker_fee_bps"]),
                    "taker_fee_bps": str(old_policy["taker_fee_bps"]),
                    "revision": int(old_policy["revision"]),
                    "policy_hash": str(old_policy["policy_hash"]),
                }
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
                new_value = {
                    "maker_fee_bps": str(payload["maker_fee_bps"]),
                    "taker_fee_bps": str(payload["taker_fee_bps"]),
                    "revision": revision,
                    "policy_hash": policy_hash,
                }
            elif command_type == "change_leverage_cap":
                old_policy = connection.execute(
                    """
                    SELECT * FROM replay_training_leverage_policy
                    WHERE run_id = ?
                    ORDER BY effective_virtual_time_ms DESC, revision DESC LIMIT 1
                    """,
                    (run_id,),
                ).fetchone()
                if old_policy is None:
                    raise TypeError("active leverage policy is missing")
                old_value = {
                    "max_leverage": str(old_policy["max_leverage"]),
                    "revision": int(old_policy["revision"]),
                    "policy_hash": str(old_policy["policy_hash"]),
                }
                revision = int(
                    connection.execute(
                        """
                        SELECT COALESCE(MAX(revision), 0) + 1
                        FROM replay_training_leverage_policy WHERE run_id = ?
                        """,
                        (run_id,),
                    ).fetchone()[0]
                )
                leverage_policy = {
                    "schema_version": RUN_RULES_SCHEMA_VERSION,
                    "kind": "LEVERAGE_CAP",
                    "run_id": run_id,
                    "revision": revision,
                    "effective_virtual_time_ms": virtual_time_ms,
                    "source_sequence": source_sequence,
                    "max_leverage": str(payload["max_leverage"]),
                    "fidelity": "CONFIGURED_USER_CAP_EXACT",
                }
                policy_hash = canonical_sha256(leverage_policy)
                connection.execute(
                    """
                    INSERT INTO replay_training_leverage_policy(
                        run_id, revision, effective_virtual_time_ms,
                        source_sequence, max_leverage, policy_hash, fidelity,
                        reason, command_id, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, 'CONFIGURED_USER_CAP_EXACT',
                              ?, ?, ?)
                    """,
                    (
                        run_id,
                        revision,
                        virtual_time_ms,
                        source_sequence,
                        payload["max_leverage"],
                        policy_hash,
                        payload["reason"],
                        command_id,
                        now_ms,
                    ),
                )
                new_value = {
                    "max_leverage": str(payload["max_leverage"]),
                    "revision": revision,
                    "policy_hash": policy_hash,
                }
            elif command_type == "change_funding_policy":
                if str(account["account_data_mode"]) == "HISTORICAL_EXACT":
                    raise TrainingRunError(
                        "HISTORICAL_FUNDING_POLICY_IMMUTABLE",
                        "exact account-history funding policy cannot be replaced",
                        status_code=409,
                        details={
                            "fallback_applied": False,
                            "archive_rule_mutated": False,
                        },
                    )
                old_policy = connection.execute(
                    """
                    SELECT * FROM replay_training_funding_policy
                    WHERE run_id = ?
                    ORDER BY effective_virtual_time_ms DESC, revision DESC LIMIT 1
                    """,
                    (run_id,),
                ).fetchone()
                if old_policy is None:
                    raise TypeError("active funding policy is missing")
                old_value = {
                    "funding_mode": str(old_policy["funding_mode"]),
                    "fixed_funding_rate": old_policy["fixed_funding_rate"],
                    "funding_interval_ms": old_policy["funding_interval_ms"],
                    "revision": int(old_policy["revision"]),
                    "policy_hash": str(old_policy["policy_hash"]),
                }
                revision = int(
                    connection.execute(
                        """
                        SELECT COALESCE(MAX(revision), 0) + 1
                        FROM replay_training_funding_policy WHERE run_id = ?
                        """,
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
                funding_policy = {
                    "schema_version": RUN_RULES_SCHEMA_VERSION,
                    "kind": "FUNDING_POLICY",
                    "run_id": run_id,
                    "revision": revision,
                    "effective_virtual_time_ms": virtual_time_ms,
                    "source_sequence": source_sequence,
                    "funding_mode": mode,
                    "fixed_funding_rate": rate,
                    "funding_interval_ms": interval,
                    "fidelity": "CONFIGURED_FUNDING_POLICY_EXACT",
                }
                policy_hash = canonical_sha256(funding_policy)
                connection.execute(
                    """
                    INSERT INTO replay_training_funding_policy(
                        run_id, revision, effective_virtual_time_ms,
                        source_sequence, funding_mode, fixed_funding_rate,
                        funding_interval_ms, policy_hash, fidelity, reason,
                        command_id, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                              'CONFIGURED_FUNDING_POLICY_EXACT', ?, ?, ?)
                    """,
                    (
                        run_id,
                        revision,
                        virtual_time_ms,
                        source_sequence,
                        mode,
                        rate,
                        interval,
                        policy_hash,
                        payload["reason"],
                        command_id,
                        now_ms,
                    ),
                )
                new_value = {
                    "funding_mode": mode,
                    "fixed_funding_rate": rate,
                    "funding_interval_ms": interval,
                    "revision": revision,
                    "policy_hash": policy_hash,
                }
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
            previous_action = connection.execute(
                """
                SELECT state_hash_after FROM replay_run_action_event
                WHERE run_id = ? ORDER BY action_sequence DESC LIMIT 1
                """,
                (run_id,),
            ).fetchone()
            action_sequence = int(
                connection.execute(
                    """
                    SELECT COALESCE(MAX(action_sequence), 0) + 1
                    FROM replay_run_action_event WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()[0]
            )
            session = connection.execute(
                "SELECT state_hash FROM replay_session WHERE session_id = ?",
                (account["adapter_session_id"],),
            ).fetchone()
            if session is None:
                raise TypeError("policy adapter session is missing")
            public_time = self._public_time(
                connection,
                session_id=str(account["adapter_session_id"]),
                policy=str(account["time_disclosure_policy"]),
                revealed=bool(account["revealed"]),
                public_time_ms=virtual_time_ms,
                sequence=source_sequence,
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
                    run_id,
                    action_sequence,
                    f"action-{action_sequence:08d}",
                    command_id,
                    command_type.upper(),
                    int(account["active_rule_revision"]),
                    canonical_json(public_time),
                    canonical_json(old_value),
                    canonical_json(new_value),
                    payload["reason"],
                    (
                        None
                        if previous_action is None
                        else str(previous_action["state_hash_after"])
                    ),
                    str(session["state_hash"]),
                    now_ms,
                ),
            )
            self._append_review_timeline_event(
                connection,
                run_id=run_id,
                session_id=str(account["adapter_session_id"]),
                context={
                    "kind": "DIRECT",
                    "event_type": command_type.upper(),
                    "category": "RULE",
                    "command_id": command_id,
                },
                state=None,
                checkpoint=None,
                now_ms=now_ms,
            )
            return {
                "revision": revision,
                "policy_hash": policy_hash,
                "effective_cursor": {
                    "virtual_time_ms": virtual_time_ms,
                    "source_sequence": source_sequence,
                },
                "deduplicated": False,
            }

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
                SELECT event.*, run.settlement_asset, track.adapter_session_id
                FROM replay_training_liquidation_event AS event
                JOIN replay_training_run AS run USING(run_id)
                JOIN replay_training_market_track AS track
                  ON track.run_id = event.run_id
                 AND track.track_id = event.track_id
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
            self._append_review_timeline_event(
                connection,
                run_id=run_id,
                session_id=str(event["adapter_session_id"]),
                context={
                    "kind": "DIRECT",
                    "category": "LIQUIDATION",
                    "event_type": "LIQUIDATION",
                    "command_id": close_order_id,
                },
                state=None,
                checkpoint=None,
                now_ms=now_ms,
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
        historical_book_binding: PreparedHistoricalBookBinding | None = None,
        account_history_binding: PreparedAccountHistoryBinding | None = None,
        review_parent_run_id: str | None = None,
        review_parent_track_id: str | None = None,
        review_parent_event_id: str | None = None,
    ) -> Callable[..., Callable[[sqlite3.Connection, int], None]]:
        def extension_factory(
            *,
            session_id: str,
            session_state: Mapping[str, object],
            component_state: Mapping[str, object],
            broker_config: Mapping[str, object],
            dataset_ref: Mapping[str, object],
            dataset_blob: Mapping[str, object],
            actual_replay_start_ms: int,
            actual_replay_end_ms: int,
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
                policy_row = connection.execute(
                    """
                    SELECT * FROM replay_training_data_policy
                    WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()
                if policy_row is None:
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "training data policy is missing",
                        status_code=503,
                    )
                history_policy = self._data_policy_from_row(policy_row)
                register_archive_segment(
                    connection,
                    run_id=run_id,
                    track_id=track_id,
                    adapter_session_id=session_id,
                    source_kind=str(row["source_kind"]),
                    dataset_ref=dataset_ref,
                    dataset_blob=dataset_blob,
                    actual_replay_start_ms=actual_replay_start_ms,
                    actual_replay_end_ms=actual_replay_end_ms,
                    history_policy=history_policy,
                    now_ms=now_ms,
                )
                run = connection.execute(
                    "SELECT book_mode FROM replay_training_run WHERE run_id = ?",
                    (run_id,),
                ).fetchone()
                if (
                    run is not None
                    and run["book_mode"] == "BOOK_ASSISTED_REQUIRED"
                    and requested_tier == "FULL"
                ):
                    if (
                        review_parent_run_id is not None
                        and review_parent_track_id is not None
                        and review_parent_event_id is not None
                    ):
                        self._copy_review_book_inputs(
                            connection,
                            child_run_id=run_id,
                            parent_run_id=review_parent_run_id,
                            parent_event_id=review_parent_event_id,
                            track_mapping={review_parent_track_id: track_id},
                            now_ms=now_ms,
                        )
                    elif historical_book_binding is None:
                        raise TypeError(
                            "book-assisted track is missing its verified L2 binding"
                        )
                    else:
                        bind_historical_book_archive(
                            connection,
                            run_id=run_id,
                            track_id=track_id,
                            binding=historical_book_binding,
                            bound_range_start_ms=actual_replay_start_ms,
                            bound_range_end_ms=actual_replay_end_ms,
                            now_ms=now_ms,
                        )
                history = connection.execute(
                    """
                    SELECT account_data_mode
                    FROM replay_training_account_history WHERE run_id = ?
                    """,
                    (run_id,),
                ).fetchone()
                if (
                    history is not None
                    and history["account_data_mode"] == "HISTORICAL_EXACT"
                    and requested_tier in {"WARM", "FULL"}
                ):
                    if (
                        review_parent_run_id is not None
                        and review_parent_track_id is not None
                        and review_parent_event_id is not None
                    ):
                        self._copy_exact_review_fork_inputs(
                            connection,
                            child_run_id=run_id,
                            parent_run_id=review_parent_run_id,
                            parent_event_id=review_parent_event_id,
                            track_mapping={review_parent_track_id: track_id},
                            now_ms=now_ms,
                        )
                    elif account_history_binding is None:
                        raise TypeError(
                            "exact account track is missing its archive binding"
                        )
                    else:
                        bind_account_history_archive(
                            connection,
                            run_id=run_id,
                            track_id=track_id,
                            binding=account_history_binding,
                            bound_range_start_ms=actual_replay_start_ms,
                            bound_range_end_ms=actual_replay_end_ms,
                            source_kind=str(row["source_kind"]),
                            now_ms=now_ms,
                        )
                else:
                    self._insert_contract_track_rule(
                        connection,
                        run_id=run_id,
                        track_id=track_id,
                        source_kind=str(row["source_kind"]),
                        broker_config=broker_config,
                        effective_virtual_time_ms=int(cursor["virtual_time_ms"]),
                        now_ms=now_ms,
                    )
                self._sync_contract_components(
                    connection,
                    run_id=run_id,
                    track_id=track_id,
                    virtual_time_ms=int(cursor["virtual_time_ms"]),
                    source_sequence=validate_v2_counter(
                        session_state["source_sequence"],
                        field_name="source_sequence",
                    ),
                    component_state=component_state,
                    now_ms=now_ms,
                )
                if (
                    history is not None
                    and history["account_data_mode"] == "HISTORICAL_EXACT"
                ):
                    self._apply_exact_mark_projection(
                        connection,
                        run_id=run_id,
                        track_id=track_id,
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
        historical_book_binding: PreparedHistoricalBookBinding | None = None,
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
            now_ms = self.base_store._validated_now_ms()
            run = connection.execute(
                """
                SELECT r.book_mode,
                       dataset.actual_replay_start_ms,
                       dataset.actual_replay_end_ms
                FROM replay_training_run AS r
                JOIN replay_dataset_ref AS dataset
                  ON dataset.session_id = r.adapter_session_id
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
            history = connection.execute(
                """
                SELECT account_data_mode, status
                FROM replay_training_account_history WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if (
                history is not None
                and history["account_data_mode"] == "HISTORICAL_EXACT"
                and subscription_tier != "NONE"
            ):
                account_ref = connection.execute(
                    """
                    SELECT 1 FROM replay_account_history_ref
                    WHERE run_id = ? AND track_id = ? AND active = 1
                    LIMIT 1
                    """,
                    (run_id, track_id),
                ).fetchone()
                if history["status"] != "ACTIVE" or account_ref is None:
                    raise TrainingRunError(
                        "ACCOUNT_HISTORY_BINDING_MISSING",
                        "exact account WARM/FULL track requires a pinned archive",
                        status_code=409,
                        details={"fallback_applied": False},
                    )
            if run["book_mode"] == "BOOK_ASSISTED_REQUIRED":
                if subscription_tier == "FULL":
                    active = connection.execute(
                        """
                        SELECT 1 FROM replay_historical_book_ref
                        WHERE run_id = ? AND track_id = ? AND active = 1
                        LIMIT 1
                        """,
                        (run_id, track_id),
                    ).fetchone()
                    if historical_book_binding is not None:
                        bind_historical_book_archive(
                            connection,
                            run_id=run_id,
                            track_id=track_id,
                            binding=historical_book_binding,
                            bound_range_start_ms=int(run["actual_replay_start_ms"]),
                            bound_range_end_ms=int(run["actual_replay_end_ms"]),
                            now_ms=now_ms,
                        )
                    elif active is None:
                        raise TrainingRunError(
                            "HISTORICAL_BOOK_BINDING_MISSING",
                            "FULL book-assisted track requires a pinned L2 archive",
                            status_code=409,
                        )
                else:
                    connection.execute(
                        """
                        UPDATE replay_historical_book_ref
                        SET active = 0, released_at_ms = ?
                        WHERE run_id = ? AND track_id = ? AND active = 1
                        """,
                        (now_ms, run_id, track_id),
                    )
                    connection.execute(
                        """
                        DELETE FROM replay_historical_book_projection
                        WHERE run_id = ? AND track_id = ?
                        """,
                        (run_id, track_id),
                    )
                    for table in (
                        "replay_training_track",
                        "replay_training_market_track",
                    ):
                        connection.execute(
                            f"""
                            UPDATE {table}
                            SET capabilities_json = json_set(
                                capabilities_json,
                                '$.ORDER_BOOK',
                                'UNSUPPORTED_NO_HISTORY'
                            ), updated_at_ms = ?
                            WHERE run_id = ? AND track_id = ?
                            """,
                            (now_ms, run_id, track_id),
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
                    now_ms,
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
            self._append_review_timeline_event(
                connection,
                run_id=run_id,
                session_id=str(target["adapter_session_id"]),
                context={
                    "kind": "DIRECT",
                    "category": "VIEWER",
                    "event_type": "SELECT_TRACK",
                    "command_id": command_id,
                },
                state=None,
                checkpoint=None,
                now_ms=now_ms,
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
            selected = connection.execute(
                """
                SELECT track.adapter_session_id
                FROM replay_training_viewer_state AS viewer
                JOIN replay_training_market_track AS track
                  ON track.run_id = viewer.run_id
                 AND track.track_id = viewer.selected_track_id
                WHERE viewer.run_id = ?
                """,
                (run_id,),
            ).fetchone()
            if inserted and selected is not None:
                self._append_review_timeline_event(
                    connection,
                    run_id=run_id,
                    session_id=str(selected["adapter_session_id"]),
                    context={
                        "kind": "SOURCE_EVENT",
                    },
                    state=None,
                    checkpoint=None,
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

    async def set_actor_segment_refs(self, run_id: str, *, active: bool) -> None:
        now_ms = self.base_store._validated_now_ms()

        def write(connection: sqlite3.Connection) -> None:
            if active:
                self._assert_run_segments_ready(
                    connection,
                    run_id=run_id,
                    operation="actor activation",
                )
                connection.execute(
                    """
                    UPDATE replay_data_segment_ref
                    SET active = 1, released_at_ms = NULL
                    WHERE run_id = ? AND owner_kind = 'ACTOR'
                      AND (active != 1 OR released_at_ms IS NOT NULL)
                    """,
                    (run_id,),
                )
            else:
                connection.execute(
                    """
                    UPDATE replay_data_segment_ref
                    SET active = 0, released_at_ms = ?
                    WHERE run_id = ? AND owner_kind = 'ACTOR'
                      AND (active != 0 OR released_at_ms IS NULL)
                    """,
                    (now_ms, run_id),
                )

        await self.base_store.run_extension_write(write)

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
            connection.execute(
                "DELETE FROM replay_data_segment_ref WHERE run_id = ? AND track_id = ?",
                (run_id, track_id),
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

        This query deliberately reads only replay-owned SQLite tables. The
        service may subsequently page pre-start chart history through its
        read-only replay repository when the bound policy is ALL_AVAILABLE.
        """

        def read(connection: sqlite3.Connection) -> sqlite3.Row | None:
            return connection.execute(
                """
                SELECT
                    r.run_id,
                    r.adapter_session_id AS primary_adapter_session_id,
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
                    t.subscription_tier,
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
                    s.degraded_reason,
                    policy.schema_version,
                    policy.indicator_warmup_bars,
                    policy.visible_history_mode,
                    policy.visible_history_lookback_ms,
                    policy.visible_history_rows,
                    policy.actual_visible_history_start_ms,
                    policy.actual_replay_start_ms,
                    policy.effective_warmup_bars,
                    policy.forward_cache_ms,
                    policy.interval_ms,
                    policy.policy_hash
                FROM replay_training_run AS r
                JOIN replay_training_market_track AS t ON t.run_id = r.run_id
                LEFT JOIN replay_training_track AS legacy
                  ON legacy.run_id = t.run_id AND legacy.track_id = t.track_id
                JOIN replay_session AS s ON s.session_id = t.adapter_session_id
                JOIN replay_training_data_policy AS policy USING(run_id)
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
        history_policy = self._data_policy_from_row(row)
        return {
            "run_id": str(row["run_id"]),
            "primary_adapter_session_id": str(row["primary_adapter_session_id"]),
            "session_id": str(row["adapter_session_id"]),
            "track_id": str(row["track_id"]),
            "exchange": str(row["exchange"]),
            "market_type": str(row["market_type"]),
            "symbol": str(row["symbol"]),
            "source_kind": str(row["source_kind"]),
            "subscription_tier": str(row["subscription_tier"]),
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
            "history_policy": {
                **history_policy.to_dict(include_actual=True),
                "policy_hash": history_policy.policy_hash,
            },
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

    @staticmethod
    def _historical_book_projection(
        row: Mapping[str, object] | None,
        *,
        book_mode: str,
        subscription_tier: str,
    ) -> dict[str, object]:
        if row is None:
            required = (
                book_mode == "BOOK_ASSISTED_REQUIRED"
                and subscription_tier == "FULL"
            )
            return {
                "mode": book_mode,
                "capability_state": (
                    CapabilityState.DEGRADED.value
                    if required
                    else CapabilityState.UNSUPPORTED_NO_HISTORY.value
                ),
                "status": "CLEARED" if required else "OFF",
                "execution_fidelity": (
                    BOOK_EXECUTION_FIDELITY
                    if book_mode == "BOOK_ASSISTED_REQUIRED"
                    else "NO_BOOK_TOUCH_OR_TAPE_APPROX"
                ),
                "queue_exact": False,
                "as_of_virtual_time_ms": None,
                "last_update_id": None,
                "bids": [],
                "asks": [],
                "book_hash": None,
                "message": (
                    "缺少已 pin 的连续历史 L2；Run 必须保持暂停"
                    if required
                    else (
                        "该轨道不是 FULL；未激活历史盘口投影"
                        if book_mode == "BOOK_ASSISTED_REQUIRED"
                        else "历史盘口模式未启用"
                    )
                ),
            }
        try:
            bids = json.loads(str(row["bids_json"]))
            asks = json.loads(str(row["asks_json"]))
        except json.JSONDecodeError as exc:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "historical book projection JSON is invalid",
                status_code=503,
            ) from exc
        if not isinstance(bids, list) or not isinstance(asks, list):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "historical book projection levels are invalid",
                status_code=503,
            )
        return {
            "mode": book_mode,
            "capability_state": str(row["capability_state"]),
            "status": str(row["status"]),
            "execution_fidelity": str(row["execution_fidelity"]),
            "queue_exact": bool(row["queue_exact"]),
            "as_of_virtual_time_ms": row["as_of_virtual_ms"],
            "last_update_id": row["last_update_id"],
            "bids": bids,
            "asks": asks,
            "book_hash": row["book_hash"],
            "message": str(row["message"]),
        }

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
    def _contract_current_equity(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        initial_equity: str,
        tracks: list[dict[str, object]],
    ) -> str:
        """Return the contract-equity scalar without materializing full history."""

        base = cls._portfolio_projection(
            initial_equity=initial_equity,
            tracks=tracks,
        )
        account = connection.execute(
            """
            SELECT account_model, overlay_cash
            FROM replay_training_contract_account
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if account is None or str(account["account_model"]) != CONTRACT_ACCOUNT_MODEL:
            return str(base["equity"])
        try:
            equity = (
                Decimal(str(base["cash_balance"]))
                + Decimal(str(account["overlay_cash"]))
                + Decimal(str(base["unrealized_pnl"]))
            )
        except (InvalidOperation, KeyError, TypeError) as exc:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "contract account equity is invalid",
                status_code=503,
            ) from exc
        return decimal_to_string(equity, field_name="equity")

    @classmethod
    def _refresh_contract_current_equity(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        now_ms: int,
        summary_revision: int | None = None,
    ) -> str:
        rows = tuple(
            connection.execute(
                """
                SELECT account_json FROM replay_training_market_track
                WHERE run_id = ? ORDER BY stable_ordinal, track_id
                """,
                (run_id,),
            ).fetchall()
        )
        tracks: list[dict[str, object]] = []
        for row in rows:
            try:
                account = json.loads(str(row["account_json"]))
            except json.JSONDecodeError as exc:
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market track account projection is invalid",
                    status_code=503,
                ) from exc
            if not isinstance(account, dict):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market track account projection is invalid",
                    status_code=503,
                )
            tracks.append({"account": account})
        run = connection.execute(
            """
            SELECT initial_equity FROM replay_training_run WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if run is None:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training run account owner is missing",
                status_code=503,
            )
        current_equity = cls._contract_current_equity(
            connection,
            run_id=run_id,
            initial_equity=str(run["initial_equity"]),
            tracks=tracks,
        )
        if summary_revision is None:
            connection.execute(
                """
                UPDATE replay_training_run
                SET current_equity = ?, updated_at_ms = ?
                WHERE run_id = ?
                """,
                (current_equity, now_ms, run_id),
            )
        else:
            connection.execute(
                """
                UPDATE replay_training_run
                SET current_equity = ?, summary_revision = ?, updated_at_ms = ?
                WHERE run_id = ?
                """,
                (current_equity, summary_revision, now_ms, run_id),
            )
        return current_equity

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
        run_contract = connection.execute(
            "SELECT book_mode FROM replay_training_run WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if run_contract is None:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training run execution contract is missing",
                status_code=503,
            )
        account_history = connection.execute(
            """
            SELECT * FROM replay_training_account_history WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        account_data_mode = (
            "APPROX_PROXY"
            if account_history is None
            else str(account_history["account_data_mode"])
        )
        exact_account = account_data_mode == "HISTORICAL_EXACT"
        execution_fidelity = (
            BOOK_EXECUTION_FIDELITY
            if run_contract["book_mode"] == "BOOK_ASSISTED_REQUIRED"
            else "NO_BOOK_TOUCH_OR_TAPE_APPROX"
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
        archive_bindings = [
            {
                "track_id": str(row["track_id"]),
                "archive_id": str(row["archive_id"]),
                "dataset_epoch": str(row["dataset_epoch"]),
                "checksum_sha256": str(row["checksum_sha256"]),
                "proof_hash": str(row["proof_hash"]),
                "event_chain_tail": str(row["event_chain_tail"]),
                "archive_generation": int(row["archive_generation"]),
                "last_event_sequence": int(row["last_event_sequence"]),
                "as_of_actual_time_ms": int(row["as_of_actual_time_ms"]),
                "as_of_virtual_time_ms": int(row["as_of_virtual_time_ms"]),
                "mark_price": row["mark_price"],
                "index_price": row["index_price"],
                "status": str(row["status"]),
            }
            for row in connection.execute(
                """
                SELECT projection.*, ref.dataset_epoch, ref.checksum_sha256,
                       ref.event_chain_tail, archive.proof_hash
                FROM replay_account_history_projection AS projection
                JOIN replay_account_history_ref AS ref
                  ON ref.run_id = projection.run_id
                 AND ref.track_id = projection.track_id
                 AND ref.archive_id = projection.archive_id
                 AND ref.active = 1
                JOIN replay_account_history_archive AS archive
                  ON archive.archive_id = projection.archive_id
                WHERE projection.run_id = ?
                ORDER BY projection.track_id
                """,
                (run_id,),
            ).fetchall()
        ]
        return {
            "schema_version": CONTRACT_ACCOUNT_SCHEMA_VERSION,
            "account_model": CONTRACT_ACCOUNT_MODEL,
            "execution_model": "TOUCH_OR_TAPE_V2",
            "execution_fidelity": execution_fidelity,
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
            "account_history": {
                "mode": account_data_mode,
                "status": (
                    "ACTIVE"
                    if account_history is None
                    else str(account_history["status"])
                ),
                "fidelity": (
                    "REVEALED_PRICE_PROXY_MODELLED_ACCOUNT"
                    if account_history is None
                    else str(account_history["fidelity"])
                ),
                "archive_proof_hash": (
                    None
                    if account_history is None
                    else account_history["archive_proof_hash"]
                ),
                "bindings": archive_bindings,
                "auditor": {
                    "status": (
                        "NOT_RUN"
                        if account_history is None
                        else str(account_history["auditor_status"])
                    ),
                    "proof_hash": (
                        None
                        if account_history is None
                        else account_history["auditor_proof_hash"]
                    ),
                    "differences": (
                        []
                        if account_history is None
                        else json.loads(
                            str(account_history["auditor_differences_json"])
                        )
                    ),
                },
            },
            "liquidation_channels": {
                "simulated_account": {
                    "label": "模拟账户强平",
                    "source": "MODELLED_ACCOUNT",
                    "fidelity": (
                        "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT"
                        if exact_account
                        else "AVAILABLE_APPROX_SIMULATED_ACCOUNT"
                    ),
                },
                "historical_market": {
                    "label": "历史市场爆仓",
                    "source": "INDEPENDENT_MARKET_LIQUIDATION_FEED",
                    "fidelity": "UNSUPPORTED_NO_HISTORY",
                },
            },
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
                "instrument_rules": (
                    "HISTORICAL_EXACT_VERSIONED_EXCHANGE_RULE"
                    if exact_account
                    else "AVAILABLE_APPROX_SIMULATION_RULES"
                ),
                "fees": CONFIGURED_FEE_FIDELITY,
                "funding": (
                    "OFF"
                    if str(account["funding_mode"]) == "OFF"
                    else (
                        "HISTORICAL_EXACT_ARCHIVE_FUNDING"
                        if exact_account
                        else SANDBOX_FUNDING_FIDELITY
                    )
                ),
                "mark": (
                    "HISTORICAL_EXACT_ARCHIVE_MARK"
                    if exact_account
                    else "REVEALED_PRICE_PROXY_NOT_HISTORICAL_MARK"
                ),
                "liquidation": (
                    "HISTORICAL_EXACT_INPUTS_MODELLED_ACCOUNT"
                    if exact_account
                    else "AVAILABLE_APPROX_SIMULATED_ACCOUNT"
                ),
            },
        }

    @staticmethod
    def _assert_run_segments_ready(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        operation: str,
    ) -> None:
        unavailable = connection.execute(
            """
            SELECT s.segment_id, s.health
            FROM replay_data_segment_ref AS r
            JOIN replay_data_segment AS s USING(segment_id)
            WHERE r.run_id = ? AND r.owner_kind = 'RUN_ARCHIVE'
              AND s.health != 'READY'
            ORDER BY s.segment_id LIMIT 1
            """,
            (run_id,),
        ).fetchone()
        if unavailable is not None:
            raise TrainingRunError(
                "SEGMENT_NOT_READY",
                f"replay data segment must be ready before {operation}",
                status_code=409,
                details={
                    "segment_id": str(unavailable["segment_id"]),
                    "health": str(unavailable["health"]),
                },
            )

    @classmethod
    def _insert_global_checkpoint(
        cls,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        now_ms: int,
    ) -> dict[str, object]:
        cls._assert_run_segments_ready(
            connection,
            run_id=run_id,
            operation="checkpoint",
        )
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
            INSERT OR IGNORE INTO replay_data_segment_ref(
                segment_id, run_id, track_id, owner_kind, owner_id,
                active, created_at_ms, released_at_ms
            )
            SELECT segment_id, run_id, track_id, 'CHECKPOINT',
                   'latest-global-checkpoint', 0, ?, ?
            FROM replay_data_segment_ref
            WHERE run_id = ? AND owner_kind = 'RUN_ARCHIVE'
            ON CONFLICT(segment_id, run_id, owner_kind, owner_id) DO UPDATE SET
                active = 0,
                released_at_ms = excluded.released_at_ms
            """,
            (now_ms, now_ms, run_id),
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
        leverage_policy = {
            "schema_version": RUN_RULES_SCHEMA_VERSION,
            "kind": "LEVERAGE_CAP",
            "run_id": run_id,
            "revision": 1,
            "effective_virtual_time_ms": virtual_time_ms,
            "source_sequence": 0,
            "max_leverage": request.max_leverage,
            "fidelity": "CONFIGURED_USER_CAP_EXACT",
        }
        connection.execute(
            """
            INSERT INTO replay_training_leverage_policy(
                run_id, revision, effective_virtual_time_ms, source_sequence,
                max_leverage, policy_hash, fidelity, reason, command_id,
                created_at_ms
            ) VALUES (?, 1, ?, 0, ?, ?, 'CONFIGURED_USER_CAP_EXACT',
                      'creation policy', NULL, ?)
            """,
            (
                run_id,
                virtual_time_ms,
                request.max_leverage,
                canonical_sha256(leverage_policy),
                now_ms,
            ),
        )
        funding_fidelity = (
            "HISTORICAL_EXACT_ARCHIVE_POLICY"
            if request.funding_mode.value == "HISTORICAL_EXACT"
            else "CONFIGURED_FUNDING_POLICY_EXACT"
        )
        funding_policy = {
            "schema_version": RUN_RULES_SCHEMA_VERSION,
            "kind": "FUNDING_POLICY",
            "run_id": run_id,
            "revision": 1,
            "effective_virtual_time_ms": virtual_time_ms,
            "source_sequence": 0,
            "funding_mode": request.funding_mode.value,
            "fixed_funding_rate": request.fixed_funding_rate,
            "funding_interval_ms": request.funding_interval_ms,
            "fidelity": funding_fidelity,
        }
        connection.execute(
            """
            INSERT INTO replay_training_funding_policy(
                run_id, revision, effective_virtual_time_ms, source_sequence,
                funding_mode, fixed_funding_rate, funding_interval_ms,
                policy_hash, fidelity, reason, command_id, created_at_ms
            ) VALUES (?, 1, ?, 0, ?, ?, ?, ?, ?, 'creation policy', NULL, ?)
            """,
            (
                run_id,
                virtual_time_ms,
                request.funding_mode.value,
                request.fixed_funding_rate,
                request.funding_interval_ms,
                canonical_sha256(funding_policy),
                funding_fidelity,
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

    @staticmethod
    def _copy_review_rule_policies(
        connection: sqlite3.Connection,
        *,
        child_run_id: str,
        parent_run_id: str,
        parent_event_id: str,
        virtual_time_ms: int,
        source_sequence: int,
        now_ms: int,
    ) -> None:
        event = connection.execute(
            """
            SELECT projection_json FROM replay_review_timeline_event
            WHERE run_id = ? AND event_id = ?
            """,
            (parent_run_id, parent_event_id),
        ).fetchone()
        if event is None:
            raise TypeError("review fork projection is missing")
        projection = json.loads(str(event["projection_json"]))
        if not isinstance(projection, Mapping):
            raise TypeError("review fork projection is invalid")
        rules = projection.get("rules")
        if not isinstance(rules, Mapping):
            raise TypeError("review fork rule projection is missing")
        leverage = rules.get("leverage_policy")
        funding = rules.get("funding_policy")
        if not isinstance(leverage, Mapping) or not isinstance(funding, Mapping):
            raise TypeError("review fork active policies are missing")
        leverage_revision = validate_v2_counter(
            leverage.get("revision"),
            field_name="review leverage revision",
        )
        funding_revision = validate_v2_counter(
            funding.get("revision"),
            field_name="review funding revision",
        )
        for row in connection.execute(
            """
            SELECT * FROM replay_training_leverage_policy
            WHERE run_id = ?
              AND revision <= ?
              AND (
                  effective_virtual_time_ms < ?
                  OR (
                      effective_virtual_time_ms = ?
                      AND source_sequence <= ?
                  )
              )
            ORDER BY revision
            """,
            (
                parent_run_id,
                leverage_revision,
                virtual_time_ms,
                virtual_time_ms,
                source_sequence,
            ),
        ).fetchall():
            payload = {
                "schema_version": RUN_RULES_SCHEMA_VERSION,
                "kind": "LEVERAGE_CAP",
                "run_id": child_run_id,
                "revision": int(row["revision"]),
                "effective_virtual_time_ms": int(row["effective_virtual_time_ms"]),
                "source_sequence": int(row["source_sequence"]),
                "max_leverage": str(row["max_leverage"]),
                "fidelity": str(row["fidelity"]),
            }
            connection.execute(
                """
                INSERT INTO replay_training_leverage_policy(
                    run_id, revision, effective_virtual_time_ms,
                    source_sequence, max_leverage, policy_hash, fidelity,
                    reason, command_id, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                """,
                (
                    child_run_id,
                    row["revision"],
                    row["effective_virtual_time_ms"],
                    row["source_sequence"],
                    row["max_leverage"],
                    canonical_sha256(payload),
                    row["fidelity"],
                    f"fork of {parent_run_id}: {row['reason']}",
                    now_ms,
                ),
            )
        for row in connection.execute(
            """
            SELECT * FROM replay_training_funding_policy
            WHERE run_id = ?
              AND revision <= ?
              AND (
                  effective_virtual_time_ms < ?
                  OR (
                      effective_virtual_time_ms = ?
                      AND source_sequence <= ?
                  )
              )
            ORDER BY revision
            """,
            (
                parent_run_id,
                funding_revision,
                virtual_time_ms,
                virtual_time_ms,
                source_sequence,
            ),
        ).fetchall():
            payload = {
                "schema_version": RUN_RULES_SCHEMA_VERSION,
                "kind": "FUNDING_POLICY",
                "run_id": child_run_id,
                "revision": int(row["revision"]),
                "effective_virtual_time_ms": int(row["effective_virtual_time_ms"]),
                "source_sequence": int(row["source_sequence"]),
                "funding_mode": str(row["funding_mode"]),
                "fixed_funding_rate": row["fixed_funding_rate"],
                "funding_interval_ms": row["funding_interval_ms"],
                "fidelity": str(row["fidelity"]),
            }
            connection.execute(
                """
                INSERT INTO replay_training_funding_policy(
                    run_id, revision, effective_virtual_time_ms,
                    source_sequence, funding_mode, fixed_funding_rate,
                    funding_interval_ms, policy_hash, fidelity, reason,
                    command_id, created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                """,
                (
                    child_run_id,
                    row["revision"],
                    row["effective_virtual_time_ms"],
                    row["source_sequence"],
                    row["funding_mode"],
                    row["fixed_funding_rate"],
                    row["funding_interval_ms"],
                    canonical_sha256(payload),
                    row["fidelity"],
                    f"fork of {parent_run_id}: {row['reason']}",
                    now_ms,
                ),
            )
        for table in (
            "replay_training_leverage_policy",
            "replay_training_funding_policy",
        ):
            if connection.execute(
                f"SELECT 1 FROM {table} WHERE run_id = ? LIMIT 1",
                (child_run_id,),
            ).fetchone() is None:
                raise TypeError(f"forked run has no {table} history")

    @staticmethod
    def _copy_review_book_inputs(
        connection: sqlite3.Connection,
        *,
        child_run_id: str,
        parent_run_id: str,
        parent_event_id: str,
        track_mapping: Mapping[str, str],
        now_ms: int,
    ) -> None:
        event = connection.execute(
            """
            SELECT projection_json FROM replay_review_timeline_event
            WHERE run_id = ? AND event_id = ?
            """,
            (parent_run_id, parent_event_id),
        ).fetchone()
        if event is None:
            raise TypeError("book-assisted fork review projection is missing")
        projection = json.loads(str(event["projection_json"]))
        if not isinstance(projection, Mapping):
            raise TypeError("book-assisted fork projection is invalid")
        internal = projection.get("_book_history_internal")
        if not isinstance(internal, Mapping):
            raise TrainingRunError(
                "HISTORICAL_BOOK_REVIEW_FORK_UNAVAILABLE",
                "review event has no pinned historical book snapshot",
                status_code=409,
                details={"fallback_applied": False},
            )
        inputs = internal.get("tracks")
        if not isinstance(inputs, list):
            raise TypeError("review historical book inputs are invalid")
        input_by_track = {
            str(item["track_id"]): item
            for item in inputs
            if isinstance(item, Mapping) and isinstance(item.get("track_id"), str)
        }
        for parent_track_id, child_track_id in track_mapping.items():
            item = input_by_track.get(parent_track_id)
            if item is None:
                raise TrainingRunError(
                    "HISTORICAL_BOOK_REVIEW_FORK_UNAVAILABLE",
                    "review event lacks one required historical book snapshot",
                    status_code=409,
                    details={
                        "track_id": parent_track_id,
                        "fallback_applied": False,
                    },
                )
            connection.execute(
                """
                INSERT INTO replay_historical_book_ref(
                    archive_id, run_id, track_id, binding_generation,
                    bound_range_start_ms, bound_range_end_ms, active,
                    created_at_ms, released_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)
                """,
                (
                    item["archive_id"],
                    child_run_id,
                    child_track_id,
                    item["binding_generation"],
                    item["bound_range_start_ms"],
                    item["bound_range_end_ms"],
                    now_ms,
                ),
            )
            if item.get("capability_state") is not None:
                connection.execute(
                    """
                    INSERT INTO replay_historical_book_projection(
                        run_id, track_id, archive_id, capability_state,
                        status, execution_fidelity, queue_exact,
                        as_of_actual_ms, as_of_virtual_ms, last_update_id,
                        bids_json, asks_json, book_hash, message, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        child_run_id,
                        child_track_id,
                        item["archive_id"],
                        item["capability_state"],
                        item["status"],
                        item["execution_fidelity"],
                        item["queue_exact"],
                        item["as_of_actual_ms"],
                        item["as_of_virtual_ms"],
                        item["last_update_id"],
                        item["bids_json"],
                        item["asks_json"],
                        item["book_hash"],
                        item["message"],
                        now_ms,
                    ),
                )
            connection.execute(
                """
                UPDATE replay_historical_book_archive
                SET last_used_at_ms = ?, updated_at_ms = ?
                WHERE archive_id = ?
                """,
                (now_ms, now_ms, item["archive_id"]),
            )

    @staticmethod
    def _copy_exact_review_fork_inputs(
        connection: sqlite3.Connection,
        *,
        child_run_id: str,
        parent_run_id: str,
        parent_event_id: str,
        track_mapping: Mapping[str, str],
        now_ms: int,
    ) -> None:
        event = connection.execute(
            """
            SELECT projection_json FROM replay_review_timeline_event
            WHERE run_id = ? AND event_id = ?
            """,
            (parent_run_id, parent_event_id),
        ).fetchone()
        if event is None:
            raise TypeError("exact fork review projection is missing")
        raw_projection = json.loads(str(event["projection_json"]))
        if not isinstance(raw_projection, dict):
            raise TypeError("review projection must be an object")
        projection = raw_projection
        history = projection.get("_account_history_internal")
        if not isinstance(history, Mapping) or history.get(
            "account_data_mode"
        ) != "HISTORICAL_EXACT":
            raise TrainingRunError(
                "ACCOUNT_HISTORY_REVIEW_FORK_UNAVAILABLE",
                "review event has no exact account input snapshot",
                status_code=409,
                details={"fallback_applied": False},
            )
        inputs = history.get("tracks")
        if not isinstance(inputs, list):
            raise TypeError("exact review track inputs are invalid")
        input_by_track = {
            str(item["track_id"]): item
            for item in inputs
            if isinstance(item, Mapping) and isinstance(item.get("track_id"), str)
        }
        for parent_track_id, child_track_id in track_mapping.items():
            item = input_by_track.get(parent_track_id)
            if item is None:
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_REVIEW_FORK_UNAVAILABLE",
                    "review event lacks an exact input for one track",
                    status_code=409,
                    details={
                        "track_id": parent_track_id,
                        "fallback_applied": False,
                    },
                )
            connection.execute(
                """
                INSERT INTO replay_account_history_ref(
                    archive_id, run_id, track_id, binding_generation, active,
                    bound_range_start_ms, bound_range_end_ms, dataset_epoch,
                    checksum_sha256, archive_generation, event_chain_tail,
                    created_at_ms, released_at_ms
                ) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    item["archive_id"],
                    child_run_id,
                    child_track_id,
                    item["bound_range_start_ms"],
                    item["bound_range_end_ms"],
                    item["dataset_epoch"],
                    item["checksum_sha256"],
                    item["archive_generation"],
                    item["event_chain_tail"],
                    now_ms,
                ),
            )
            connection.execute(
                """
                INSERT INTO replay_account_history_projection(
                    run_id, track_id, archive_id, archive_generation,
                    last_event_sequence, last_rule_sequence,
                    last_mark_sequence, last_funding_sequence,
                    as_of_actual_time_ms, as_of_virtual_time_ms,
                    current_rule_json, current_rule_hash, mark_price,
                    index_price, input_chain_hash, status,
                    degraded_reason, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          ?, ?, ?)
                """,
                (
                    child_run_id,
                    child_track_id,
                    item["archive_id"],
                    item["archive_generation"],
                    item["last_event_sequence"],
                    item["last_rule_sequence"],
                    item["last_mark_sequence"],
                    item["last_funding_sequence"],
                    item["as_of_actual_time_ms"],
                    item["as_of_virtual_time_ms"],
                    item["current_rule_json"],
                    item["current_rule_hash"],
                    item["mark_price"],
                    item["index_price"],
                    item["input_chain_hash"],
                    item["status"],
                    item["degraded_reason"],
                    now_ms,
                ),
            )
            connection.execute(
                """
                INSERT INTO replay_account_history_applied_event(
                    run_id, track_id, archive_id, archive_event_sequence,
                    event_time_ms, event_phase, event_kind,
                    component_sequence, archive_event_hash,
                    applied_payload_hash, created_at_ms
                )
                SELECT ?, ?, archive_id, archive_event_sequence,
                       event_time_ms, event_phase, event_kind,
                       component_sequence, archive_event_hash,
                       applied_payload_hash, ?
                FROM replay_account_history_applied_event
                WHERE run_id = ? AND track_id = ?
                  AND archive_event_sequence <= ?
                ORDER BY archive_event_sequence
                """,
                (
                    child_run_id,
                    child_track_id,
                    now_ms,
                    parent_run_id,
                    parent_track_id,
                    item["last_event_sequence"],
                ),
            )
            for rule_row in connection.execute(
                """
                SELECT * FROM replay_training_instrument_rule
                WHERE run_id = ? AND track_id = ?
                  AND effective_virtual_time_ms <= ?
                ORDER BY revision
                """,
                (
                    parent_run_id,
                    parent_track_id,
                    item["as_of_virtual_time_ms"],
                ),
            ).fetchall():
                raw_rule = json.loads(str(rule_row["rule_json"]))
                if not isinstance(raw_rule, dict):
                    raise TypeError("fork instrument rule must be an object")
                raw_rule["track_id"] = child_track_id
                rule = InstrumentRule.from_mapping(raw_rule)
                connection.execute(
                    """
                    INSERT OR IGNORE INTO replay_training_instrument_rule(
                        run_id, track_id, revision,
                        effective_virtual_time_ms, rule_json, rule_hash,
                        fidelity, created_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        child_run_id,
                        child_track_id,
                        rule_row["revision"],
                        rule_row["effective_virtual_time_ms"],
                        canonical_json(rule.to_dict()),
                        rule.rule_hash,
                        rule_row["fidelity"],
                        now_ms,
                    ),
                )
            parent_track = connection.execute(
                """
                SELECT capabilities_json
                FROM replay_training_market_track
                WHERE run_id = ? AND track_id = ?
                """,
                (parent_run_id, parent_track_id),
            ).fetchone()
            if parent_track is not None:
                connection.execute(
                    """
                    UPDATE replay_training_market_track
                    SET capabilities_json = ?, updated_at_ms = ?
                    WHERE run_id = ? AND track_id = ?
                    """,
                    (
                        parent_track["capabilities_json"],
                        now_ms,
                        child_run_id,
                        child_track_id,
                    ),
                )
        parent_account = connection.execute(
            """
            SELECT fidelity FROM replay_training_contract_account
            WHERE run_id = ?
            """,
            (parent_run_id,),
        ).fetchone()
        if parent_account is not None:
            connection.execute(
                """
                UPDATE replay_training_contract_account
                SET fidelity = ?, updated_at_ms = ? WHERE run_id = ?
                """,
                (parent_account["fidelity"], now_ms, child_run_id),
            )

    @classmethod
    def _insert_fork_contract_account(
        cls,
        connection: sqlite3.Connection,
        *,
        child_run_id: str,
        parent_run_id: str,
        parent_event_id: str,
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
        event = connection.execute(
            """
            SELECT projection_json FROM replay_review_timeline_event
            WHERE run_id = ? AND event_id = ?
            """,
            (parent_run_id, parent_event_id),
        ).fetchone()
        if event is None:
            raise TypeError("review fork projection is missing")
        review_projection = json.loads(str(event["projection_json"]))
        if not isinstance(review_projection, Mapping):
            raise TypeError("review fork projection is invalid")
        review_domain = review_projection.get("domain")
        review_account = review_projection.get("account")
        review_rules = review_projection.get("rules")
        if (
            not isinstance(review_domain, Mapping)
            or not isinstance(review_account, Mapping)
            or not isinstance(review_rules, Mapping)
        ):
            raise TypeError("review fork account projection is incomplete")
        ledger_count = validate_v2_counter(
            review_domain.get("ledger_count"),
            field_name="review ledger count",
        )
        fee_policy = review_rules.get("fee_policy")
        leverage_policy = review_rules.get("leverage_policy")
        funding_policy = review_rules.get("funding_policy")
        instrument_policies = review_rules.get("instrument_rules")
        if (
            not isinstance(fee_policy, Mapping)
            or not isinstance(leverage_policy, Mapping)
            or not isinstance(funding_policy, Mapping)
            or not isinstance(instrument_policies, list)
        ):
            raise TypeError("review fork rule projection is incomplete")
        fee_revision = validate_v2_counter(
            fee_policy.get("revision"),
            field_name="review fee revision",
        )
        instrument_revision_by_track = {
            str(item["track_id"]): validate_v2_counter(
                item.get("revision"),
                field_name="review instrument revision",
            )
            for item in instrument_policies
            if isinstance(item, Mapping) and isinstance(item.get("track_id"), str)
        }
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

        parent_ledger = tuple(
            connection.execute(
                """
                SELECT * FROM replay_training_contract_ledger
                WHERE run_id = ?
                ORDER BY ledger_sequence
                LIMIT ?
                """,
                (parent_run_id, ledger_count),
            ).fetchall()
        )
        if len(parent_ledger) != ledger_count:
            raise TrainingRunError(
                "REVIEW_FORK_MISMATCH",
                "review ledger prefix is no longer reconstructable",
                status_code=409,
                details={
                    "expected_ledger_count": ledger_count,
                    "actual_ledger_count": len(parent_ledger),
                },
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
            review_account.get(
                "margin_mode",
                creation_metadata.get("margin_mode", parent["margin_mode"]),
            )
        )
        funding_mode = str(funding_policy["funding_mode"])
        fixed_rate = funding_policy.get("fixed_funding_rate")
        funding_interval = funding_policy.get("funding_interval_ms")
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
                  AND revision <= ?
                  AND effective_virtual_time_ms <= ?
                ORDER BY revision
                """,
                (
                    parent_run_id,
                    instrument_revision_by_track.get("track-1", 1),
                    virtual_time_ms,
                ),
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
                WHERE run_id = ? AND revision <= ?
                  AND effective_virtual_time_ms <= ?
                ORDER BY revision
                """,
                (parent_run_id, fee_revision, virtual_time_ms),
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
    def _insert_launch_context(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        context: ReplayLaunchContext,
        now_ms: int,
    ) -> None:
        payload = context.to_dict()
        connection.execute(
            """
            INSERT INTO replay_training_launch_context(
                run_id, schema_version, source, context_json,
                context_hash, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                context.schema_version,
                context.source,
                canonical_json(payload),
                canonical_sha256(payload),
                now_ms,
            ),
        )

    @classmethod
    def _copy_launch_context(
        cls,
        connection: sqlite3.Connection,
        *,
        parent_run_id: str,
        child_run_id: str,
        now_ms: int,
    ) -> None:
        row = connection.execute(
            """
            SELECT context_json, context_hash
            FROM replay_training_launch_context
            WHERE run_id = ?
            """,
            (parent_run_id,),
        ).fetchone()
        if row is None:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "parent launch context is missing",
                status_code=503,
            )
        try:
            raw = json.loads(str(row["context_json"]))
            context = ReplayLaunchContext.from_dict(raw)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "parent launch context is invalid",
                status_code=503,
            ) from exc
        if canonical_sha256(context.to_dict()) != str(row["context_hash"]):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "parent launch context failed its integrity check",
                status_code=503,
            )
        cls._insert_launch_context(
            connection,
            run_id=child_run_id,
            context=context,
            now_ms=now_ms,
        )

    @staticmethod
    def _insert_start_selection(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        start_mode: str,
        seed_source: str,
        random_seed: int | None,
        actual_start_ms: int,
        actual_end_ms: int,
        dataset_epoch: str,
        parent_selection_hash: str | None,
        now_ms: int,
    ) -> None:
        if start_mode not in {"MANUAL", "RANDOM"}:
            raise TypeError("training start selection mode is invalid")
        if seed_source not in {"SERVER", "MANUAL", "LEGACY_CLIENT", "FORK"}:
            raise TypeError("training start selection seed source is invalid")
        if seed_source == "MANUAL" and start_mode != "MANUAL":
            raise TypeError("manual seed source requires a manual start")
        if seed_source in {"SERVER", "LEGACY_CLIENT"} and start_mode != "RANDOM":
            raise TypeError("random seed source requires a random start")
        if start_mode == "MANUAL" and random_seed is not None:
            raise TypeError("manual start selection cannot persist a random seed")
        if start_mode == "RANDOM" and random_seed is None:
            raise TypeError("random start selection must persist its private seed")
        if (
            random_seed is not None
            and (
                isinstance(random_seed, bool)
                or not isinstance(random_seed, int)
                or not 0 <= random_seed <= 9_007_199_254_740_991
            )
        ):
            raise TypeError("training start selection seed is invalid")
        if (
            isinstance(actual_start_ms, bool)
            or not isinstance(actual_start_ms, int)
            or actual_start_ms < 0
            or isinstance(actual_end_ms, bool)
            or not isinstance(actual_end_ms, int)
            or actual_end_ms < actual_start_ms
        ):
            raise TypeError("training start selection bounds are invalid")
        if not isinstance(dataset_epoch, str) or not dataset_epoch:
            raise TypeError("training start selection dataset epoch is invalid")
        if parent_selection_hash is not None and (
            not isinstance(parent_selection_hash, str)
            or len(parent_selection_hash) != 71
            or not parent_selection_hash.startswith("sha256:")
        ):
            raise TypeError("parent start selection hash is invalid")
        digest = start_selection_hash(
            run_id=run_id,
            start_mode=start_mode,
            seed_source=seed_source,
            random_seed=random_seed,
            actual_start_ms=actual_start_ms,
            actual_end_ms=actual_end_ms,
            dataset_epoch=dataset_epoch,
            parent_selection_hash=parent_selection_hash,
        )
        connection.execute(
            """
            INSERT INTO replay_training_start_selection(
                run_id, schema_version, start_mode, seed_source, random_seed,
                actual_start_ms, actual_end_ms, dataset_epoch,
                parent_selection_hash, selection_hash, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                START_SELECTION_SCHEMA_VERSION,
                start_mode,
                seed_source,
                random_seed,
                actual_start_ms,
                actual_end_ms,
                dataset_epoch,
                parent_selection_hash,
                digest,
                now_ms,
            ),
        )

    @staticmethod
    def _insert_data_policy(
        connection: sqlite3.Connection,
        *,
        run_id: str,
        policy: ResolvedHistoryPolicy,
        actual_replay_start_ms: int,
        now_ms: int,
    ) -> None:
        if not isinstance(policy, ResolvedHistoryPolicy):
            raise TypeError("history_policy must be a ResolvedHistoryPolicy")
        if policy.actual_replay_start_ms != actual_replay_start_ms:
            raise TypeError("history policy does not match the frozen replay start")
        digest = data_policy_hash(
            indicator_warmup_bars=policy.indicator_warmup_bars,
            visible_history_mode=policy.visible_history_mode.value,
            visible_history_lookback_ms=policy.visible_history_lookback_ms,
            visible_history_rows=policy.visible_history_rows,
            actual_visible_history_start_ms=policy.actual_visible_history_start_ms,
            actual_replay_start_ms=policy.actual_replay_start_ms,
            effective_warmup_bars=policy.effective_warmup_bars,
            forward_cache_ms=policy.forward_cache_ms,
            interval_ms=policy.interval_ms,
        )
        if digest != policy.policy_hash:
            raise TypeError("history policy hash implementation drifted")
        connection.execute(
            """
            INSERT INTO replay_training_data_policy(
                run_id, schema_version, indicator_warmup_bars,
                visible_history_mode, visible_history_lookback_ms,
                visible_history_rows, actual_visible_history_start_ms,
                actual_replay_start_ms, effective_warmup_bars,
                forward_cache_ms, interval_ms, policy_hash, created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                DATA_POLICY_SCHEMA_VERSION,
                policy.indicator_warmup_bars,
                policy.visible_history_mode.value,
                policy.visible_history_lookback_ms,
                policy.visible_history_rows,
                policy.actual_visible_history_start_ms,
                policy.actual_replay_start_ms,
                policy.effective_warmup_bars,
                policy.forward_cache_ms,
                policy.interval_ms,
                digest,
                now_ms,
            ),
        )

    @staticmethod
    def _data_policy_from_row(
        row: Mapping[str, object],
    ) -> ResolvedHistoryPolicy:
        if str(row["schema_version"]) != DATA_POLICY_SCHEMA_VERSION:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training data policy schema is unsupported",
                status_code=503,
            )
        try:
            policy = ResolvedHistoryPolicy(
                indicator_warmup_bars=int(row["indicator_warmup_bars"]),
                visible_history_mode=VisibleHistoryMode(
                    str(row["visible_history_mode"])
                ),
                visible_history_lookback_ms=(
                    None
                    if row["visible_history_lookback_ms"] is None
                    else int(row["visible_history_lookback_ms"])
                ),
                visible_history_rows=int(row["visible_history_rows"]),
                actual_visible_history_start_ms=int(
                    row["actual_visible_history_start_ms"]
                ),
                actual_replay_start_ms=int(row["actual_replay_start_ms"]),
                effective_warmup_bars=int(row["effective_warmup_bars"]),
                forward_cache_ms=int(row["forward_cache_ms"]),
                interval_ms=int(row["interval_ms"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training data policy is invalid",
                status_code=503,
            ) from exc
        if policy.policy_hash != str(row["policy_hash"]):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training data policy failed its integrity check",
                status_code=503,
            )
        return policy

    @classmethod
    def _copy_data_policy(
        cls,
        connection: sqlite3.Connection,
        *,
        parent_run_id: str,
        child_run_id: str,
        actual_replay_start_ms: int,
        now_ms: int,
    ) -> ResolvedHistoryPolicy:
        row = connection.execute(
            """
            SELECT * FROM replay_training_data_policy
            WHERE run_id = ?
            """,
            (parent_run_id,),
        ).fetchone()
        if row is None:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "parent training data policy is missing",
                status_code=503,
            )
        policy = cls._data_policy_from_row(row)
        cls._insert_data_policy(
            connection,
            run_id=child_run_id,
            policy=policy,
            actual_replay_start_ms=actual_replay_start_ms,
            now_ms=now_ms,
        )
        return policy

    @classmethod
    def _copy_start_selection(
        cls,
        connection: sqlite3.Connection,
        *,
        parent_run_id: str,
        child_run_id: str,
        actual_start_ms: int,
        actual_end_ms: int,
        dataset_epoch: str,
        now_ms: int,
    ) -> None:
        row = connection.execute(
            """
            SELECT * FROM replay_training_start_selection
            WHERE run_id = ?
            """,
            (parent_run_id,),
        ).fetchone()
        if row is None:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "parent start selection commitment is missing",
                status_code=503,
            )
        expected_hash = start_selection_hash(
            run_id=parent_run_id,
            start_mode=str(row["start_mode"]),
            seed_source=str(row["seed_source"]),
            random_seed=(
                None if row["random_seed"] is None else int(row["random_seed"])
            ),
            actual_start_ms=int(row["actual_start_ms"]),
            actual_end_ms=int(row["actual_end_ms"]),
            dataset_epoch=str(row["dataset_epoch"]),
            parent_selection_hash=row["parent_selection_hash"],
        )
        if expected_hash != str(row["selection_hash"]):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "parent start selection commitment failed validation",
                status_code=503,
            )
        if (
            int(row["actual_start_ms"]) != actual_start_ms
            or int(row["actual_end_ms"]) != actual_end_ms
            or str(row["dataset_epoch"]) != dataset_epoch
        ):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "forked dataset does not match the parent start selection",
                status_code=503,
            )
        cls._insert_start_selection(
            connection,
            run_id=child_run_id,
            start_mode=str(row["start_mode"]),
            seed_source="FORK",
            random_seed=(
                None if row["random_seed"] is None else int(row["random_seed"])
            ),
            actual_start_ms=actual_start_ms,
            actual_end_ms=actual_end_ms,
            dataset_epoch=dataset_epoch,
            parent_selection_hash=str(row["selection_hash"]),
            now_ms=now_ms,
        )

    @staticmethod
    def _launch_context_projection(row: Mapping[str, object]) -> dict[str, object]:
        raw_json = row["launch_context_json"]
        raw_hash = row["launch_context_hash"]
        if raw_json is None or raw_hash is None:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "stored replay launch context is missing",
                status_code=503,
            )
        try:
            context = ReplayLaunchContext.from_dict(json.loads(str(raw_json)))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "stored replay launch context is invalid",
                status_code=503,
            ) from exc
        payload = context.to_dict()
        if canonical_sha256(payload) != str(raw_hash):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "stored replay launch context failed its integrity check",
                status_code=503,
            )
        return payload

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
                broker_notional = Decimal(str(raw["notional"]))
                notional = broker_notional * Decimal(rule.contract_size)
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
                        canonical_json(
                            {
                                **dict(raw),
                                "account_notional": decimal_to_string(
                                    notional,
                                    field_name="account fill notional",
                                ),
                                "contract_size": rule.contract_size,
                                "rule_fidelity": rule.rule_fidelity,
                            }
                        ),
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
                cash_delta = Decimal(str(raw["amount"]))
                if (
                    kind == "REALIZED_PNL"
                    and rule.rule_fidelity
                    == "HISTORICAL_EXACT_VERSIONED_EXCHANGE_RULE"
                ):
                    cash_delta *= Decimal(rule.contract_size)
                cls._append_contract_ledger(
                    connection,
                    run_id=run_id,
                    posting_id=f"broker:{track_id}:{entry_id}",
                    track_id=track_id,
                    kind=f"BROKER_{kind}",
                    cash_delta=cash_delta,
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
                        "broker_amount": str(raw["amount"]),
                        "contract_size": rule.contract_size,
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
        trigger_virtual_time_ms: int | None = None,
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
            bankruptcy = entry - (
                allocation / (abs(quantity) * Decimal(rule.contract_size))
            ) * (
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
                    (
                        int(track["virtual_time_ms"] or 0)
                        if trigger_virtual_time_ms is None
                        else trigger_virtual_time_ms
                    ),
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
        history_guard = connection.execute(
            """
            SELECT account_data_mode, status, degraded_reason
            FROM replay_training_account_history WHERE run_id = ?
            """,
            (track["run_id"],),
        ).fetchone()
        if (
            history_guard is not None
            and history_guard["account_data_mode"] == "HISTORICAL_EXACT"
            and history_guard["status"] != "ACTIVE"
        ):
            # Never let an adapter pause/checkpoint overwrite the last exact
            # mark after its immutable input has degraded.
            connection.execute(
                """
                UPDATE replay_training_run
                SET state = 'PAUSED', compatibility = 'DEGRADED',
                    updated_at_ms = ?, saved_at_ms = ?
                WHERE run_id = ?
                """,
                (now_ms, now_ms, track["run_id"]),
            )
            connection.execute(
                """
                UPDATE replay_training_market_track
                SET state = 'DEGRADED',
                    degraded_reason = COALESCE(degraded_reason, ?),
                    updated_at_ms = ?
                WHERE run_id = ? AND track_id = ?
                """,
                (
                    history_guard["degraded_reason"],
                    now_ms,
                    track["run_id"],
                    track["track_id"],
                ),
            )
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
            SET state = CASE
                    WHEN EXISTS(
                        SELECT 1
                        FROM replay_historical_book_projection AS book
                        WHERE book.run_id = replay_training_market_track.run_id
                          AND book.track_id = replay_training_market_track.track_id
                          AND book.status IN ('CLEARED', 'DISABLED')
                    ) THEN 'DEGRADED'
                    ELSE ?
                END,
                subscription_tier = ?, virtual_time_ms = ?,
                source_sequence = ?, revision = ?, forced_full_reasons_json = ?,
                public_price = ?, position_json = ?, account_json = ?,
                open_orders_json = ?, degraded_reason = CASE
                    WHEN ? = 'ERROR' THEN COALESCE(degraded_reason, 'ADAPTER_ERROR')
                    WHEN EXISTS(
                        SELECT 1
                        FROM replay_historical_book_projection AS book
                        WHERE book.run_id = replay_training_market_track.run_id
                          AND book.track_id = replay_training_market_track.track_id
                          AND book.status IN ('CLEARED', 'DISABLED')
                    ) THEN COALESCE(degraded_reason, 'HISTORICAL_BOOK_UNAVAILABLE')
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
        account_history = connection.execute(
            """
            SELECT account_data_mode, status
            FROM replay_training_account_history WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        exact_account = (
            account_history is not None
            and account_history["account_data_mode"] == "HISTORICAL_EXACT"
        )
        if exact_account:
            self._apply_exact_mark_projection(
                connection,
                run_id=run_id,
                track_id=track_id,
                now_ms=now_ms,
            )
        self._settle_contract_funding(
            connection,
            run_id=run_id,
            now_ms=now_ms,
        )
        if not exact_account:
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
            self._refresh_contract_current_equity(
                connection,
                run_id=run_id,
                now_ms=now_ms,
                summary_revision=int(state["revision"]),
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
    def _required_synthetic_origin(value: object) -> int:
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
        ):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "hidden training synthetic origin is missing",
                status_code=503,
            )
        return value

    @staticmethod
    def _redact_active_rule(
        value: object,
        *,
        hidden: bool,
    ) -> dict[str, object]:
        if not isinstance(value, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "active training rule must be an object",
                status_code=503,
            )
        rule = dict(value)
        if not hidden:
            return rule
        for field_name in ("requested_start_ms", "random_seed"):
            if field_name in rule:
                rule[field_name] = None
        nested = rule.get("config")
        if isinstance(nested, Mapping):
            public_config = dict(nested)
            public_config["requested_start_ms"] = None
            public_config["random_seed"] = None
            rule["config"] = public_config
        return rule

    @staticmethod
    def _project_public_time(
        *,
        actual_origin_ms: int,
        public_origin_ms: int,
        policy: str,
        revealed: bool,
        public_time_ms: int,
        sequence: int,
    ) -> dict[str, object]:
        effective_policy = "NONE" if revealed else policy
        actual_time_ms = actual_origin_ms + public_time_ms - public_origin_ms
        return dict(
            project_public_time(
                actual_time_ms=actual_time_ms,
                public_time_ms=(
                    actual_time_ms
                    if effective_policy == "NONE"
                    else public_time_ms
                ),
                actual_origin_ms=actual_origin_ms,
                public_origin_ms=(
                    actual_origin_ms
                    if effective_policy == "NONE"
                    else public_origin_ms
                ),
                policy=effective_policy,
                sequence=sequence,
            )
        )

    @classmethod
    def _selection_public_bounds(
        cls,
        connection: sqlite3.Connection,
        *,
        session_id: str,
        policy: str,
        revealed: bool,
        actual_start_ms: int,
        actual_end_ms: int,
    ) -> tuple[dict[str, object], dict[str, object]]:
        dataset = connection.execute(
            """
            SELECT actual_replay_start_ms, actual_replay_end_ms,
                   synthetic_origin_ms
            FROM replay_dataset_ref WHERE session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if dataset is None:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training dataset time binding is missing",
                status_code=503,
            )
        actual_origin = int(dataset["actual_replay_start_ms"])
        if (
            actual_origin != actual_start_ms
            or int(dataset["actual_replay_end_ms"]) != actual_end_ms
        ):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training start selection and dataset bounds disagree",
                status_code=503,
            )
        public_origin = (
            actual_origin
            if policy == "NONE"
            else cls._required_synthetic_origin(dataset["synthetic_origin_ms"])
        )
        return (
            cls._project_public_time(
                actual_origin_ms=actual_origin,
                public_origin_ms=public_origin,
                policy=policy,
                revealed=revealed,
                public_time_ms=public_origin,
                sequence=0,
            ),
            cls._project_public_time(
                actual_origin_ms=actual_origin,
                public_origin_ms=public_origin,
                policy=policy,
                revealed=revealed,
                public_time_ms=public_origin + actual_end_ms - actual_origin,
                sequence=1,
            ),
        )

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
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training dataset time binding is missing",
                status_code=503,
            )
        actual_origin = int(dataset["actual_replay_start_ms"])
        public_origin = (
            actual_origin
            if policy == "NONE"
            else TrainingRunStore._required_synthetic_origin(
                dataset["synthetic_origin_ms"]
            )
        )
        return TrainingRunStore._project_public_time(
            actual_origin_ms=actual_origin,
            public_origin_ms=public_origin,
            policy=policy,
            revealed=revealed,
            public_time_ms=public_time_ms,
            sequence=sequence,
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
