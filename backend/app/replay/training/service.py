"""TrainingRun lifecycle, ViewerState, and replay.v3 control adaptation."""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import uuid
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from decimal import ROUND_FLOOR, Decimal, InvalidOperation
from typing import TYPE_CHECKING, cast

from app.data_engine.interval_policy import (
    VALID_INTERVALS,
    compute_bucket_start_ms,
    parse_interval_ms,
)
from app.replay.constants import (
    REPLAY_PROTOCOL,
    CommandType,
    ExecutionModel,
    QualityMode,
    SlippageKind,
    SourceKind,
    StartPolicy,
)
from app.replay.broker.models import TOUCH_OR_TAPE_EXECUTION_MODE, decimal_to_string
from app.replay.canonical import canonical_sha256
from app.replay.catalog import ReplaySeriesIdentity
from app.replay.display_time import SourceBucketTimeMapper
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.internal_commands import InternalCommandType
from app.replay.models import (
    MAX_TIMESTAMP_MS,
    FeeModel,
    ReplayCommand,
    ReplaySessionConfig,
    SlippageModel,
    normalize_decimal_string,
    validate_identifier,
)
from app.replay.period_summary import (
    EncodedPeriodSummaryCandidate,
    ReplayPeriodSummary,
)

from .errors import TrainingRunError
from .commands import ReplayV2Command
from .control import (
    ADVANCE_CONTRACT_VERSION,
    MAX_CONTROL_COUNT,
    MAX_PLAYBACK_BATCH_UNITS,
    PLAYBACK_CONTRACT_VERSION,
    advance_basis,
    aligned_step_target_ms,
    compatible_step_interval_ms,
    control_count,
    control_rate,
    default_playback_basis,
    discrete_playback_units,
    fixed_interval_ms,
    source_aligned_step_target_ms,
    supported_advance_bases,
    supported_playback_bases,
    validate_bar_duration_ms,
    virtual_duration_ms,
)
from .history import build_display_projection, build_history_page
from .account_history import (
    FUNDING_EVENT_PHASE,
    MARK_INDEX_EVENT_PHASE,
    RULE_EVENT_PHASE,
    AccountHistoryArchiveManager,
)
from .historical_book import HistoricalBookArchiveManager, HistoricalBookProjection
from .hedge_inputs import HedgeInputArchiveManager, PreparedHedgeInputBinding
from .account import isolated_margin_key, round_to_step
from .fast_forward import FastForwardContext, FastForwardDecision, FastForwardPlanner
from .models import (
    AccountDataMode,
    AdvanceBasis,
    BookMode,
    FastForwardPlan,
    FundingMode,
    IntegrityMode,
    REPLAY_V2_PROTOCOL,
    ReplaySource,
    ReplayV2CommandType,
    RunState,
    StartMode,
    SubscriptionTier,
    TimeDisclosurePolicy,
    TrainingCursor,
    TrainingRunCreateRequest,
    TrainingRunMarketSelectionRequest,
    TrainingRunSetupRequest,
    VisibleHistoryMode,
    validate_v2_counter,
)

from .multitrack import (
    GLOBAL_ORDERING_VERSION,
    MARKET_EVENT_PHASE,
    StableMarketEvent,
    TrainingRunActor,
    stable_market_event_order,
)
from .storage import TrainingRunStore
from .storage_governance import ReplayStorageGovernance
from .segments import (
    ReplaySegmentManager,
    resolve_history_policy,
)
from .trade_flow import ReplayTradeFlowAdapter

if TYPE_CHECKING:
    from app.replay.service import ReplayService


ADVANCE_PROGRESS_RETENTION_SECONDS = 2.0
FINAL_STATE_PROJECTION_DELIVERY = "FINAL_STATE"
FINAL_STATE_EMPTY_ACCOUNT_CHUNK_EVENTS = 10_000
ORDERED_PLAYBACK_INTERACTIVE_BATCH_UNITS = 1
ORDERED_PLAYBACK_FINAL_STATE_MIN_RATE = 60
ORDERED_PLAYBACK_FINAL_STATE_TARGET_HZ = 3
_NATIVE_DISPLAY_PIN_PROOF_CACHE_SIZE = 4_096
_NativeDisplayPinProofKey = tuple[str, str, str, str, str, int, int, int, str]
_NativeDisplayPinProof = tuple[int, str, int]


def _stored_counter(value: object, *, field_name: str) -> int:
    try:
        return validate_v2_counter(value, field_name=field_name)
    except (TypeError, ValueError) as exc:
        raise TrainingRunError(
            "TRAINING_RUN_STORAGE_DEGRADED",
            f"{field_name} is invalid",
            status_code=503,
        ) from exc


def _stored_mapping(value: object, *, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TrainingRunError(
            "TRAINING_RUN_STORAGE_DEGRADED",
            f"{field_name} must be an object",
            status_code=503,
        )
    return cast(Mapping[str, object], value)


def _position_is_open(value: object) -> bool:
    if not isinstance(value, Mapping):
        return False
    if value.get("position_mode") == "HEDGE":
        return any(
            isinstance(value.get(leg), Mapping)
            and value[leg].get("quantity") not in {None, "0", 0}
            for leg in ("long", "short")
        )
    return value.get("quantity") not in {None, "0", 0}


def _position_leg(
    value: object,
    *,
    position_side: object = None,
) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    if value.get("position_mode") != "HEDGE":
        return cast(Mapping[str, object], value)
    if position_side not in {"LONG", "SHORT"}:
        return None
    leg = value.get(str(position_side).lower())
    return cast(Mapping[str, object], leg) if isinstance(leg, Mapping) else None


def _position_mark(value: object, *, position_side: object = None) -> object:
    leg = _position_leg(value, position_side=position_side)
    if leg is not None and leg.get("mark_price") is not None:
        return leg.get("mark_price")
    if isinstance(value, Mapping) and value.get("position_mode") == "HEDGE":
        for name in ("long", "short"):
            candidate = value.get(name)
            if (
                isinstance(candidate, Mapping)
                and candidate.get("mark_price") is not None
            ):
                return candidate.get("mark_price")
    return None


def _position_gross_notional(value: object) -> Decimal:
    if not isinstance(value, Mapping):
        return Decimal(0)
    if value.get("position_mode") != "HEDGE":
        return Decimal(str(value.get("notional", "0")))
    return sum(
        (
            Decimal(str(leg.get("notional", "0")))
            for name in ("long", "short")
            if isinstance((leg := value.get(name)), Mapping)
        ),
        Decimal(0),
    )


def _portfolio_risk_position(
    portfolio: Mapping[str, object],
    *,
    track_id: str,
    position_side: object,
) -> Mapping[str, object] | None:
    positions = portfolio.get("positions")
    if not isinstance(positions, list):
        return None
    item = next(
        (
            candidate
            for candidate in positions
            if isinstance(candidate, Mapping)
            and candidate.get("track_id") == track_id
            and candidate.get("position_side") == position_side
        ),
        None,
    )
    return cast(Mapping[str, object], item) if isinstance(item, Mapping) else None


def _hedge_leg_leverage(
    portfolio: Mapping[str, object],
    *,
    track_id: str,
    position_side: object,
) -> Decimal | None:
    if position_side not in {"LONG", "SHORT"}:
        return None
    position = _portfolio_risk_position(
        portfolio,
        track_id=track_id,
        position_side=position_side,
    )
    if position is not None and position.get("leverage") is not None:
        return Decimal(str(position["leverage"]))
    hedge_state = portfolio.get("hedge_state")
    legs = (
        hedge_state.get("position_legs") if isinstance(hedge_state, Mapping) else None
    )
    if not isinstance(legs, list):
        return None
    leg = next(
        (
            candidate
            for candidate in legs
            if isinstance(candidate, Mapping)
            and candidate.get("track_id") == track_id
            and candidate.get("position_side") == position_side
        ),
        None,
    )
    if not isinstance(leg, Mapping) or leg.get("leverage") is None:
        return None
    return Decimal(str(leg["leverage"]))


class TrainingRunService:
    """Own Hub metadata and delegate active single-track execution to replay.v1."""

    def __init__(
        self,
        *,
        replay_service: "ReplayService",
        run_id_factory: Callable[[], str] = lambda: uuid.uuid4().hex,
        random_seed_factory: Callable[[], int] = (lambda: uuid.uuid4().int % (1 << 53)),
    ) -> None:
        self.replay_service = replay_service
        self.store = TrainingRunStore(replay_service.store)
        self.segments = ReplaySegmentManager(
            replay_service.store,
            download_worker_enabled=(
                replay_service.settings.replay_segment_download_worker_enabled
            ),
            auto_gc_enabled=replay_service.settings.replay_segment_auto_gc_enabled,
            max_archive_bytes=(
                replay_service.settings.replay_segment_max_archive_bytes
            ),
        )
        self.historical_books = HistoricalBookArchiveManager(
            replay_service.store,
            enabled=replay_service.settings.replay_historical_book_enabled,
            max_archive_bytes=(
                replay_service.settings.replay_historical_book_max_archive_bytes
            ),
        )
        self.account_history = AccountHistoryArchiveManager(
            replay_service.store,
            enabled=replay_service.settings.replay_account_history_enabled,
            max_archive_bytes=(
                replay_service.settings.replay_account_history_max_archive_bytes
            ),
        )
        self.hedge_inputs = HedgeInputArchiveManager(replay_service.store)
        self.storage_governance = ReplayStorageGovernance(
            replay_service.store,
            settings=replay_service.settings,
            segments=self.segments,
            historical_books=self.historical_books,
            account_history=self.account_history,
            bar_repository=replay_service.history_repository,
            raw_trade_archive=replay_service.raw_trade_archive,
        )
        self._run_id_factory = run_id_factory
        self._random_seed_factory = random_seed_factory
        self._fast_forward_planner = FastForwardPlanner()
        self._trade_flow_adapter = ReplayTradeFlowAdapter()
        self._advance_jobs: dict[tuple[str, str], dict[str, object]] = {}
        self._period_summary_builds: set[str] = set()
        self._run_actors: dict[str, TrainingRunActor] = {}
        self._display_source_grid_anchors: dict[tuple[str, str, str, str], int] = {}
        self._native_display_pin_proofs: OrderedDict[
            _NativeDisplayPinProofKey,
            _NativeDisplayPinProof,
        ] = OrderedDict()

    def _remember_native_display_pin_proof(
        self,
        key: _NativeDisplayPinProofKey,
        proof: _NativeDisplayPinProof,
    ) -> None:
        self._native_display_pin_proofs[key] = proof
        self._native_display_pin_proofs.move_to_end(key)
        if len(self._native_display_pin_proofs) > _NATIVE_DISPLAY_PIN_PROOF_CACHE_SIZE:
            self._native_display_pin_proofs.popitem(last=False)

    async def start(self) -> None:
        await self.store.start()
        await self.segments.start()
        await self.historical_books.start()
        await self.account_history.start()
        await self.hedge_inputs.start()

    async def shutdown(self) -> frozenset[str]:
        """Stop server-owned ordered playback before replay.v1 actors close."""

        tasks: list[asyncio.Task[None]] = []
        active_run_ids: list[str] = []
        for run_id, actor in tuple(self._run_actors.items()):
            async with actor.serialized():
                if actor.playback_snapshot()["state"] == "PLAYING":
                    active_run_ids.append(run_id)
                task = actor.request_ordered_pause(reason="SERVICE_SHUTDOWN")
                if task is not None:
                    tasks.append(task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        shutdown_pause_sessions: set[str] = set()
        for run_id in active_run_ids:
            projection = await self.store.get_market_tracks(run_id)
            tracks = projection.get("tracks")
            if not isinstance(tracks, list):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market tracks projection is invalid during shutdown",
                    status_code=503,
                )
            for track in tracks:
                if not isinstance(track, Mapping):
                    continue
                session_id = track.get("adapter_session_id")
                if track.get("subscription_tier") == "FULL" and isinstance(
                    session_id, str
                ):
                    shutdown_pause_sessions.add(session_id)
        await self.segments.shutdown()
        return frozenset(shutdown_pause_sessions)

    async def get_selection_preparation(
        self,
        preparation_id: str,
    ) -> dict[str, object]:
        normalized = self._identifier(
            preparation_id,
            field_name="preparation_id",
        )
        return {
            "protocol": "replay.v3",
            "preparation": await self.store.selection_preparation(normalized),
        }

    async def retry_selection_preparation(
        self,
        preparation_id: str,
    ) -> dict[str, object]:
        return await self._retry_selection_preparation(preparation_id)

    async def _retry_selection_preparation(
        self,
        preparation_id: str,
        *,
        existing_shell_run_id: str | None = None,
    ) -> dict[str, object]:
        normalized = self._identifier(
            preparation_id,
            field_name="preparation_id",
        )
        retry = await self.store.claim_selection_preparation_retry(normalized)
        try:
            request = TrainingRunCreateRequest.from_dict(retry["request"])
        except (TypeError, ValueError) as exc:
            await self.store.fail_selection_preparation(
                normalized,
                error_code="TRAINING_RUN_STORAGE_DEGRADED",
                error_message="training preparation retry request is invalid",
            )
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training preparation retry request is invalid",
                status_code=503,
                details={"preparation_id": normalized},
            ) from exc
        try:
            return await self.create_run(
                request,
                _retry_preparation=retry,
                _existing_shell_run_id=existing_shell_run_id,
            )
        except BaseException:
            await self.store.fail_selection_preparation(
                normalized,
                error_code="TRAINING_RUN_CREATE_FAILED",
                error_message="training preparation retry failed",
            )
            raise

    async def list_runs(
        self,
        *,
        limit: int,
        cursor: str | None,
        state: str | None,
        source_kind: str | None,
        compatibility: str | None,
    ) -> dict[str, object]:
        return await self.store.list_runs(
            limit=limit,
            cursor=cursor,
            state=state,
            source_kind=source_kind,
            compatibility=compatibility,
        )

    async def get_run(self, run_id: str) -> dict[str, object]:
        return await self.store.get_run(self._identifier(run_id, field_name="run_id"))

    async def create_empty_run(
        self,
        request: TrainingRunSetupRequest,
    ) -> dict[str, object]:
        if not isinstance(request, TrainingRunSetupRequest):
            raise TypeError("request must be TrainingRunSetupRequest")
        run_id = self._identifier(self._run_id_factory(), field_name="run_id")
        settings = request.to_dict()
        if settings["start_mode"] == StartMode.MANUAL.value:
            committed_start_ms = int(settings["requested_start_ms"])
            random_seed = None
        else:
            random_seed = self._authoritative_random_seed()
            range_start = int(settings["random_range_start_ms"])
            range_end = int(settings["random_range_end_ms"])
            minute_count = ((range_end - range_start) // 60_000) + 1
            committed_start_ms = range_start + (random_seed % minute_count) * 60_000
        try:
            await self.store.create_empty_run(
                run_id=run_id,
                request=request,
                committed_start_ms=committed_start_ms,
                random_seed=random_seed,
            )
        except sqlite3.IntegrityError as exc:
            raise TrainingRunError(
                "TRAINING_RUN_CONFLICT",
                "training run identity already exists",
                status_code=409,
            ) from exc
        return {
            "protocol": REPLAY_V2_PROTOCOL,
            "created": True,
            "run": await self.store.get_run(run_id),
        }

    async def select_initial_market(
        self,
        run_id: str,
        selection: TrainingRunMarketSelectionRequest,
    ) -> dict[str, object]:
        if not isinstance(selection, TrainingRunMarketSelectionRequest):
            raise TypeError("selection must be TrainingRunMarketSelectionRequest")
        normalized = self._identifier(run_id, field_name="run_id")
        actor = self._run_actors.setdefault(normalized, TrainingRunActor(normalized))
        async with actor.serialized():
            setup = await self.store.get_run_setup(normalized)
            commitment = await self.store.get_time_commitment(normalized)
            request = setup.for_market(selection)
            if request.start_mode is StartMode.RANDOM:
                request = replace(request, random_seed=int(commitment["random_seed"]))
            else:
                request = replace(request, random_seed=None)
            await self._require_market_at_committed_start(
                selection=selection,
                setup=setup,
                commitment=commitment,
            )
            preparation_id = canonical_sha256(
                {
                    "contract": "replay.initial-market-preparation.v1",
                    "run_id": normalized,
                    "selection": selection.to_dict(),
                    "time_commitment_hash": commitment["commitment_hash"],
                }
            )[7:39]
            try:
                preparation = await self.store.selection_preparation(preparation_id)
            except TrainingRunError as exc:
                if exc.code != "TRAINING_PREPARATION_NOT_FOUND":
                    raise
                result = await self.create_run(
                    request,
                    _existing_shell_run_id=normalized,
                    _preparation_id=preparation_id,
                    _committed_start_ms=int(commitment["committed_start_ms"]),
                )
            else:
                status = str(preparation.get("status"))
                if status == "FAILED":
                    result = await self._retry_selection_preparation(
                        preparation_id,
                        existing_shell_run_id=normalized,
                    )
                elif status == "PREPARING_DATA":
                    raise TrainingRunError(
                        "TRAINING_RUN_BUSY",
                        "the initial market is already being prepared",
                        status_code=409,
                        details={"preparation_id": preparation_id},
                    )
                else:
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "an empty run has an already-completed market preparation",
                        status_code=503,
                        details={"preparation_id": preparation_id},
                    )
        return {
            "protocol": REPLAY_V2_PROTOCOL,
            "initialized": True,
            "run": result["run"],
        }

    async def market_catalog(self, run_id: str) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        setup = await self.store.get_run_setup(
            normalized,
            require_awaiting_market=False,
        )
        settings = setup.to_dict()
        # A MANUAL start means the user knows the committed start; it does not
        # authorize exposing the source tail, eligible future windows, or data
        # fingerprint while the Run's disclosure policy is still active.
        blind_mode = settings["time_disclosure_policy"] != "NONE"
        catalog = await self.replay_service.catalog(
            warmup_bars=int(settings["indicator_warmup_bars"]),
            horizon_ms=int(settings["forward_cache_ms"]),
            quality_mode="exact",
            blind_mode=blind_mode,
        )
        internal_catalog = (
            await self.replay_service.catalog(
                warmup_bars=int(settings["indicator_warmup_bars"]),
                horizon_ms=int(settings["forward_cache_ms"]),
                quality_mode="exact",
                blind_mode=False,
            )
            if blind_mode
            else catalog
        )
        commitment = await self.store.get_time_commitment(normalized)
        internal_by_identity = {
            self._catalog_identity_key(entry): entry
            for entry in cast(list[Mapping[str, object]], internal_catalog["entries"])
        }
        for entry in cast(list[dict[str, object]], catalog["entries"]):
            internal_entry = internal_by_identity.get(
                self._catalog_identity_key(entry), entry
            )
            entry["start_compatibility"] = self._market_start_compatibility(
                internal_entry,
                int(commitment["committed_start_ms"]),
            )
        catalog["time_commitment"] = self._public_time_commitment(
            commitment,
            disclose_start=settings["time_disclosure_policy"] == "NONE",
        )
        return catalog

    async def initial_market_plan(
        self,
        run_id: str,
        selection: TrainingRunMarketSelectionRequest,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        setup = await self.store.get_run_setup(normalized)
        commitment = await self.store.get_time_commitment(normalized)
        await self._require_market_at_committed_start(
            selection=selection,
            setup=setup,
            commitment=commitment,
        )
        request = setup.for_market(selection)
        return await self.segment_plan(
            replace(
                request,
                start_mode=StartMode.MANUAL,
                requested_start_ms=int(commitment["committed_start_ms"]),
                random_seed=None,
            )
        )

    async def account_record_page(
        self,
        run_id: str,
        *,
        record_type: str,
        order_scope: str,
        track_id: str | None,
        cursor: str | None,
        limit: int,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        normalized_track = (
            None
            if track_id is None
            else self._identifier(track_id, field_name="track_id")
        )
        return await self.store.account_record_page(
            normalized,
            record_type=record_type,
            order_scope=order_scope,
            track_id=normalized_track,
            cursor=cursor,
            limit=limit,
        )

    async def delete_run(self, run_id: str) -> dict[str, object]:
        """Pause, detach, and atomically remove one Hub archive."""

        normalized = self._identifier(run_id, field_name="run_id")
        # Reject missing or protected archives before publishing a run actor.
        await self.store.deletion_target(normalized)
        pause_task: asyncio.Task[None] | None = None
        actor = self._run_actors.setdefault(
            normalized,
            TrainingRunActor(normalized),
        )
        try:
            async with actor.serialized():
                kind, session_ids = await self.store.deletion_target(normalized)
                if kind == "V2":
                    pause_task = actor.request_ordered_pause(reason="DELETE_RUN")
                try:
                    deleted_session_ids = (
                        await self.replay_service.delete_sessions_atomically(
                            session_ids,
                            lambda: self.store.delete_run(
                                normalized,
                                expected_session_ids=session_ids,
                            ),
                        )
                    )
                except ReplayDomainError as exc:
                    if exc.http_status == 409:
                        raise TrainingRunError(
                            "TRAINING_RUN_BUSY",
                            "training run cannot be deleted while an adapter session is busy",
                            status_code=409,
                            details={
                                "reason": exc.code.value,
                                "session_id": exc.details.get("session_id"),
                            },
                        ) from exc
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "training adapter sessions could not be detached for deletion",
                        status_code=503,
                        details={"reason": exc.code.value},
                    ) from exc
                if self._run_actors.get(normalized) is actor:
                    self._run_actors.pop(normalized, None)
                for cache_key in tuple(self._display_source_grid_anchors):
                    if cache_key[0] == normalized:
                        self._display_source_grid_anchors.pop(cache_key, None)
        finally:
            if pause_task is not None:
                await asyncio.gather(pause_task, return_exceptions=True)
        return {
            "protocol": REPLAY_V2_PROTOCOL,
            "deleted": True,
            "run_id": normalized,
            "session_ids": list(deleted_session_ids),
        }

    async def segment_plan(
        self, request: TrainingRunCreateRequest
    ) -> dict[str, object]:
        if not isinstance(request, TrainingRunCreateRequest):
            raise TypeError("request must be TrainingRunCreateRequest")
        plan = await self.segments.plan_for_request(
            request,
            max_dataset_rows=self.replay_service.settings.max_bar_dataset_rows,
        )
        return {
            **plan,
            "historical_book": await self.historical_books.plan_for_request(request),
            "account_history": await self.account_history.plan_for_request(request),
            "hedge_inputs": await self.hedge_inputs.plan_for_request(request),
        }

    async def list_account_history_archives(self) -> dict[str, object]:
        return await self.account_history.list_archives()

    async def storage_inventory(self) -> dict[str, object]:
        return await self.storage_governance.inventory()

    async def account_history_gc_plan(
        self, *, target_reclaim_bytes: int, max_archives: int
    ) -> dict[str, object]:
        return await self.account_history.gc_plan(
            target_reclaim_bytes=target_reclaim_bytes,
            max_archives=max_archives,
        )

    async def account_history_gc_run(
        self,
        *,
        plan_hash: str,
        target_reclaim_bytes: int,
        max_archives: int,
    ) -> dict[str, object]:
        return await self.account_history.gc_run(
            plan_hash=plan_hash,
            target_reclaim_bytes=target_reclaim_bytes,
            max_archives=max_archives,
        )

    async def rehydrate_account_history_archive(
        self, archive_id: str
    ) -> dict[str, object]:
        return await self.account_history.rehydrate_archive(
            self._identifier(archive_id, field_name="archive_id")
        )

    async def audit_account(self, run_id: str) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        hedge_input_audit = await self.hedge_inputs.audit_run(normalized)
        projection = await self.store.get_market_tracks(normalized)
        portfolio = projection.get("portfolio")
        authoritative: Mapping[str, Mapping[str, object]] | None = None
        if (
            isinstance(portfolio, Mapping)
            and isinstance(portfolio.get("account_history"), Mapping)
            and portfolio["account_history"].get("mode") == "HISTORICAL_EXACT"  # type: ignore[union-attr]
        ):
            raw_tracks = projection.get("tracks")
            if not isinstance(raw_tracks, list):
                raise TypeError("exact account tracks projection is invalid")
            authoritative = await self.account_history.authoritative_projections(
                run_id=normalized,
                tracks=tuple(
                    track for track in raw_tracks if isinstance(track, Mapping)
                ),
            )
        account_audit = await self.store.audit_account(
            normalized,
            authoritative_projections=authoritative,
        )
        account_status = str(account_audit.get("status"))
        hedge_input_status = str(hedge_input_audit.get("status"))
        combined_status = (
            "PASS"
            if account_status == "PASS"
            and hedge_input_status in {"PASS", "NOT_APPLICABLE"}
            else "FAIL"
        )
        return {
            **account_audit,
            "status": combined_status,
            "account_audit_status": account_status,
            "hedge_input_audit": self._public_hedge_input_audit(hedge_input_audit),
        }

    @staticmethod
    def _public_hedge_input_audit(
        audit: Mapping[str, object],
    ) -> dict[str, object]:
        differences = audit.get("differences")
        if not isinstance(differences, list):
            raise TypeError("internal HEDGE input audit differences are invalid")
        snapshot = audit.get("snapshot")
        if snapshot is not None and not isinstance(snapshot, Mapping):
            raise TypeError("internal HEDGE input audit snapshot is invalid")
        return {
            "schema_version": "replay.hedge-input-audit-summary.v1",
            "status": str(audit.get("status")),
            "proof_hash": audit.get("proof_hash"),
            "difference_count": len(differences),
            "difference_hashes": [
                canonical_sha256(difference) for difference in differences
            ],
            "snapshot_hash": (None if snapshot is None else canonical_sha256(snapshot)),
        }

    async def list_data_segments(
        self, *, run_id: str | None = None
    ) -> dict[str, object]:
        normalized = (
            None if run_id is None else self._identifier(run_id, field_name="run_id")
        )
        redact = normalized is None
        if normalized is not None:
            integrity = await self.store.integrity(normalized)
            redact = not bool(integrity.get("revealed"))
        return await self.segments.list_segments(
            run_id=normalized,
            redact_ranges=redact,
        )

    async def list_historical_book_archives(self) -> dict[str, object]:
        return await self.historical_books.list_archives()

    async def historical_book_gc_plan(
        self, *, target_reclaim_bytes: int, max_archives: int
    ) -> dict[str, object]:
        return await self.historical_books.gc_plan(
            target_reclaim_bytes=target_reclaim_bytes,
            max_archives=max_archives,
        )

    async def historical_book_gc_run(
        self,
        *,
        plan_hash: str,
        target_reclaim_bytes: int,
        max_archives: int,
    ) -> dict[str, object]:
        return await self.historical_books.gc_run(
            plan_hash=plan_hash,
            target_reclaim_bytes=target_reclaim_bytes,
            max_archives=max_archives,
        )

    async def rehydrate_historical_book_archive(
        self, archive_id: str
    ) -> dict[str, object]:
        normalized = self._identifier(archive_id, field_name="archive_id")
        return await self.historical_books.rehydrate_archive(normalized)

    async def resync_historical_book(self, run_id: str) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        binding = await self.store.run_binding(normalized)
        if str(binding.get("book_mode")) != BookMode.BOOK_ASSISTED_REQUIRED.value:
            raise TrainingRunError(
                "HISTORICAL_BOOK_NOT_REQUIRED",
                "the TrainingRun does not use BOOK_ASSISTED_REQUIRED",
                status_code=409,
            )
        actor = self._run_actors.setdefault(normalized, TrainingRunActor(normalized))
        if actor.playback_is_active():
            raise TrainingRunError(
                "HISTORICAL_BOOK_RESYNC_REQUIRES_PAUSE",
                "pause ordered playback before historical book resync",
                status_code=409,
            )
        session = await self.replay_service.get_session(
            str(binding["adapter_session_id"])
        )
        snapshot = self._snapshot(session)
        if snapshot.get("state") != "PAUSED":
            raise TrainingRunError(
                "HISTORICAL_BOOK_RESYNC_REQUIRES_PAUSE",
                "all FULL tracks must be paused before historical book resync",
                status_code=409,
            )
        cursor = _stored_mapping(snapshot.get("cursor"), field_name="adapter cursor")
        virtual_time_ms = _stored_counter(
            cursor.get("virtual_time_ms"), field_name="virtual_time_ms"
        )
        projection = await self.store.get_market_tracks(normalized)
        raw_tracks = projection.get("tracks")
        if not isinstance(raw_tracks, list):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "market tracks projection is invalid",
                status_code=503,
            )
        tracks = [
            cast(Mapping[str, object], track)
            for track in raw_tracks
            if isinstance(track, Mapping)
        ]
        prepared = await self.historical_books.resync_run(
            run_id=normalized,
            tracks=tracks,
            actual_time_ms=self._actual_event_time_ms(binding, virtual_time_ms),
            virtual_time_ms=virtual_time_ms,
        )
        return {
            "protocol": "replay.historical-book.resync.v1",
            "run_id": normalized,
            "resynced_track_count": len(prepared),
            "fallback_applied": False,
            "tracks": (await self.store.get_market_tracks(normalized))["tracks"],
        }

    async def data_segment_gc_plan(
        self, *, target_reclaim_bytes: int, max_segments: int
    ) -> dict[str, object]:
        return await self.segments.gc_plan(
            target_reclaim_bytes=target_reclaim_bytes,
            max_segments=max_segments,
        )

    async def data_segment_gc_run(
        self,
        *,
        plan_hash: str,
        target_reclaim_bytes: int,
        max_segments: int,
    ) -> dict[str, object]:
        return await self.segments.gc_run(
            plan_hash=plan_hash,
            target_reclaim_bytes=target_reclaim_bytes,
            max_segments=max_segments,
        )

    async def get_viewer_state(self, run_id: str) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        return (await self.store.get_viewer_state(normalized)).to_dict()

    async def get_viewer_state_by_session(self, session_id: str) -> dict[str, object]:
        run_id = await self.store.run_id_for_session(
            self._identifier(session_id, field_name="session_id")
        )
        return (await self.store.get_viewer_state(run_id)).to_dict()

    async def get_market_tracks(self, run_id: str) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        projection = await self.store.get_market_tracks(normalized)
        return await self._with_global_clock(normalized, projection)

    async def preview_order(
        self,
        run_id: str,
        *,
        expected_revision: int,
        expected_cursor: TrainingCursor,
        position_intent: str,
        order: Mapping[str, object],
        trade_plan: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        """Return a non-mutating order preview bound to one authoritative cursor."""

        normalized = self._identifier(run_id, field_name="run_id")
        if expected_revision != expected_cursor.revision:
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "preview revision must match expected cursor revision",
                status_code=422,
            )
        actor = self._run_actors.setdefault(normalized, TrainingRunActor(normalized))
        async with actor.serialized():
            binding = await self.store.run_binding(normalized)
            projection = await self.store.get_market_tracks(normalized)
            tracks = projection.get("tracks")
            if not isinstance(tracks, list):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market tracks projection is invalid",
                    status_code=503,
                )
            selected_track_id = str(binding["selected_track_id"])
            selected = next(
                (
                    track
                    for track in tracks
                    if isinstance(track, Mapping)
                    and track.get("track_id") == selected_track_id
                ),
                None,
            )
            if (
                selected is None
                or selected.get("subscription_tier") != "FULL"
                or selected.get("state") != "READY"
            ):
                raise TrainingRunError(
                    "MARKET_TRACK_NOT_READY",
                    "order preview requires the selected market track to be READY and FULL",
                    status_code=409,
                )
            session_id = str(binding["adapter_session_id"])
            session = await self.replay_service.get_session(session_id)
            snapshot = self._snapshot(session)
            cursor = snapshot.get("cursor")
            if not isinstance(cursor, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "adapter cursor is invalid",
                    status_code=503,
                )
            actual = {
                "virtual_time_ms": cursor.get("virtual_time_ms"),
                "source_sequence": cursor.get("source_sequence"),
                "revision": snapshot.get("revision"),
            }
            if actual != expected_cursor.to_dict():
                raise TrainingRunError(
                    "REVISION_CONFLICT",
                    "preview cursor does not match the authoritative run cursor",
                    status_code=409,
                    details={"expected": expected_cursor.to_dict(), "actual": actual},
                )
            await self._guard_historical_book_current(
                run_id=normalized,
                binding=binding,
                snapshot=snapshot,
            )
            payload = dict(
                self._order_payload_with_optional_leverage(
                    order,
                    {
                        "client_order_id",
                        "side",
                        "order_type",
                        "quantity",
                        "reduce_only",
                        "limit_price",
                        "stop_price",
                    },
                )
            )
            if position_intent not in {"NET", "OPEN"}:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "order preview position intent is unsupported",
                    status_code=422,
                )
            if binding.get("position_mode") == "HEDGE" and payload.get(
                "position_side"
            ) not in {"LONG", "SHORT"}:
                raise TrainingRunError(
                    "ORDER_REJECTED",
                    "HEDGE order preview requires position_side",
                    status_code=409,
                )
            if position_intent == "OPEN" and binding.get("position_mode") != "HEDGE":
                if (
                    payload.get("order_type") != "MARKET"
                    or payload.get("reduce_only") is not False
                ):
                    raise TrainingRunError(
                        "REPLAY_CONTROL_INVALID",
                        "OPEN preview is only available for non-reduce-only market orders",
                        status_code=422,
                    )
                position = selected.get("position")
                if not isinstance(position, Mapping):
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "selected position projection is invalid",
                        status_code=503,
                    )
                try:
                    position_quantity = Decimal(str(position.get("quantity")))
                except InvalidOperation as exc:
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "selected position quantity is invalid",
                        status_code=503,
                    ) from exc
                if position_quantity != 0 and (position_quantity > 0) != (
                    payload.get("side") == "BUY"
                ):
                    raise TrainingRunError(
                        "ORDER_REJECTED",
                        "OPEN cannot reduce or reverse the current position",
                        status_code=409,
                    )
            normalized_plan: dict[str, object] | None = None
            if trade_plan is not None:
                if position_intent != "OPEN":
                    raise TrainingRunError(
                        "TRADE_PLAN_INVALID",
                        "trade plans are only available for opening orders",
                        status_code=422,
                    )
                provisional_entry = self._planned_entry_reference(
                    payload=payload,
                    selected_track=selected,
                )
                normalized_plan = self._build_trade_plan_snapshot(
                    draft=trade_plan,
                    payload=payload,
                    selected_track=selected,
                    portfolio=projection.get("portfolio"),
                    entry_price=provisional_entry,
                )
                payload["quantity"] = normalized_plan["quantity"]
            self._assert_exact_account_order_filters(
                payload=payload,
                selected_track=selected,
                portfolio=projection.get("portfolio"),
            )
            self._assert_shared_settlement_reservation(
                payload=payload,
                selected_track=selected,
                portfolio=projection.get("portfolio"),
                binding=binding,
            )
            try:
                adapter_preview = await self.replay_service.preview_order(
                    session_id,
                    payload,
                )
            except ReplayDomainError as exc:
                raise TrainingRunError(
                    exc.code.value,
                    exc.message,
                    status_code=exc.http_status,
                    details=exc.details,
                ) from exc
            preview_cursor = adapter_preview.get("cursor")
            if not isinstance(preview_cursor, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "adapter preview cursor is invalid",
                    status_code=503,
                )
            preview_actual = {
                "virtual_time_ms": preview_cursor.get("virtual_time_ms"),
                "source_sequence": preview_cursor.get("source_sequence"),
                "revision": adapter_preview.get("revision"),
            }
            if preview_actual != expected_cursor.to_dict():
                raise TrainingRunError(
                    "REVISION_CONFLICT",
                    "market advanced while the order preview was built",
                    status_code=409,
                    details={
                        "expected": expected_cursor.to_dict(),
                        "actual": preview_actual,
                    },
                )
            preview = adapter_preview.get("preview")
            if not isinstance(preview, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "adapter order preview is invalid",
                    status_code=503,
                )
            if normalized_plan is not None:
                normalized_plan = self._build_trade_plan_snapshot(
                    draft=trade_plan,
                    payload=payload,
                    selected_track=selected,
                    portfolio=projection.get("portfolio"),
                    entry_price=preview.get("estimated_fill_price"),
                )
                if payload["quantity"] != normalized_plan["quantity"]:
                    payload["quantity"] = normalized_plan["quantity"]
                    self._assert_exact_account_order_filters(
                        payload=payload,
                        selected_track=selected,
                        portfolio=projection.get("portfolio"),
                    )
                    self._assert_shared_settlement_reservation(
                        payload=payload,
                        selected_track=selected,
                        portfolio=projection.get("portfolio"),
                        binding=binding,
                    )
                    try:
                        adapter_preview = await self.replay_service.preview_order(
                            session_id,
                            payload,
                        )
                    except ReplayDomainError as exc:
                        raise TrainingRunError(
                            exc.code.value,
                            exc.message,
                            status_code=exc.http_status,
                            details=exc.details,
                        ) from exc
                    preview = _stored_mapping(
                        adapter_preview.get("preview"),
                        field_name="adapter order preview",
                    )
                    revised_cursor = _stored_mapping(
                        adapter_preview.get("cursor"),
                        field_name="adapter order preview cursor",
                    )
                    revised_actual = {
                        "virtual_time_ms": revised_cursor.get("virtual_time_ms"),
                        "source_sequence": revised_cursor.get("source_sequence"),
                        "revision": adapter_preview.get("revision"),
                    }
                    if revised_actual != expected_cursor.to_dict():
                        raise TrainingRunError(
                            "REVISION_CONFLICT",
                            "market advanced while the planned quantity was recalculated",
                            status_code=409,
                            details={
                                "expected": expected_cursor.to_dict(),
                                "actual": revised_actual,
                            },
                        )
            preview = {
                **dict(preview),
                "max_quantity": self._shared_order_capacity_quantity(
                    adapter_max_quantity=preview.get("max_quantity"),
                    reference_price=preview.get("reference_price"),
                    payload=payload,
                    selected_track=selected,
                    portfolio=projection.get("portfolio"),
                    binding=binding,
                ),
            }
            response = {
                **dict(preview),
                "protocol": REPLAY_V2_PROTOCOL,
                "schema_version": (
                    "replay.order-preview.v2"
                    if normalized_plan is not None
                    else "replay.order-preview.v1"
                ),
                "run_id": normalized,
                "track_id": selected_track_id,
                "accepted": True,
                "position_intent": position_intent,
                "revision": expected_revision,
                "cursor": expected_cursor.to_dict(),
                "state_hash": adapter_preview["state_hash"],
                "execution_fidelity": adapter_preview["execution_fidelity"],
            }
            if normalized_plan is not None:
                response["trade_plan"] = normalized_plan
            return response

    async def order_capacity(
        self,
        run_id: str,
        *,
        expected_revision: int,
        expected_cursor: TrainingCursor,
        position_intent: str,
        context: Mapping[str, object],
    ) -> dict[str, object]:
        """Return a cursor-bound maximum without validating a draft quantity."""

        normalized = self._identifier(run_id, field_name="run_id")
        if expected_revision != expected_cursor.revision:
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "capacity revision must match expected cursor revision",
                status_code=422,
            )
        actor = self._run_actors.setdefault(normalized, TrainingRunActor(normalized))
        async with actor.serialized():
            binding = await self.store.run_binding(normalized)
            projection = await self.store.get_market_tracks(normalized)
            tracks = projection.get("tracks")
            if not isinstance(tracks, list):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market tracks projection is invalid",
                    status_code=503,
                )
            selected_track_id = str(binding["selected_track_id"])
            selected = next(
                (
                    track
                    for track in tracks
                    if isinstance(track, Mapping)
                    and track.get("track_id") == selected_track_id
                ),
                None,
            )
            if (
                selected is None
                or selected.get("subscription_tier") != "FULL"
                or selected.get("state") != "READY"
            ):
                raise TrainingRunError(
                    "MARKET_TRACK_NOT_READY",
                    "order capacity requires the selected market track to be READY and FULL",
                    status_code=409,
                )
            session_id = str(binding["adapter_session_id"])
            session = await self.replay_service.get_session(session_id)
            snapshot = self._snapshot(session)
            cursor = snapshot.get("cursor")
            if not isinstance(cursor, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "adapter cursor is invalid",
                    status_code=503,
                )
            actual = {
                "virtual_time_ms": cursor.get("virtual_time_ms"),
                "source_sequence": cursor.get("source_sequence"),
                "revision": snapshot.get("revision"),
            }
            if actual != expected_cursor.to_dict():
                raise TrainingRunError(
                    "REVISION_CONFLICT",
                    "capacity cursor does not match the authoritative run cursor",
                    status_code=409,
                    details={"expected": expected_cursor.to_dict(), "actual": actual},
                )
            await self._guard_historical_book_current(
                run_id=normalized,
                binding=binding,
                snapshot=snapshot,
            )
            payload = dict(
                self._order_payload_with_optional_leverage(
                    context,
                    {
                        "side",
                        "order_type",
                        "reduce_only",
                        "limit_price",
                        "stop_price",
                    },
                )
            )
            if position_intent not in {"NET", "OPEN"}:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "order capacity position intent is unsupported",
                    status_code=422,
                )
            if binding.get("position_mode") == "HEDGE" and payload.get(
                "position_side"
            ) not in {"LONG", "SHORT"}:
                raise TrainingRunError(
                    "ORDER_REJECTED",
                    "HEDGE order capacity requires position_side",
                    status_code=409,
                )
            if position_intent == "OPEN" and binding.get("position_mode") != "HEDGE":
                if (
                    payload.get("order_type") != "MARKET"
                    or payload.get("reduce_only") is not False
                ):
                    raise TrainingRunError(
                        "REPLAY_CONTROL_INVALID",
                        "OPEN capacity is only available for non-reduce-only market orders",
                        status_code=422,
                    )
                position = selected.get("position")
                if not isinstance(position, Mapping):
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "selected position projection is invalid",
                        status_code=503,
                    )
                try:
                    position_quantity = Decimal(str(position.get("quantity")))
                except InvalidOperation as exc:
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "selected position quantity is invalid",
                        status_code=503,
                    ) from exc
                if position_quantity != 0 and (position_quantity > 0) != (
                    payload.get("side") == "BUY"
                ):
                    raise TrainingRunError(
                        "ORDER_REJECTED",
                        "OPEN cannot reduce or reverse the current position",
                        status_code=409,
                    )
            self._assert_exact_account_capacity_context(
                payload=payload,
                selected_track=selected,
                portfolio=projection.get("portfolio"),
            )
            try:
                adapter_capacity = await self.replay_service.order_capacity(
                    session_id,
                    payload,
                )
            except ReplayDomainError as exc:
                raise TrainingRunError(
                    exc.code.value,
                    exc.message,
                    status_code=exc.http_status,
                    details=exc.details,
                ) from exc
            capacity_cursor = adapter_capacity.get("cursor")
            if not isinstance(capacity_cursor, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "adapter capacity cursor is invalid",
                    status_code=503,
                )
            capacity_actual = {
                "virtual_time_ms": capacity_cursor.get("virtual_time_ms"),
                "source_sequence": capacity_cursor.get("source_sequence"),
                "revision": adapter_capacity.get("revision"),
            }
            if capacity_actual != expected_cursor.to_dict():
                raise TrainingRunError(
                    "REVISION_CONFLICT",
                    "market advanced while order capacity was calculated",
                    status_code=409,
                    details={
                        "expected": expected_cursor.to_dict(),
                        "actual": capacity_actual,
                    },
                )
            raw_capacity = adapter_capacity.get("capacity")
            if not isinstance(raw_capacity, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "adapter order capacity is invalid",
                    status_code=503,
                )
            maximum = self._shared_order_capacity_quantity(
                adapter_max_quantity=raw_capacity.get("max_quantity"),
                reference_price=raw_capacity.get("reference_price"),
                payload=payload,
                selected_track=selected,
                portfolio=projection.get("portfolio"),
                binding=binding,
            )
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "schema_version": "replay.order-capacity.v1",
                "run_id": normalized,
                "track_id": selected_track_id,
                "position_intent": position_intent,
                "revision": expected_revision,
                "cursor": expected_cursor.to_dict(),
                "state_hash": adapter_capacity["state_hash"],
                "execution_fidelity": adapter_capacity["execution_fidelity"],
                "context": dict(raw_capacity["context"]),
                "reference_price": raw_capacity["reference_price"],
                "max_quantity": maximum,
                "quote_asset": raw_capacity["quote_asset"],
                "max_leverage": raw_capacity["max_leverage"],
            }

    async def get_fast_forward_plan(
        self,
        run_id: str,
        *,
        target_virtual_time_ms: int,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        binding = await self.store.run_binding(normalized)
        session = await self.replay_service.get_session(
            str(binding["adapter_session_id"])
        )
        snapshot = self._snapshot(session)
        projection = await self.store.get_market_tracks(normalized)
        tracks = projection.get("tracks")
        if not isinstance(tracks, list):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "market tracks projection is invalid",
                status_code=503,
            )
        decision = self._plan_fast_forward(
            binding=binding,
            snapshot=snapshot,
            tracks=tuple(
                cast(Mapping[str, object], track)
                for track in tracks
                if isinstance(track, Mapping)
            ),
            target_virtual_time_ms=target_virtual_time_ms,
        )
        summary_lookup: Mapping[str, object] = {
            "status": "SKIPPED",
            "reason_code": (
                "REFERENCE_OR_BLOCKED_PLAN"
                if decision.plan is not FastForwardPlan.AGGREGATE_SCAN
                else "SUMMARY_LOOKUP_NOT_RUN"
            ),
            "summary": None,
        }
        if decision.plan is FastForwardPlan.AGGREGATE_SCAN:
            summary_lookup = await self._eligible_period_summary(
                run_id=normalized,
                binding=binding,
                snapshot=snapshot,
                target_virtual_time_ms=target_virtual_time_ms,
            )
            candidate = summary_lookup.get("summary")
            if isinstance(candidate, ReplayPeriodSummary):
                decision = self._plan_fast_forward(
                    binding=binding,
                    snapshot=snapshot,
                    tracks=tuple(
                        cast(Mapping[str, object], track)
                        for track in tracks
                        if isinstance(track, Mapping)
                    ),
                    target_virtual_time_ms=target_virtual_time_ms,
                    summary=candidate,
                )
        return {
            "protocol": "replay.v3",
            "run_id": normalized,
            "plan": self._fast_forward_plan_payload(
                decision,
                summary_lookup=summary_lookup,
            ),
        }

    async def get_period_summary_status(self, run_id: str) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        await self.store.run_binding(normalized)
        enabled = bool(
            self.replay_service.settings.replay_fast_forward_optimization_enabled
        )
        if not enabled:
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "run_id": normalized,
                "enabled": False,
                "status": {
                    "schema_version": "replay.period-summary-set.v1",
                    "latest_build": None,
                    "active_set": None,
                    "reason_code": "OPTIMIZATION_DISABLED",
                },
            }
        return {
            "protocol": REPLAY_V2_PROTOCOL,
            "run_id": normalized,
            "enabled": True,
            "status": await self.store.period_summary_status(normalized),
        }

    async def prepare_period_summaries(
        self,
        run_id: str,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        if normalized in self._period_summary_builds:
            raise TrainingRunError(
                "PERIOD_SUMMARY_BUILD_ACTIVE",
                "a period-summary build is already active for this run",
                status_code=409,
            )
        self._period_summary_builds.add(normalized)
        try:
            return await self._prepare_period_summaries_once(normalized)
        finally:
            self._period_summary_builds.discard(normalized)

    async def _prepare_period_summaries_once(
        self,
        normalized: str,
    ) -> dict[str, object]:
        if not bool(
            self.replay_service.settings.replay_fast_forward_optimization_enabled
        ):
            raise TrainingRunError(
                "PERIOD_SUMMARY_DISABLED",
                "period-summary preparation requires the fast-forward optimization flag",
                status_code=409,
            )
        actor = self._run_actors.setdefault(normalized, TrainingRunActor(normalized))
        async with actor.serialized():
            binding = await self.store.run_binding(normalized)
            session_id = str(binding["adapter_session_id"])
            session = await self.replay_service.get_session(session_id)
            snapshot = self._snapshot(session)
            if snapshot.get("state") != "PAUSED":
                raise TrainingRunError(
                    "PERIOD_SUMMARY_REQUIRES_PAUSE",
                    "pause the training run before preparing period summaries",
                    status_code=409,
                )
            projection = await self.store.get_market_tracks(normalized)
            raw_tracks = projection.get("tracks")
            if not isinstance(raw_tracks, list):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market tracks projection is invalid",
                    status_code=503,
                )
            tracks = tuple(
                cast(Mapping[str, object], track)
                for track in raw_tracks
                if isinstance(track, Mapping)
            )
            current_time = self._cursor_time(snapshot)
            if bool(
                _stored_mapping(
                    snapshot.get("cursor"),
                    field_name="adapter cursor",
                ).get("at_end")
            ):
                raise TrainingRunError(
                    "PERIOD_SUMMARY_RANGE_UNAVAILABLE",
                    "the replay source has no future range to summarize",
                    status_code=409,
                )
            eligibility_target = min(MAX_TIMESTAMP_MS, current_time + 1)
            eligibility = self._plan_fast_forward(
                binding=binding,
                snapshot=snapshot,
                tracks=tracks,
                target_virtual_time_ms=eligibility_target,
            )
            if eligibility.plan is not FastForwardPlan.AGGREGATE_SCAN:
                raise TrainingRunError(
                    "PERIOD_SUMMARY_PATH_DEPENDENCY",
                    "the current run state is not eligible for summary preparation",
                    status_code=409,
                    details={"plan": eligibility.to_dict()},
                )
            integrity = await self.store.integrity(normalized)
            set_id = f"summary-{uuid.uuid4().hex}"
            await self.store.begin_period_summary_build(
                run_id=normalized,
                set_id=set_id,
            )
            try:
                prepared = await self.replay_service.prepare_period_summaries(
                    session_id,
                    run_id=normalized,
                    set_id=set_id,
                    rule_revision=int(integrity["active_rule_revision"]),
                    rule_hash=str(integrity["active_rule_hash"]),
                )
                candidates = prepared.get("candidates")
                metadata = prepared.get("metadata")
                if not isinstance(candidates, tuple) or not isinstance(
                    metadata, Mapping
                ):
                    raise TypeError("period-summary builder returned an invalid result")
                build = await self.store.finish_period_summary_build(
                    run_id=normalized,
                    set_id=set_id,
                    metadata=metadata,
                    build_proof_hash=str(prepared["build_proof_hash"]),
                    candidates=cast(
                        tuple[EncodedPeriodSummaryCandidate, ...],
                        candidates,
                    ),
                    source_event_count=int(prepared["source_event_count"]),
                    build_wall_ms=int(prepared["build_wall_ms"]),
                    build_cpu_ms=int(prepared["build_cpu_ms"]),
                )
            except asyncio.CancelledError:
                await asyncio.shield(
                    self.store.fail_period_summary_build(
                        run_id=normalized,
                        set_id=set_id,
                        cancelled=True,
                        error_code="PREPARATION_CANCELLED",
                        error_message="period-summary preparation was cancelled",
                    )
                )
                raise
            except BaseException as exc:
                await asyncio.shield(
                    self.store.fail_period_summary_build(
                        run_id=normalized,
                        set_id=set_id,
                        cancelled=False,
                        error_code=(
                            exc.code.value
                            if isinstance(exc, ReplayDomainError)
                            else type(exc).__name__
                        ),
                        error_message=(
                            exc.message
                            if isinstance(exc, ReplayDomainError)
                            else str(exc)
                        ),
                    )
                )
                if isinstance(exc, TrainingRunError):
                    raise
                if isinstance(exc, ReplayDomainError):
                    raise TrainingRunError(
                        exc.code.value,
                        exc.message,
                        status_code=exc.http_status,
                        details=exc.details,
                    ) from exc
                raise
            return {
                "protocol": REPLAY_V2_PROTOCOL,
                "run_id": normalized,
                "enabled": True,
                "build": build,
                "status": await self.store.period_summary_status(normalized),
            }

    async def trade_flow_page(
        self,
        run_id: str,
        *,
        track_id: str | None,
        after_sequence: int | None,
        limit: int,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 1_000
        ):
            raise TrainingRunError(
                "REPLAY_TRADE_FLOW_INVALID",
                "trade-flow limit must be between 1 and 1000",
                status_code=422,
            )
        binding = await self.store.run_binding(normalized)
        if str(binding["source_kind"]) != "AGG_TRADE":
            raise TrainingRunError(
                "REPLAY_TRADE_FLOW_UNSUPPORTED_SOURCE",
                "BAR runs cannot expose aggregate-trade tape or exact order flow",
                status_code=409,
                details={
                    "tape": "UNSUPPORTED_SOURCE_MODE",
                    "order_flow": "UNSUPPORTED_SOURCE_MODE",
                },
            )
        selected_track_id = (
            str(binding["selected_track_id"])
            if track_id is None
            else self._identifier(track_id, field_name="track_id")
        )
        track = await self.store.get_market_track(normalized, selected_track_id)
        if (
            track.get("state") in {"DEGRADED", "ERROR"}
            or track.get("degraded_reason") is not None
        ):
            raise TrainingRunError(
                "REPLAY_TRADE_FLOW_DEGRADED",
                "market track continuity is degraded; clear tape and resync",
                status_code=409,
                details={"clear_projection": True, "track_id": selected_track_id},
            )
        session_id = self._track_session_id(track)
        session = await self.replay_service.get_session(session_id)
        snapshot = self._snapshot(session)
        cursor = _stored_mapping(snapshot.get("cursor"), field_name="adapter cursor")
        revealed_sequence = _stored_counter(
            cursor.get("source_sequence"), field_name="source_sequence"
        )
        bounded_limit = min(limit, self.replay_service.settings.trade_page_rows)
        if after_sequence is None:
            after = max(0, revealed_sequence - bounded_limit)
        else:
            after = _stored_counter(after_sequence, field_name="after_sequence")
        if after > revealed_sequence:
            raise TrainingRunError(
                "REPLAY_TRADE_FLOW_RESYNC_REQUIRED",
                "trade-flow cursor is ahead of the revealed replay prefix",
                status_code=409,
                details={
                    "clear_projection": True,
                    "revealed_sequence": revealed_sequence,
                },
            )
        try:
            page = await self.replay_service.source_events_page(
                session_id,
                after_sequence=after,
                limit=bounded_limit,
            )
        except ReplayDomainError as exc:
            raise TrainingRunError(
                "REPLAY_TRADE_FLOW_DEGRADED",
                "aggregate-trade page failed continuity validation",
                status_code=409,
                details={
                    "clear_projection": True,
                    "reason": exc.code.value,
                    "track_id": selected_track_id,
                },
            ) from exc
        return self._trade_flow_adapter.project(
            run_id=normalized,
            track_id=selected_track_id,
            source_page=page,
        )

    async def get_market_tracks_by_session(
        self,
        session_id: str,
    ) -> dict[str, object]:
        normalized = self._identifier(session_id, field_name="session_id")
        run_id = await self.store.run_id_for_session(normalized)
        projection = await self.store.get_market_tracks(run_id)
        return await self._with_global_clock(run_id, projection)

    async def _with_global_clock(
        self,
        run_id: str,
        projection: Mapping[str, object],
    ) -> dict[str, object]:
        tracks = projection.get("tracks")
        viewer = projection.get("viewer_state")
        if not isinstance(tracks, list) or not isinstance(viewer, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "market tracks projection is invalid",
                status_code=503,
            )
        selected_track_id = viewer.get("selected_track_id")
        if selected_track_id is None and not tracks:
            return {
                **dict(projection),
                "global_clock": None,
            }
        selected = next(
            (
                track
                for track in tracks
                if isinstance(track, Mapping)
                and track.get("track_id") == selected_track_id
            ),
            None,
        )
        if not isinstance(selected, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "selected market track is unavailable",
                status_code=503,
            )
        selected_session_id = selected.get("adapter_session_id")
        if not isinstance(selected_session_id, str):
            raise TrainingRunError(
                "MARKET_TRACK_NOT_PREPARED",
                "selected market track has no frozen adapter session",
                status_code=409,
            )
        selected_session = await self.replay_service.get_session(selected_session_id)
        selected_snapshot = self._snapshot(selected_session)
        selected_config = _stored_mapping(
            selected_snapshot.get("config"),
            field_name="selected adapter config",
        )
        source_kind = str(selected.get("source_kind"))
        base_interval = str(selected_config.get("base_interval"))
        full_count = sum(
            1
            for track in tracks
            if isinstance(track, Mapping) and track.get("subscription_tier") == "FULL"
        )
        portfolio = projection.get("portfolio")
        contract_clock = (
            isinstance(portfolio, Mapping)
            and portfolio.get("account_model") == "TOUCH_OR_TAPE_V2"
        )
        actor = self._run_actors.get(run_id)
        actor_clock: dict[str, object] | None = None
        if actor is not None:
            actor_clock = actor.playback_snapshot()
            if (
                actor_clock["state"] == "PLAYING"
                and selected_snapshot.get("controller_client_id")
                != actor.playback_client_id
            ):
                actor.request_ordered_pause(reason="CONTROLLER_LEASE_LOST")
                actor_clock = actor.playback_snapshot()
        actor_generation = (
            _stored_counter(
                actor_clock.get("generation", 0), field_name="global_clock.generation"
            )
            if actor_clock is not None
            else 0
        )
        actor_tick = (
            _stored_counter(actor_clock.get("tick", 0), field_name="global_clock.tick")
            if actor_clock is not None
            else 0
        )
        actor_profile_revision = (
            _stored_counter(
                actor_clock.get("profile_revision", 0),
                field_name="global_clock.profile_revision",
            )
            if actor_clock is not None
            else 0
        )
        preserve_actor_terminal = (
            actor_clock is not None
            and (actor_generation > 0 or actor_profile_revision > 0)
            and (
                actor_clock.get("state") in {"PLAYING", "PAUSED", "ENDED", "ERROR"}
                or actor_clock.get("reason") == "CONTROLLER_LEASE_LOST"
            )
        )
        if (
            (contract_clock or full_count > 1)
            and preserve_actor_terminal
            and actor_clock is not None
        ):
            global_clock = dict(actor_clock)
        else:
            adapter_speed = selected_snapshot["speed"]
            rate = (
                int(adapter_speed)
                if isinstance(adapter_speed, int)
                and not isinstance(adapter_speed, bool)
                else 1
            )
            global_clock = {
                "contract": PLAYBACK_CONTRACT_VERSION,
                "mode": "ORDERED" if contract_clock or full_count > 1 else "ADAPTER",
                "state": selected_snapshot["state"],
                "basis": default_playback_basis(source_kind).value,
                "rate": rate,
                "speed": rate,
                "display_interval": None,
                "viewer_revision": None,
                "profile_revision": actor_profile_revision,
                "reason": None,
                "generation": actor_generation,
                "tick": actor_tick,
            }
        supported = supported_advance_bases(
            source_kind=source_kind,
            full_track_count=full_count,
        )
        playback_supported = supported_playback_bases(
            source_kind=source_kind,
            full_track_count=full_count,
        )
        effective_basis = advance_basis(global_clock.get("basis"))
        if effective_basis not in playback_supported:
            effective_basis = default_playback_basis(source_kind)
            global_clock["basis"] = effective_basis.value
            global_clock["display_interval"] = None
            global_clock["viewer_revision"] = None
        global_clock.update(
            {
                "contract": PLAYBACK_CONTRACT_VERSION,
                "supported_bases": [basis.value for basis in supported],
                "playback_bases": [basis.value for basis in playback_supported],
                "max_count": MAX_CONTROL_COUNT,
                "virtual_time_quantum_ms": (
                    fixed_interval_ms(
                        base_interval,
                        field_name="base_interval",
                    )
                    if source_kind == "BAR"
                    else 1
                ),
            }
        )
        return {**dict(projection), "global_clock": global_clock}

    async def integrity(self, run_id: str) -> dict[str, object]:
        return await self.store.integrity(self._identifier(run_id, field_name="run_id"))

    async def rules(self, run_id: str) -> dict[str, object]:
        return await self.store.run_rules(self._identifier(run_id, field_name="run_id"))

    async def current_drawing_document(self, run_id: str) -> dict[str, object]:
        return await self.store.current_drawing_document(
            self._identifier(run_id, field_name="run_id")
        )

    async def record_drawing_document(
        self,
        run_id: str,
        *,
        command_id: str,
        document_hash: str,
        document: Mapping[str, object],
        entity_count: int,
    ) -> dict[str, object]:
        return await self.store.record_drawing_document(
            run_id=self._identifier(run_id, field_name="run_id"),
            command_id=self._identifier(command_id, field_name="command_id"),
            document_hash=self._digest(
                document_hash,
                field_name="document_hash",
            ),
            document=document,
            entity_count=validate_v2_counter(
                entity_count,
                field_name="entity_count",
            ),
        )

    async def record_review_marker(
        self,
        run_id: str,
        *,
        command_id: str,
        text: str,
    ) -> dict[str, object]:
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        return await self.store.record_review_marker(
            run_id=self._identifier(run_id, field_name="run_id"),
            command_id=self._identifier(command_id, field_name="command_id"),
            text=text,
        )

    async def public_times(
        self,
        run_id: str,
        *,
        timeline_ms: tuple[int, ...],
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        if not isinstance(timeline_ms, tuple):
            raise TypeError("timeline_ms must be a tuple")
        if not 1 <= len(timeline_ms) <= 2_000:
            raise TrainingRunError(
                "TRAINING_RUN_INVALID",
                "public time batch must contain between 1 and 2000 values",
                status_code=422,
            )
        return await self.store.public_times(
            normalized,
            timeline_ms=timeline_ms,
            max_items=2_000,
        )

    async def equity(
        self,
        run_id: str,
        *,
        resolution: str = "AUTO",
        limit: int = 1_000,
    ) -> dict[str, object]:
        return await self.store.equity(
            self._identifier(run_id, field_name="run_id"),
            resolution=resolution,
            limit=limit,
        )

    async def journal(self, run_id: str) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        binding = await self.store.run_binding(normalized)
        journal = await self.replay_service.journal(str(binding["adapter_session_id"]))
        return {
            "protocol": "replay.v3",
            "run_id": normalized,
            "entries": journal["entries"],
            "integrity": await self.store.integrity(normalized),
        }

    async def report(self, run_id: str) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        binding = await self.store.run_binding(normalized)
        report = await self.replay_service.report(str(binding["adapter_session_id"]))
        timeline_ms: set[int] = set()

        def collect(value: object, *, key: str | None = None) -> None:
            if isinstance(value, Mapping):
                for child_key, child in value.items():
                    collect(child, key=str(child_key))
            elif isinstance(value, (list, tuple)):
                for child in value:
                    collect(child, key=key)
            elif (
                key is not None
                and key.endswith("_time_ms")
                and not isinstance(value, bool)
                and isinstance(value, int)
            ):
                if value not in timeline_ms and len(timeline_ms) >= 20_000:
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "training report exceeds the public-time projection bound",
                        status_code=503,
                    )
                timeline_ms.add(value)

        collect(report["report"])
        integrity = await self.store.integrity(normalized)
        if timeline_ms:
            public_time_index = await self.store.public_times(
                normalized,
                timeline_ms=tuple(sorted(timeline_ms)),
                max_items=20_000,
            )
        else:
            public_time_index = {
                "protocol": REPLAY_V2_PROTOCOL,
                "run_id": normalized,
                "policy": integrity["effective_time_disclosure_policy"],
                "items": [],
            }
        market_projection = await self.store.get_market_tracks(normalized)
        portfolio = market_projection.get("portfolio")
        account_audit = None
        if isinstance(portfolio, Mapping) and (
            portfolio.get("position_mode") == "HEDGE"
            or (
                isinstance(portfolio.get("account_history"), Mapping)
                and portfolio["account_history"].get("mode")  # type: ignore[union-attr]
                == "HISTORICAL_EXACT"
            )
        ):
            account_audit = await self.audit_account(normalized)
            market_projection = await self.store.get_market_tracks(normalized)
            portfolio = market_projection.get("portfolio")
        return {
            "protocol": "replay.v3",
            "run_id": normalized,
            "data_fidelity": report["data_fidelity"],
            "execution_fidelity": report["execution_fidelity"],
            "revealed": report["revealed"],
            "report": report["report"],
            "integrity": integrity,
            "public_time_index": public_time_index,
            "modelled_account": portfolio,
            "account_audit": account_audit,
            "liquidation_channel_contract": {
                "simulated_account": "MODELLED_ACCOUNT_NOT_MARKET_LIQUIDATION_FEED",
                "historical_market": "INDEPENDENT_FEED_OR_UNSUPPORTED",
            },
            **(
                {"actual_history": report["actual_history"]}
                if report.get("revealed") and "actual_history" in report
                else {}
            ),
        }

    async def training_results(self, run_id: str, *, limit: int) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        projection = await self.store.training_results(normalized, limit=limit)
        binding = await self.store.run_binding(normalized)
        broker_report = await self.replay_service.report(
            str(binding["adapter_session_id"])
        )
        report = _stored_mapping(
            broker_report.get("report"),
            field_name="broker report",
        )
        summary = _stored_mapping(
            projection.get("summary"),
            field_name="training-results summary",
        )
        realized_pnl = Decimal(str(report.get("realized_pnl", "0")))
        fees_paid = Decimal(str(report.get("fees_paid", "0")))
        return {
            **projection,
            "summary": {
                **dict(summary),
                "max_drawdown": report.get("max_drawdown", "0"),
                "profit_factor": report.get("profit_factor"),
                "fees_paid": decimal_to_string(
                    fees_paid,
                    field_name="training results fees paid",
                ),
                "net_realized_pnl": decimal_to_string(
                    realized_pnl - fees_paid,
                    field_name="training results net realized pnl",
                ),
            },
            "data_fidelity": broker_report.get("data_fidelity"),
            "execution_fidelity": broker_report.get("execution_fidelity"),
        }

    async def _assert_review_original_quiescent(self, run_id: str) -> None:
        market_tracks = await self.get_market_tracks(run_id)
        global_clock = _stored_mapping(
            market_tracks.get("global_clock"),
            field_name="review global clock",
        )
        state = str(global_clock.get("state"))
        if state not in {"PAUSED", "ENDED"}:
            raise TrainingRunError(
                "REVIEW_REQUIRES_PAUSED_RUN",
                "pause the training run before entering ReviewMode",
                status_code=409,
                details={"state": state},
            )

    async def start_review(
        self,
        run_id: str,
        *,
        event_id: str | None,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        await self._assert_review_original_quiescent(normalized)
        normalized_event = (
            None
            if event_id is None
            else self._identifier(event_id, field_name="event_id")
        )
        return await self.store.start_review(
            run_id=normalized,
            review_id=self._identifier(
                f"review-{uuid.uuid4().hex}",
                field_name="review_id",
            ),
            event_id=normalized_event,
        )

    async def control_review(
        self,
        run_id: str,
        review_id: str,
        *,
        action: str,
        event_id: str | None,
        expected_cursor_revision: int,
        playback_rate: str | None,
    ) -> dict[str, object]:
        normalized_run_id = self._identifier(run_id, field_name="run_id")
        await self._assert_review_original_quiescent(normalized_run_id)
        normalized_event = (
            None
            if event_id is None
            else self._identifier(event_id, field_name="event_id")
        )
        return await self.store.control_review(
            run_id=normalized_run_id,
            review_id=self._identifier(review_id, field_name="review_id"),
            action=action,
            event_id=normalized_event,
            expected_cursor_revision=validate_v2_counter(
                expected_cursor_revision,
                field_name="expected_cursor_revision",
            ),
            playback_rate=playback_rate,
        )

    async def fork_run(
        self,
        run_id: str,
        *,
        event_id: str,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        normalized_event = self._identifier(event_id, field_name="event_id")
        market_tracks = await self.store.get_market_tracks(normalized)
        event = await self.store.checkpoint_for_event(normalized, normalized_event)
        anchors = event.get("anchors")
        if not isinstance(anchors, list) or not anchors:
            raise TrainingRunError(
                "REVIEW_ANCHOR_UNAVAILABLE",
                "review event has no immutable actor anchors",
                status_code=503,
            )
        tracks = market_tracks.get("tracks")
        if not isinstance(tracks, list) or not tracks:
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "parent market tracks are unavailable",
                status_code=503,
            )
        parent_track_by_id = {
            str(track["track_id"]): track
            for track in tracks
            if isinstance(track, Mapping)
        }
        primary_anchor = next(
            (
                anchor
                for anchor in anchors
                if isinstance(anchor, Mapping) and anchor.get("track_id") == "track-1"
            ),
            anchors[0],
        )
        if not isinstance(primary_anchor, Mapping):
            raise TypeError("primary review anchor is invalid")
        checkpoint_id = validate_v2_counter(
            primary_anchor["checkpoint_id"],
            field_name="review checkpoint_id",
        )
        child_run_id = self._identifier(self._run_id_factory(), field_name="run_id")
        extension_factory = self.store.fork_run_writer(
            child_run_id=child_run_id,
            parent_run_id=normalized,
            parent_event_id=normalized_event,
            parent_checkpoint_id=checkpoint_id,
            parent_timeline_sequence=validate_v2_counter(
                event["timeline_sequence"],
                field_name="review timeline_sequence",
            ),
            parent_anchor_set_hash=str(event["anchor_set_hash"]),
        )
        child_sessions: list[str] = []
        try:
            forked = await self.replay_service.fork_session_from_checkpoint_blob(
                str(primary_anchor["adapter_session_id"]),
                checkpoint=bytes(primary_anchor["payload"]),
                extension_factory=extension_factory,
            )
        except ReplayDomainError as exc:
            raise TrainingRunError(
                "REVIEW_FORK_FAILED",
                "review event could not be forked exactly",
                status_code=409,
                details={"reason": exc.code.value},
            ) from exc
        snapshot = forked["snapshot"]
        child_sessions.append(str(forked["session_id"]))
        if (
            not isinstance(snapshot, Mapping)
            or snapshot.get("state_hash") != primary_anchor["state_hash"]
        ):
            await self.replay_service.discard_session(child_sessions[0])
            raise TrainingRunError(
                "REVIEW_FORK_MISMATCH",
                "forked run state does not match the selected review event",
                status_code=409,
            )
        try:
            secondary_anchors = sorted(
                (
                    anchor
                    for anchor in anchors
                    if isinstance(anchor, Mapping)
                    and anchor.get("track_id") != primary_anchor["track_id"]
                ),
                key=lambda item: str(item["track_id"]),
            )
            for anchor in secondary_anchors:
                parent_track_id = str(anchor["track_id"])
                parent_track = parent_track_by_id.get(parent_track_id)
                if parent_track is None:
                    raise TrainingRunError(
                        "REVIEW_FORK_MISMATCH",
                        "review anchor references an unknown market track",
                        status_code=409,
                    )
                reserved = await self.store.reserve_market_track(
                    run_id=child_run_id,
                    exchange=str(parent_track["exchange"]),
                    market_type=str(parent_track["market_type"]),
                    symbol=str(parent_track["symbol"]),
                    settlement_asset=str(parent_track["settlement_asset"]),
                    source_kind=str(parent_track["source_kind"]),
                    subscription_tier="FULL",
                )
                child_track_id = str(reserved["track_id"])
                attach = self.store.attach_market_track_writer(
                    run_id=child_run_id,
                    track_id=child_track_id,
                    requested_tier="FULL",
                    review_parent_run_id=normalized,
                    review_parent_track_id=parent_track_id,
                    review_parent_event_id=normalized_event,
                )
                attached = await self.replay_service.fork_session_from_checkpoint_blob(
                    str(anchor["adapter_session_id"]),
                    checkpoint=bytes(anchor["payload"]),
                    extension_factory=attach,
                )
                child_sessions.append(str(attached["session_id"]))
                attached_snapshot = attached.get("snapshot")
                if (
                    not isinstance(attached_snapshot, Mapping)
                    or attached_snapshot.get("state_hash") != anchor["state_hash"]
                ):
                    raise TrainingRunError(
                        "REVIEW_FORK_MISMATCH",
                        "secondary forked actor does not match its review anchor",
                        status_code=409,
                    )
            await self.store.checkpoint_market_tracks(child_run_id)
            portfolio = market_tracks.get("portfolio")
            history = (
                portfolio.get("account_history")
                if isinstance(portfolio, Mapping)
                else None
            )
            account_audit = None
            if (
                isinstance(history, Mapping)
                and history.get("mode") == "HISTORICAL_EXACT"
                or (
                    isinstance(portfolio, Mapping)
                    and portfolio.get("position_mode") == "HEDGE"
                )
            ):
                account_audit = await self.audit_account(child_run_id)
                if account_audit.get("status") != "PASS":
                    raise TrainingRunError(
                        "REVIEW_FORK_ACCOUNT_AUDIT_FAILED",
                        "exact-account child failed its independent audit",
                        status_code=409,
                        details={
                            "fallback_applied": False,
                            "differences": account_audit.get("differences", []),
                        },
                    )
                hedge_audit = account_audit.get("hedge_input_audit")
                if (
                    isinstance(portfolio, Mapping)
                    and portfolio.get("position_mode") == "HEDGE"
                    and (
                        not isinstance(hedge_audit, Mapping)
                        or hedge_audit.get("status") != "PASS"
                    )
                ):
                    raise TrainingRunError(
                        "REVIEW_FORK_HEDGE_INPUT_AUDIT_FAILED",
                        "HEDGE child failed its pinned input audit",
                        status_code=409,
                        details={
                            "fallback_applied": False,
                            "differences": (
                                hedge_audit.get("difference_hashes", [])
                                if isinstance(hedge_audit, Mapping)
                                else []
                            ),
                        },
                    )
        except BaseException:
            for session_id in reversed(child_sessions):
                try:
                    await self.replay_service.discard_session(session_id)
                except BaseException:
                    pass
            raise
        card = await self.store.get_run(child_run_id)
        child_tracks = await self.store.get_market_tracks(child_run_id)
        return {
            "protocol": "replay.v3",
            "parent_run_id": normalized,
            "parent_event_id": normalized_event,
            "parent_timeline_sequence": event["timeline_sequence"],
            "anchor_set_hash": event["anchor_set_hash"],
            "run": {
                **card,
                "dataset_epoch": event["dataset_epoch"],
                "state_hash": snapshot["state_hash"],
            },
            "tracks": child_tracks["tracks"],
            "account_audit": account_audit,
        }

    async def create_run(
        self,
        request: TrainingRunCreateRequest,
        *,
        _retry_preparation: Mapping[str, object] | None = None,
        _existing_shell_run_id: str | None = None,
        _preparation_id: str | None = None,
        _committed_start_ms: int | None = None,
    ) -> dict[str, object]:
        if not isinstance(request, TrainingRunCreateRequest):
            raise TypeError("request must be TrainingRunCreateRequest")
        if _retry_preparation is None:
            if _committed_start_ms is None:
                request = self._authoritative_start_request(request)
                selection_request = request
            else:
                selection_request = replace(
                    request,
                    start_mode=StartMode.MANUAL,
                    requested_start_ms=_committed_start_ms,
                    random_seed=None,
                )
            selection_config = self._adapter_config(selection_request)
            try:
                selection = await self.replay_service.select_training_window(
                    selection_config,
                    expected_catalog_epoch=request.catalog_epoch,
                    minimum_history_bars=self._selection_warmup_bars(request),
                )
            except ReplayDomainError as exc:
                if exc.details.get("reason") == "CATALOG_EPOCH_MISMATCH":
                    raise TrainingRunError(
                        "CATALOG_EPOCH_MISMATCH",
                        "data capability changed after validation; refresh and try again",
                        status_code=409,
                    ) from exc
                raise TrainingRunError(
                    "MARKET_UNSUPPORTED_AT_COMMITTED_START",
                    "this market cannot replay from the run's immutable start time",
                    status_code=409,
                    details={
                        "reason": exc.code.value,
                        "requires_new_run": True,
                    },
                ) from exc
        else:
            raw_selection = _retry_preparation.get("selection")
            if not isinstance(raw_selection, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "training preparation retry selection is invalid",
                    status_code=503,
                )
            selection = dict(raw_selection)
        history_policy = resolve_history_policy(
            request,
            selection,
            max_dataset_rows=self.replay_service.settings.max_bar_dataset_rows,
        )
        base_interval_ms = compatible_step_interval_ms(
            base_interval=request.base_interval,
            step_interval=request.display_interval,
        )
        if (
            request.funding_mode is FundingMode.HISTORICAL_EXACT
            and request.account_data_mode
            not in {
                AccountDataMode.HISTORICAL_EXACT,
                AccountDataMode.DETERMINISTIC_SIMULATION,
            }
        ):
            raise TrainingRunError(
                "HISTORICAL_FUNDING_UNAVAILABLE",
                "historical exact funding requires exact account-history inputs",
                status_code=409,
                details={
                    "funding_rate": "UNSUPPORTED_NO_HISTORY",
                    "historical_mark": "UNSUPPORTED_NO_HISTORY",
                    "fallback_applied": False,
                },
            )
        account_history_binding = None
        if request.account_data_mode is AccountDataMode.HISTORICAL_EXACT:
            if request.start_mode is not StartMode.MANUAL:
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_MANUAL_START_REQUIRED",
                    "historical exact account data requires a manual start",
                    status_code=409,
                    details={"fallback_applied": False},
                )
            account_history_binding = await self.account_history.prepare_binding(
                request=request,
                bound_range_start_ms=history_policy.actual_replay_start_ms,
                bound_range_end_ms=(
                    history_policy.actual_replay_start_ms + request.forward_cache_ms
                ),
                actual_time_ms=history_policy.actual_replay_start_ms,
                virtual_time_ms=history_policy.actual_replay_start_ms,
            )
        historical_book_binding = None
        if request.book_mode is BookMode.BOOK_ASSISTED_REQUIRED:
            if (
                request.start_mode is not StartMode.MANUAL
                or request.requested_start_ms is None
            ):
                raise TrainingRunError(
                    "HISTORICAL_BOOK_MANUAL_START_REQUIRED",
                    "BOOK_ASSISTED_REQUIRED currently requires an exact manual start",
                    status_code=409,
                    details={"fallback_applied": False},
                )
            historical_book_binding = await self.historical_books.prepare_binding(
                exchange=request.exchange,
                market_type=request.market_type,
                symbol=request.symbol,
                range_start_ms=request.requested_start_ms,
                range_end_ms=(
                    request.requested_start_ms
                    + request.forward_cache_ms
                    + base_interval_ms
                ),
                actual_time_ms=request.requested_start_ms,
                virtual_time_ms=request.requested_start_ms,
            )
        hedge_input_binding: PreparedHedgeInputBinding | None = None
        if request.position_mode.value == "HEDGE":
            if request.start_mode is not StartMode.MANUAL:
                raise TrainingRunError(
                    "HEDGE_INPUT_MANUAL_START_REQUIRED",
                    "pinned HEDGE inputs require an exact manual start",
                    status_code=409,
                    details={"fallback_applied": False},
                )
            if request.book_mode is not BookMode.BOOK_ASSISTED_REQUIRED:
                raise TrainingRunError(
                    "HEDGE_HISTORICAL_BOOK_REQUIRED",
                    "HEDGE deterministic simulation requires historical L2",
                    status_code=409,
                    details={"fallback_applied": False},
                )
            if request.funding_mode is not FundingMode.HISTORICAL_EXACT:
                raise TrainingRunError(
                    "HEDGE_HISTORICAL_FUNDING_REQUIRED",
                    "HEDGE deterministic simulation requires pinned historical funding",
                    status_code=409,
                    details={"fallback_applied": False},
                )
            hedge_input_binding = await self.hedge_inputs.prepare_binding(
                request=request,
                bound_range_start_ms=history_policy.actual_replay_start_ms,
                bound_range_end_ms=(
                    history_policy.actual_replay_start_ms
                    + history_policy.forward_cache_ms
                ),
                virtual_time_ms=history_policy.actual_replay_start_ms,
                historical_book_binding=historical_book_binding,
            )
        run_id = self._identifier(
            (
                _existing_shell_run_id
                if _existing_shell_run_id is not None
                else (
                    self._run_id_factory()
                    if _retry_preparation is None
                    else _retry_preparation.get("preparation_id")
                )
            ),
            field_name="run_id",
        )
        preparation_id = self._identifier(
            (
                _retry_preparation.get("preparation_id")
                if _retry_preparation is not None
                else (
                    _preparation_id
                    if _preparation_id is not None
                    else (
                        uuid.uuid4().hex
                        if _existing_shell_run_id is not None
                        else run_id
                    )
                )
            ),
            field_name="preparation_id",
        )
        config = self._adapter_config(
            request,
            warmup_bars=history_policy.effective_warmup_bars,
        )
        required_start_ms = (
            history_policy.actual_replay_start_ms
            - history_policy.effective_warmup_bars * history_policy.interval_ms
        )
        required_end_ms = (
            history_policy.actual_replay_start_ms
            + history_policy.forward_cache_ms
            - history_policy.interval_ms
        )
        if _retry_preparation is None:
            try:
                await self.store.create_selection_preparation(
                    preparation_id=preparation_id,
                    start_mode=request.start_mode.value,
                    random_seed=request.random_seed,
                    catalog_epoch=request.catalog_epoch,
                    source_fingerprint=str(selection["source_fingerprint"]),
                    selected_start_ms=history_policy.actual_replay_start_ms,
                    required_start_ms=required_start_ms,
                    required_end_ms=required_end_ms,
                    interval_ms=history_policy.interval_ms,
                    request=request,
                    selection=selection,
                )
            except sqlite3.IntegrityError as exc:
                raise TrainingRunError(
                    "TRAINING_RUN_CONFLICT",
                    "training preparation identity already exists",
                    status_code=409,
                ) from exc

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
        ):
            bound_book = historical_book_binding
            bound_account = account_history_binding
            bound_hedge = hedge_input_binding
            if bound_book is not None:
                cursor = session_state.get("cursor")
                if not isinstance(cursor, Mapping):
                    raise TypeError("training adapter cursor must be an object")
                bound_book = replace(
                    bound_book,
                    projection=replace(
                        bound_book.projection,
                        actual_time_ms=actual_replay_start_ms,
                        virtual_time_ms=int(cursor["virtual_time_ms"]),
                    ),
                )
            if bound_account is not None:
                cursor = session_state.get("cursor")
                if not isinstance(cursor, Mapping):
                    raise TypeError("training adapter cursor must be an object")
                bound_account = replace(
                    bound_account,
                    projection=replace(
                        bound_account.projection,
                        as_of_actual_time_ms=actual_replay_start_ms,
                        as_of_virtual_time_ms=int(cursor["virtual_time_ms"]),
                    ),
                )
            if bound_hedge is not None:
                cursor = session_state.get("cursor")
                if not isinstance(cursor, Mapping):
                    raise TypeError("training adapter cursor must be an object")
                bound_hedge = replace(
                    bound_hedge,
                    public_projection=replace(
                        bound_hedge.public_projection,
                        as_of_virtual_time_ms=int(cursor["virtual_time_ms"]),
                    ),
                    simulation_projection=replace(
                        bound_hedge.simulation_projection,
                        as_of_virtual_time_ms=int(cursor["virtual_time_ms"]),
                    ),
                )
            return self.store.initial_run_writer(
                run_id=run_id,
                request=request,
                adapter_session_id=session_id,
                session_state=session_state,
                component_state=component_state,
                broker_config=broker_config,
                dataset_ref=dataset_ref,
                dataset_blob=dataset_blob,
                actual_replay_start_ms=actual_replay_start_ms,
                actual_replay_end_ms=actual_replay_end_ms,
                history_policy=history_policy,
                source_fingerprint=str(selection["source_fingerprint"]),
                historical_book_binding=bound_book,
                account_history_binding=bound_account,
                hedge_input_binding=bound_hedge,
                existing_shell=_existing_shell_run_id is not None,
                preparation_id=preparation_id,
            )

        try:
            await self.replay_service.create_session(
                config,
                _expected_catalog_epoch=request.catalog_epoch,
                _internal_forced_start_ms=history_policy.actual_replay_start_ms,
                _internal_expected_source_fingerprint=str(
                    selection["source_fingerprint"]
                ),
                _internal_training_history=True,
                _internal_training_selection=selection,
                _extension_factory=extension_factory,
                _internal_execution_mode=TOUCH_OR_TAPE_EXECUTION_MODE,
            )
        except ReplayDomainError as exc:
            await self.store.fail_selection_preparation(
                preparation_id,
                error_code=exc.code.value,
                error_message="selected replay data could not be materialized",
            )
            catalog_drift = False
            failure: BaseException | None = exc
            while isinstance(failure, ReplayDomainError):
                if failure.details.get("reason") == "CATALOG_EPOCH_MISMATCH":
                    catalog_drift = True
                    break
                failure = failure.__cause__
            if exc.code is ReplayErrorCode.DATASET_MISMATCH and catalog_drift:
                raise TrainingRunError(
                    "CATALOG_EPOCH_MISMATCH",
                    "data capability changed after validation; refresh and try again",
                    status_code=409,
                    details={"preparation_id": preparation_id},
                ) from exc
            raise TrainingRunError(
                "TRAINING_RUN_CREATE_FAILED",
                "training run could not be created",
                status_code=409,
                details={
                    "reason": exc.code.value,
                    "preparation_id": preparation_id,
                },
            ) from exc
        except sqlite3.IntegrityError as exc:
            await self.store.fail_selection_preparation(
                preparation_id,
                error_code="TRAINING_RUN_CONFLICT",
                error_message="training run persistence conflicted",
            )
            raise TrainingRunError(
                "TRAINING_RUN_CONFLICT",
                "training run identity already exists",
                status_code=409,
                details={"preparation_id": preparation_id},
            ) from exc
        except BaseException as exc:
            await self.store.fail_selection_preparation(
                preparation_id,
                error_code=type(exc).__name__,
                error_message="training data preparation failed",
            )
            raise
        run = await self.store.get_run(run_id)
        return {
            "protocol": "replay.v3",
            "created": True,
            "run": run,
        }

    async def return_to_hub(self, run_id: str) -> dict[str, object]:
        run_id = self._identifier(run_id, field_name="run_id")
        actor = self._run_actors.setdefault(run_id, TrainingRunActor(run_id))
        async with actor.serialized():
            actor.request_ordered_pause(reason="RETURN_TO_HUB")
            projection = await self.store.get_market_tracks(run_id)
            tracks = projection.get("tracks")
            if not isinstance(tracks, list):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market tracks projection is invalid",
                    status_code=503,
                )
            released = 0
            durable_states: list[str] = []
            for track in sorted(
                tracks,
                key=lambda item: (int(item["stable_ordinal"]), str(item["track_id"])),
            ):
                adapter_session_id = track.get("adapter_session_id")
                if not isinstance(adapter_session_id, str):
                    continue
                try:
                    await self.replay_service.release_session_to_hub(adapter_session_id)
                except ReplayDomainError as exc:
                    raise TrainingRunError(
                        "TRAINING_RUN_BUSY",
                        "training run cannot return to the Hub while another mutation is active",
                        status_code=409,
                        details={
                            "reason": exc.code.value,
                            "track_id": track["track_id"],
                        },
                    ) from exc
                record = await self.replay_service.store.get_session(adapter_session_id)
                durable_state = None if record is None else str(record["state"])
                if durable_state not in {
                    RunState.PAUSED.value,
                    RunState.ENDED.value,
                    RunState.ERROR.value,
                }:
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "training run did not reach a durable Hub-safe state",
                        status_code=503,
                        details={
                            "track_id": track["track_id"],
                            "state": durable_state,
                        },
                    )
                durable_states.append(durable_state)
                released += 1
            checkpoint = await self.store.checkpoint_market_tracks(run_id)
            await self.store.set_actor_segment_refs(run_id, active=False)
            card = await self.store.get_run(run_id)
            run_state = str(card["state"])
            if run_state not in {
                RunState.PAUSED.value,
                RunState.ENDED.value,
                RunState.ERROR.value,
            } or run_state not in set(durable_states):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "training run Hub state is inconsistent with its durable tracks",
                    status_code=503,
                    details={
                        "run_state": run_state,
                        "track_states": durable_states,
                    },
                )
        result: dict[str, object] = {
            "protocol": "replay.v3",
            "run_id": run_id,
            "state": run_state,
            "checkpointed": True,
            "released": True,
        }
        if len(tracks) > 1:
            result.update(
                {
                    "released_track_count": released,
                    "global_checkpoint": checkpoint,
                }
            )
        return result

    async def _attach_native_display_archive_pin(
        self,
        binding: Mapping[str, object],
        *,
        display_interval: str | None,
        require_projection_grid: bool = False,
    ) -> dict[str, object]:
        """Bind optional chart context without changing the execution snapshot."""

        requested_interval = (
            str(binding["display_interval"])
            if display_interval is None
            else display_interval
        )
        base_interval = str(binding["base_interval"])
        policy = binding.get("history_policy")
        lookback = (
            policy.get("visible_history_lookback")
            if isinstance(policy, Mapping)
            else None
        )
        if requested_interval == base_interval or (
            not require_projection_grid
            and (
                not isinstance(lookback, Mapping)
                or lookback.get("mode") != "ALL_AVAILABLE"
            )
        ):
            return dict(binding)

        run_id = str(binding["run_id"])
        track_id = str(binding["track_id"])
        interval_ms = parse_interval_ms(requested_interval)
        if interval_ms is None or interval_ms < 1:
            return dict(binding)
        actual_replay_start_ms = int(policy["actual_replay_start_ms"])
        strict_native_source = (
            str(binding.get("exchange", "")).lower() == "binance"
            and str(binding.get("market_type", "")).lower() == "spot"
            and str(binding.get("source_kind", "")).upper() == "BAR"
        )
        if getattr(self.replay_service, "_native_intervals_explicit", False):
            try:
                advertised_native_intervals = set(
                    self.replay_service._native_intervals(  # noqa: SLF001
                        ReplaySeriesIdentity(
                            str(binding["exchange"]),
                            str(binding["market_type"]),
                            str(binding["symbol"]),
                        )
                    )
                )
            except Exception as exc:
                raise TrainingRunError(
                    "HISTORY_SOURCE_UNAVAILABLE",
                    "native display interval capabilities are unavailable",
                    status_code=503,
                ) from exc
        else:
            advertised_native_intervals = set(VALID_INTERVALS)
        native_display_required = (
            strict_native_source and requested_interval in advertised_native_intervals
        )
        # BTC can legitimately have exchange-maintenance holes on intraday
        # series. Daily and wider native bars must remain continuous; otherwise
        # a missing archive object turns into exactly the giant chart gaps this
        # path is responsible for preventing.
        zero_gap_native_required = strict_native_source and interval_ms >= 86_400_000

        def resolve_source_grid(
            bounds: Mapping[str, object],
        ) -> tuple[int, str, int]:
            raw_anchor = bounds.get("source_bucket_anchor_ms")
            if raw_anchor is None:
                anchor_ms = compute_bucket_start_ms(
                    0,
                    interval_ms,
                    interval=requested_interval,
                )
            elif isinstance(raw_anchor, bool) or not isinstance(raw_anchor, int):
                raise TrainingRunError(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "native display source grid is invalid",
                    status_code=503,
                )
            else:
                anchor_ms = raw_anchor
            raw_alignment = bounds.get("alignment_policy")
            if raw_alignment is None:
                alignment_policy = "LEGACY_CANONICAL_INTERVAL_V1"
            elif isinstance(raw_alignment, str) and raw_alignment:
                alignment_policy = raw_alignment
            else:
                raise TrainingRunError(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "native display source grid is invalid",
                    status_code=503,
                )
            raw_start_ms = bounds.get("earliest_open_time")
            raw_end_ms = bounds.get("latest_open_time")
            if (
                isinstance(raw_start_ms, bool)
                or not isinstance(raw_start_ms, int)
                or isinstance(raw_end_ms, bool)
                or not isinstance(raw_end_ms, int)
            ):
                raise TrainingRunError(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "native display source grid is invalid",
                    status_code=503,
                )
            try:
                mapper = SourceBucketTimeMapper.create(
                    interval=requested_interval,
                    actual_replay_start_ms=actual_replay_start_ms,
                    public_replay_start_ms=actual_replay_start_ms,
                    source_bucket_anchor_ms=anchor_ms,
                )
                mapper.actual_bucket_ordinal(raw_start_ms)
                mapper.actual_bucket_ordinal(raw_end_ms)
                previous_open_ms = mapper.actual_bucket_open(-1)
            except ValueError as exc:
                raise TrainingRunError(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "native display source grid is invalid",
                    status_code=503,
                ) from exc
            if previous_open_ms < 0:
                raise TrainingRunError(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "native display source grid does not have a closed prefix",
                    status_code=503,
                )
            return anchor_ms, alignment_policy, previous_open_ms

        def assert_pin_identity(
            pin: Mapping[str, object],
            *,
            interval: str,
        ) -> None:
            if (
                str(pin.get("exchange")) != str(binding["exchange"])
                or str(pin.get("market_type")) != str(binding["market_type"])
                or str(pin.get("symbol")) != str(binding["symbol"])
                or str(pin.get("base_interval")) != interval
                or str(pin.get("dataset_epoch")) != str(binding["track_dataset_epoch"])
            ):
                raise TrainingRunError(
                    "HISTORY_SOURCE_IDENTITY_DRIFT",
                    "training history archive pin identity changed",
                    status_code=503,
                )

        async def assert_native_continuity(
            *,
            source_revision: str,
            range_start_ms: int,
            last_complete_open_ms: int,
        ) -> None:
            if not strict_native_source:
                return
            scan_gaps = getattr(
                self.replay_service.history_repository,
                "scan_gaps_at_revision",
                None,
            )
            if not callable(scan_gaps):
                raise TrainingRunError(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "pinned native display history has no continuity proof",
                    status_code=503,
                )
            try:
                gap_evidence = await asyncio.to_thread(
                    scan_gaps,
                    source_revision,
                    str(binding["symbol"]),
                    requested_interval,
                    start_ms=range_start_ms,
                    end_ms=last_complete_open_ms,
                    exchange=str(binding["exchange"]),
                    market_type=str(binding["market_type"]),
                    limit=100_000,
                )
            except Exception as exc:
                raise TrainingRunError(
                    "HISTORY_SOURCE_UNAVAILABLE",
                    "pinned native display continuity proof is unavailable",
                    status_code=503,
                ) from exc
            gap_count = (
                gap_evidence.get("gap_count")
                if isinstance(gap_evidence, Mapping)
                else None
            )
            if (
                not isinstance(gap_evidence, Mapping)
                or gap_evidence.get("truncated") is not False
                or gap_evidence.get("source_revision") not in {None, source_revision}
                or isinstance(gap_count, bool)
                or not isinstance(gap_count, int)
                or gap_count < 0
                or (zero_gap_native_required and gap_count != 0)
            ):
                raise TrainingRunError(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "pinned native display history is not continuous",
                    status_code=503,
                )

        base_pin = await self.store.history_archive_pin(
            run_id=run_id,
            track_id=track_id,
            interval=base_interval,
        )
        if base_pin is None:
            if native_display_required:
                raise TrainingRunError(
                    "HISTORY_NATIVE_DISPLAY_REQUIRED",
                    "native replay display history requires an immutable base archive pin",
                    status_code=503,
                )
            # A same-interval projection does not require a separate native pin.
            return dict(binding)
        assert_pin_identity(base_pin, interval=base_interval)
        display_pin = await self.store.history_archive_pin(
            run_id=run_id,
            track_id=track_id,
            interval=requested_interval,
        )
        candidate_proof: (
            tuple[
                str,
                int,
                int,
                int,
                str,
                int,
            ]
            | None
        ) = None
        if display_pin is None:
            repository = self.replay_service.history_repository
            get_bounds = getattr(repository, "get_bounds", None)
            if not callable(get_bounds):
                if native_display_required:
                    raise TrainingRunError(
                        "HISTORY_NATIVE_DISPLAY_REQUIRED",
                        "native replay display history is unavailable",
                        status_code=503,
                    )
                return dict(binding)
            try:
                bounds = await asyncio.to_thread(
                    get_bounds,
                    str(binding["symbol"]),
                    requested_interval,
                    exchange=str(binding["exchange"]),
                    market_type=str(binding["market_type"]),
                )
                source_revision = str(bounds["source_revision"])
                range_start_ms = int(bounds["earliest_open_time"])
                range_end_ms = int(bounds["latest_open_time"])
                (
                    candidate_source_bucket_anchor_ms,
                    candidate_alignment_policy,
                    candidate_last_complete_open_ms,
                ) = resolve_source_grid(bounds)
                get_bounds_at_revision = getattr(
                    repository,
                    "get_bounds_at_revision",
                    None,
                )
                if strict_native_source and not callable(get_bounds_at_revision):
                    raise TrainingRunError(
                        "HISTORY_SOURCE_INCOMPLETE",
                        "native display history has no immutable bounds proof",
                        status_code=503,
                    )
                if not callable(get_bounds_at_revision):
                    return dict(binding)
                if callable(get_bounds_at_revision):
                    exact_bounds = await asyncio.to_thread(
                        get_bounds_at_revision,
                        source_revision,
                        str(binding["symbol"]),
                        requested_interval,
                        exchange=str(binding["exchange"]),
                        market_type=str(binding["market_type"]),
                    )
                    exact_revision = str(exact_bounds["source_revision"])
                    exact_start_ms = int(exact_bounds["earliest_open_time"])
                    exact_end_ms = int(exact_bounds["latest_open_time"])
                    (
                        exact_source_bucket_anchor_ms,
                        exact_alignment_policy,
                        exact_last_complete_open_ms,
                    ) = resolve_source_grid(exact_bounds)
                    if (
                        exact_revision != source_revision
                        or exact_start_ms != range_start_ms
                        or exact_end_ms != range_end_ms
                        or exact_source_bucket_anchor_ms
                        != candidate_source_bucket_anchor_ms
                        or exact_alignment_policy != candidate_alignment_policy
                        or exact_last_complete_open_ms
                        != candidate_last_complete_open_ms
                    ):
                        raise TrainingRunError(
                            "HISTORY_SOURCE_IDENTITY_DRIFT",
                            "native display archive bounds changed before pinning",
                            status_code=503,
                        )
                if (
                    len(source_revision) != 71
                    or not source_revision.startswith("sha256:")
                    or range_start_ms < 0
                    or range_end_ms < candidate_last_complete_open_ms
                    or range_start_ms > candidate_last_complete_open_ms
                ):
                    raise TrainingRunError(
                        "HISTORY_SOURCE_INCOMPLETE",
                        "native display archive does not cover the replay seam",
                        status_code=503,
                    )
            except (KeyError, TypeError, ValueError):
                if native_display_required:
                    raise TrainingRunError(
                        "HISTORY_NATIVE_DISPLAY_REQUIRED",
                        "native replay display history is unavailable",
                        status_code=503,
                    ) from None
                return dict(binding)
            except TrainingRunError:
                raise
            except Exception:
                if native_display_required:
                    raise TrainingRunError(
                        "HISTORY_NATIVE_DISPLAY_REQUIRED",
                        "native replay display history is unavailable",
                        status_code=503,
                    ) from None
                # An optional native chart catalog may be absent. The pinned
                # base archive remains the deterministic, gap-aware fallback.
                return dict(binding)
            # Validate the candidate before making it an immutable Run pin. A
            # rejected or gappy catalog must never become sticky for the Run.
            await assert_native_continuity(
                source_revision=source_revision,
                range_start_ms=range_start_ms,
                last_complete_open_ms=candidate_last_complete_open_ms,
            )
            candidate_proof = (
                source_revision,
                range_start_ms,
                range_end_ms,
                candidate_source_bucket_anchor_ms,
                candidate_alignment_policy,
                candidate_last_complete_open_ms,
            )
            display_pin = await self.store.pin_history_archive_interval(
                run_id=run_id,
                track_id=track_id,
                source_revision=source_revision,
                exchange=str(binding["exchange"]),
                market_type=str(binding["market_type"]),
                symbol=str(binding["symbol"]),
                interval=requested_interval,
                range_start_ms=range_start_ms,
                range_end_ms=range_end_ms,
            )
        assert_pin_identity(display_pin, interval=requested_interval)
        repository = self.replay_service.history_repository
        try:
            pinned_start_ms = int(display_pin["range_start_ms"])
            pinned_end_ms = int(display_pin["range_end_ms"])
            pinned_source_revision = str(display_pin["source_revision"])
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingRunError(
                "HISTORY_SOURCE_INCOMPLETE",
                "native display archive pin range is invalid",
                status_code=503,
            ) from exc
        proof_key = (
            pinned_source_revision,
            str(binding["exchange"]),
            str(binding["market_type"]),
            str(binding["symbol"]),
            requested_interval,
            pinned_start_ms,
            pinned_end_ms,
            actual_replay_start_ms,
            str(binding["track_dataset_epoch"]),
        )
        if candidate_proof is not None and candidate_proof[:3] == (
            pinned_source_revision,
            pinned_start_ms,
            pinned_end_ms,
        ):
            self._remember_native_display_pin_proof(proof_key, candidate_proof[3:])
        cached_proof = self._native_display_pin_proofs.get(proof_key)
        if cached_proof is not None:
            self._native_display_pin_proofs.move_to_end(proof_key)
        if cached_proof is None:
            get_bounds_at_revision = getattr(
                repository,
                "get_bounds_at_revision",
                None,
            )
            if not callable(get_bounds_at_revision):
                raise TrainingRunError(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "pinned native display history has no immutable bounds proof",
                    status_code=503,
                )
            try:
                pinned_bounds = await asyncio.to_thread(
                    get_bounds_at_revision,
                    pinned_source_revision,
                    str(binding["symbol"]),
                    requested_interval,
                    exchange=str(binding["exchange"]),
                    market_type=str(binding["market_type"]),
                )
                exact_source_revision = str(pinned_bounds["source_revision"])
                exact_start_ms = int(pinned_bounds["earliest_open_time"])
                exact_end_ms = int(pinned_bounds["latest_open_time"])
                cached_proof = resolve_source_grid(pinned_bounds)
            except TrainingRunError:
                raise
            except (KeyError, TypeError, ValueError) as exc:
                raise TrainingRunError(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "native display archive pin range is invalid",
                    status_code=503,
                ) from exc
            except Exception as exc:
                raise TrainingRunError(
                    "HISTORY_SOURCE_UNAVAILABLE",
                    "pinned native display history is unavailable",
                    status_code=503,
                ) from exc
            if (
                exact_source_revision != pinned_source_revision
                or exact_start_ms != pinned_start_ms
                or exact_end_ms != pinned_end_ms
            ):
                raise TrainingRunError(
                    "HISTORY_SOURCE_IDENTITY_DRIFT",
                    "pinned native display archive bounds changed",
                    status_code=503,
                )
            (
                display_source_bucket_anchor_ms,
                display_alignment_policy,
                last_complete_open_ms,
            ) = cached_proof
            if (
                pinned_start_ms < 0
                or pinned_start_ms > last_complete_open_ms
                or pinned_end_ms < last_complete_open_ms
            ):
                raise TrainingRunError(
                    "HISTORY_SOURCE_INCOMPLETE",
                    "pinned native display archive does not cover the replay seam",
                    status_code=503,
                )
            await assert_native_continuity(
                source_revision=pinned_source_revision,
                range_start_ms=pinned_start_ms,
                last_complete_open_ms=last_complete_open_ms,
            )
            self._remember_native_display_pin_proof(proof_key, cached_proof)
        else:
            (
                display_source_bucket_anchor_ms,
                display_alignment_policy,
                last_complete_open_ms,
            ) = cached_proof
        display_grid_commitment = canonical_sha256(
            {
                "schema_version": "replay.display-source-grid.v1",
                "source_revision": pinned_source_revision,
                "display_interval": requested_interval,
                "source_bucket_anchor_ms": display_source_bucket_anchor_ms,
                "alignment_policy": display_alignment_policy,
            }
        )
        self._display_source_grid_anchors[
            (
                run_id,
                track_id,
                requested_interval,
                str(binding["track_dataset_epoch"]),
            )
        ] = display_source_bucket_anchor_ms
        return {
            **binding,
            "display_source_revision": pinned_source_revision,
            # The display catalog is immutable at ``pinned_source_revision``,
            # but it can legitimately lag the newer pinned base catalog near
            # the live tail.  Carry its exact bounds so projection can use
            # native authority only where that revision actually has rows and
            # aggregate the remaining closed tail from the pinned base source.
            "display_source_range_start_ms": pinned_start_ms,
            "display_source_range_end_ms": pinned_end_ms,
            "display_source_bucket_anchor_ms": display_source_bucket_anchor_ms,
            "display_alignment_policy": display_alignment_policy,
            "display_grid_commitment": display_grid_commitment,
        }

    async def history_page(
        self,
        session_id: str,
        *,
        track_id: str,
        before_ms: int,
        revealed_boundary_ms: int,
        limit: int,
        data_epoch: str,
        history_epoch: str | None,
        display_interval: str | None = None,
    ) -> dict[str, object]:
        """Return one revealed-only page through the replay-owned data boundary."""

        normalized_session = self._identifier(session_id, field_name="session_id")
        normalized_track = self._identifier(track_id, field_name="track_id")
        binding = await self.store.history_binding(
            session_id=normalized_session,
            track_id=normalized_track,
        )
        if binding.get("subscription_tier") == SubscriptionTier.NONE.value:
            raise TrainingRunError(
                "HISTORY_SUBSCRIPTION_REQUIRED",
                "history is unavailable while the market track is unsubscribed",
                status_code=409,
                details={"required_tier": "WARM_OR_FULL"},
            )
        binding = await self._attach_native_display_archive_pin(
            binding,
            display_interval=display_interval,
        )
        persisted = await self.replay_service.store.load_dataset(normalized_session)
        if persisted is None:
            raise TrainingRunError(
                "HISTORY_SNAPSHOT_UNAVAILABLE",
                "training history snapshot is unavailable",
                status_code=503,
            )
        return await asyncio.to_thread(
            build_history_page,
            binding=binding,
            persisted=persisted,
            before_ms=before_ms,
            revealed_boundary_ms=revealed_boundary_ms,
            limit=limit,
            data_epoch=data_epoch,
            expected_history_epoch=history_epoch,
            display_interval=display_interval,
            repository=self.replay_service.history_repository,
        )

    async def display_projection(
        self,
        session_id: str,
        *,
        track_id: str,
        revealed_boundary_ms: int,
        limit: int,
        data_epoch: str,
        display_interval: str,
    ) -> dict[str, object]:
        """Return a source-bucket-aligned, public-time-only viewer tail."""

        normalized_session = self._identifier(session_id, field_name="session_id")
        normalized_track = self._identifier(track_id, field_name="track_id")
        binding = await self.store.history_binding(
            session_id=normalized_session,
            track_id=normalized_track,
        )
        if binding.get("subscription_tier") == SubscriptionTier.NONE.value:
            raise TrainingRunError(
                "HISTORY_SUBSCRIPTION_REQUIRED",
                "display projection is unavailable while the market track is unsubscribed",
                status_code=409,
                details={"required_tier": "WARM_OR_FULL"},
            )
        binding = await self._attach_native_display_archive_pin(
            binding,
            display_interval=display_interval,
            require_projection_grid=True,
        )
        persisted = await self.replay_service.store.load_dataset(normalized_session)
        if persisted is None:
            raise TrainingRunError(
                "HISTORY_SNAPSHOT_UNAVAILABLE",
                "training display projection snapshot is unavailable",
                status_code=503,
            )
        return await asyncio.to_thread(
            build_display_projection,
            binding=binding,
            persisted=persisted,
            revealed_boundary_ms=revealed_boundary_ms,
            limit=limit,
            data_epoch=data_epoch,
            display_interval=display_interval,
            repository=self.replay_service.history_repository,
        )

    async def command(
        self,
        run_id: str,
        command: ReplayV2Command,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        if command.type in {
            ReplayV2CommandType.CANCEL_ADVANCE,
            ReplayV2CommandType.SET_DISPLAY_INTERVAL,
            ReplayV2CommandType.RECORD_VIEW_ACTION,
        }:
            return await self._command_serialized(normalized, command)
        actor = self._run_actors.setdefault(normalized, TrainingRunActor(normalized))
        ordered_pause_barrier = (
            command.type is ReplayV2CommandType.PAUSE and actor.playback_is_active()
        )
        if command.type is ReplayV2CommandType.PAUSE:
            # A pause is a barrier, not ordinary queued work. Signal the
            # server-owned loop before waiting for its serialization lock so a
            # high playback rate cannot consume the remaining dataset first.
            actor.signal_ordered_stop()
        async with actor.serialized():
            return await self._command_serialized(
                normalized,
                command,
                ordered_pause_barrier=ordered_pause_barrier,
            )

    async def _command_serialized(
        self,
        run_id: str,
        command: ReplayV2Command,
        *,
        ordered_pause_barrier: bool = False,
    ) -> dict[str, object]:
        normalized_run = self._identifier(run_id, field_name="run_id")
        if not isinstance(command, ReplayV2Command):
            raise TypeError("command must be ReplayV2Command")
        if command.run_id != normalized_run:
            raise TrainingRunError(
                "TRAINING_RUN_INVALID",
                "command run_id does not match the route",
                status_code=422,
            )
        command_payload = command.to_dict()
        replayed = await self.store.get_command_result(
            normalized_run,
            command.command_id,
            command_payload,
        )
        if replayed is not None:
            return replayed

        binding = await self.store.run_binding(normalized_run)
        if str(
            binding.get("account_data_mode")
        ) == AccountDataMode.HISTORICAL_EXACT.value and (
            not self.account_history.enabled
            or str(binding.get("account_history_status")) != "ACTIVE"
        ):
            raise TrainingRunError(
                (
                    "ACCOUNT_HISTORY_DISABLED"
                    if not self.account_history.enabled
                    else "ACCOUNT_HISTORY_ARCHIVE_DEGRADED"
                ),
                "exact account inputs are unavailable; the Run remains paused",
                status_code=409,
                details={
                    "compatibility": binding["compatibility"],
                    "fallback_applied": False,
                },
            )
        if binding["compatibility"] != "READY":
            if (
                str(binding.get("book_mode", "OFF"))
                == BookMode.BOOK_ASSISTED_REQUIRED.value
            ):
                raise TrainingRunError(
                    (
                        "HISTORICAL_BOOK_CAPABILITY_UNAVAILABLE"
                        if self.historical_books.enabled
                        else "HISTORICAL_BOOK_DISABLED"
                    ),
                    "book-assisted execution capability is unavailable; the Run remains paused",
                    status_code=409,
                    details={
                        "compatibility": binding["compatibility"],
                        "fallback_applied": False,
                    },
                )
            raise TrainingRunError(
                "REPLAY_CONTROL_UNAVAILABLE",
                "Phase 3 controls require a base-interval v2 adapter",
                status_code=409,
                details={"compatibility": binding["compatibility"]},
            )
        await self.store.set_actor_segment_refs(normalized_run, active=True)
        session_id = str(binding["adapter_session_id"])
        if command.type is ReplayV2CommandType.CANCEL_ADVANCE:
            result = await self._cancel_advance(command, session_id=session_id)
            await self.store.save_command_result(
                run_id=normalized_run,
                command_id=command.command_id,
                command=command_payload,
                result=result,
            )
            return result
        session = await self.replay_service.get_session(session_id)
        durable_intent = await self.store.get_advance_intent(
            run_id=normalized_run,
            command_id=command.command_id,
            command=command_payload,
        )
        if durable_intent is not None:
            intent_status = str(durable_intent["status"])
            stored_result = durable_intent.get("result")
            if intent_status in {"COMPLETED", "CANCELLED"}:
                if not isinstance(stored_result, Mapping):
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "completed advance intent is missing its result",
                        status_code=503,
                    )
                result = dict(stored_result)
                await self.store.save_command_result(
                    run_id=normalized_run,
                    command_id=command.command_id,
                    command=command_payload,
                    result=result,
                )
                return result
            if intent_status == "RUNNING":
                stored_plan = _stored_mapping(
                    durable_intent.get("plan"),
                    field_name="durable advance plan",
                )
                stored_mode = str(
                    stored_plan.get(
                        "mode",
                        FastForwardPlan.FULL_EVENT_SCAN.value,
                    )
                )
                recovery_mode = (
                    FastForwardPlan.AGGREGATE_SCAN.value
                    if stored_mode
                    in {
                        FastForwardPlan.CHECKPOINT_JUMP.value,
                        FastForwardPlan.AGGREGATE_SCAN.value,
                    }
                    else FastForwardPlan.FULL_EVENT_SCAN.value
                )
                recovery_plan = {
                    **dict(stored_plan),
                    "mode": recovery_mode,
                    "plan": recovery_mode,
                    "optimized": (
                        recovery_mode == FastForwardPlan.AGGREGATE_SCAN.value
                    ),
                    "period_summary": {
                        "status": "RECOVERY_REFERENCE",
                        "reason_code": "DURABLE_INTENT_RESUME",
                    },
                }
                try:
                    await self.replay_service.ensure_advance_recovery_controller(
                        session_id,
                        client_instance_id=command.client_instance_id,
                    )
                except ReplayDomainError as exc:
                    raise TrainingRunError(
                        exc.code.value,
                        exc.message,
                        status_code=exc.http_status,
                        details=exc.details,
                    ) from exc
                result = await self._execute_target_scan(
                    command=command,
                    session_id=session_id,
                    target_virtual_time_ms=_stored_counter(
                        durable_intent["target_virtual_time_ms"],
                        field_name="target_virtual_time_ms",
                    ),
                    plan=recovery_plan,
                    summary=None,
                    resuming=True,
                )
                await self.store.save_command_result(
                    run_id=normalized_run,
                    command_id=command.command_id,
                    command=command_payload,
                    result=result,
                )
                return result
            raise TrainingRunError(
                "ADVANCE_INTENT_FAILED",
                "the durable advance intent cannot be resumed automatically",
                status_code=409,
                details={"status": intent_status},
            )
        if command.type in {
            ReplayV2CommandType.ADD_TRACK,
            ReplayV2CommandType.SELECT_TRACK,
            ReplayV2CommandType.SET_SUBSCRIPTION_TIER,
            ReplayV2CommandType.REMOVE_UNOWNED_TRACK,
        }:
            snapshot = self._assert_expected_cursor(command, session)
            result = await self._execute_market_track_command(
                command=command,
                binding=binding,
                selected_snapshot=snapshot,
            )
            await self.store.save_command_result(
                run_id=normalized_run,
                command_id=command.command_id,
                command=command_payload,
                result=result,
            )
            return result
        if command.type in {
            ReplayV2CommandType.PLACE_ORDER,
            ReplayV2CommandType.REPLACE_ORDER,
            ReplayV2CommandType.CANCEL_ORDER,
            ReplayV2CommandType.CANCEL_ORDERS,
            ReplayV2CommandType.CLOSE_POSITION,
            ReplayV2CommandType.EXECUTE_POSITION_INTENT,
            ReplayV2CommandType.SET_POSITION_PROTECTION,
            ReplayV2CommandType.SET_POSITION_LEVERAGE,
        }:
            snapshot = self._assert_expected_cursor(command, session)
            await self._guard_historical_book_current(
                run_id=normalized_run,
                binding=binding,
                snapshot=snapshot,
            )
            result = await self._execute_market_trade_command(
                command=command,
                binding=binding,
                snapshot=snapshot,
            )
            await self.store.save_command_result(
                run_id=normalized_run,
                command_id=command.command_id,
                command=command_payload,
                result=result,
            )
            return result
        if command.type is ReplayV2CommandType.ALLOCATE_ISOLATED_MARGIN:
            snapshot = self._assert_expected_cursor(command, session)
            payload = self._exact_payload(
                command.payload,
                {"track_id", "position_side", "amount"},
            )
            track_id = self._identifier(payload["track_id"], field_name="track_id")
            position_side = payload["position_side"]
            if binding.get("position_mode") == "HEDGE":
                if position_side not in {"LONG", "SHORT"}:
                    raise TrainingRunError(
                        "REPLAY_CONTROL_INVALID",
                        "HEDGE isolated margin requires position_side",
                        status_code=422,
                    )
            elif position_side is not None:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "ONE_WAY isolated margin does not accept position_side",
                    status_code=422,
                )
            amount = payload["amount"]
            if not isinstance(amount, str):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "isolated margin amount must be a canonical Decimal string",
                    status_code=422,
                )
            try:
                normalized_amount = normalize_decimal_string(
                    amount,
                    field_name="isolated margin amount",
                )
            except (TypeError, ValueError) as exc:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "isolated margin amount is invalid",
                    status_code=422,
                ) from exc
            if normalized_amount != amount or Decimal(amount) < 0:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "isolated margin amount must be a non-negative canonical Decimal string",
                    status_code=422,
                )
            cursor = _stored_mapping(snapshot["cursor"], field_name="adapter cursor")
            portfolio = await self.store.allocate_isolated_margin(
                run_id=normalized_run,
                track_id=track_id,
                position_side=(None if position_side is None else str(position_side)),
                amount=amount,
                command_id=command.command_id,
                virtual_time_ms=_stored_counter(
                    cursor["virtual_time_ms"],
                    field_name="virtual_time_ms",
                ),
                source_sequence=_stored_counter(
                    cursor["source_sequence"],
                    field_name="source_sequence",
                ),
            )
            checkpoint = await self.store.checkpoint_market_tracks(normalized_run)
            refreshed = await self.store.get_market_tracks(normalized_run)
            portfolio = cast(dict[str, object], refreshed["portfolio"])
            viewer = await self.store.get_viewer_state(normalized_run)
            result = self._result_payload(
                command=command,
                session_id=session_id,
                snapshot=snapshot,
                viewer=viewer.to_dict(),
                data={
                    "account_contract": "TOUCH_OR_TAPE_V2_CONTRACT_ACCOUNT",
                    "portfolio": portfolio,
                    "global_checkpoint": checkpoint,
                    "allocated_track_id": track_id,
                    "allocated_position_side": position_side,
                    "allocated_margin": amount,
                },
            )
            await self.store.save_command_result(
                run_id=normalized_run,
                command_id=command.command_id,
                command=command_payload,
                result=result,
            )
            return result
        if command.type is ReplayV2CommandType.RECORD_VIEW_ACTION:
            snapshot = self._assert_expected_cursor(command, session)
            payload = self._exact_payload(
                command.payload,
                {"event_type", "semantic_key", "value"},
            )
            event_type = self._identifier(
                payload["event_type"],
                field_name="view event_type",
            )
            semantic_key = self._identifier(
                payload["semantic_key"],
                field_name="view semantic_key",
            )
            value = payload["value"]
            if not isinstance(value, Mapping):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "view action value must be an object",
                    status_code=422,
                )
            cursor = snapshot["cursor"]
            if not isinstance(cursor, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "adapter cursor is invalid",
                    status_code=503,
                )
            view_action = await self.store.record_view_action(
                run_id=normalized_run,
                command_id=command.command_id,
                event_type=event_type,
                semantic_key=semantic_key,
                value=value,
                public_time_ms=int(cursor["virtual_time_ms"]),
                source_sequence=int(cursor["source_sequence"]),
            )
            viewer = await self.store.get_viewer_state(normalized_run)
            return {
                "protocol": "replay.v3",
                "run_id": normalized_run,
                "session_id": session_id,
                "command_id": command.command_id,
                "revision": snapshot["revision"],
                "sequence": snapshot["sequence"],
                "state": snapshot["state"],
                "state_hash": snapshot["state_hash"],
                "cursor": cursor,
                "viewer_state": viewer.to_dict(),
                "data": {
                    "view_action": view_action,
                    "domain_hash_unchanged": True,
                },
            }
        if command.type in {
            ReplayV2CommandType.DEPOSIT,
            ReplayV2CommandType.WITHDRAW,
            ReplayV2CommandType.CHANGE_FEE_POLICY,
            ReplayV2CommandType.CHANGE_LEVERAGE_CAP,
            ReplayV2CommandType.CHANGE_FUNDING_POLICY,
            ReplayV2CommandType.REVEAL_TIME,
        }:
            snapshot = self._assert_expected_cursor(command, session)
            result = await self._execute_policy_command(
                command=command,
                binding=binding,
                snapshot=snapshot,
                session_id=session_id,
            )
            await self.store.save_command_result(
                run_id=normalized_run,
                command_id=command.command_id,
                command=command_payload,
                result=result,
            )
            return result
        if command.type is ReplayV2CommandType.SET_DISPLAY_INTERVAL:
            # ViewerState is outside the domain hash and cursor. A display
            # switch submitted while an advance is running must not be rejected
            # merely because its captured domain cursor is already stale.
            snapshot = self._snapshot(session)
            result = await self._set_display_interval(
                command=command,
                binding=binding,
                snapshot=snapshot,
            )
            await self.store.save_command_result(
                run_id=normalized_run,
                command_id=command.command_id,
                command=command_payload,
                result=result,
            )
            return result

        run_actor = self._run_actors.setdefault(
            normalized_run,
            TrainingRunActor(normalized_run),
        )
        if run_actor.playback_is_active() and command.type not in {
            ReplayV2CommandType.PAUSE,
            ReplayV2CommandType.SET_SPEED,
            ReplayV2CommandType.RELEASE_CONTROLLER,
            ReplayV2CommandType.END,
        }:
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "pause ordered playback before submitting another clock control",
                status_code=409,
            )
        snapshot = (
            self._snapshot(session)
            if (run_actor.playback_is_active() or ordered_pause_barrier)
            and command.type
            in {
                ReplayV2CommandType.PAUSE,
                ReplayV2CommandType.SET_SPEED,
                ReplayV2CommandType.RELEASE_CONTROLLER,
                ReplayV2CommandType.END,
            }
            else self._assert_expected_cursor(command, session)
        )
        track_projection = await self.store.get_market_tracks(normalized_run)
        projection_tracks = track_projection.get("tracks")
        if not isinstance(projection_tracks, list):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "market tracks projection is invalid",
                status_code=503,
            )
        all_tracks = [
            cast(Mapping[str, object], track)
            for track in projection_tracks
            if isinstance(track, Mapping)
        ]
        full_tracks = [
            track for track in all_tracks if track.get("subscription_tier") == "FULL"
        ]
        if command.type in {
            ReplayV2CommandType.PLAY,
            ReplayV2CommandType.STEP_EVENT,
            ReplayV2CommandType.STEP_BASE,
            ReplayV2CommandType.STEP_DISPLAY,
            ReplayV2CommandType.ADVANCE,
            ReplayV2CommandType.ADVANCE_BY,
            ReplayV2CommandType.ADVANCE_TO,
        }:
            await self._guard_historical_book_current(
                run_id=normalized_run,
                binding=binding,
                snapshot=snapshot,
                tracks=full_tracks,
            )
        contract_clock = binding.get("account_model") == "TOUCH_OR_TAPE_V2"
        contract_ordered_types = {
            ReplayV2CommandType.PLAY,
            ReplayV2CommandType.PAUSE,
            ReplayV2CommandType.SET_SPEED,
            ReplayV2CommandType.RELEASE_CONTROLLER,
        }
        exact_account_ordered_types = contract_ordered_types | {
            ReplayV2CommandType.STEP_EVENT,
            ReplayV2CommandType.STEP_BASE,
            ReplayV2CommandType.STEP_DISPLAY,
            ReplayV2CommandType.ADVANCE,
            ReplayV2CommandType.ADVANCE_BY,
            ReplayV2CommandType.ADVANCE_TO,
        }
        exact_account_clock = (
            binding.get("account_data_mode") == AccountDataMode.HISTORICAL_EXACT.value
        )
        hedge_input_clock = binding.get("position_mode") == "HEDGE"
        multi_track_command = (
            len(full_tracks) > 1
            or (contract_clock and command.type in contract_ordered_types)
            or (exact_account_clock and command.type in exact_account_ordered_types)
            or (hedge_input_clock and command.type in exact_account_ordered_types)
            or (command.type is ReplayV2CommandType.END and len(all_tracks) > 1)
        )
        if multi_track_command and command.type in {
            ReplayV2CommandType.ACQUIRE_CONTROLLER,
            ReplayV2CommandType.TAKEOVER_CONTROLLER,
            ReplayV2CommandType.RELEASE_CONTROLLER,
            ReplayV2CommandType.PLAY,
            ReplayV2CommandType.PAUSE,
            ReplayV2CommandType.SET_SPEED,
            ReplayV2CommandType.STEP_EVENT,
            ReplayV2CommandType.STEP_BASE,
            ReplayV2CommandType.STEP_DISPLAY,
            ReplayV2CommandType.ADVANCE,
            ReplayV2CommandType.ADVANCE_BY,
            ReplayV2CommandType.ADVANCE_TO,
            ReplayV2CommandType.END,
        }:
            result = await self._execute_multi_track_control(
                command=command,
                binding=binding,
                selected_snapshot=snapshot,
                tracks=(
                    all_tracks
                    if command.type is ReplayV2CommandType.END
                    else full_tracks
                ),
            )
            await self.store.save_command_result(
                run_id=normalized_run,
                command_id=command.command_id,
                command=command_payload,
                result=result,
            )
            return result
        v1_type, v1_payload, plan = await self._translate_control(
            command=command,
            binding=binding,
            snapshot=snapshot,
        )
        target = plan.get("target_virtual_time_ms")
        if v1_type is CommandType.ADVANCE_BY and isinstance(target, int):
            decision = self._plan_fast_forward(
                binding=binding,
                snapshot=snapshot,
                tracks=tuple(all_tracks),
                target_virtual_time_ms=target,
            )
            summary_lookup: Mapping[str, object] = {
                "status": "SKIPPED",
                "reason_code": "REFERENCE_OR_BLOCKED_PLAN",
                "summary": None,
            }
            if decision.plan is FastForwardPlan.AGGREGATE_SCAN:
                summary_lookup = await self._eligible_period_summary(
                    run_id=normalized_run,
                    binding=binding,
                    snapshot=snapshot,
                    target_virtual_time_ms=target,
                )
                candidate = summary_lookup.get("summary")
                if isinstance(candidate, ReplayPeriodSummary):
                    decision = self._plan_fast_forward(
                        binding=binding,
                        snapshot=snapshot,
                        tracks=tuple(all_tracks),
                        target_virtual_time_ms=target,
                        summary=candidate,
                    )
            translated_plan = plan
            final_state_delivery = translated_plan.get(
                "basis"
            ) == AdvanceBasis.DISPLAY_BAR.value and command.type in {
                ReplayV2CommandType.ADVANCE,
                ReplayV2CommandType.STEP_DISPLAY,
            }
            plan = {
                **self._fast_forward_plan_payload(
                    decision,
                    summary_lookup=summary_lookup,
                ),
                **{
                    key: value
                    for key, value in translated_plan.items()
                    if key
                    in {
                        "contract",
                        "basis",
                        "count",
                        "duration_ms",
                        "legacy_alias",
                        "grain",
                        "display_interval",
                        "viewer_revision",
                        "target_virtual_time_ms",
                    }
                },
            }
            if decision.plan is FastForwardPlan.BLOCKED:
                raise TrainingRunError(
                    "REPLAY_FAST_FORWARD_BLOCKED",
                    decision.explanation,
                    status_code=409,
                    details={"plan": plan},
                )
            if final_state_delivery:
                empty_account_path = not decision.context.path_dependencies
                sparse_interaction_path = set(decision.context.path_dependencies) == {
                    "OPEN_ORDER"
                }
                if empty_account_path or sparse_interaction_path:
                    plan["chunk_event_limit"] = max(
                        1,
                        min(
                            FINAL_STATE_EMPTY_ACCOUNT_CHUNK_EVENTS,
                            self.replay_service.settings.event_buffer_size,
                            self.replay_service.settings.trade_page_rows,
                        ),
                    )
                plan.update(
                    {
                        "projection_delivery": FINAL_STATE_PROJECTION_DELIVERY,
                        "path_execution": (
                            "EMPTY_ACCOUNT"
                            if empty_account_path
                            else (
                                "SPARSE_INTERACTION"
                                if sparse_interaction_path
                                else "EXACT_INTERACTION"
                            )
                        ),
                        "final_state_optimized": True,
                        "single_pass_source_chunks": True,
                        "interaction_boundary_stop": sparse_interaction_path,
                        "intermediate_projection_policy": "ORDERS_FILLS_WARNINGS",
                    }
                )
            result = await self._execute_target_scan(
                command=command,
                session_id=session_id,
                target_virtual_time_ms=target,
                plan=plan,
                summary=(
                    candidate
                    if isinstance(
                        (candidate := summary_lookup.get("summary")),
                        ReplayPeriodSummary,
                    )
                    else None
                ),
            )
            await self.store.save_command_result(
                run_id=normalized_run,
                command_id=command.command_id,
                command=command_payload,
                result=result,
            )
            return result
        v1_command = ReplayCommand(
            protocol=REPLAY_PROTOCOL,
            command_id=command.command_id,
            client_instance_id=command.client_instance_id,
            expected_revision=command.expected_revision,
            type=v1_type,
            payload=v1_payload,
        )
        try:
            adapter_result = await self.replay_service.command(session_id, v1_command)
        except ReplayDomainError as exc:
            raise TrainingRunError(
                exc.code.value,
                exc.message,
                status_code=exc.http_status,
                details=exc.details,
            ) from exc
        adapter_data = dict(
            _stored_mapping(
                adapter_result.get("data"),
                field_name="adapter_result.data",
            )
        )
        liquidation_count = await self._reconcile_liquidations(
            run_id=normalized_run,
            client_instance_id=command.client_instance_id,
            command_id=command.command_id,
        )
        authoritative = (
            self._snapshot(await self.replay_service.get_session(session_id))
            if liquidation_count
            else adapter_result
        )
        if command.type in {
            ReplayV2CommandType.STEP_EVENT,
            ReplayV2CommandType.STEP_BASE,
            ReplayV2CommandType.STEP_DISPLAY,
            ReplayV2CommandType.ADVANCE,
        }:
            await self._guard_historical_book_current(
                run_id=normalized_run,
                binding=binding,
                snapshot=authoritative,
            )
        viewer = await self.store.get_viewer_state(normalized_run)
        result = {
            "protocol": "replay.v3",
            "run_id": normalized_run,
            "session_id": session_id,
            "command_id": command.command_id,
            "revision": authoritative["revision"],
            "sequence": authoritative["sequence"],
            "state": authoritative["state"],
            "state_hash": authoritative["state_hash"],
            "cursor": authoritative["cursor"],
            "viewer_state": viewer.to_dict(),
            "data": {
                **adapter_data,
                "plan": plan,
                "adapter_command": v1_type.value,
                "simulated_account_liquidations": liquidation_count,
            },
        }
        await self.store.save_command_result(
            run_id=normalized_run,
            command_id=command.command_id,
            command=command_payload,
            result=result,
        )
        return result

    async def _execute_market_track_command(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        selected_snapshot: Mapping[str, object],
    ) -> dict[str, object]:
        actor = self._run_actors.setdefault(
            command.run_id,
            TrainingRunActor(command.run_id),
        )
        actor.request_ordered_pause(reason="TRACK_MUTATION")
        if command.type is ReplayV2CommandType.ADD_TRACK:
            payload = self._exact_payload(
                command.payload,
                {
                    "exchange",
                    "market_type",
                    "symbol",
                    "settlement_asset",
                    "subscription_tier",
                },
            )
            exchange = self._identifier(payload["exchange"], field_name="exchange")
            market_type = self._identifier(
                payload["market_type"], field_name="market_type"
            )
            symbol = self._identifier(payload["symbol"], field_name="symbol")
            settlement_asset = self._identifier(
                payload["settlement_asset"],
                field_name="settlement_asset",
            )
            try:
                tier = SubscriptionTier(str(payload["subscription_tier"]))
            except ValueError as exc:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "subscription_tier is unsupported",
                    status_code=422,
                ) from exc
            self._assert_same_market_scope(
                binding=binding,
                exchange=exchange,
                market_type=market_type,
                settlement_asset=settlement_asset,
            )
            target_virtual_time_ms = self._cursor_time(selected_snapshot)
            if (
                str(binding.get("book_mode", "OFF"))
                == BookMode.BOOK_ASSISTED_REQUIRED.value
                and tier is SubscriptionTier.FULL
            ):
                # Prove exact L2 coverage before reserving the track. A failed
                # capability check must not leave a phantom FULL track behind.
                await self.historical_books.prepare_binding(
                    exchange=exchange,
                    market_type=market_type,
                    symbol=symbol,
                    range_start_ms=_stored_counter(
                        binding["actual_replay_start_ms"],
                        field_name="actual_replay_start_ms",
                    ),
                    range_end_ms=_stored_counter(
                        binding["actual_replay_end_ms"],
                        field_name="actual_replay_end_ms",
                    ),
                    actual_time_ms=self._actual_event_time_ms(
                        binding,
                        target_virtual_time_ms,
                    ),
                    virtual_time_ms=target_virtual_time_ms,
                )
            track = await self.store.reserve_market_track(
                run_id=command.run_id,
                exchange=exchange,
                market_type=market_type,
                symbol=symbol,
                settlement_asset=settlement_asset,
                source_kind=str(binding["source_kind"]),
                subscription_tier=tier.value,
            )
            if tier is not SubscriptionTier.NONE:
                try:
                    track = await self._prepare_market_track(
                        command=command,
                        binding=binding,
                        track=track,
                        requested_tier=tier,
                        target_virtual_time_ms=target_virtual_time_ms,
                    )
                except TrainingRunError:
                    if track.get("adapter_session_id") is None:
                        await self.store.remove_market_track(
                            command.run_id,
                            str(track["track_id"]),
                        )
                    raise
                except Exception as exc:
                    await self.store.mark_market_track_error(
                        run_id=command.run_id,
                        track_id=str(track["track_id"]),
                        reason=type(exc).__name__,
                    )
                    raise TrainingRunError(
                        "MARKET_TRACK_PREPARE_FAILED",
                        "market track could not be prepared from frozen history",
                        status_code=409,
                    ) from exc
            return await self._market_track_result(
                command=command,
                session_id=str(binding["adapter_session_id"]),
                snapshot=selected_snapshot,
                data={
                    "track": track,
                    "history_reads": 0 if tier is SubscriptionTier.NONE else "BOUNDED",
                    "ordering_version": GLOBAL_ORDERING_VERSION,
                },
            )

        payload = self._exact_payload(
            command.payload,
            (
                {"track_id", "expected_viewer_revision"}
                if command.type is ReplayV2CommandType.SELECT_TRACK
                else (
                    {"track_id", "subscription_tier"}
                    if command.type is ReplayV2CommandType.SET_SUBSCRIPTION_TIER
                    else {"track_id"}
                )
            ),
        )
        track_id = self._identifier(payload["track_id"], field_name="track_id")
        track = await self.store.get_market_track(command.run_id, track_id)

        if command.type is ReplayV2CommandType.REMOVE_UNOWNED_TRACK:
            session_id = await self.store.remove_market_track(command.run_id, track_id)
            if session_id is not None:
                await self.replay_service.discard_session(session_id)
            return await self._market_track_result(
                command=command,
                session_id=str(binding["adapter_session_id"]),
                snapshot=selected_snapshot,
                data={"removed_track_id": track_id},
            )

        if command.type is ReplayV2CommandType.SET_SUBSCRIPTION_TIER:
            recovered = False
            tier_book_binding = None
            try:
                tier = SubscriptionTier(str(payload["subscription_tier"]))
            except ValueError as exc:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "subscription_tier is unsupported",
                    status_code=422,
                ) from exc
            if tier is not SubscriptionTier.NONE:
                if track["adapter_session_id"] is None:
                    track = await self._prepare_market_track(
                        command=command,
                        binding=binding,
                        track=track,
                        requested_tier=tier,
                        target_virtual_time_ms=self._cursor_time(selected_snapshot),
                    )
                elif tier is SubscriptionTier.FULL:
                    if (
                        str(binding.get("book_mode", "OFF"))
                        == BookMode.BOOK_ASSISTED_REQUIRED.value
                        and track.get("subscription_tier")
                        != SubscriptionTier.FULL.value
                    ):
                        target_virtual_time_ms = self._cursor_time(selected_snapshot)
                        tier_book_binding = await self.historical_books.prepare_binding(
                            exchange=str(track["exchange"]),
                            market_type=str(track["market_type"]),
                            symbol=str(track["symbol"]),
                            range_start_ms=_stored_counter(
                                binding["actual_replay_start_ms"],
                                field_name="actual_replay_start_ms",
                            ),
                            range_end_ms=_stored_counter(
                                binding["actual_replay_end_ms"],
                                field_name="actual_replay_end_ms",
                            ),
                            actual_time_ms=self._actual_event_time_ms(
                                binding,
                                target_virtual_time_ms,
                            ),
                            virtual_time_ms=target_virtual_time_ms,
                        )
                    await self._activate_existing_track(
                        command=command,
                        track=track,
                        target_virtual_time_ms=self._cursor_time(selected_snapshot),
                    )
                    forced_reasons = track.get("forced_full_reasons")
                    needs_recovery = (
                        track["state"] == "DEGRADED"
                        or track.get("degraded_reason") is not None
                        or (
                            isinstance(forced_reasons, list)
                            and "REVIEW_REQUIRED" in forced_reasons
                        )
                    )
                    if needs_recovery:
                        track = await self.store.clear_market_track_degradation(
                            run_id=command.run_id,
                            track_id=track_id,
                        )
                        recovered = True
            if tier is not SubscriptionTier.FULL:
                # The tier writer performs the forced-reason check in the same
                # transaction. Only a clean track reaches this checkpoint.
                await self.store.checkpoint_market_tracks(command.run_id)
            track = await self.store.set_market_track_tier(
                run_id=command.run_id,
                track_id=track_id,
                subscription_tier=tier.value,
                historical_book_binding=tier_book_binding,
            )
            if tier is not SubscriptionTier.FULL and track["adapter_session_id"]:
                await self.replay_service.release_session_to_hub(
                    str(track["adapter_session_id"])
                )
            recovery_checkpoint = (
                await self.store.checkpoint_market_tracks(command.run_id)
                if recovered
                else None
            )
            return await self._market_track_result(
                command=command,
                session_id=str(binding["adapter_session_id"]),
                snapshot=selected_snapshot,
                data={
                    "track": track,
                    "checkpointed_before_downgrade": tier.value != "FULL",
                    "recovered_from_degradation": recovered,
                    "recovery_checkpoint": recovery_checkpoint,
                },
            )

        expected_viewer_revision = payload["expected_viewer_revision"]
        if (
            isinstance(expected_viewer_revision, bool)
            or not isinstance(expected_viewer_revision, int)
            or expected_viewer_revision < 0
        ):
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "expected_viewer_revision must be a non-negative integer",
                status_code=422,
            )
        if track["adapter_session_id"] is None:
            track = await self._prepare_market_track(
                command=command,
                binding=binding,
                track=track,
                requested_tier=SubscriptionTier.FULL,
                target_virtual_time_ms=self._cursor_time(selected_snapshot),
            )
        else:
            await self._activate_existing_track(
                command=command,
                track=track,
                target_virtual_time_ms=self._cursor_time(selected_snapshot),
            )
        await self.store.set_market_track_tier(
            run_id=command.run_id,
            track_id=track_id,
            subscription_tier="FULL",
        )
        await self._pause_ready_full_tracks(command.run_id, command.client_instance_id)
        viewer = await self.store.select_market_track(
            run_id=command.run_id,
            track_id=track_id,
            expected_viewer_revision=expected_viewer_revision,
            command_id=command.command_id,
            command=command.to_dict(),
        )
        target_session_id = str(track["adapter_session_id"])
        target_session = await self.replay_service.get_session(target_session_id)
        target_snapshot = self._snapshot(target_session)
        await self.store.checkpoint_market_tracks(command.run_id)
        return self._result_payload(
            command=command,
            session_id=target_session_id,
            snapshot=target_snapshot,
            viewer=viewer.to_dict(),
            data={
                "selected_track_id": track_id,
                "atomic_switch": True,
                "global_clock_paused": True,
                "ordering_version": GLOBAL_ORDERING_VERSION,
            },
        )

    async def _prepare_market_track(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        track: Mapping[str, object],
        requested_tier: SubscriptionTier,
        target_virtual_time_ms: int,
    ) -> dict[str, object]:
        config_payload = binding.get("adapter_config")
        if not isinstance(config_payload, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training adapter config is invalid",
                status_code=503,
            )
        base_config = ReplaySessionConfig.from_dict(config_payload)
        config = replace(
            base_config,
            symbol=str(track["symbol"]),
            start_policy=StartPolicy.MANUAL,
            requested_start_ms=_stored_counter(
                binding["actual_replay_start_ms"],
                field_name="actual_replay_start_ms",
            ),
            display_interval=base_config.base_interval,
        )
        historical_book_binding = None
        account_history_binding = None
        hedge_track_public_binding = None
        if str(
            binding.get("account_data_mode")
        ) == AccountDataMode.HISTORICAL_EXACT.value and requested_tier in {
            SubscriptionTier.WARM,
            SubscriptionTier.FULL,
        }:
            actual_time_ms = self._actual_event_time_ms(
                binding,
                target_virtual_time_ms,
            )
            account_history_binding = await self.account_history.prepare_track_binding(
                exchange=str(track["exchange"]),
                market_type=str(track["market_type"]),
                symbol=str(track["symbol"]),
                settlement_asset=str(track["settlement_asset"]),
                source_kind=str(track["source_kind"]),
                bound_range_start_ms=_stored_counter(
                    binding["actual_replay_start_ms"],
                    field_name="actual_replay_start_ms",
                ),
                bound_range_end_ms=_stored_counter(
                    binding["actual_replay_end_ms"],
                    field_name="actual_replay_end_ms",
                ),
                actual_time_ms=actual_time_ms,
                virtual_time_ms=target_virtual_time_ms,
                require_funding=(
                    str(binding.get("funding_mode"))
                    == FundingMode.HISTORICAL_EXACT.value
                ),
            )
        if (
            str(binding.get("book_mode")) == BookMode.BOOK_ASSISTED_REQUIRED.value
            and requested_tier is SubscriptionTier.FULL
        ):
            actual_time_ms = self._actual_event_time_ms(
                binding,
                target_virtual_time_ms,
            )
            historical_book_binding = await self.historical_books.prepare_binding(
                exchange=str(track["exchange"]),
                market_type=str(track["market_type"]),
                symbol=str(track["symbol"]),
                range_start_ms=_stored_counter(
                    binding["actual_replay_start_ms"],
                    field_name="actual_replay_start_ms",
                ),
                range_end_ms=_stored_counter(
                    binding["actual_replay_end_ms"],
                    field_name="actual_replay_end_ms",
                ),
                actual_time_ms=actual_time_ms,
                virtual_time_ms=target_virtual_time_ms,
            )
        if (
            str(binding.get("position_mode")) == "HEDGE"
            and requested_tier is SubscriptionTier.FULL
        ):
            actual_time_ms = self._actual_event_time_ms(
                binding,
                target_virtual_time_ms,
            )
            hedge_track_public_binding = (
                await self.hedge_inputs.prepare_track_public_binding(
                    run_id=command.run_id,
                    track_id=str(track["track_id"]),
                    exchange=str(track["exchange"]),
                    market_type=str(track["market_type"]),
                    symbol=str(track["symbol"]),
                    settlement_asset=str(track["settlement_asset"]),
                    bound_range_start_ms=_stored_counter(
                        binding["actual_replay_start_ms"],
                        field_name="actual_replay_start_ms",
                    ),
                    bound_range_end_ms=_stored_counter(
                        binding["actual_replay_end_ms"],
                        field_name="actual_replay_end_ms",
                    ),
                    actual_time_ms=actual_time_ms,
                    virtual_time_ms=target_virtual_time_ms,
                    historical_book_binding=historical_book_binding,
                )
            )
        extension_factory = self.store.attach_market_track_writer(
            run_id=command.run_id,
            track_id=str(track["track_id"]),
            requested_tier=requested_tier.value,
            historical_book_binding=historical_book_binding,
            account_history_binding=account_history_binding,
            hedge_track_public_binding=hedge_track_public_binding,
        )
        try:
            track_catalog = await self.replay_service.catalog(
                warmup_bars=config.warmup_bars,
                horizon_ms=config.horizon_ms,
                quality_mode=config.quality_mode,
                blind_mode=config.blind_mode,
            )
            track_catalog_epoch = str(track_catalog["catalog_epoch"])
            selection = await self.replay_service.select_training_window(
                config,
                expected_catalog_epoch=track_catalog_epoch,
            )
            created = await self.replay_service.create_session(
                config,
                _expected_catalog_epoch=track_catalog_epoch,
                _internal_forced_start_ms=_stored_counter(
                    binding["actual_replay_start_ms"],
                    field_name="actual_replay_start_ms",
                ),
                _internal_expected_source_fingerprint=str(
                    selection["source_fingerprint"]
                ),
                _internal_training_history=True,
                _internal_training_selection=selection,
                _extension_factory=extension_factory,
                _internal_execution_mode=TOUCH_OR_TAPE_EXECUTION_MODE,
            )
        except ReplayDomainError as exc:
            await self.store.mark_market_track_error(
                run_id=command.run_id,
                track_id=str(track["track_id"]),
                reason=exc.code.value,
            )
            raise TrainingRunError(
                "MARKET_TRACK_COVERAGE_UNAVAILABLE",
                "market track lacks qualifying frozen coverage for this TrainingRun",
                status_code=409,
                details={"reason": exc.code.value},
            ) from exc
        session_id = str(created["session_id"])
        snapshot = await self._ensure_track_controller(
            session_id=session_id,
            client_instance_id=command.client_instance_id,
            command_id=command.command_id,
        )
        await self._advance_adapter_to(
            session_id=session_id,
            target_virtual_time_ms=target_virtual_time_ms,
            client_instance_id=command.client_instance_id,
            command_id=command.command_id,
            track_id=str(track["track_id"]),
            initial_snapshot=snapshot,
        )
        if requested_tier is SubscriptionTier.WARM:
            await self.replay_service.release_session_to_hub(session_id)
        return await self.store.get_market_track(command.run_id, str(track["track_id"]))

    async def _execute_market_trade_command(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        snapshot: Mapping[str, object],
    ) -> dict[str, object]:
        expected_fields = {
            ReplayV2CommandType.PLACE_ORDER: {
                "client_order_id",
                "side",
                "order_type",
                "quantity",
                "reduce_only",
                "limit_price",
                "stop_price",
            },
            ReplayV2CommandType.REPLACE_ORDER: {
                "order_id",
                "client_order_id",
                "quantity",
                "limit_price",
                "stop_price",
            },
            ReplayV2CommandType.CANCEL_ORDER: {"order_id"},
            ReplayV2CommandType.CANCEL_ORDERS: {"scope", "order_ids"},
            ReplayV2CommandType.CLOSE_POSITION: {"quantity"},
            ReplayV2CommandType.EXECUTE_POSITION_INTENT: {
                "intent",
                "side",
                "quantity",
            },
            ReplayV2CommandType.SET_POSITION_PROTECTION: {
                "quantity",
                "stop_loss_price",
                "take_profit_price",
            },
            ReplayV2CommandType.SET_POSITION_LEVERAGE: {
                "position_side",
                "leverage",
            },
        }
        v1_types = {
            ReplayV2CommandType.PLACE_ORDER: CommandType.PLACE_ORDER,
            ReplayV2CommandType.REPLACE_ORDER: CommandType.REPLACE_ORDER,
            ReplayV2CommandType.CANCEL_ORDER: CommandType.CANCEL_ORDER,
            ReplayV2CommandType.CANCEL_ORDERS: CommandType.CANCEL_ORDERS,
            ReplayV2CommandType.CLOSE_POSITION: CommandType.CLOSE_POSITION,
            ReplayV2CommandType.EXECUTE_POSITION_INTENT: (
                CommandType.EXECUTE_POSITION_INTENT
            ),
            ReplayV2CommandType.SET_POSITION_PROTECTION: (
                CommandType.SET_POSITION_PROTECTION
            ),
            ReplayV2CommandType.SET_POSITION_LEVERAGE: (
                CommandType.SET_POSITION_LEVERAGE
            ),
        }
        trade_plan_draft: Mapping[str, object] | None = None
        if (
            command.type is ReplayV2CommandType.PLACE_ORDER
            and "trade_plan" in command.payload
        ):
            payload_with_plan = self._order_payload_with_optional_leverage(
                command.payload,
                expected_fields[command.type] | {"trade_plan"},
            )
            raw_trade_plan = payload_with_plan["trade_plan"]
            if not isinstance(raw_trade_plan, Mapping):
                raise TrainingRunError(
                    "TRADE_PLAN_INVALID",
                    "trade_plan must be an object",
                    status_code=422,
                )
            trade_plan_draft = raw_trade_plan
            payload = {
                key: value
                for key, value in payload_with_plan.items()
                if key != "trade_plan"
            }
        elif command.type in {
            ReplayV2CommandType.PLACE_ORDER,
            ReplayV2CommandType.EXECUTE_POSITION_INTENT,
            ReplayV2CommandType.CLOSE_POSITION,
            ReplayV2CommandType.SET_POSITION_PROTECTION,
        }:
            payload = dict(
                self._order_payload_with_optional_leverage(
                    command.payload,
                    expected_fields[command.type],
                )
            )
        elif command.type is ReplayV2CommandType.SET_POSITION_LEVERAGE:
            payload = dict(
                self._exact_payload(command.payload, expected_fields[command.type])
            )
            if payload.get("position_side") not in {"LONG", "SHORT"}:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "position_side must be LONG or SHORT",
                    status_code=422,
                )
            raw_leverage = payload.get("leverage")
            if not isinstance(raw_leverage, str):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "position leverage must be a canonical Decimal string",
                    status_code=422,
                )
            try:
                normalized_leverage = normalize_decimal_string(
                    raw_leverage,
                    field_name="position leverage",
                )
            except (TypeError, ValueError) as exc:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "position leverage is invalid",
                    status_code=422,
                ) from exc
            if normalized_leverage != raw_leverage or Decimal(raw_leverage) < 1:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "position leverage must be canonical and at least 1",
                    status_code=422,
                )
        else:
            payload = dict(
                self._exact_payload(command.payload, expected_fields[command.type])
            )
        projection = await self.store.get_market_tracks(command.run_id)
        tracks = projection.get("tracks")
        if not isinstance(tracks, list):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "market tracks projection is invalid",
                status_code=503,
            )
        selected_track_id = str(binding["selected_track_id"])
        selected = next(
            (
                track
                for track in tracks
                if isinstance(track, Mapping)
                and track.get("track_id") == selected_track_id
            ),
            None,
        )
        if (
            selected is None
            or selected.get("subscription_tier") != "FULL"
            or selected.get("state") != "READY"
        ):
            raise TrainingRunError(
                "MARKET_TRACK_NOT_READY",
                "orders require the selected market track to be READY and FULL",
                status_code=409,
            )
        if command.type is ReplayV2CommandType.SET_POSITION_LEVERAGE:
            if binding.get("position_mode") != "HEDGE":
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "set_position_leverage requires HEDGE mode",
                    status_code=422,
                )
            portfolio = projection.get("portfolio")
            if not isinstance(portfolio, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "run portfolio projection is invalid",
                    status_code=503,
                )
            rule = self._active_instrument_rule(
                portfolio,
                track_id=selected_track_id,
            )
            leverage = Decimal(str(payload["leverage"]))
            if leverage > Decimal(str(rule["max_leverage"])):
                raise TrainingRunError(
                    "RISK_LIMIT_EXCEEDED",
                    "position leverage exceeds the active instrument rule",
                    status_code=409,
                )
            if portfolio.get("margin_mode") == "ISOLATED":
                positions = portfolio.get("positions")
                allocations = portfolio.get("isolated_allocations")
                orders = portfolio.get("orders")
                if (
                    not isinstance(positions, list)
                    or not isinstance(allocations, Mapping)
                    or not isinstance(orders, list)
                ):
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "HEDGE isolated risk projection is invalid",
                        status_code=503,
                    )
                side = str(payload["position_side"])
                risk_position = next(
                    (
                        item
                        for item in positions
                        if isinstance(item, Mapping)
                        and item.get("track_id") == selected_track_id
                        and item.get("position_side") == side
                    ),
                    None,
                )
                notional = Decimal(
                    str(
                        0
                        if not isinstance(risk_position, Mapping)
                        else risk_position.get("account_notional", "0")
                    )
                )
                required = round_to_step(
                    notional / leverage,
                    Decimal(str(rule["quote_step"])),
                    upward=True,
                )
                reserved = sum(
                    (
                        Decimal(str(order.get("reserved_margin", "0")))
                        for order in orders
                        if isinstance(order, Mapping)
                        and order.get("track_id") == selected_track_id
                        and order.get("position_side") == side
                        and order.get("status") in {"OPEN", "PARTIALLY_FILLED"}
                    ),
                    Decimal(0),
                )
                allocation = Decimal(
                    str(
                        allocations.get(
                            isolated_margin_key(selected_track_id, side),
                            "0",
                        )
                    )
                )
                if required + reserved > allocation:
                    raise TrainingRunError(
                        "RUN_ACCOUNT_MARGIN_EXCEEDED",
                        "position leverage change exceeds isolated leg wallet",
                        status_code=409,
                    )
        session_id = str(binding["adapter_session_id"])
        if command.type is ReplayV2CommandType.PLACE_ORDER:
            if trade_plan_draft is not None:
                provisional_plan = self._build_trade_plan_snapshot(
                    draft=trade_plan_draft,
                    payload=payload,
                    selected_track=selected,
                    portfolio=projection.get("portfolio"),
                    entry_price=self._planned_entry_reference(
                        payload=payload,
                        selected_track=selected,
                    ),
                )
                try:
                    raw_plan_preview = await self.replay_service.preview_order(
                        session_id,
                        {**payload, "quantity": provisional_plan["quantity"]},
                    )
                except ReplayDomainError as exc:
                    raise TrainingRunError(
                        exc.code.value,
                        exc.message,
                        status_code=exc.http_status,
                        details=exc.details,
                    ) from exc
                plan_preview = _stored_mapping(
                    raw_plan_preview.get("preview"),
                    field_name="adapter trade-plan preview",
                )
                normalized_plan = self._build_trade_plan_snapshot(
                    draft=trade_plan_draft,
                    payload=payload,
                    selected_track=selected,
                    portfolio=projection.get("portfolio"),
                    entry_price=plan_preview.get("estimated_fill_price"),
                )
                if payload.get("quantity") != normalized_plan["quantity"]:
                    raise TrainingRunError(
                        "TRADE_PLAN_QUANTITY_CHANGED",
                        "planned quantity no longer matches the authoritative cursor",
                        status_code=409,
                        details={
                            "submitted_quantity": payload.get("quantity"),
                            "calculated_quantity": normalized_plan["quantity"],
                        },
                    )
                payload["trade_plan"] = normalized_plan
            self._assert_exact_account_order_filters(
                payload=payload,
                selected_track=selected,
                portfolio=projection.get("portfolio"),
            )
            self._assert_shared_settlement_reservation(
                payload=payload,
                selected_track=selected,
                portfolio=projection.get("portfolio"),
                binding=binding,
            )
        elif command.type is ReplayV2CommandType.REPLACE_ORDER:
            portfolio = projection.get("portfolio")
            if not isinstance(portfolio, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "run portfolio projection is invalid",
                    status_code=503,
                )
            raw_orders = portfolio.get("orders")
            if not isinstance(raw_orders, list):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "active order projection is invalid",
                    status_code=503,
                )
            existing = next(
                (
                    order
                    for order in raw_orders
                    if isinstance(order, Mapping)
                    and order.get("order_id") == payload.get("order_id")
                    and order.get("track_id") == selected_track_id
                    and order.get("status") in {"OPEN", "PARTIALLY_FILLED"}
                ),
                None,
            )
            if not isinstance(existing, Mapping):
                raise TrainingRunError(
                    "ORDER_REJECTED",
                    "replacement requires an open order on the selected track",
                    status_code=409,
                    details={"order_id": payload.get("order_id")},
                )
            replacement_payload = {
                "quantity": payload.get("quantity"),
                "reduce_only": existing.get("reduce_only"),
                "limit_price": payload.get("limit_price"),
                "stop_price": payload.get("stop_price"),
            }
            self._assert_exact_account_order_filters(
                payload=replacement_payload,
                selected_track=selected,
                portfolio=portfolio,
            )
            self._assert_shared_settlement_reservation(
                payload=replacement_payload,
                selected_track=selected,
                portfolio=portfolio,
                binding=binding,
                release_order_reservation=Decimal(
                    str(existing.get("reserved_margin", "0"))
                ),
            )
        elif command.type is ReplayV2CommandType.EXECUTE_POSITION_INTENT:
            intent = payload.get("intent")
            if intent in {"OPEN", "REVERSE"}:
                opening_payload = {
                    "quantity": payload.get("quantity"),
                    "reduce_only": False,
                    "limit_price": None,
                    "stop_price": None,
                    "leverage": payload.get("leverage"),
                    "position_side": payload.get("position_side"),
                }
                self._assert_exact_account_order_filters(
                    payload=opening_payload,
                    selected_track=selected,
                    portfolio=projection.get("portfolio"),
                    replace_position=intent == "REVERSE",
                )
                self._assert_shared_settlement_reservation(
                    payload=opening_payload,
                    selected_track=selected,
                    portfolio=projection.get("portfolio"),
                    binding=binding,
                    release_selected_margin=intent == "REVERSE",
                )
        elif command.type is ReplayV2CommandType.SET_POSITION_PROTECTION:
            position = selected.get("position")
            if (
                isinstance(position, Mapping)
                and position.get("position_mode") == "HEDGE"
            ):
                leg_name = str(payload.get("position_side", "")).lower()
                position = position.get(leg_name)
            raw_quantity = payload.get("quantity")
            if raw_quantity is None and isinstance(position, Mapping):
                try:
                    raw_quantity = normalize_decimal_string(
                        format(abs(Decimal(str(position.get("quantity")))), "f"),
                        field_name="protection quantity",
                    )
                except (InvalidOperation, TypeError, ValueError) as exc:
                    raise TrainingRunError(
                        "REPLAY_CONTROL_INVALID",
                        "position protection quantity is invalid",
                        status_code=422,
                    ) from exc
            for field_name in ("stop_loss_price", "take_profit_price"):
                price = payload.get(field_name)
                if price is None:
                    continue
                self._assert_exact_account_order_filters(
                    payload={
                        "quantity": raw_quantity,
                        "reduce_only": True,
                        "limit_price": None,
                        "stop_price": price,
                    },
                    selected_track=selected,
                    portfolio=projection.get("portfolio"),
                )
        controller_snapshot = await self._ensure_track_controller(
            session_id=session_id,
            client_instance_id=command.client_instance_id,
            command_id=command.command_id,
            known_snapshot=snapshot,
        )
        adapter = ReplayCommand(
            protocol=REPLAY_PROTOCOL,
            command_id=command.command_id,
            client_instance_id=command.client_instance_id,
            expected_revision=_stored_counter(
                controller_snapshot["revision"], field_name="revision"
            ),
            type=v1_types[command.type],
            payload=payload,
        )
        try:
            acknowledged = await self.replay_service.command(session_id, adapter)
        except ReplayDomainError as exc:
            raise TrainingRunError(
                exc.code.value,
                exc.message,
                status_code=exc.http_status,
                details=exc.details,
            ) from exc
        await self.store.finalize_account_history(command.run_id)
        adapter_data = dict(
            _stored_mapping(
                acknowledged.get("data"),
                field_name="adapter_result.data",
            )
        )
        liquidation_count = await self._reconcile_liquidations(
            run_id=command.run_id,
            client_instance_id=command.client_instance_id,
            command_id=command.command_id,
        )
        if liquidation_count:
            acknowledged = self._snapshot(
                await self.replay_service.get_session(session_id)
            )
        checkpoint = await self.store.checkpoint_market_tracks(command.run_id)
        refreshed = await self.store.get_market_tracks(command.run_id)
        viewer = await self.store.get_viewer_state(command.run_id)
        return self._result_payload(
            command=command,
            session_id=session_id,
            snapshot=acknowledged,
            viewer=viewer.to_dict(),
            data={
                **adapter_data,
                "selected_track_id": selected_track_id,
                "portfolio": refreshed["portfolio"],
                "global_checkpoint": checkpoint,
                "account_contract": "TOUCH_OR_TAPE_V2_CONTRACT_ACCOUNT",
                "simulated_account_liquidations": liquidation_count,
            },
        )

    @staticmethod
    def _planned_entry_reference(
        *,
        payload: Mapping[str, object],
        selected_track: Mapping[str, object],
    ) -> object:
        if payload.get("order_type") == "LIMIT":
            return payload.get("limit_price")
        position = selected_track.get("position")
        mark = _position_mark(position, position_side=payload.get("position_side"))
        if mark is not None:
            return mark
        return selected_track.get("public_price")

    @staticmethod
    def _active_instrument_rule(
        portfolio: Mapping[str, object],
        *,
        track_id: str,
    ) -> Mapping[str, object]:
        rules = portfolio.get("instrument_rules")
        if not isinstance(rules, list):
            raise TrainingRunError(
                "TRADE_PLAN_RULE_UNAVAILABLE",
                "trade-plan sizing requires an active instrument rule",
                status_code=409,
            )
        active = next(
            (
                item
                for item in rules
                if isinstance(item, Mapping)
                and item.get("track_id") == track_id
                and isinstance(item.get("rule"), Mapping)
            ),
            None,
        )
        if not isinstance(active, Mapping) or not isinstance(
            active.get("rule"), Mapping
        ):
            raise TrainingRunError(
                "TRADE_PLAN_RULE_UNAVAILABLE",
                "trade-plan sizing requires an active instrument rule",
                status_code=409,
            )
        return cast(Mapping[str, object], active["rule"])

    @classmethod
    def _build_trade_plan_snapshot(
        cls,
        *,
        draft: Mapping[str, object],
        payload: Mapping[str, object],
        selected_track: Mapping[str, object],
        portfolio: object,
        entry_price: object,
    ) -> dict[str, object]:
        expected = {
            "sizing_mode",
            "risk_amount",
            "risk_percent",
            "invalidation_price",
            "target_price",
            "reason",
        }
        if set(draft) != expected:
            raise TrainingRunError(
                "TRADE_PLAN_INVALID",
                "trade-plan fields do not match the contract",
                status_code=422,
                details={
                    "missing": sorted(expected - set(draft)),
                    "unknown": sorted(set(draft) - expected),
                },
            )
        if payload.get("reduce_only") is not False or payload.get("order_type") not in {
            "MARKET",
            "LIMIT",
        }:
            raise TrainingRunError(
                "TRADE_PLAN_INVALID",
                "trade plans require a non-reduce-only market or limit order",
                status_code=422,
            )
        side = payload.get("side")
        if side not in {"BUY", "SELL"}:
            raise TrainingRunError(
                "TRADE_PLAN_INVALID",
                "trade-plan side is invalid",
                status_code=422,
            )
        if not isinstance(portfolio, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "run portfolio projection is invalid",
                status_code=503,
            )

        def decimal_value(value: object, field_name: str) -> Decimal:
            try:
                normalized = normalize_decimal_string(value, field_name=field_name)
                parsed = Decimal(normalized)
            except (InvalidOperation, TypeError, ValueError) as exc:
                raise TrainingRunError(
                    "TRADE_PLAN_INVALID",
                    f"{field_name} is invalid",
                    status_code=422,
                ) from exc
            if parsed <= 0:
                raise TrainingRunError(
                    "TRADE_PLAN_INVALID",
                    f"{field_name} must be positive",
                    status_code=422,
                )
            return parsed

        def decimal_text(value: Decimal, field_name: str) -> str:
            return normalize_decimal_string(format(value, "f"), field_name=field_name)

        entry = decimal_value(entry_price, "trade-plan entry price")
        invalidation = decimal_value(
            draft["invalidation_price"],
            "trade-plan invalidation price",
        )
        target = decimal_value(draft["target_price"], "trade-plan target price")
        if side == "BUY":
            price_sides_valid = invalidation < entry < target
        else:
            price_sides_valid = target < entry < invalidation
        if not price_sides_valid:
            raise TrainingRunError(
                "TRADE_PLAN_PRICE_SIDE_INVALID",
                "invalidation and target prices must bracket entry in the order direction",
                status_code=422,
                details={"side": side, "entry_price": decimal_text(entry, "entry")},
            )
        reason = draft["reason"]
        if not isinstance(reason, str):
            raise TrainingRunError(
                "TRADE_PLAN_INVALID",
                "trade-plan reason must be a string",
                status_code=422,
            )
        normalized_reason = reason.strip()
        if not normalized_reason or len(normalized_reason) > 500:
            raise TrainingRunError(
                "TRADE_PLAN_INVALID",
                "trade-plan reason must contain 1-500 characters",
                status_code=422,
            )
        equity = decimal_value(portfolio.get("equity"), "account equity")
        sizing_mode = draft["sizing_mode"]
        risk_percent: str | None
        if sizing_mode == "RISK_AMOUNT":
            if draft.get("risk_percent") is not None:
                raise TrainingRunError(
                    "TRADE_PLAN_INVALID",
                    "fixed-risk sizing must not include risk_percent",
                    status_code=422,
                )
            risk_budget = decimal_value(draft.get("risk_amount"), "risk amount")
            risk_percent = None
        elif sizing_mode == "ACCOUNT_RISK_PERCENT":
            if draft.get("risk_amount") is not None:
                raise TrainingRunError(
                    "TRADE_PLAN_INVALID",
                    "percentage-risk sizing must not include risk_amount",
                    status_code=422,
                )
            percent = decimal_value(draft.get("risk_percent"), "risk percent")
            if percent > 100:
                raise TrainingRunError(
                    "TRADE_PLAN_INVALID",
                    "risk percent must not exceed 100",
                    status_code=422,
                )
            risk_percent = decimal_text(percent, "risk percent")
            risk_budget = equity * percent / Decimal(100)
        else:
            raise TrainingRunError(
                "TRADE_PLAN_INVALID",
                "trade-plan sizing mode is unsupported",
                status_code=422,
            )
        if risk_budget > equity:
            raise TrainingRunError(
                "TRADE_PLAN_RISK_EXCEEDS_EQUITY",
                "planned maximum loss exceeds current account equity",
                status_code=422,
                details={
                    "risk_amount": decimal_text(risk_budget, "risk amount"),
                    "account_equity": decimal_text(equity, "account equity"),
                },
            )
        track_id = str(selected_track["track_id"])
        rule = cls._active_instrument_rule(portfolio, track_id=track_id)
        contract_size = decimal_value(rule.get("contract_size"), "contract size")
        quantity_step = decimal_value(rule.get("quantity_step"), "quantity step")
        minimum_quantity = decimal_value(rule.get("min_quantity"), "minimum quantity")
        maximum_quantity = decimal_value(rule.get("max_quantity"), "maximum quantity")
        risk_per_unit = abs(entry - invalidation) * contract_size
        raw_quantity = risk_budget / risk_per_unit
        quantity = (raw_quantity / quantity_step).to_integral_value(
            rounding=ROUND_FLOOR
        ) * quantity_step
        quantity = min(quantity, maximum_quantity)
        if quantity < minimum_quantity or quantity <= 0:
            raise TrainingRunError(
                "TRADE_PLAN_SIZE_BELOW_MINIMUM",
                "risk budget is too small for the active minimum quantity",
                status_code=422,
                details={
                    "minimum_quantity": decimal_text(
                        minimum_quantity, "minimum quantity"
                    ),
                    "quantity_step": decimal_text(quantity_step, "quantity step"),
                },
            )
        position = _position_leg(
            selected_track.get("position"),
            position_side=payload.get("position_side"),
        )
        if position is not None:
            try:
                position_quantity = Decimal(str(position.get("quantity", "0")))
            except InvalidOperation as exc:
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "selected position quantity is invalid",
                    status_code=503,
                ) from exc
            if position_quantity != 0 and (position_quantity > 0) != (side == "BUY"):
                raise TrainingRunError(
                    "TRADE_PLAN_REVERSE_REQUIRES_EXPLICIT_ACTION",
                    "a trade plan cannot implicitly reduce or reverse the current position",
                    status_code=409,
                )
        reward_risk_ratio = abs(target - entry) * contract_size / risk_per_unit
        return {
            "schema_version": "replay.trade-plan.snapshot.v1",
            "track_id": track_id,
            "client_order_id": str(payload["client_order_id"]),
            "side": side,
            "order_type": str(payload["order_type"]),
            "sizing_mode": sizing_mode,
            "risk_amount": decimal_text(risk_budget, "risk amount"),
            "risk_percent": risk_percent,
            "account_equity": decimal_text(equity, "account equity"),
            "entry_price": decimal_text(entry, "entry price"),
            "invalidation_price": decimal_text(invalidation, "invalidation price"),
            "target_price": decimal_text(target, "target price"),
            "risk_per_unit": decimal_text(risk_per_unit, "risk per unit"),
            "reward_risk_ratio": decimal_text(reward_risk_ratio, "reward risk ratio"),
            "quantity": decimal_text(quantity, "planned quantity"),
            "reason": normalized_reason,
        }

    @staticmethod
    def _assert_exact_account_order_filters(
        *,
        payload: Mapping[str, object],
        selected_track: Mapping[str, object],
        portfolio: object,
        replace_position: bool = False,
    ) -> None:
        if not isinstance(portfolio, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "run portfolio projection is invalid",
                status_code=503,
            )
        history = portfolio.get("account_history")
        if (
            not isinstance(history, Mapping)
            or history.get("mode") != "HISTORICAL_EXACT"
        ):
            return
        if history.get("status") != "ACTIVE":
            raise TrainingRunError(
                "ACCOUNT_HISTORY_ARCHIVE_DEGRADED",
                "exact account inputs are not active",
                status_code=409,
                details={"fallback_applied": False},
            )
        raw_rules = portfolio.get("instrument_rules")
        if not isinstance(raw_rules, list):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "exact instrument-rule projection is invalid",
                status_code=503,
            )
        selected_id = str(selected_track["track_id"])
        active = next(
            (
                item
                for item in raw_rules
                if isinstance(item, Mapping) and item.get("track_id") == selected_id
            ),
            None,
        )
        if not isinstance(active, Mapping) or not isinstance(
            active.get("rule"), Mapping
        ):
            raise TrainingRunError(
                "ACCOUNT_HISTORY_RULE_MISSING",
                "selected exact account track has no active historical rule",
                status_code=409,
                details={"fallback_applied": False},
            )
        rule = active["rule"]
        assert isinstance(rule, Mapping)
        try:
            quantity = Decimal(str(payload["quantity"]))
            step = Decimal(str(rule["quantity_step"]))
            minimum = Decimal(str(rule["min_quantity"]))
            maximum = Decimal(str(rule["max_quantity"]))
            if quantity < minimum or quantity > maximum or quantity % step != 0:
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_QUANTITY_FILTER",
                    "order quantity violates the active historical exchange rule",
                    status_code=422,
                    details={
                        "rule_revision": active.get("revision"),
                        "min_quantity": str(minimum),
                        "max_quantity": str(maximum),
                        "quantity_step": str(step),
                    },
                )
            for field_name in ("limit_price", "stop_price"):
                raw = payload.get(field_name)
                if raw is None:
                    continue
                price = Decimal(str(raw))
                tick = Decimal(str(rule["price_tick"]))
                if price <= 0 or price % tick != 0:
                    raise TrainingRunError(
                        "ACCOUNT_HISTORY_PRICE_FILTER",
                        f"{field_name} violates the active historical price tick",
                        status_code=422,
                        details={
                            "rule_revision": active.get("revision"),
                            "price_tick": str(tick),
                        },
                    )
            position = selected_track.get("position")
            if not isinstance(position, Mapping):
                raise TypeError("selected exact position is invalid")
            reference = (
                payload.get("limit_price")
                or payload.get("stop_price")
                or position.get("mark_price")
            )
            price = Decimal(str(reference))
            contract_size = Decimal(str(rule["contract_size"]))
            notional = quantity * price * contract_size
            if payload.get("reduce_only") is not True:
                minimum_notional = Decimal(str(rule["min_notional"]))
                maximum_notional = Decimal(str(rule["max_notional"]))
                existing_notional = (
                    Decimal(0)
                    if replace_position
                    else Decimal(str(position.get("notional", "0")))
                )
                if (
                    notional < minimum_notional
                    or notional > maximum_notional
                    or existing_notional + notional > maximum_notional
                ):
                    raise TrainingRunError(
                        "ACCOUNT_HISTORY_NOTIONAL_FILTER",
                        "order notional violates the active historical exchange rule",
                        status_code=422,
                        details={
                            "rule_revision": active.get("revision"),
                            "min_notional": str(minimum_notional),
                            "max_notional": str(maximum_notional),
                            "order_notional": str(notional),
                        },
                    )
        except TrainingRunError:
            raise
        except (InvalidOperation, KeyError, TypeError, ZeroDivisionError) as exc:
            raise TrainingRunError(
                "ACCOUNT_HISTORY_RULE_INVALID",
                "active historical order filters are invalid",
                status_code=409,
                details={"fallback_applied": False},
            ) from exc

    @staticmethod
    def _assert_exact_account_capacity_context(
        *,
        payload: Mapping[str, object],
        selected_track: Mapping[str, object],
        portfolio: object,
    ) -> None:
        """Validate quantity-independent historical price rules."""

        if not isinstance(portfolio, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "run portfolio projection is invalid",
                status_code=503,
            )
        history = portfolio.get("account_history")
        if (
            not isinstance(history, Mapping)
            or history.get("mode") != "HISTORICAL_EXACT"
        ):
            return
        if history.get("status") != "ACTIVE":
            raise TrainingRunError(
                "ACCOUNT_HISTORY_ARCHIVE_DEGRADED",
                "exact account inputs are not active",
                status_code=409,
                details={"fallback_applied": False},
            )
        rule = TrainingRunService._active_instrument_rule(
            portfolio,
            track_id=str(selected_track["track_id"]),
        )
        try:
            tick = Decimal(str(rule["price_tick"]))
            for field_name in ("limit_price", "stop_price"):
                raw = payload.get(field_name)
                if raw is None:
                    continue
                price = Decimal(str(raw))
                if price <= 0 or price % tick != 0:
                    raise TrainingRunError(
                        "ACCOUNT_HISTORY_PRICE_FILTER",
                        f"{field_name} violates the active historical price tick",
                        status_code=422,
                        details={"price_tick": str(tick)},
                    )
        except TrainingRunError:
            raise
        except (InvalidOperation, KeyError, TypeError) as exc:
            raise TrainingRunError(
                "ACCOUNT_HISTORY_RULE_INVALID",
                "active historical capacity filters are invalid",
                status_code=409,
                details={"fallback_applied": False},
            ) from exc

    @staticmethod
    def _shared_order_capacity_quantity(
        *,
        adapter_max_quantity: object,
        reference_price: object,
        payload: Mapping[str, object],
        selected_track: Mapping[str, object],
        portfolio: object,
        binding: Mapping[str, object],
    ) -> str:
        """Clamp adapter capacity to shared-account and historical-rule limits."""

        if not isinstance(portfolio, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "run portfolio projection is invalid",
                status_code=503,
            )
        config = binding.get("adapter_config")
        if not isinstance(config, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training adapter config is invalid",
                status_code=503,
            )
        try:
            maximum = Decimal(str(adapter_max_quantity))
            price = Decimal(str(reference_price))
            if payload.get("reduce_only") is True:
                return decimal_to_string(maximum, field_name="max_quantity")
            raw_leverage = payload.get("leverage")
            leverage = Decimal(str(raw_leverage or config["max_leverage"]))
            track_id = str(selected_track["track_id"])
            if binding.get("position_mode") == "HEDGE":
                active_leg_leverage = _hedge_leg_leverage(
                    portfolio,
                    track_id=track_id,
                    position_side=payload.get("position_side"),
                )
                if raw_leverage is None and active_leg_leverage is not None:
                    leverage = active_leg_leverage
                active_position = _portfolio_risk_position(
                    portfolio,
                    track_id=track_id,
                    position_side=payload.get("position_side"),
                )
                if (
                    raw_leverage is not None
                    and active_position is not None
                    and active_leg_leverage is not None
                    and leverage != active_leg_leverage
                ):
                    raise TrainingRunError(
                        "RISK_LIMIT_EXCEEDED",
                        "opening order leverage differs from the active hedge leg",
                        status_code=409,
                    )
            configured_max = Decimal(str(config["max_leverage"]))
            if leverage < 1 or leverage > configured_max:
                raise TrainingRunError(
                    "RISK_LIMIT_EXCEEDED",
                    "order leverage is outside the session limit",
                    status_code=409,
                )
            contract_size = Decimal(1)
            quantity_step: Decimal | None = None
            minimum_quantity = Decimal(0)
            minimum_notional = Decimal(0)
            rules = portfolio.get("instrument_rules")
            active = (
                next(
                    (
                        item
                        for item in rules
                        if isinstance(rules, list)
                        and isinstance(item, Mapping)
                        and item.get("track_id") == selected_track.get("track_id")
                        and isinstance(item.get("rule"), Mapping)
                    ),
                    None,
                )
                if isinstance(rules, list)
                else None
            )
            if isinstance(active, Mapping):
                rule = cast(Mapping[str, object], active["rule"])
                contract_size = Decimal(str(rule.get("contract_size", "1")))
                rule_max_leverage = Decimal(str(rule.get("max_leverage", leverage)))
                if (
                    leverage > rule_max_leverage
                    and raw_leverage is None
                    and binding.get("position_mode") != "HEDGE"
                ):
                    leverage = rule_max_leverage
                elif leverage > rule_max_leverage:
                    raise TrainingRunError(
                        "RISK_LIMIT_EXCEEDED",
                        "order leverage exceeds the active instrument rule",
                        status_code=409,
                    )
                quantity_step = Decimal(str(rule["quantity_step"]))
                minimum_quantity = Decimal(str(rule["min_quantity"]))
                minimum_notional = Decimal(str(rule["min_notional"]))
                maximum = min(maximum, Decimal(str(rule["max_quantity"])))
                position = selected_track.get("position")
                if not isinstance(position, Mapping):
                    raise TypeError("selected position projection is invalid")
                remaining_notional = max(
                    Decimal(0),
                    Decimal(str(rule["max_notional"]))
                    - _position_gross_notional(position),
                )
                maximum = min(maximum, remaining_notional / (price * contract_size))
            if portfolio.get("margin_mode") == "ISOLATED":
                allocations = portfolio.get("isolated_allocations")
                account = selected_track.get("account")
                if not isinstance(allocations, Mapping) or not isinstance(
                    account, Mapping
                ):
                    raise TypeError("isolated account projection is invalid")
                position_side = payload.get("position_side")
                allocation_key = isolated_margin_key(
                    track_id,
                    None if position_side is None else str(position_side),
                )
                allocated = Decimal(str(allocations.get(allocation_key, "0")))
                if binding.get("position_mode") == "HEDGE":
                    positions = portfolio.get("positions")
                    orders = portfolio.get("orders")
                    if not isinstance(positions, list) or not isinstance(orders, list):
                        raise TypeError("HEDGE isolated risk projection is invalid")
                    risk_position = next(
                        (
                            item
                            for item in positions
                            if isinstance(item, Mapping)
                            and item.get("track_id") == track_id
                            and item.get("position_side") == position_side
                        ),
                        None,
                    )
                    in_use = Decimal(
                        str(
                            0
                            if not isinstance(risk_position, Mapping)
                            else risk_position.get("initial_margin", "0")
                        )
                    ) + sum(
                        (
                            Decimal(str(order.get("reserved_margin", "0")))
                            for order in orders
                            if isinstance(order, Mapping)
                            and order.get("track_id") == track_id
                            and order.get("position_side") == position_side
                            and order.get("status") in {"OPEN", "PARTIALLY_FILLED"}
                        ),
                        Decimal(0),
                    )
                else:
                    in_use = Decimal(str(account.get("margin_used", "0"))) + Decimal(
                        str(account.get("reserved_margin", "0"))
                    )
                available = allocated - in_use
                if allocated <= 0:
                    available = Decimal(0)
            else:
                available = Decimal(str(portfolio["available_equity"]))
            shared_maximum = (
                max(Decimal(0), available) * leverage / (price * contract_size)
            )
            maximum = min(maximum, shared_maximum)
            if quantity_step is not None:
                maximum = (maximum / quantity_step).to_integral_value(
                    rounding=ROUND_FLOOR
                ) * quantity_step
            maximum = max(Decimal(0), maximum)
            if (
                maximum < minimum_quantity
                or maximum * price * contract_size < minimum_notional
            ):
                maximum = Decimal(0)
            return decimal_to_string(maximum, field_name="max_quantity")
        except TrainingRunError:
            raise
        except (InvalidOperation, KeyError, TypeError, ZeroDivisionError) as exc:
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "order capacity cannot be valued against the shared settlement account",
                status_code=422,
            ) from exc

    async def _reconcile_liquidations(
        self,
        *,
        run_id: str,
        client_instance_id: str,
        command_id: str,
        pending: Sequence[Mapping[str, object]] | None = None,
    ) -> int:
        pending_events = tuple(pending) if pending is not None else ()
        completed_case_ids: set[str] = set()
        for iteration in range(256):
            events = (
                pending_events
                if iteration == 0 and pending_events
                else await self.store.pending_liquidations(run_id)
            )
            if not events:
                return len(completed_case_ids)
            progressed = False
            for event in events:
                liquidation_id = str(event["liquidation_id"])
                pending_step = event.get("pending_step")
                if not isinstance(pending_step, Mapping):
                    raise TrainingRunError(
                        "LIQUIDATION_EXECUTION_FAILED",
                        "liquidation case lost its durable pending step",
                        status_code=409,
                    )
                step_sequence = _stored_counter(
                    pending_step.get("step_sequence"),
                    field_name="liquidation step sequence",
                )
                step_type = str(pending_step.get("step_type"))
                plan = pending_step.get("plan")
                if not isinstance(plan, Mapping):
                    raise TrainingRunError(
                        "LIQUIDATION_EXECUTION_FAILED",
                        "liquidation step lost its immutable action plan",
                        status_code=409,
                    )
                try:
                    if step_type == "CANCEL_ORDERS":
                        canceled: list[dict[str, object]] = []
                        planned_orders = plan.get("orders")
                        if not isinstance(planned_orders, list):
                            raise TrainingRunError(
                                "LIQUIDATION_EXECUTION_FAILED",
                                "liquidation cancellation plan is invalid",
                                status_code=409,
                            )
                        track_by_id = {
                            str(track["track_id"]): track
                            for track in event.get("tracks", [])
                            if isinstance(track, Mapping)
                        }
                        for raw in planned_orders:
                            if not isinstance(raw, Mapping):
                                raise TrainingRunError(
                                    "LIQUIDATION_EXECUTION_FAILED",
                                    "liquidation cancellation target is invalid",
                                    status_code=409,
                                )
                            track_id = str(raw["track_id"])
                            order_id = str(raw["order_id"])
                            track = track_by_id.get(track_id)
                            session_id = (
                                track.get("adapter_session_id")
                                if track is not None
                                else None
                            )
                            if not isinstance(session_id, str):
                                raise TrainingRunError(
                                    "LIQUIDATION_EXECUTION_FAILED",
                                    "liquidation cancellation lost its market adapter",
                                    status_code=409,
                                )
                            await self._ensure_track_controller(
                                session_id=session_id,
                                client_instance_id=client_instance_id,
                                command_id=command_id,
                            )
                            session = await self.replay_service.get_session(session_id)
                            snapshot = self._snapshot(session)
                            cancel = ReplayCommand(
                                protocol=REPLAY_PROTOCOL,
                                command_id=self._multi_command_id(
                                    liquidation_id,
                                    track_id,
                                    f"step-{step_sequence}-cancel-{order_id}",
                                    0,
                                ),
                                client_instance_id=client_instance_id,
                                expected_revision=_stored_counter(
                                    snapshot["revision"], field_name="revision"
                                ),
                                type=CommandType.CANCEL_ORDER,
                                payload={"order_id": order_id},
                            )
                            cancel = await self._resume_durable_liquidation_command(
                                session_id=session_id,
                                proposed=cancel,
                            )
                            await self.replay_service.command(session_id, cancel)
                            canceled.append(
                                {"track_id": track_id, "order_id": order_id}
                            )
                        await self.store.commit_liquidation_cancellation(
                            run_id=run_id,
                            liquidation_id=liquidation_id,
                            step_sequence=step_sequence,
                            canceled_orders=canceled,
                        )
                    elif step_type == "RISK_RECHECK":
                        await self.store.commit_liquidation_recheck(
                            run_id=run_id,
                            liquidation_id=liquidation_id,
                            step_sequence=step_sequence,
                        )
                    elif step_type in {"PARTIAL_LIQUIDATION", "FULL_LIQUIDATION"}:
                        session_id = plan.get("adapter_session_id")
                        if not isinstance(session_id, str):
                            raise TrainingRunError(
                                "LIQUIDATION_EXECUTION_FAILED",
                                "liquidation execution lost its market adapter",
                                status_code=409,
                            )
                        await self._ensure_track_controller(
                            session_id=session_id,
                            client_instance_id=client_instance_id,
                            command_id=command_id,
                        )
                        session = await self.replay_service.get_session(session_id)
                        snapshot = self._snapshot(session)
                        hedge_execution = plan.get("position_mode") == "HEDGE"
                        book_execution = plan.get("book_execution")
                        if hedge_execution and not isinstance(book_execution, Mapping):
                            raise TrainingRunError(
                                "HISTORICAL_BOOK_EXECUTION_UNAVAILABLE",
                                "HEDGE liquidation lost its frozen historical L2 plan",
                                status_code=409,
                            )
                        close = ReplayCommand(
                            protocol=REPLAY_PROTOCOL,
                            command_id=self._multi_command_id(
                                liquidation_id,
                                str(plan["track_id"]),
                                f"step-{step_sequence}-close-{plan['position_side']}",
                                0,
                            ),
                            client_instance_id=client_instance_id,
                            expected_revision=_stored_counter(
                                snapshot["revision"], field_name="revision"
                            ),
                            type=(
                                InternalCommandType.EXECUTE_HISTORICAL_BOOK_CLOSE
                                if hedge_execution
                                else CommandType.CLOSE_POSITION
                            ),
                            payload=(
                                {
                                    "position_side": str(plan["position_side"]),
                                    "side": str(plan["side"]),
                                    "quantity": str(plan["quantity"]),
                                    "levels": list(book_execution["levels"]),
                                    "book_hash": str(book_execution["book_hash"]),
                                    "last_update_id": _stored_counter(
                                        book_execution["last_update_id"],
                                        field_name="historical book last_update_id",
                                    ),
                                    "execution_fidelity": str(
                                        book_execution["execution_fidelity"]
                                    ),
                                    "queue_exact": False,
                                }
                                if isinstance(book_execution, Mapping)
                                else {"quantity": str(plan["quantity"])}
                            ),
                        )
                        close = await self._resume_durable_liquidation_command(
                            session_id=session_id,
                            proposed=close,
                        )
                        closed = await self.replay_service.command(
                            session_id,
                            close,
                            _training_internal=hedge_execution,
                        )
                        data = _stored_mapping(
                            closed.get("data"), field_name="liquidation close data"
                        )
                        orders = data.get("orders")
                        if (
                            not isinstance(orders, list)
                            or not orders
                            or not isinstance(orders[0], Mapping)
                            or not isinstance(orders[0].get("order_id"), str)
                        ):
                            raise TrainingRunError(
                                "LIQUIDATION_EXECUTION_FAILED",
                                "liquidation close order projection is missing",
                                status_code=409,
                            )
                        await self.store.commit_liquidation_execution(
                            run_id=run_id,
                            liquidation_id=liquidation_id,
                            step_sequence=step_sequence,
                            order_id=str(orders[0]["order_id"]),
                        )
                    elif step_type == "BANKRUPTCY_TRANSFER":
                        await self.store.commit_liquidation_bankruptcy(
                            run_id=run_id,
                            liquidation_id=liquidation_id,
                            step_sequence=step_sequence,
                        )
                    elif step_type == "INSURANCE_FUND_SETTLEMENT":
                        await self.store.commit_liquidation_insurance(
                            run_id=run_id,
                            liquidation_id=liquidation_id,
                            step_sequence=step_sequence,
                        )
                    elif step_type == "ADL":
                        await self.store.commit_liquidation_adl(
                            run_id=run_id,
                            liquidation_id=liquidation_id,
                            step_sequence=step_sequence,
                        )
                    elif step_type == "COMPLETE":
                        await self.store.commit_liquidation_complete(
                            run_id=run_id,
                            liquidation_id=liquidation_id,
                            step_sequence=step_sequence,
                        )
                        completed_case_ids.add(liquidation_id)
                    elif step_type == "FAILED_CLOSED":
                        raise TrainingRunError(
                            str(
                                plan.get("failure_code", "LIQUIDATION_EXECUTION_FAILED")
                            ),
                            "liquidation continuation failed closed before a fallback execution",
                            status_code=409,
                        )
                    else:
                        raise TrainingRunError(
                            "LIQUIDATION_EXECUTION_FAILED",
                            "liquidation durable step type is unsupported",
                            status_code=409,
                            details={"step_type": step_type},
                        )
                    progressed = True
                except (
                    ReplayDomainError,
                    TrainingRunError,
                    KeyError,
                    TypeError,
                    ValueError,
                ) as exc:
                    failure_code = (
                        exc.code.value
                        if isinstance(exc, ReplayDomainError)
                        else exc.code
                        if isinstance(exc, TrainingRunError)
                        else type(exc).__name__
                    )
                    await self.store.fail_liquidation_case(
                        run_id=run_id,
                        liquidation_id=liquidation_id,
                        failure_code=str(failure_code),
                    )
                    raise TrainingRunError(
                        "LIQUIDATION_EXECUTION_FAILED",
                        "simulated account liquidation failed closed",
                        status_code=409,
                        details={
                            "liquidation_id": liquidation_id,
                            "reason": failure_code,
                        },
                    ) from exc
            if not progressed:
                break
        raise TrainingRunError(
            "LIQUIDATION_EXECUTION_FAILED",
            "liquidation state machine exceeded its deterministic step budget",
            status_code=409,
        )

    async def _resume_durable_liquidation_command(
        self,
        *,
        session_id: str,
        proposed: ReplayCommand,
    ) -> ReplayCommand:
        """Reuse the exact durable broker envelope after response/process loss."""

        stored = await self.replay_service.store.get_command(
            session_id,
            proposed.command_id,
        )
        if stored is None:
            return proposed
        try:
            durable = ReplayCommand.from_persisted_dict(stored.command)
        except (KeyError, TypeError, ValueError) as exc:
            raise TrainingRunError(
                "LIQUIDATION_COMMAND_EVIDENCE_INVALID",
                "durable liquidation command envelope is invalid",
                status_code=503,
            ) from exc
        proposed_payload = proposed.to_dict()
        durable_payload = durable.to_dict()
        for field in ("protocol", "command_id", "type", "payload"):
            if durable_payload[field] != proposed_payload[field]:
                raise TrainingRunError(
                    "LIQUIDATION_COMMAND_CONFLICT",
                    "durable liquidation command no longer matches its immutable plan",
                    status_code=409,
                    details={"field": field, "command_id": proposed.command_id},
                )
        return durable

    @staticmethod
    def _assert_shared_settlement_reservation(
        *,
        payload: Mapping[str, object],
        selected_track: Mapping[str, object],
        portfolio: object,
        binding: Mapping[str, object],
        release_selected_margin: bool = False,
        release_order_reservation: Decimal = Decimal(0),
    ) -> None:
        if payload.get("reduce_only") is True:
            return
        if not isinstance(portfolio, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "run portfolio projection is invalid",
                status_code=503,
            )
        config = binding.get("adapter_config")
        if not isinstance(config, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training adapter config is invalid",
                status_code=503,
            )
        price_value = payload.get("limit_price") or payload.get("stop_price")
        if price_value is None:
            position = selected_track.get("position")
            price_value = _position_mark(
                position,
                position_side=payload.get("position_side"),
            )
            if price_value is None:
                price_value = selected_track.get("public_price")
        try:
            quantity = Decimal(str(payload["quantity"]))
            price = Decimal(str(price_value))
            max_leverage = Decimal(str(config["max_leverage"]))
            leverage = max_leverage
            raw_leverage = payload.get("leverage")
            if raw_leverage is not None:
                leverage = Decimal(str(raw_leverage))
                if leverage < 1 or leverage > max_leverage:
                    raise TrainingRunError(
                        "RISK_LIMIT_EXCEEDED",
                        "order leverage must be between 1 and session max_leverage",
                        status_code=409,
                    )
            track_id = str(selected_track["track_id"])
            if binding.get("position_mode") == "HEDGE":
                active_leg_leverage = _hedge_leg_leverage(
                    portfolio,
                    track_id=track_id,
                    position_side=payload.get("position_side"),
                )
                if raw_leverage is None and active_leg_leverage is not None:
                    leverage = active_leg_leverage
                active_position = _portfolio_risk_position(
                    portfolio,
                    track_id=track_id,
                    position_side=payload.get("position_side"),
                )
                if (
                    raw_leverage is not None
                    and active_position is not None
                    and active_leg_leverage is not None
                    and leverage != active_leg_leverage
                ):
                    raise TrainingRunError(
                        "RISK_LIMIT_EXCEEDED",
                        "opening order leverage differs from the active hedge leg",
                        status_code=409,
                    )
            contract_size = Decimal(1)
            quote_step = Decimal("0.00000001")
            rules = portfolio.get("instrument_rules")
            active = next(
                (
                    item
                    for item in rules
                    if isinstance(rules, list)
                    and isinstance(item, Mapping)
                    and item.get("track_id") == selected_track.get("track_id")
                    and isinstance(item.get("rule"), Mapping)
                ),
                None,
            )
            if isinstance(active, Mapping):
                active_rule = cast(Mapping[str, object], active["rule"])
                contract_size = Decimal(str(active_rule.get("contract_size", "1")))
                quote_step = Decimal(str(active_rule.get("quote_step", quote_step)))
                rule_max_leverage = Decimal(
                    str(active_rule.get("max_leverage", leverage))
                )
                if (
                    leverage > rule_max_leverage
                    and raw_leverage is None
                    and binding.get("position_mode") != "HEDGE"
                ):
                    leverage = rule_max_leverage
                elif leverage > rule_max_leverage:
                    raise TrainingRunError(
                        "RISK_LIMIT_EXCEEDED",
                        "order leverage exceeds the active instrument rule",
                        status_code=409,
                    )
            history = portfolio.get("account_history")
            if (
                isinstance(history, Mapping)
                and history.get("mode") == "HISTORICAL_EXACT"
            ):
                rules = portfolio.get("instrument_rules")
                if not isinstance(rules, list):
                    raise TypeError("exact instrument rules are missing")
                active = next(
                    (
                        item
                        for item in rules
                        if isinstance(item, Mapping)
                        and item.get("track_id") == selected_track.get("track_id")
                    ),
                    None,
                )
                if not isinstance(active, Mapping) or not isinstance(
                    active.get("rule"), Mapping
                ):
                    raise TypeError("exact active instrument rule is missing")
                exact_rule = active["rule"]
                assert isinstance(exact_rule, Mapping)
                contract_size = Decimal(str(exact_rule["contract_size"]))
                quote_step = Decimal(str(exact_rule["quote_step"]))
                exact_rule_max = Decimal(str(exact_rule["max_leverage"]))
                if (
                    leverage > exact_rule_max
                    and raw_leverage is None
                    and binding.get("position_mode") != "HEDGE"
                ):
                    leverage = exact_rule_max
                elif leverage > exact_rule_max:
                    raise TrainingRunError(
                        "RISK_LIMIT_EXCEEDED",
                        "order leverage exceeds the active historical rule",
                        status_code=409,
                    )
            if portfolio.get("margin_mode") == "ISOLATED":
                allocations = portfolio.get("isolated_allocations")
                track_account = selected_track.get("account")
                if not isinstance(allocations, Mapping) or not isinstance(
                    track_account,
                    Mapping,
                ):
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "isolated account projection is invalid",
                        status_code=503,
                    )
                position_side = payload.get("position_side")
                allocation_key = isolated_margin_key(
                    track_id,
                    None if position_side is None else str(position_side),
                )
                allocated = Decimal(str(allocations.get(allocation_key, "0")))
                if binding.get("position_mode") == "HEDGE":
                    positions = portfolio.get("positions")
                    orders = portfolio.get("orders")
                    if not isinstance(positions, list) or not isinstance(orders, list):
                        raise TypeError("HEDGE isolated risk projection is invalid")
                    risk_position = next(
                        (
                            item
                            for item in positions
                            if isinstance(item, Mapping)
                            and item.get("track_id") == track_id
                            and item.get("position_side") == position_side
                        ),
                        None,
                    )
                    position_margin = Decimal(
                        str(
                            0
                            if not isinstance(risk_position, Mapping)
                            else risk_position.get("initial_margin", "0")
                        )
                    )
                    order_margin = sum(
                        (
                            Decimal(str(order.get("reserved_margin", "0")))
                            for order in orders
                            if isinstance(order, Mapping)
                            and order.get("track_id") == track_id
                            and order.get("position_side") == position_side
                            and order.get("status") in {"OPEN", "PARTIALLY_FILLED"}
                        ),
                        Decimal(0),
                    )
                    in_use = position_margin + order_margin
                else:
                    position_margin = Decimal(
                        str(track_account.get("margin_used", "0"))
                    )
                    in_use = position_margin + Decimal(
                        str(track_account.get("reserved_margin", "0"))
                    )
                available = allocated - in_use
                if release_selected_margin:
                    available += position_margin
                available += release_order_reservation
                if allocated <= 0:
                    raise TrainingRunError(
                        "ISOLATED_MARGIN_REQUIRED",
                        "allocate isolated margin before placing an opening order",
                        status_code=409,
                        details={"track_id": track_id},
                    )
            else:
                available = Decimal(str(portfolio["available_equity"]))
                if release_selected_margin:
                    track_account = selected_track.get("account")
                    if not isinstance(track_account, Mapping):
                        raise TypeError("selected track account is invalid")
                    available += Decimal(str(track_account.get("margin_used", "0")))
                available += release_order_reservation
            reservation = round_to_step(
                quantity * price * contract_size / leverage,
                quote_step,
                upward=True,
            )
        except (InvalidOperation, KeyError, TypeError, ZeroDivisionError) as exc:
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "order cannot be valued against the shared settlement account",
                status_code=422,
            ) from exc
        if quantity <= 0 or price <= 0 or leverage <= 0:
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "order reservation inputs must be positive",
                status_code=422,
            )
        if reservation > available:
            raise TrainingRunError(
                "RUN_ACCOUNT_MARGIN_EXCEEDED",
                "order exceeds the TrainingRun shared available equity",
                status_code=409,
                details={
                    "required_reservation": str(reservation),
                    "available_equity": str(available),
                },
            )

    async def _activate_existing_track(
        self,
        *,
        command: ReplayV2Command,
        track: Mapping[str, object],
        target_virtual_time_ms: int,
    ) -> None:
        session_id = track.get("adapter_session_id")
        if not isinstance(session_id, str):
            raise TrainingRunError(
                "MARKET_TRACK_NOT_PREPARED",
                "market track has no frozen adapter session",
                status_code=409,
            )
        snapshot = await self._ensure_track_controller(
            session_id=session_id,
            client_instance_id=command.client_instance_id,
            command_id=command.command_id,
        )
        await self._advance_adapter_to(
            session_id=session_id,
            target_virtual_time_ms=target_virtual_time_ms,
            client_instance_id=command.client_instance_id,
            command_id=command.command_id,
            track_id=str(track["track_id"]),
            initial_snapshot=snapshot,
        )

    async def _execute_multi_track_control(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        selected_snapshot: Mapping[str, object],
        tracks: list[Mapping[str, object]],
    ) -> dict[str, object]:
        ordered = tuple(
            sorted(
                tracks,
                key=lambda track: (
                    _stored_counter(
                        track["stable_ordinal"], field_name="stable_ordinal"
                    ),
                    str(track["track_id"]),
                ),
            )
        )
        selected_session_id = str(binding["adapter_session_id"])
        actor = self._run_actors.setdefault(
            command.run_id,
            TrainingRunActor(command.run_id),
        )
        if command.type is ReplayV2CommandType.END:
            return await self._end_multi_track_run(
                command=command,
                tracks=ordered,
                selected_session_id=selected_session_id,
            )
        direct_types = {
            ReplayV2CommandType.ACQUIRE_CONTROLLER,
            ReplayV2CommandType.TAKEOVER_CONTROLLER,
            ReplayV2CommandType.RELEASE_CONTROLLER,
            ReplayV2CommandType.PLAY,
            ReplayV2CommandType.PAUSE,
            ReplayV2CommandType.SET_SPEED,
        }
        if command.type in direct_types:
            if command.type is ReplayV2CommandType.PLAY:
                if actor.playback_is_active():
                    raise TrainingRunError(
                        "REPLAY_CONTROL_INVALID",
                        "ordered playback is already running",
                        status_code=409,
                    )
                (
                    basis,
                    rate,
                    display_interval,
                    viewer_revision,
                    legacy_profile,
                ) = await self._playback_profile(
                    command=command,
                    binding=binding,
                    selected_snapshot=selected_snapshot,
                    full_track_count=len(ordered),
                    actor=actor,
                )
                for track in ordered:
                    await self._ensure_track_controller(
                        session_id=self._track_session_id(track),
                        client_instance_id=command.client_instance_id,
                        command_id=command.command_id,
                    )
                    session = await self.replay_service.get_session(
                        self._track_session_id(track)
                    )
                    snapshot = self._snapshot(session)
                    if snapshot["state"] != "PAUSED":
                        raise TrainingRunError(
                            "REPLAY_CONTROL_INVALID",
                            "all FULL market tracks must be paused before playback",
                            status_code=409,
                            details={"track_id": track["track_id"]},
                        )
                generation, stop = actor.begin_ordered_playback(
                    client_instance_id=command.client_instance_id,
                    basis=basis,
                    rate=rate,
                    display_interval=display_interval,
                    viewer_revision=viewer_revision,
                )
                task = asyncio.create_task(
                    self._run_ordered_playback(
                        run_id=command.run_id,
                        generation=generation,
                        stop=stop,
                    ),
                    name=f"replay-v2-play-{command.run_id}",
                )
                actor.attach_ordered_playback_task(
                    generation=generation,
                    task=task,
                )
                viewer = await self.store.get_viewer_state(command.run_id)
                result = self._result_payload(
                    command=command,
                    session_id=selected_session_id,
                    snapshot=selected_snapshot,
                    viewer=viewer.to_dict(),
                    data={
                        "full_track_count": len(ordered),
                        "ordering_version": GLOBAL_ORDERING_VERSION,
                        "playback_contract": PLAYBACK_CONTRACT_VERSION,
                        "legacy_profile": legacy_profile,
                        "global_clock": actor.playback_snapshot(),
                    },
                )
                result["state"] = "PLAYING"
                return result
            if command.type is ReplayV2CommandType.PAUSE:
                self._exact_payload(command.payload, set())
                if not actor.playback_is_active():
                    raise TrainingRunError(
                        "REPLAY_CONTROL_INVALID",
                        "ordered playback is not running",
                        status_code=409,
                    )
                actor.request_ordered_pause(reason="USER_PAUSE")
                selected = await self.replay_service.get_session(selected_session_id)
                snapshot = self._snapshot(selected)
                viewer = await self.store.get_viewer_state(command.run_id)
                result = self._result_payload(
                    command=command,
                    session_id=selected_session_id,
                    snapshot=snapshot,
                    viewer=viewer.to_dict(),
                    data={
                        "full_track_count": len(ordered),
                        "ordering_version": GLOBAL_ORDERING_VERSION,
                        "global_clock": actor.playback_snapshot(),
                    },
                )
                result["state"] = "PAUSED"
                return result
            if command.type is ReplayV2CommandType.SET_SPEED:
                if not command.payload:
                    self._exact_payload(command.payload, {"speed"})
                (
                    basis,
                    rate,
                    display_interval,
                    viewer_revision,
                    legacy_profile,
                ) = await self._playback_profile(
                    command=command,
                    binding=binding,
                    selected_snapshot=selected_snapshot,
                    full_track_count=len(ordered),
                    actor=actor,
                )
                for track in ordered:
                    await self._ensure_track_controller(
                        session_id=self._track_session_id(track),
                        client_instance_id=command.client_instance_id,
                        command_id=command.command_id,
                    )
                selected_result: Mapping[str, object] | None = None
                if legacy_profile:
                    adapter_speed = command.payload["speed"]
                    try:
                        for track in ordered:
                            session_id = self._track_session_id(track)
                            session = await self.replay_service.get_session(session_id)
                            snapshot = self._snapshot(session)
                            adapter = ReplayCommand(
                                protocol=REPLAY_PROTOCOL,
                                command_id=self._multi_command_id(
                                    command.command_id,
                                    str(track["track_id"]),
                                    CommandType.SET_SPEED.value,
                                    _stored_counter(
                                        snapshot["revision"],
                                        field_name="revision",
                                    ),
                                ),
                                client_instance_id=command.client_instance_id,
                                expected_revision=_stored_counter(
                                    snapshot["revision"],
                                    field_name="revision",
                                ),
                                type=CommandType.SET_SPEED,
                                payload={"speed": adapter_speed},
                            )
                            acknowledged = await self.replay_service.command(
                                session_id,
                                adapter,
                            )
                            if session_id == selected_session_id:
                                selected_result = acknowledged
                    except ReplayDomainError as exc:
                        await self._fail_closed_multi_track(
                            run_id=command.run_id,
                            tracks=ordered,
                            failed_track=track,
                            client_instance_id=command.client_instance_id,
                            reason=exc.code.value,
                        )
                        raise TrainingRunError(
                            "MULTI_TRACK_PAUSED",
                            "a required FULL market track rejected the global control",
                            status_code=409,
                            details={
                                "reason": exc.code.value,
                                "track_id": track["track_id"],
                            },
                        ) from exc
                actor.update_ordered_profile(
                    basis=basis,
                    rate=rate,
                    display_interval=display_interval,
                    viewer_revision=viewer_revision,
                )
                if selected_result is None:
                    selected = await self.replay_service.get_session(
                        selected_session_id
                    )
                    selected_result = self._snapshot(selected)
                snapshot = (
                    selected_result
                    if "cursor" in selected_result
                    else self._snapshot(selected_result)
                )
                viewer = await self.store.get_viewer_state(command.run_id)
                return self._result_payload(
                    command=command,
                    session_id=selected_session_id,
                    snapshot=snapshot,
                    viewer=viewer.to_dict(),
                    data={
                        "full_track_count": len(ordered),
                        "ordering_version": GLOBAL_ORDERING_VERSION,
                        "playback_contract": PLAYBACK_CONTRACT_VERSION,
                        "legacy_profile": legacy_profile,
                        "profile_only": not legacy_profile,
                        "global_clock": actor.playback_snapshot(),
                    },
                )
            if command.type is ReplayV2CommandType.ACQUIRE_CONTROLLER:
                v1_type = CommandType.ACQUIRE_CONTROLLER
                payload = dict(self._exact_payload(command.payload, {"takeover"}))
            elif command.type is ReplayV2CommandType.TAKEOVER_CONTROLLER:
                self._exact_payload(command.payload, set())
                v1_type = CommandType.ACQUIRE_CONTROLLER
                payload = {"takeover": True}
            else:
                self._exact_payload(command.payload, set())
                v1_type = (
                    CommandType.RELEASE_CONTROLLER
                    if command.type is ReplayV2CommandType.RELEASE_CONTROLLER
                    else CommandType.PAUSE
                )
                payload = {}
            if command.type is ReplayV2CommandType.RELEASE_CONTROLLER:
                actor.request_ordered_pause(reason="CONTROLLER_RELEASED")
            if command.type in {
                ReplayV2CommandType.RELEASE_CONTROLLER,
            }:
                for track in ordered:
                    await self._ensure_track_controller(
                        session_id=self._track_session_id(track),
                        client_instance_id=command.client_instance_id,
                        command_id=command.command_id,
                    )
            selected_result: Mapping[str, object] | None = None
            try:
                for track in ordered:
                    session_id = self._track_session_id(track)
                    session = await self.replay_service.get_session(session_id)
                    snapshot = self._snapshot(session)
                    adapter = ReplayCommand(
                        protocol=REPLAY_PROTOCOL,
                        command_id=self._multi_command_id(
                            command.command_id,
                            str(track["track_id"]),
                            v1_type.value,
                            _stored_counter(
                                snapshot["revision"], field_name="revision"
                            ),
                        ),
                        client_instance_id=command.client_instance_id,
                        expected_revision=_stored_counter(
                            snapshot["revision"], field_name="revision"
                        ),
                        type=v1_type,
                        payload=payload,
                    )
                    acknowledged = await self.replay_service.command(
                        session_id, adapter
                    )
                    if session_id == selected_session_id:
                        selected_result = acknowledged
            except ReplayDomainError as exc:
                await self._fail_closed_multi_track(
                    run_id=command.run_id,
                    tracks=ordered,
                    failed_track=track,
                    client_instance_id=command.client_instance_id,
                    reason=exc.code.value,
                )
                raise TrainingRunError(
                    "MULTI_TRACK_PAUSED",
                    "a required FULL market track rejected the global control",
                    status_code=409,
                    details={"reason": exc.code.value, "track_id": track["track_id"]},
                ) from exc
            if selected_result is None:
                selected = await self.replay_service.get_session(selected_session_id)
                selected_result = self._snapshot(selected)
            snapshot = (
                selected_result
                if "cursor" in selected_result
                else self._snapshot(selected_result)
            )
            viewer = await self.store.get_viewer_state(command.run_id)
            return self._result_payload(
                command=command,
                session_id=selected_session_id,
                snapshot=snapshot,
                viewer=viewer.to_dict(),
                data={
                    "full_track_count": len(ordered),
                    "ordering_version": GLOBAL_ORDERING_VERSION,
                    "adapter_command": v1_type.value,
                    "global_clock": actor.playback_snapshot(),
                },
            )

        current_time = self._cursor_time(selected_snapshot)
        fast_forward_plan: dict[str, object] | None = None
        control_plan: dict[str, object] | None = None
        advance_job: dict[str, object] | None = None
        advance_key: tuple[str, str] | None = None
        if command.type is ReplayV2CommandType.ADVANCE:
            requested_basis = advance_basis(command.payload.get("basis"))
            if requested_basis is AdvanceBasis.SOURCE_EVENT:
                normalized = self._exact_payload(
                    command.payload,
                    {"basis", "count"},
                )
                control_count(normalized["count"])
                raise TrainingRunError(
                    "REPLAY_CONTROL_UNSUPPORTED",
                    "SOURCE_EVENT is unavailable with multiple FULL tracks because a same-time cohort must commit atomically",
                    status_code=409,
                    details={
                        "basis": requested_basis.value,
                        "full_track_count": len(ordered),
                        "playback_bases": [
                            item.value
                            for item in supported_playback_bases(
                                source_kind=str(binding["source_kind"]),
                                full_track_count=len(ordered),
                            )
                        ],
                    },
                )
        if command.type is ReplayV2CommandType.STEP_EVENT:
            step_event_payload = self._exact_payload(command.payload, {"count"})
            count = control_count(step_event_payload["count"])
            if str(binding["source_kind"]) != "AGG_TRADE":
                raise TrainingRunError(
                    "REPLAY_CONTROL_UNSUPPORTED",
                    "STEP_EVENT is available only for AGG_TRADE runs",
                    status_code=409,
                )
            total_events: list[StableMarketEvent] = []
            for _ in range(count):
                next_time = await self._next_global_event_time(
                    run_id=command.run_id,
                    binding=binding,
                    tracks=ordered,
                )
                wave = await self._advance_full_tracks_to(
                    command=command,
                    binding=binding,
                    tracks=ordered,
                    target_virtual_time_ms=next_time,
                )
                total_events.extend(wave)
        else:
            _v1_type, _v1_payload, plan = await self._translate_control(
                command=command,
                binding=binding,
                snapshot=selected_snapshot,
            )
            target = plan.get("target_virtual_time_ms")
            if target is None and (
                command.type is ReplayV2CommandType.STEP_BASE
                or (
                    command.type is ReplayV2CommandType.ADVANCE
                    and plan.get("basis") == AdvanceBasis.BASE_BAR.value
                )
            ):
                if command.type is ReplayV2CommandType.STEP_BASE:
                    step_base_payload = self._exact_payload(
                        command.payload,
                        {"count"},
                    )
                    count = control_count(step_base_payload["count"])
                else:
                    count = control_count(plan.get("count"))
                target = aligned_step_target_ms(
                    current_virtual_time_ms=current_time,
                    base_interval=str(binding["base_interval"]),
                    step_interval=str(binding["base_interval"]),
                    count=count,
                )
                plan["target_virtual_time_ms"] = target
            control_plan = dict(plan)
            control_plan["mode"] = "GLOBAL_ORDERED_INPUT_CLOCK"
            if binding.get("position_mode") == "HEDGE":
                control_plan["input_clock"] = "PINNED_HEDGE_PUBLIC_SIMULATION"
            if not isinstance(target, int):
                raise TrainingRunError(
                    "REPLAY_CONTROL_UNSUPPORTED",
                    "multi-track control requires an exact global target",
                    status_code=409,
                )
            cancelable_scan = command.type in {
                ReplayV2CommandType.ADVANCE_BY,
                ReplayV2CommandType.ADVANCE_TO,
            } or (
                command.type is ReplayV2CommandType.ADVANCE
                and plan.get("basis") == AdvanceBasis.VIRTUAL_TIME.value
            )
            if cancelable_scan:
                decision = self._plan_fast_forward(
                    binding=binding,
                    snapshot=selected_snapshot,
                    tracks=ordered,
                    target_virtual_time_ms=target,
                )
                fast_forward_plan = {
                    **decision.to_dict(),
                    **{
                        key: value
                        for key, value in plan.items()
                        if key
                        in {
                            "contract",
                            "basis",
                            "count",
                            "duration_ms",
                            "legacy_alias",
                            "display_interval",
                            "viewer_revision",
                            "target_virtual_time_ms",
                        }
                    },
                }
                if decision.plan is FastForwardPlan.BLOCKED:
                    raise TrainingRunError(
                        "REPLAY_FAST_FORWARD_BLOCKED",
                        decision.explanation,
                        status_code=409,
                        details={"plan": fast_forward_plan},
                    )
                advance_key = (command.run_id, command.command_id)
                if advance_key in self._advance_jobs:
                    raise TrainingRunError(
                        "ADVANCE_ALREADY_ACTIVE",
                        "advance command is already active",
                        status_code=409,
                    )
                advance_job = {
                    "cancel": asyncio.Event(),
                    "client_instance_id": command.client_instance_id,
                    "status": "RUNNING",
                    "initial_virtual_time_ms": current_time,
                    "target_virtual_time_ms": target,
                    "current_virtual_time_ms": current_time,
                    "consumed": 0,
                    "chunks": 0,
                    "cancelable": True,
                    "plan": dict(fast_forward_plan),
                    "chunk_event_limit": 1,
                    "queue_high_water": 0,
                    "stable_order_truncated": False,
                }
                self._advance_jobs[advance_key] = advance_job
            try:
                total_events = list(
                    await self._advance_full_tracks_to(
                        command=command,
                        binding=binding,
                        tracks=ordered,
                        target_virtual_time_ms=target,
                        job=advance_job,
                    )
                )
            except BaseException:
                if advance_key is not None:
                    self._advance_jobs.pop(advance_key, None)
                raise
            if advance_key is not None:
                assert advance_job is not None
                advance_job["cancelable"] = False
                # The command response and a racing progress poll must agree
                # that a terminal job cannot still be cancelled.
                asyncio.get_running_loop().call_later(
                    ADVANCE_PROGRESS_RETENTION_SECONDS,
                    self._advance_jobs.pop,
                    advance_key,
                    None,
                )
        selected = await self.replay_service.get_session(selected_session_id)
        final = self._snapshot(selected)
        viewer = await self.store.get_viewer_state(command.run_id)
        if fast_forward_plan is not None:
            equivalence = fast_forward_plan.get("equivalence")
            if isinstance(equivalence, Mapping):
                fast_forward_plan["equivalence"] = {
                    **dict(equivalence),
                    "status": "REFERENCE_PATH",
                    "observed_state_hash": final["state_hash"],
                    "observed_cursor": dict(
                        _stored_mapping(final["cursor"], field_name="adapter cursor")
                    ),
                    "consumed_source_events": (
                        int(advance_job["consumed"])
                        if advance_job is not None
                        else len(total_events)
                    ),
                }
            if advance_job is not None:
                advance_job["plan"] = dict(fast_forward_plan)
        return self._result_payload(
            command=command,
            session_id=selected_session_id,
            snapshot=final,
            viewer=viewer.to_dict(),
            data={
                "consumed": (
                    int(advance_job["consumed"])
                    if advance_job is not None
                    else len(total_events)
                ),
                "cancelled": (
                    advance_job is not None and advance_job["status"] == "CANCELLED"
                ),
                "full_track_count": len(ordered),
                "ordering_version": GLOBAL_ORDERING_VERSION,
                "stable_order": [event.to_dict() for event in total_events],
                **(
                    {
                        "stable_order_truncated": bool(
                            advance_job["stable_order_truncated"]
                        ),
                        "progress": self._public_progress(advance_job),
                    }
                    if advance_job is not None
                    else {}
                ),
                **(
                    {"plan": fast_forward_plan or control_plan}
                    if fast_forward_plan is not None or control_plan is not None
                    else {}
                ),
            },
        )

    async def _run_ordered_playback(
        self,
        *,
        run_id: str,
        generation: int,
        stop: asyncio.Event,
    ) -> None:
        """Drive every FULL track from one wall-clock-independent ordered lane."""

        actor = self._run_actors[run_id]
        event_loop = asyncio.get_running_loop()
        last_advance_wall = event_loop.time()
        initial_clock = actor.playback_snapshot()
        last_profile_revision = _stored_counter(
            initial_clock["profile_revision"],
            field_name="global_clock.profile_revision",
        )
        terminal_state = "PAUSED"
        terminal_reason: str | None = None
        try:
            while not stop.is_set():
                async with actor.serialized():
                    if not actor.playback_is_active(generation):
                        break
                    binding = await self.store.run_binding(run_id)
                    projection = await self.store.get_market_tracks(run_id)
                    projection_tracks = projection.get("tracks")
                    if not isinstance(projection_tracks, list):
                        raise TrainingRunError(
                            "TRAINING_RUN_STORAGE_DEGRADED",
                            "market tracks projection is invalid",
                            status_code=503,
                        )
                    tracks = TrainingRunActor.ordered_full_tracks(
                        track
                        for track in projection_tracks
                        if isinstance(track, Mapping)
                    )
                    if len(tracks) < 1:
                        terminal_reason = "ORDERED_PLAYBACK_REQUIRES_A_FULL_TRACK"
                        break
                    playback_client_id = actor.playback_client_id
                    if playback_client_id is None:
                        terminal_reason = "CONTROLLER_LEASE_LOST"
                        break
                    controller_lease_lost = False
                    for track in tracks:
                        try:
                            await self.replay_service.heartbeat(
                                self._track_session_id(track),
                                playback_client_id,
                            )
                        except ReplayDomainError:
                            controller_lease_lost = True
                            terminal_reason = "CONTROLLER_LEASE_LOST"
                            break
                    if controller_lease_lost:
                        break
                    selected_session_id = str(binding["adapter_session_id"])
                    selected = await self.replay_service.get_session(
                        selected_session_id
                    )
                    selected_snapshot = self._snapshot(selected)
                    if (
                        selected_snapshot.get("controller_client_id")
                        != playback_client_id
                    ):
                        terminal_reason = "CONTROLLER_LEASE_LOST"
                        break
                    current_time = self._cursor_time(selected_snapshot)
                    cursor = _stored_mapping(
                        selected_snapshot.get("cursor"),
                        field_name="adapter cursor",
                    )
                    if cursor.get("at_end") is True:
                        terminal_state = "ENDED"
                        terminal_reason = "SOURCE_EXHAUSTED"
                        break
                    clock = actor.playback_snapshot()
                    profile_revision = _stored_counter(
                        clock["profile_revision"],
                        field_name="global_clock.profile_revision",
                    )
                    now_wall = event_loop.time()
                    if profile_revision != last_profile_revision:
                        last_advance_wall = now_wall
                        last_profile_revision = profile_revision
                    raw_elapsed_seconds = now_wall - last_advance_wall
                    elapsed_seconds = max(0.0, raw_elapsed_seconds)
                    basis = advance_basis(clock.get("basis"))
                    rate = control_rate(clock.get("rate"))
                    source_kind = str(binding["source_kind"])
                    allowed = supported_playback_bases(
                        source_kind=source_kind,
                        full_track_count=len(tracks),
                    )
                    if basis not in allowed:
                        raise TrainingRunError(
                            "REPLAY_CONTROL_UNSUPPORTED",
                            "active playback basis no longer matches the FULL-track topology",
                            status_code=409,
                            details={
                                "basis": basis.value,
                                "playback_bases": [item.value for item in allowed],
                            },
                        )
                    consumed_wall_seconds = 0.0
                    if basis is AdvanceBasis.VIRTUAL_TIME:
                        try:
                            next_time = await self._next_global_event_time(
                                run_id=run_id,
                                binding=binding,
                                tracks=tracks,
                            )
                        except TrainingRunError as exc:
                            if exc.code != "REPLAY_CONTROL_UNAVAILABLE":
                                raise
                            terminal_state = "ENDED"
                            terminal_reason = "SOURCE_EXHAUSTED"
                            break
                        elapsed_ms = max(
                            0,
                            int(elapsed_seconds * 1_000 * rate),
                        )
                        if current_time + elapsed_ms < next_time:
                            timeout = min(
                                0.25,
                                max(
                                    0.001,
                                    (next_time - current_time) / rate / 1_000,
                                ),
                            )
                            target = None
                        else:
                            target = max(next_time, current_time + elapsed_ms)
                            consumed_wall_seconds = elapsed_seconds
                            timeout = 0.0
                    else:
                        final_state_batch_units = 0
                        interactive_batch_limit = 0
                        if source_kind == "BAR":
                            base_interval_ms = fixed_interval_ms(
                                str(binding["base_interval"]),
                                field_name="base_interval",
                            )
                            if current_time <= MAX_TIMESTAMP_MS - base_interval_ms:
                                next_base_time = current_time + base_interval_ms
                                interactive_batch_limit = (
                                    self._ordered_playback_interactive_batch_limit(
                                        binding=binding,
                                        tracks=tracks,
                                        snapshot=selected_snapshot,
                                        target_virtual_time_ms=next_base_time,
                                    )
                                )
                                if rate >= ORDERED_PLAYBACK_FINAL_STATE_MIN_RATE:
                                    final_state_profile = (
                                        self._ordered_final_state_batch_profile(
                                            binding=binding,
                                            tracks=tracks,
                                            snapshot=selected_snapshot,
                                            target_virtual_time_ms=next_base_time,
                                            enabled=True,
                                        )
                                    )
                                    if final_state_profile is not None:
                                        final_state_batch_units = min(
                                            final_state_profile[0],
                                            (
                                                rate
                                                + ORDERED_PLAYBACK_FINAL_STATE_TARGET_HZ
                                                - 1
                                            )
                                            // ORDERED_PLAYBACK_FINAL_STATE_TARGET_HZ,
                                        )
                        units = discrete_playback_units(
                            elapsed_seconds,
                            rate=rate,
                        )
                        if interactive_batch_limit > 0:
                            # The Run actor lock is also the PAUSE/SET_SPEED
                            # acknowledgement boundary.  Once orders or positions
                            # exist, yield that fair lock after every committed BAR
                            # so account growth cannot turn one playback batch into
                            # an unbounded control-command stall.
                            units = min(units, interactive_batch_limit)
                        if units < final_state_batch_units:
                            if raw_elapsed_seconds >= 0:
                                # Keep one bounded projection batch computed
                                # ahead of wall time. Without this lead, a fast
                                # actor catches up and falls back to one durable
                                # command per BAR at high public rates.
                                units = final_state_batch_units
                            else:
                                units = 0
                                target = None
                                timeout = min(
                                    0.25,
                                    max(0.001, -raw_elapsed_seconds),
                                )
                        if units == 0:
                            if final_state_batch_units == 0:
                                target = None
                                timeout = min(
                                    0.25,
                                    max(
                                        0.001,
                                        (1 / rate) - elapsed_seconds,
                                    ),
                                )
                        elif basis is AdvanceBasis.SOURCE_EVENT:
                            if len(tracks) != 1:
                                raise TrainingRunError(
                                    "REPLAY_CONTROL_UNSUPPORTED",
                                    "SOURCE_EVENT playback requires exactly one FULL track",
                                    status_code=409,
                                )
                            target = await self._ordered_batch_target(
                                tracks,
                                max_events=units,
                            )
                            if target is None:
                                terminal_state = "ENDED"
                                terminal_reason = "SOURCE_EXHAUSTED"
                                break
                            consumed_wall_seconds = units / rate
                            timeout = 0.0
                        else:
                            step_interval = (
                                clock.get("display_interval")
                                if basis is AdvanceBasis.DISPLAY_BAR
                                else str(binding["base_interval"])
                            )
                            if not isinstance(step_interval, str):
                                raise TrainingRunError(
                                    "TRAINING_RUN_STORAGE_DEGRADED",
                                    "display playback profile has no interval",
                                    status_code=503,
                                )
                            if basis is AdvanceBasis.DISPLAY_BAR:
                                target = await self._source_aligned_display_target(
                                    binding=binding,
                                    current_virtual_time_ms=current_time,
                                    base_interval=str(binding["base_interval"]),
                                    display_interval=step_interval,
                                    count=units,
                                )
                            else:
                                target = aligned_step_target_ms(
                                    current_virtual_time_ms=current_time,
                                    base_interval=str(binding["base_interval"]),
                                    step_interval=step_interval,
                                    count=units,
                                )
                            base_interval_ms = compatible_step_interval_ms(
                                base_interval=str(binding["base_interval"]),
                                step_interval=str(binding["base_interval"]),
                            )
                            adapter_config = binding.get("adapter_config")
                            if not isinstance(adapter_config, Mapping):
                                raise TrainingRunError(
                                    "TRAINING_RUN_STORAGE_DEGRADED",
                                    "training adapter config is invalid",
                                    status_code=503,
                                )
                            actual_start_ms = _stored_counter(
                                binding["actual_replay_start_ms"],
                                field_name="actual_replay_start_ms",
                            )
                            public_start_ms = (
                                _stored_counter(
                                    binding.get("synthetic_origin_ms"),
                                    field_name="synthetic_origin_ms",
                                )
                                if adapter_config.get("blind_mode") is True
                                else actual_start_ms
                            )
                            final_open_ms = (
                                public_start_ms
                                + _stored_counter(
                                    binding["actual_replay_end_ms"],
                                    field_name="actual_replay_end_ms",
                                )
                                - actual_start_ms
                            )
                            final_close_ms = final_open_ms + base_interval_ms - 1
                            penultimate_close_ms = final_open_ms - 1
                            if (
                                current_time < penultimate_close_ms
                                and target >= final_close_ms
                            ):
                                # Leave the terminal event for one final loop.
                                # This creates a scheduling barrier where a
                                # pending PAUSE can win without reducing steady
                                # state playback batch throughput.
                                target = penultimate_close_ms
                            consumed_wall_seconds = units / rate
                            timeout = 0.0
                    if target is not None:
                        tick = actor.next_playback_tick(generation)
                        internal = ReplayV2Command(
                            protocol="replay.v3",
                            run_id=run_id,
                            command_id=f"ordered-play-{generation}-{tick}",
                            client_instance_id=str(actor.playback_client_id),
                            expected_revision=_stored_counter(
                                selected_snapshot["revision"], field_name="revision"
                            ),
                            expected_cursor=TrainingCursor(
                                virtual_time_ms=_stored_counter(
                                    cursor["virtual_time_ms"],
                                    field_name="virtual_time_ms",
                                ),
                                source_sequence=_stored_counter(
                                    cursor["source_sequence"],
                                    field_name="source_sequence",
                                ),
                                revision=_stored_counter(
                                    selected_snapshot["revision"],
                                    field_name="revision",
                                ),
                            ),
                            type=ReplayV2CommandType.ADVANCE_TO,
                            payload={"virtual_time_ms": target},
                        )
                        await self._advance_full_tracks_to(
                            command=internal,
                            binding=binding,
                            tracks=tracks,
                            target_virtual_time_ms=target,
                            stop_event=stop,
                            allow_final_state_batch=True,
                        )
                        if consumed_wall_seconds > 0:
                            last_advance_wall += consumed_wall_seconds
                        else:
                            last_advance_wall = event_loop.time()
                        timeout = 0.0
                if timeout > 0:
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=timeout)
                    except TimeoutError:
                        pass
                else:
                    await asyncio.sleep(0)
        except asyncio.CancelledError:
            terminal_reason = terminal_reason or "PLAYBACK_CANCELLED"
        except (ReplayDomainError, TrainingRunError) as exc:
            terminal_reason = (
                exc.code.value if isinstance(exc, ReplayDomainError) else exc.code
            )
            terminal_state = (
                "PAUSED" if terminal_reason.startswith("HISTORICAL_BOOK_") else "ERROR"
            )
        except Exception as exc:  # pragma: no cover - defensive task boundary
            terminal_state = "ERROR"
            terminal_reason = type(exc).__name__
        finally:
            async with actor.serialized():
                snapshot = actor.playback_snapshot()
                if (
                    _stored_counter(
                        snapshot["generation"], field_name="global_clock.generation"
                    )
                    == generation
                ):
                    if snapshot["state"] != "PLAYING":
                        terminal_state = str(snapshot["state"])
                        terminal_reason = (
                            str(snapshot["reason"])
                            if snapshot["reason"] is not None
                            else terminal_reason
                        )
                    actor.finish_ordered_playback(
                        generation=generation,
                        state=terminal_state,
                        reason=terminal_reason,
                    )

    async def _ordered_batch_target(
        self,
        tracks: tuple[Mapping[str, object], ...],
        *,
        max_events: int,
    ) -> int | None:
        targets: list[int] = []
        for track in tracks:
            plan = await self.replay_service.plan_source_chunk(
                self._track_session_id(track),
                target_time_ms=MAX_TIMESTAMP_MS,
                max_events=max_events,
            )
            if _stored_counter(plan["event_count"], field_name="event_count") == 0:
                return None
            last_event_time_ms = plan.get("last_event_time_ms")
            if not isinstance(last_event_time_ms, int):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market event plan is missing its timestamp",
                    status_code=503,
                )
            targets.append(last_event_time_ms)
        return min(targets) if targets else None

    async def _end_multi_track_run(
        self,
        *,
        command: ReplayV2Command,
        tracks: tuple[Mapping[str, object], ...],
        selected_session_id: str,
    ) -> dict[str, object]:
        payload = dict(
            self._exact_payload(
                command.payload,
                {"open_order_disposition", "position_disposition"},
            )
        )
        actor = self._run_actors[command.run_id]
        actor.request_ordered_pause(reason="RUN_END")
        prepared = tuple(
            track
            for track in tracks
            if isinstance(track.get("adapter_session_id"), str)
        )
        snapshots: list[tuple[Mapping[str, object], Mapping[str, object]]] = []
        for track in prepared:
            session_id = self._track_session_id(track)
            session = await self.replay_service.get_session(session_id)
            snapshot = self._snapshot(session)
            if snapshot["state"] == "PLAYING":
                raise TrainingRunError(
                    "MULTI_TRACK_PAUSED",
                    "all market tracks must pause before the run can end",
                    status_code=409,
                    details={"track_id": track["track_id"]},
                )
            if snapshot["state"] != "ENDED":
                await self._ensure_track_controller(
                    session_id=session_id,
                    client_instance_id=command.client_instance_id,
                    command_id=command.command_id,
                )
                session = await self.replay_service.get_session(session_id)
                snapshot = self._snapshot(session)
            snapshots.append((track, snapshot))
        selected_result: Mapping[str, object] | None = None
        ended = 0
        try:
            for track, snapshot in snapshots:
                session_id = self._track_session_id(track)
                if snapshot["state"] == "ENDED":
                    acknowledged = snapshot
                else:
                    adapter = ReplayCommand(
                        protocol=REPLAY_PROTOCOL,
                        command_id=self._multi_command_id(
                            command.command_id,
                            str(track["track_id"]),
                            CommandType.END_SESSION.value,
                            _stored_counter(
                                snapshot["revision"], field_name="revision"
                            ),
                        ),
                        client_instance_id=command.client_instance_id,
                        expected_revision=_stored_counter(
                            snapshot["revision"], field_name="revision"
                        ),
                        type=CommandType.END_SESSION,
                        payload=payload,
                    )
                    acknowledged = await self.replay_service.command(
                        session_id,
                        adapter,
                    )
                ended += 1
                if session_id == selected_session_id:
                    selected_result = acknowledged
        except ReplayDomainError as exc:
            await self._fail_closed_multi_track(
                run_id=command.run_id,
                tracks=prepared,
                failed_track=track,
                client_instance_id=command.client_instance_id,
                reason=exc.code.value,
            )
            raise TrainingRunError(
                "MULTI_TRACK_END_FAILED",
                "a prepared market track rejected the run end command",
                status_code=409,
                details={"reason": exc.code.value, "track_id": track["track_id"]},
            ) from exc
        if selected_result is None:
            selected = await self.replay_service.get_session(selected_session_id)
            selected_result = self._snapshot(selected)
        selected_snapshot = (
            selected_result
            if "cursor" in selected_result
            else self._snapshot(selected_result)
        )
        checkpoint = await self.store.checkpoint_market_tracks(command.run_id)
        generation = _stored_counter(
            actor.playback_snapshot()["generation"],
            field_name="global_clock.generation",
        )
        actor.finish_ordered_playback(
            generation=generation,
            state="ENDED",
            reason="RUN_END",
        )
        viewer = await self.store.get_viewer_state(command.run_id)
        result = self._result_payload(
            command=command,
            session_id=selected_session_id,
            snapshot=selected_snapshot,
            viewer=viewer.to_dict(),
            data={
                "ended_track_count": ended,
                "global_checkpoint": checkpoint,
                "ordering_version": GLOBAL_ORDERING_VERSION,
                "global_clock": actor.playback_snapshot(),
            },
        )
        result["state"] = "ENDED"
        return result

    async def _advance_full_tracks_to(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        tracks: tuple[Mapping[str, object], ...],
        target_virtual_time_ms: int,
        job: dict[str, object] | None = None,
        stop_event: asyncio.Event | None = None,
        allow_final_state_batch: bool = False,
    ) -> tuple[StableMarketEvent, ...]:
        hedge_mode = str(binding.get("position_mode")) == "HEDGE"
        if not hedge_mode:
            await self.account_history.guard_run(
                run_id=command.run_id,
                tracks=tracks,
            )
        pending_account_events = await self.store.pending_account_global_events(
            command.run_id
        )
        pending_hedge_events = await self.store.pending_hedge_input_global_events(
            command.run_id
        )
        if pending_account_events or pending_hedge_events:
            await self.store.record_global_events(
                command.run_id,
                stable_market_event_order(
                    (*pending_account_events, *pending_hedge_events)
                ),
            )
        hedge_runtime_snapshot = (
            await self.hedge_inputs.runtime_snapshot(command.run_id)
            if hedge_mode
            else None
        )
        book_required = (
            str(binding.get("book_mode", "OFF"))
            == BookMode.BOOK_ASSISTED_REQUIRED.value
        )
        all_events: list[StableMarketEvent] = []
        pending_global_events: list[StableMarketEvent] = []
        cancel_event = stop_event
        if job is not None:
            job_cancel = job.get("cancel")
            if isinstance(job_cancel, asyncio.Event):
                cancel_event = job_cancel

        async def cancel_at_committed_barrier() -> tuple[StableMarketEvent, ...]:
            if job is not None:
                job["status"] = "CANCELLED"
            await self.audit_account(command.run_id)
            return tuple(all_events)

        for _wave_index in range(10_000):
            if (
                cancel_event is not None
                and cancel_event.is_set()
                and not pending_global_events
            ):
                return await cancel_at_committed_barrier()
            snapshots: list[tuple[Mapping[str, object], Mapping[str, object]]] = []
            times: set[int] = set()
            next_times: list[int] = []
            for track in tracks:
                session_id = self._track_session_id(track)
                session = await self.replay_service.get_session(session_id)
                snapshot = self._snapshot(session)
                snapshots.append((track, snapshot))
                times.add(self._cursor_time(snapshot))

            final_state_profile = self._ordered_final_state_batch_profile(
                binding=binding,
                tracks=tracks,
                snapshot=snapshots[0][1],
                target_virtual_time_ms=target_virtual_time_ms,
                enabled=allow_final_state_batch,
            )
            source_plan_limit = (
                1 if final_state_profile is None else final_state_profile[0]
            )
            planned_event_times: dict[str, tuple[int, ...]] = {}
            for track, _snapshot in snapshots:
                session_id = self._track_session_id(track)
                try:
                    plan = await self.replay_service.plan_source_chunk(
                        session_id,
                        target_time_ms=target_virtual_time_ms,
                        max_events=source_plan_limit,
                    )
                except (ReplayDomainError, TrainingRunError) as exc:
                    await self._fail_closed_multi_track(
                        run_id=command.run_id,
                        tracks=tracks,
                        failed_track=track,
                        client_instance_id=command.client_instance_id,
                        reason=(
                            exc.code.value
                            if isinstance(exc, ReplayDomainError)
                            else exc.code
                        ),
                    )
                    raise TrainingRunError(
                        "MULTI_TRACK_PAUSED",
                        "a required FULL market track failed global preflight",
                        status_code=409,
                        details={"track_id": track["track_id"]},
                    ) from exc
                event_count = _stored_counter(
                    plan["event_count"], field_name="event_count"
                )
                if final_state_profile is not None:
                    raw_event_times = plan.get("event_times_ms")
                    if not isinstance(raw_event_times, (list, tuple)):
                        raise TrainingRunError(
                            "TRAINING_RUN_STORAGE_DEGRADED",
                            "batched market event plan is missing timestamps",
                            status_code=503,
                        )
                    event_times = tuple(
                        _stored_counter(value, field_name="source_event_time_ms")
                        for value in raw_event_times
                    )
                    if len(event_times) != event_count:
                        raise TrainingRunError(
                            "TRAINING_RUN_STORAGE_DEGRADED",
                            "batched market event plan has an invalid timestamp count",
                            status_code=503,
                        )
                    planned_event_times[str(track["track_id"])] = event_times
                if event_count > 0:
                    next_time = plan["last_event_time_ms"]
                    if not isinstance(next_time, int):
                        raise TrainingRunError(
                            "TRAINING_RUN_STORAGE_DEGRADED",
                            "market event plan is missing its timestamp",
                            status_code=503,
                        )
                    next_times.append(next_time)
            if len(times) != 1:
                raise TrainingRunError(
                    "GLOBAL_CLOCK_DIVERGED",
                    "FULL market tracks do not share one VirtualTime",
                    status_code=409,
                )
            current = next(iter(times))
            target_actual_time_ms = self._actual_event_time_ms(
                binding,
                target_virtual_time_ms,
            )
            next_account_actual = await self.account_history.next_event_time(
                run_id=command.run_id,
                tracks=tracks,
                target_actual_time_ms=target_actual_time_ms,
                guarded=True,
            )
            next_hedge_actual = (
                await self.hedge_inputs.next_event_time(
                    run_id=command.run_id,
                    target_actual_time_ms=target_actual_time_ms,
                    runtime_snapshot=hedge_runtime_snapshot,
                )
                if hedge_mode
                else None
            )
            next_account_virtual = (
                None
                if next_account_actual is None
                else self._virtual_event_time_ms(
                    binding,
                    next_account_actual,
                )
            )
            next_hedge_virtual = (
                None
                if next_hedge_actual is None
                else self._virtual_event_time_ms(binding, next_hedge_actual)
            )
            if next_account_virtual is not None and next_account_virtual < current:
                raise TrainingRunError(
                    "ACCOUNT_HISTORY_CURSOR_BEHIND_MARKET",
                    "account timeline fell behind the committed market cursor",
                    status_code=409,
                    details={"fallback_applied": False},
                )
            if next_hedge_virtual is not None and next_hedge_virtual < current:
                await self.hedge_inputs.pause_run(
                    command.run_id,
                    reason="HEDGE_INPUT_CURSOR_BEHIND_MARKET",
                )
                raise TrainingRunError(
                    "HEDGE_INPUT_CURSOR_BEHIND_MARKET",
                    "HEDGE input timeline fell behind the committed market cursor",
                    status_code=409,
                    details={"fallback_applied": False},
                )
            if (
                current >= target_virtual_time_ms
                and (next_account_virtual is None or next_account_virtual > current)
                and (next_hedge_virtual is None or next_hedge_virtual > current)
            ):
                if pending_global_events:
                    raise TrainingRunError(
                        "GLOBAL_CHECKPOINT_INCOMPLETE",
                        "account events reached the target without a market barrier",
                        status_code=409,
                    )
                if job is not None:
                    job["status"] = "COMPLETED"
                    job["current_virtual_time_ms"] = current
                await self.audit_account(command.run_id)
                return tuple(all_events)
            candidate_times = [*next_times, target_virtual_time_ms]
            if next_account_virtual is not None:
                candidate_times.append(next_account_virtual)
            if next_hedge_virtual is not None:
                candidate_times.append(next_hedge_virtual)
            wave_time = min(candidate_times)
            market_barrier = (
                wave_time == target_virtual_time_ms or wave_time in next_times
            )
            wave_events: list[StableMarketEvent] = []
            actual_wave_time = self._actual_event_time_ms(binding, wave_time)
            if book_required:
                wave_book = await self.historical_books.prepare_run_projection(
                    run_id=command.run_id,
                    tracks=tracks,
                    actual_time_ms=actual_wave_time,
                    virtual_time_ms=wave_time,
                )
                await self.historical_books.commit_run_projection(
                    run_id=command.run_id,
                    prepared=wave_book,
                    event_type="READY",
                )
            account_events = await self.account_history.events_at(
                run_id=command.run_id,
                tracks=tracks,
                actual_time_ms=actual_wave_time,
                guarded=True,
            )
            hedge_events = (
                await self.hedge_inputs.events_at(
                    run_id=command.run_id,
                    actual_time_ms=actual_wave_time,
                    runtime_snapshot=hedge_runtime_snapshot,
                )
                if hedge_mode
                else ()
            )
            pre_account_events = tuple(
                item
                for item in account_events
                if item[1].event_phase == RULE_EVENT_PHASE
            )
            post_account_events = tuple(
                item
                for item in account_events
                if item[1].event_phase in {MARK_INDEX_EVENT_PHASE, FUNDING_EVENT_PHASE}
            )
            pre_hedge_events = tuple(
                item for item in hedge_events if item.event_phase == 10
            )
            post_hedge_events = tuple(
                item for item in hedge_events if item.event_phase in {30, 40}
            )
            simulation_hedge_events = tuple(
                item for item in hedge_events if item.event_phase == 70
            )
            failed_track: Mapping[str, object] = tracks[0]

            async def advance_market_barrier() -> None:
                nonlocal failed_track
                for barrier_track, before in snapshots:
                    failed_track = barrier_track
                    before_cursor = before.get("cursor")
                    if not isinstance(before_cursor, Mapping):
                        raise TrainingRunError(
                            "TRAINING_RUN_STORAGE_DEGRADED",
                            "market track cursor is invalid",
                            status_code=503,
                        )
                    before_sequence = _stored_counter(
                        before_cursor["source_sequence"],
                        field_name="source_sequence",
                    )
                    after = await self._advance_adapter_to(
                        session_id=self._track_session_id(barrier_track),
                        target_virtual_time_ms=wave_time,
                        client_instance_id=command.client_instance_id,
                        command_id=command.command_id,
                        track_id=str(barrier_track["track_id"]),
                        initial_snapshot=before,
                        final_state_max_events=(
                            None
                            if final_state_profile is None
                            else final_state_profile[0]
                        ),
                        require_empty_account=(
                            False
                            if final_state_profile is None
                            else final_state_profile[1]
                        ),
                    )
                    after_cursor = after.get("cursor")
                    if not isinstance(after_cursor, Mapping):
                        raise TrainingRunError(
                            "TRAINING_RUN_STORAGE_DEGRADED",
                            "market track cursor is invalid",
                            status_code=503,
                        )
                    after_sequence = _stored_counter(
                        after_cursor["source_sequence"],
                        field_name="source_sequence",
                    )
                    if final_state_profile is not None:
                        event_times = planned_event_times.get(
                            str(barrier_track["track_id"]),
                            (),
                        )
                        if after_sequence - before_sequence != len(event_times):
                            raise TrainingRunError(
                                "GLOBAL_CHECKPOINT_INCOMPLETE",
                                "batched market advance did not match its source plan",
                                status_code=503,
                                details={
                                    "planned_count": len(event_times),
                                    "consumed_count": after_sequence - before_sequence,
                                },
                            )
                        wave_events.extend(
                            StableMarketEvent(
                                actual_event_time_ms=self._actual_event_time_ms(
                                    binding,
                                    event_time_ms,
                                ),
                                event_phase=MARKET_EVENT_PHASE,
                                market_track_stable_id=str(barrier_track["track_id"]),
                                source_sequence=before_sequence + offset,
                            )
                            for offset, event_time_ms in enumerate(
                                event_times,
                                start=1,
                            )
                        )
                    else:
                        for sequence in range(before_sequence + 1, after_sequence + 1):
                            wave_events.append(
                                StableMarketEvent(
                                    actual_event_time_ms=self._actual_event_time_ms(
                                        binding,
                                        wave_time,
                                    ),
                                    event_phase=MARKET_EVENT_PHASE,
                                    market_track_stable_id=str(
                                        barrier_track["track_id"]
                                    ),
                                    source_sequence=sequence,
                                )
                            )

            try:
                wave_events.extend(
                    await self.store.apply_account_history_events(
                        command.run_id,
                        events=pre_account_events,
                        virtual_time_ms=wave_time,
                    )
                )
                wave_events.extend(
                    await self.store.apply_hedge_input_events(
                        command.run_id,
                        events=pre_hedge_events,
                        virtual_time_ms=wave_time,
                    )
                )
                if market_barrier:
                    await advance_market_barrier()
                wave_events.extend(
                    await self.store.apply_account_history_events(
                        command.run_id,
                        events=post_account_events,
                        virtual_time_ms=wave_time,
                    )
                )
                wave_events.extend(
                    await self.store.apply_hedge_input_events(
                        command.run_id,
                        events=post_hedge_events,
                        virtual_time_ms=wave_time,
                    )
                )
                await self.store.finalize_account_history(
                    command.run_id,
                    write_audit=False,
                    risk_virtual_time_ms=wave_time,
                )
                await self.store.finalize_hedge_inputs(
                    command.run_id,
                    risk_virtual_time_ms=wave_time,
                )
                wave_events.extend(
                    await self.store.apply_hedge_input_events(
                        command.run_id,
                        events=simulation_hedge_events,
                        virtual_time_ms=wave_time,
                    )
                )
                pending_liquidations = await self.store.pending_liquidations(
                    command.run_id
                )
                if pending_liquidations and not market_barrier:
                    # Exact account marks can trigger liquidation between two
                    # source events. Align every adapter to that precise
                    # account time before cancel/close mutations are issued.
                    await advance_market_barrier()
                    market_barrier = True
            except (ReplayDomainError, TrainingRunError) as exc:
                await self._fail_closed_multi_track(
                    run_id=command.run_id,
                    tracks=tracks,
                    failed_track=failed_track,
                    client_instance_id=command.client_instance_id,
                    reason=(
                        exc.code.value
                        if isinstance(exc, ReplayDomainError)
                        else exc.code
                    ),
                )
                raise TrainingRunError(
                    "MULTI_TRACK_PAUSED",
                    "a required FULL market track failed during global advance",
                    status_code=409,
                    details={"track_id": failed_track["track_id"]},
                ) from exc
            await self._reconcile_liquidations(
                run_id=command.run_id,
                client_instance_id=command.client_instance_id,
                command_id=command.command_id,
                pending=pending_liquidations,
            )
            if wave_events:
                ordered_wave = stable_market_event_order(wave_events)
                pending_global_events.extend(ordered_wave)
                all_events.extend(ordered_wave)
                if job is not None and len(all_events) > 512:
                    del all_events[:-512]
                    job["stable_order_truncated"] = True
            if market_barrier:
                if pending_global_events:
                    await self.store.record_global_events(
                        command.run_id,
                        stable_market_event_order(pending_global_events),
                    )
                    pending_global_events.clear()
                else:
                    await self.store.checkpoint_market_tracks(command.run_id)
            if job is not None:
                job["consumed"] = int(job["consumed"]) + len(wave_events)
                job["chunks"] = int(job["chunks"]) + 1
                job["current_virtual_time_ms"] = (
                    wave_time if market_barrier else current
                )
                job["queue_high_water"] = max(
                    int(job["queue_high_water"]),
                    len(tracks),
                )
            if (
                cancel_event is not None
                and cancel_event.is_set()
                and not pending_global_events
            ):
                return await cancel_at_committed_barrier()
            await asyncio.sleep(0)
        raise TrainingRunError(
            "REPLAY_SCAN_LIMIT_EXCEEDED",
            "global advance exceeded the bounded wave budget",
            status_code=409,
        )

    def _ordered_final_state_batch_profile(
        self,
        *,
        binding: Mapping[str, object],
        tracks: tuple[Mapping[str, object], ...],
        snapshot: Mapping[str, object],
        target_virtual_time_ms: int,
        enabled: bool,
    ) -> tuple[int, bool] | None:
        """Choose bounded terminal delivery only for proven ordered BAR paths."""

        if (
            not enabled
            or str(binding.get("source_kind")) != "BAR"
            or len(tracks) != 1
            or self._cursor_time(snapshot) >= target_virtual_time_ms
        ):
            return None
        decision = self._plan_fast_forward(
            binding=binding,
            snapshot=snapshot,
            tracks=tracks,
            target_virtual_time_ms=target_virtual_time_ms,
        )
        dependencies = set(decision.context.path_dependencies)
        if decision.context.blocking_reasons or not dependencies.issubset(
            {"OPEN_ORDER", "OPEN_POSITION"}
        ):
            return None
        if str(binding.get("account_model")) == "TOUCH_OR_TAPE_V2" and dependencies:
            # Contract-account marks and liquidation checks still require the
            # global event barrier while any trading path is active.
            return None
        require_empty_account = not dependencies
        limit = min(
            (
                MAX_PLAYBACK_BATCH_UNITS
                if require_empty_account
                else ORDERED_PLAYBACK_INTERACTIVE_BATCH_UNITS
            ),
            self.replay_service.settings.event_buffer_size,
            FINAL_STATE_EMPTY_ACCOUNT_CHUNK_EVENTS,
        )
        return max(1, limit), require_empty_account

    def _ordered_playback_interactive_batch_limit(
        self,
        *,
        binding: Mapping[str, object],
        tracks: tuple[Mapping[str, object], ...],
        snapshot: Mapping[str, object],
        target_virtual_time_ms: int,
    ) -> int:
        """Bound a playing account to one durable market barrier per Run lock."""

        decision = self._plan_fast_forward(
            binding=binding,
            snapshot=snapshot,
            tracks=tracks,
            target_virtual_time_ms=target_virtual_time_ms,
        )
        dependencies = set(decision.context.path_dependencies)
        if dependencies.intersection({"OPEN_ORDER", "OPEN_POSITION"}):
            return ORDERED_PLAYBACK_INTERACTIVE_BATCH_UNITS
        return 0

    @staticmethod
    def _actual_event_time_ms(
        binding: Mapping[str, object],
        virtual_time_ms: int,
    ) -> int:
        synthetic_origin = binding.get("synthetic_origin_ms")
        if synthetic_origin is None:
            return virtual_time_ms
        return (
            _stored_counter(
                binding["actual_replay_start_ms"],
                field_name="actual_replay_start_ms",
            )
            + virtual_time_ms
            - _stored_counter(synthetic_origin, field_name="synthetic_origin_ms")
        )

    @staticmethod
    def _virtual_event_time_ms(
        binding: Mapping[str, object],
        actual_time_ms: int,
    ) -> int:
        synthetic_origin = binding.get("synthetic_origin_ms")
        if synthetic_origin is None:
            return actual_time_ms
        return (
            _stored_counter(
                synthetic_origin,
                field_name="synthetic_origin_ms",
            )
            + actual_time_ms
            - _stored_counter(
                binding["actual_replay_start_ms"],
                field_name="actual_replay_start_ms",
            )
        )

    async def _guard_historical_book_current(
        self,
        *,
        run_id: str,
        binding: Mapping[str, object],
        snapshot: Mapping[str, object],
        tracks: list[Mapping[str, object]] | None = None,
    ) -> None:
        if (
            str(binding.get("book_mode", "OFF"))
            != BookMode.BOOK_ASSISTED_REQUIRED.value
        ):
            return
        cursor = _stored_mapping(snapshot.get("cursor"), field_name="adapter cursor")
        virtual_time_ms = _stored_counter(
            cursor.get("virtual_time_ms"), field_name="virtual_time_ms"
        )
        if tracks is None:
            projection = await self.store.get_market_tracks(run_id)
            values = projection.get("tracks")
            if not isinstance(values, list):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market tracks projection is invalid",
                    status_code=503,
                )
            tracks = [
                cast(Mapping[str, object], track)
                for track in values
                if isinstance(track, Mapping)
                and track.get("subscription_tier") == "FULL"
            ]
        prepared = await self.historical_books.prepare_run_projection(
            run_id=run_id,
            tracks=tracks,
            actual_time_ms=self._actual_event_time_ms(binding, virtual_time_ms),
            virtual_time_ms=virtual_time_ms,
        )
        await self.historical_books.commit_run_projection(
            run_id=run_id,
            prepared=prepared,
        )

    async def _next_global_event_time(
        self,
        *,
        run_id: str,
        binding: Mapping[str, object],
        tracks: tuple[Mapping[str, object], ...],
    ) -> int:
        candidates: list[int] = []
        for track in tracks:
            plan = await self.replay_service.plan_source_chunk(
                self._track_session_id(track),
                target_time_ms=MAX_TIMESTAMP_MS,
                max_events=1,
            )
            if _stored_counter(
                plan["event_count"], field_name="event_count"
            ) == 1 and isinstance(plan["last_event_time_ms"], int):
                candidates.append(int(plan["last_event_time_ms"]))
        next_account_actual = await self.account_history.next_event_time(
            run_id=run_id,
            tracks=tracks,
            target_actual_time_ms=_stored_counter(
                binding["actual_replay_end_ms"],
                field_name="actual_replay_end_ms",
            ),
        )
        if next_account_actual is not None:
            candidates.append(self._virtual_event_time_ms(binding, next_account_actual))
        if str(binding.get("position_mode")) == "HEDGE":
            next_hedge_actual = await self.hedge_inputs.next_event_time(
                run_id=run_id,
                target_actual_time_ms=_stored_counter(
                    binding["actual_replay_end_ms"],
                    field_name="actual_replay_end_ms",
                ),
            )
            if next_hedge_actual is not None:
                candidates.append(
                    self._virtual_event_time_ms(binding, next_hedge_actual)
                )
        if not candidates:
            raise TrainingRunError(
                "REPLAY_CONTROL_UNAVAILABLE",
                "all FULL market tracks reached the end of frozen history",
                status_code=409,
            )
        return min(candidates)

    async def _advance_adapter_to(
        self,
        *,
        session_id: str,
        target_virtual_time_ms: int,
        client_instance_id: str,
        command_id: str,
        track_id: str,
        initial_snapshot: Mapping[str, object] | None = None,
        final_state_max_events: int | None = None,
        require_empty_account: bool = False,
    ) -> Mapping[str, object]:
        known_snapshot = initial_snapshot
        for _chunk_index in range(100_000):
            snapshot = await self._ensure_track_controller(
                session_id=session_id,
                client_instance_id=client_instance_id,
                command_id=command_id,
                known_snapshot=known_snapshot,
            )
            known_snapshot = None
            cursor = snapshot.get("cursor")
            if not isinstance(cursor, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market track cursor is invalid",
                    status_code=503,
                )
            current = int(cursor["virtual_time_ms"])
            if current > target_virtual_time_ms:
                raise TrainingRunError(
                    "GLOBAL_CLOCK_DIVERGED",
                    "market track is ahead of the TrainingRun clock",
                    status_code=409,
                )
            if current == target_virtual_time_ms:
                return snapshot
            plan = await self.replay_service.plan_source_chunk(
                session_id,
                target_time_ms=target_virtual_time_ms,
                max_events=(
                    32 if final_state_max_events is None else final_state_max_events
                ),
            )
            count = _stored_counter(plan["event_count"], field_name="event_count")
            if count > 0:
                if final_state_max_events is None:
                    v1_type: CommandType | InternalCommandType = CommandType.STEP
                    payload: dict[str, object] = {"count": count}
                else:
                    v1_type = InternalCommandType.FAST_FORWARD_FINAL_STATE
                    payload = {
                        "target_virtual_time_ms": target_virtual_time_ms,
                        "max_events": count,
                        "require_empty_account": require_empty_account,
                        "snapshot_only": False,
                    }
            else:
                if snapshot["state"] == "ENDED":
                    raise TrainingRunError(
                        "MARKET_TRACK_COVERAGE_UNAVAILABLE",
                        "market track ended before the TrainingRun VirtualTime",
                        status_code=409,
                    )
                v1_type = CommandType.ADVANCE_BY
                payload = {"ms": min(target_virtual_time_ms - current, 30 * 86_400_000)}
            part = ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id=self._multi_command_id(
                    command_id,
                    track_id,
                    v1_type.value,
                    _stored_counter(snapshot["revision"], field_name="revision"),
                ),
                client_instance_id=client_instance_id,
                expected_revision=_stored_counter(
                    snapshot["revision"], field_name="revision"
                ),
                type=v1_type,
                payload=payload,
            )
            try:
                acknowledged = await self.replay_service.command(
                    session_id,
                    part,
                    _training_internal=isinstance(v1_type, InternalCommandType),
                )
            except ReplayDomainError as exc:
                raise TrainingRunError(
                    exc.code.value,
                    exc.message,
                    status_code=exc.http_status,
                    details=exc.details,
                ) from exc
            acknowledged_cursor = acknowledged.get("cursor")
            if (
                isinstance(acknowledged_cursor, Mapping)
                and int(acknowledged_cursor["virtual_time_ms"])
                == target_virtual_time_ms
            ):
                return acknowledged
            known_snapshot = acknowledged
            await asyncio.sleep(0)
        raise TrainingRunError(
            "REPLAY_SCAN_LIMIT_EXCEEDED",
            "market track catch-up exceeded the bounded chunk budget",
            status_code=409,
        )

    async def _ensure_track_controller(
        self,
        *,
        session_id: str,
        client_instance_id: str,
        command_id: str,
        known_snapshot: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]:
        if known_snapshot is None:
            session = await self.replay_service.get_session(session_id)
            snapshot = self._snapshot(session)
        else:
            snapshot = known_snapshot
        owner = snapshot.get("controller_client_id")
        if owner == client_instance_id:
            try:
                await self.replay_service.heartbeat(
                    session_id,
                    client_instance_id,
                )
                return snapshot
            except ReplayDomainError as exc:
                if exc.code is not ReplayErrorCode.CONTROLLER_CONFLICT:
                    raise TrainingRunError(
                        exc.code.value,
                        exc.message,
                        status_code=exc.http_status,
                        details=exc.details,
                    ) from exc
                session = await self.replay_service.get_session(session_id)
                snapshot = self._snapshot(session)
                owner = snapshot.get("controller_client_id")
        if owner is not None:
            raise TrainingRunError(
                "CONTROLLER_CONFLICT",
                "market track is controlled by another client",
                status_code=409,
            )
        acquire = ReplayCommand(
            protocol=REPLAY_PROTOCOL,
            command_id=self._multi_command_id(
                command_id,
                session_id,
                "acquire",
                _stored_counter(snapshot["revision"], field_name="revision"),
            ),
            client_instance_id=client_instance_id,
            expected_revision=_stored_counter(
                snapshot["revision"], field_name="revision"
            ),
            type=CommandType.ACQUIRE_CONTROLLER,
            payload={"takeover": False},
        )
        try:
            return await self.replay_service.command(session_id, acquire)
        except ReplayDomainError as exc:
            raise TrainingRunError(
                exc.code.value,
                exc.message,
                status_code=exc.http_status,
                details=exc.details,
            ) from exc

    async def _pause_ready_full_tracks(
        self,
        run_id: str,
        client_instance_id: str,
    ) -> None:
        projection = await self.store.get_market_tracks(run_id)
        tracks = projection["tracks"]
        if not isinstance(tracks, list):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "market tracks projection is invalid",
                status_code=503,
            )
        for track in sorted(tracks, key=lambda item: int(item["stable_ordinal"])):
            if track["subscription_tier"] != "FULL" or not track["adapter_session_id"]:
                continue
            session_id = str(track["adapter_session_id"])
            session = await self.replay_service.get_session(session_id)
            snapshot = self._snapshot(session)
            if snapshot["state"] != "PLAYING":
                continue
            pause = ReplayCommand(
                protocol=REPLAY_PROTOCOL,
                command_id=self._multi_command_id(
                    "select-pause",
                    str(track["track_id"]),
                    "pause",
                    _stored_counter(snapshot["revision"], field_name="revision"),
                ),
                client_instance_id=client_instance_id,
                expected_revision=_stored_counter(
                    snapshot["revision"], field_name="revision"
                ),
                type=CommandType.PAUSE,
                payload={},
            )
            try:
                await self.replay_service.command(session_id, pause)
            except ReplayDomainError as exc:
                raise TrainingRunError(
                    "MULTI_TRACK_PAUSED",
                    "global clock could not pause before selecting a track",
                    status_code=409,
                    details={"reason": exc.code.value},
                ) from exc

    async def _fail_closed_multi_track(
        self,
        *,
        run_id: str,
        tracks: tuple[Mapping[str, object], ...],
        failed_track: Mapping[str, object],
        client_instance_id: str,
        reason: str,
    ) -> None:
        await self.store.mark_market_track_error(
            run_id=run_id,
            track_id=str(failed_track["track_id"]),
            reason=reason,
            degraded=True,
        )
        for track in tracks:
            try:
                session_id = self._track_session_id(track)
                session = await self.replay_service.get_session(session_id)
                snapshot = self._snapshot(session)
                if snapshot["state"] != "PLAYING":
                    continue
                pause = ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=self._multi_command_id(
                        "fail-closed",
                        str(track["track_id"]),
                        "pause",
                        _stored_counter(snapshot["revision"], field_name="revision"),
                    ),
                    client_instance_id=client_instance_id,
                    expected_revision=_stored_counter(
                        snapshot["revision"], field_name="revision"
                    ),
                    type=CommandType.PAUSE,
                    payload={},
                )
                await self.replay_service.command(session_id, pause)
            except (ReplayDomainError, TrainingRunError):
                continue

    async def _market_track_result(
        self,
        *,
        command: ReplayV2Command,
        session_id: str,
        snapshot: Mapping[str, object],
        data: Mapping[str, object],
    ) -> dict[str, object]:
        viewer = await self.store.get_viewer_state(command.run_id)
        return self._result_payload(
            command=command,
            session_id=session_id,
            snapshot=snapshot,
            viewer=viewer.to_dict(),
            data=data,
        )

    @staticmethod
    def _result_payload(
        *,
        command: ReplayV2Command,
        session_id: str,
        snapshot: Mapping[str, object],
        viewer: Mapping[str, object],
        data: Mapping[str, object],
    ) -> dict[str, object]:
        return {
            "protocol": "replay.v3",
            "run_id": command.run_id,
            "session_id": session_id,
            "command_id": command.command_id,
            "revision": snapshot["revision"],
            "sequence": snapshot["sequence"],
            "state": snapshot["state"],
            "state_hash": snapshot["state_hash"],
            "cursor": snapshot["cursor"],
            "viewer_state": dict(viewer),
            "data": dict(data),
        }

    _PRIVATE_COMMAND_RESULT_FIELDS = frozenset(
        {
            "actual_event_time_ms",
            "actual_time_ms",
            "as_of_actual_time_ms",
            "bound_range_end_ms",
            "bound_range_start_ms",
            "global_checkpoint",
            "hedge_inputs",
            "recovery_checkpoint",
            "source_fingerprint",
        }
    )

    @classmethod
    def project_public_command_result(
        cls,
        result: Mapping[str, object],
    ) -> dict[str, object]:
        """Project a durable internal command result onto the HTTP boundary."""

        data = result.get("data")
        if not isinstance(data, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "stored command result data is invalid",
                status_code=503,
            )
        return {
            **dict(result),
            "data": cls._project_public_command_value(data),
        }

    @classmethod
    def _project_public_command_value(cls, value: object) -> object:
        if isinstance(value, Mapping):
            return {
                str(key): cls._project_public_command_value(item)
                for key, item in value.items()
                if str(key) not in cls._PRIVATE_COMMAND_RESULT_FIELDS
            }
        if isinstance(value, (list, tuple)):
            return [cls._project_public_command_value(item) for item in value]
        return value

    @staticmethod
    def _cursor_time(snapshot: Mapping[str, object]) -> int:
        cursor = snapshot.get("cursor")
        if not isinstance(cursor, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "adapter cursor is invalid",
                status_code=503,
            )
        return int(cursor["virtual_time_ms"])

    @staticmethod
    def _track_session_id(track: Mapping[str, object]) -> str:
        session_id = track.get("adapter_session_id")
        if not isinstance(session_id, str):
            raise TrainingRunError(
                "MARKET_TRACK_NOT_PREPARED",
                "FULL market track has no adapter session",
                status_code=409,
            )
        return session_id

    @staticmethod
    def _multi_command_id(
        command_id: str,
        track_id: str,
        operation: str,
        revision: int,
    ) -> str:
        material = f"{command_id}:{track_id}:{operation}:{revision}".encode("utf-8")
        return f"v2multi-{hashlib.sha256(material).hexdigest()[:40]}"

    @staticmethod
    def _assert_same_market_scope(
        *,
        binding: Mapping[str, object],
        exchange: str,
        market_type: str,
        settlement_asset: str,
    ) -> None:
        actual = (exchange, market_type, settlement_asset)
        expected = (
            str(binding["exchange"]),
            str(binding["market_type"]),
            str(binding["settlement_asset"]),
        )
        if actual != expected:
            raise TrainingRunError(
                "MARKET_SCOPE_MISMATCH",
                "multi-market tracks must share exchange, market type, and settlement asset",
                status_code=409,
                details={"expected": list(expected), "actual": list(actual)},
            )

    async def _execute_policy_command(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        snapshot: Mapping[str, object],
        session_id: str,
    ) -> dict[str, object]:
        command_value = command.type.value
        integrity_mode = IntegrityMode(str(binding["integrity_mode"]))
        allowed_payload = binding["allowed_mutations"]
        if not isinstance(allowed_payload, (list, tuple)) or any(
            not isinstance(item, str) for item in allowed_payload
        ):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training mutation allowlist is invalid",
                status_code=503,
            )
        allowed = {str(item) for item in allowed_payload}
        if integrity_mode is IntegrityMode.CHALLENGE:
            if command.type is not ReplayV2CommandType.REVEAL_TIME:
                raise TrainingRunError(
                    "INTEGRITY_POLICY_REJECTED",
                    "CHALLENGE integrity mode rejects policy mutations",
                    status_code=409,
                    details={"command": command_value},
                )
            if snapshot["state"] != "ENDED":
                raise TrainingRunError(
                    "INTEGRITY_POLICY_REJECTED",
                    "CHALLENGE time reveal is available only after the run ended",
                    status_code=409,
                )
        elif integrity_mode is IntegrityMode.PRACTICE and command_value not in allowed:
            raise TrainingRunError(
                "INTEGRITY_POLICY_REJECTED",
                "PRACTICE mutation is not in the creation-time allowlist",
                status_code=409,
                details={"command": command_value},
            )
        if command.type in {
            ReplayV2CommandType.CHANGE_FEE_POLICY,
            ReplayV2CommandType.CHANGE_LEVERAGE_CAP,
            ReplayV2CommandType.CHANGE_FUNDING_POLICY,
        }:
            if command.type is ReplayV2CommandType.CHANGE_FEE_POLICY:
                policy_payload = dict(
                    self._exact_payload(
                        command.payload,
                        {"maker_fee_bps", "taker_fee_bps", "reason"},
                    )
                )
                decimal_fields = ("maker_fee_bps", "taker_fee_bps")
            elif command.type is ReplayV2CommandType.CHANGE_LEVERAGE_CAP:
                policy_payload = dict(
                    self._exact_payload(
                        command.payload,
                        {"max_leverage", "reason"},
                    )
                )
                decimal_fields = ("max_leverage",)
            else:
                policy_payload = dict(
                    self._exact_payload(
                        command.payload,
                        {
                            "funding_mode",
                            "fixed_funding_rate",
                            "funding_interval_ms",
                            "reason",
                        },
                    )
                )
                decimal_fields = ()
            reason = policy_payload.get("reason")
            if (
                not isinstance(reason, str)
                or not reason.strip()
                or len(reason.strip()) > 500
            ):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "policy revision reason must contain 1-500 characters",
                    status_code=422,
                )
            policy_payload["reason"] = reason.strip()
            for field_name in decimal_fields:
                value = policy_payload.get(field_name)
                if not isinstance(value, str):
                    raise TrainingRunError(
                        "REPLAY_CONTROL_INVALID",
                        f"{field_name} must be a canonical Decimal string",
                        status_code=422,
                    )
                try:
                    normalized = normalize_decimal_string(
                        value,
                        field_name=field_name,
                    )
                except (TypeError, ValueError) as exc:
                    raise TrainingRunError(
                        "REPLAY_CONTROL_INVALID",
                        f"{field_name} is invalid",
                        status_code=422,
                    ) from exc
                positive = field_name == "max_leverage"
                decimal_value = Decimal(value)
                if (
                    normalized != value
                    or (positive and decimal_value <= 0)
                    or (not positive and decimal_value < 0)
                ):
                    raise TrainingRunError(
                        "REPLAY_CONTROL_INVALID",
                        f"{field_name} is outside the supported range",
                        status_code=422,
                    )
            if command.type is ReplayV2CommandType.CHANGE_FUNDING_POLICY:
                if integrity_mode is not IntegrityMode.SANDBOX:
                    raise TrainingRunError(
                        "INTEGRITY_POLICY_REJECTED",
                        "custom funding policy is available only in SANDBOX",
                        status_code=409,
                    )
                mode = policy_payload.get("funding_mode")
                rate = policy_payload.get("fixed_funding_rate")
                interval = policy_payload.get("funding_interval_ms")
                if mode == "OFF":
                    if rate is not None or interval is not None:
                        raise TrainingRunError(
                            "REPLAY_CONTROL_INVALID",
                            "OFF funding cannot include fixed funding fields",
                            status_code=422,
                        )
                elif mode == "SANDBOX_FIXED":
                    if not isinstance(rate, str) or not isinstance(interval, int):
                        raise TrainingRunError(
                            "REPLAY_CONTROL_INVALID",
                            "SANDBOX_FIXED funding requires Decimal rate and interval",
                            status_code=422,
                        )
                    try:
                        normalized_rate = normalize_decimal_string(
                            rate,
                            field_name="fixed_funding_rate",
                        )
                    except (TypeError, ValueError) as exc:
                        raise TrainingRunError(
                            "REPLAY_CONTROL_INVALID",
                            "fixed funding rate is invalid",
                            status_code=422,
                        ) from exc
                    if (
                        normalized_rate != rate
                        or isinstance(interval, bool)
                        or not 60_000 <= interval <= 30 * 86_400_000
                    ):
                        raise TrainingRunError(
                            "REPLAY_CONTROL_INVALID",
                            "fixed funding policy is outside supported bounds",
                            status_code=422,
                        )
                else:
                    raise TrainingRunError(
                        "HISTORICAL_FUNDING_UNAVAILABLE",
                        "historical exact funding cannot be enabled without aligned history",
                        status_code=409,
                        details={"fallback_applied": False},
                    )
            cursor = _stored_mapping(snapshot["cursor"], field_name="adapter cursor")
            policy = await self.store.revise_contract_policy(
                run_id=command.run_id,
                command_id=command.command_id,
                command_type=command_value,
                payload=policy_payload,
                virtual_time_ms=_stored_counter(
                    cursor["virtual_time_ms"],
                    field_name="virtual_time_ms",
                ),
                source_sequence=_stored_counter(
                    cursor["source_sequence"],
                    field_name="source_sequence",
                ),
            )
            viewer = await self.store.get_viewer_state(command.run_id)
            return self._result_payload(
                command=command,
                session_id=session_id,
                snapshot=snapshot,
                viewer=viewer.to_dict(),
                data={
                    "policy_command": command_value,
                    "atomic": True,
                    "applied": True,
                    **policy,
                },
            )
        if command.type is ReplayV2CommandType.REVEAL_TIME:
            if bool(binding["revealed"]):
                raise TrainingRunError(
                    "TIME_ALREADY_REVEALED",
                    "training time disclosure is already irreversible",
                    status_code=409,
                )
            if set(command.payload) not in (set(), {"reason"}):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "reveal_time accepts only an optional reason",
                    status_code=422,
                )
            reason = command.payload.get("reason", "user reveal")
            if (
                not isinstance(reason, str)
                or not reason.strip()
                or len(reason.strip()) > 500
            ):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "reveal reason must contain 1-500 characters",
                    status_code=422,
                )
            v1_type = InternalCommandType.REVEAL_HISTORY_AUTHORIZED
            v1_payload: dict[str, object] = {"reason": reason.strip()}
        else:
            payload = self._exact_payload(command.payload, {"amount", "reason"})
            amount = payload["amount"]
            reason = payload["reason"]
            if not isinstance(amount, str) or not isinstance(reason, str):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "capital mutation requires Decimal amount and reason strings",
                    status_code=422,
                )
            try:
                normalized_amount = normalize_decimal_string(
                    amount,
                    field_name="capital amount",
                )
            except (TypeError, ValueError) as exc:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "capital amount is invalid",
                    status_code=422,
                ) from exc
            if normalized_amount != amount or Decimal(amount) <= 0:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "capital amount must be a positive canonical Decimal string",
                    status_code=422,
                )
            normalized_reason = reason.strip()
            if not normalized_reason or len(normalized_reason) > 500:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "capital mutation reason must contain 1-500 characters",
                    status_code=422,
                )
            v1_type = InternalCommandType.ADJUST_CAPITAL
            v1_payload = {
                "kind": command_value,
                "amount": normalized_amount,
                "reason": normalized_reason,
            }
        v1_command = ReplayCommand(
            protocol=REPLAY_PROTOCOL,
            command_id=command.command_id,
            client_instance_id=command.client_instance_id,
            expected_revision=command.expected_revision,
            type=v1_type,
            payload=v1_payload,
        )
        try:
            adapter_result = await self.replay_service.command(
                session_id,
                v1_command,
                _training_internal=True,
            )
        except ReplayDomainError as exc:
            raise TrainingRunError(
                exc.code.value,
                exc.message,
                status_code=exc.http_status,
                details=exc.details,
            ) from exc
        viewer = await self.store.get_viewer_state(command.run_id)
        adapter_data = adapter_result["data"]
        if not isinstance(adapter_data, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "adapter command data is invalid",
                status_code=503,
            )
        return {
            "protocol": "replay.v3",
            "run_id": command.run_id,
            "session_id": session_id,
            "command_id": command.command_id,
            "revision": adapter_result["revision"],
            "sequence": adapter_result["sequence"],
            "state": adapter_result["state"],
            "state_hash": adapter_result["state_hash"],
            "cursor": adapter_result["cursor"],
            "viewer_state": viewer.to_dict(),
            "data": {
                **dict(adapter_data),
                "integrity_mode": integrity_mode.value,
                "policy_command": command_value,
                "adapter_command": v1_type.value,
            },
        }

    def _plan_fast_forward(
        self,
        *,
        binding: Mapping[str, object],
        snapshot: Mapping[str, object],
        tracks: tuple[Mapping[str, object], ...],
        target_virtual_time_ms: int,
        summary: ReplayPeriodSummary | None = None,
    ) -> FastForwardDecision:
        if (
            isinstance(target_virtual_time_ms, bool)
            or not isinstance(target_virtual_time_ms, int)
            or target_virtual_time_ms < 0
        ):
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "fast-forward target must be a non-negative integer",
                status_code=422,
            )
        cursor = _stored_mapping(snapshot.get("cursor"), field_name="adapter cursor")
        current = _stored_counter(
            cursor.get("virtual_time_ms"), field_name="virtual_time_ms"
        )
        full_tracks = tuple(
            track for track in tracks if track.get("subscription_tier") == "FULL"
        )
        dependencies: set[str] = set()
        blocking: set[str] = set()
        if len(full_tracks) > 1:
            dependencies.add("MULTI_TRACK_GLOBAL_ORDER")
        if str(binding.get("funding_mode")) != "OFF":
            dependencies.add("FUNDING_SCHEDULE")
        if (
            str(binding.get("account_data_mode"))
            == AccountDataMode.HISTORICAL_EXACT.value
        ):
            dependencies.add("ACCOUNT_HISTORY_TIMELINE")
        if str(binding.get("account_status")) != "ACTIVE":
            dependencies.add("ACCOUNT_RISK_STATE")
        if str(binding.get("book_mode", "OFF")) != "OFF":
            dependencies.add("BOOK_ASSISTED_PATH")
        if (
            snapshot.get("state") == "ERROR"
            or snapshot.get("degraded_reason") is not None
        ):
            blocking.add("SESSION_DEGRADED")
        terminal_order_states = {"FILLED", "CANCELED", "REJECTED", "EXPIRED"}
        for track in full_tracks or tracks:
            if (
                track.get("state") in {"DEGRADED", "ERROR"}
                or track.get("degraded_reason") is not None
            ):
                blocking.add("TRACK_DEGRADED")
            position = track.get("position")
            if _position_is_open(position):
                dependencies.add("OPEN_POSITION")
            count = track.get("open_order_count")
            if isinstance(count, int) and not isinstance(count, bool) and count > 0:
                dependencies.add("OPEN_ORDER")
        components = snapshot.get("components")
        if isinstance(components, Mapping):
            orders = components.get("orders")
            if isinstance(orders, (list, tuple)) and any(
                isinstance(order, Mapping)
                and order.get("status") not in terminal_order_states
                for order in orders
            ):
                dependencies.add("OPEN_ORDER")
            position = components.get("position")
            if _position_is_open(position):
                dependencies.add("OPEN_POSITION")
        optimization_enabled = bool(
            self.replay_service.settings.replay_fast_forward_optimization_enabled
        )
        optimized_candidate = optimization_enabled and not dependencies and not blocking
        chunk_event_limit = (
            min(
                4_096,
                self.replay_service.settings.event_buffer_size,
                self.replay_service.settings.trade_page_rows,
            )
            if optimized_candidate
            else min(32, self.replay_service.settings.event_buffer_size)
        )
        context = FastForwardContext(
            source_kind=ReplaySource(str(binding["source_kind"])),
            current_virtual_time_ms=current,
            target_virtual_time_ms=target_virtual_time_ms,
            dataset_epoch=str(binding["dataset_epoch"]),
            optimization_enabled=optimization_enabled,
            path_dependencies=tuple(dependencies),
            blocking_reasons=tuple(blocking),
            checkpoint_identity_match=summary is not None,
            checkpoint_state_hash=(
                summary.summary_hash if summary is not None else None
            ),
            estimated_events=(summary.event_count if summary is not None else None),
            chunk_event_limit=max(1, chunk_event_limit),
            tail_event_count=(min(32, chunk_event_limit) if optimized_candidate else 0),
            track_count=max(1, len(full_tracks)),
        )
        return self._fast_forward_planner.plan(context)

    async def _eligible_period_summary(
        self,
        *,
        run_id: str,
        binding: Mapping[str, object],
        snapshot: Mapping[str, object],
        target_virtual_time_ms: int,
    ) -> Mapping[str, object]:
        if (
            str(binding.get("account_data_mode"))
            == AccountDataMode.HISTORICAL_EXACT.value
        ):
            return {
                "status": "BLOCKED",
                "reason_code": "ACCOUNT_HISTORY_TIMELINE_REFERENCE_PATH_REQUIRED",
                "summary": None,
            }
        if not bool(
            self.replay_service.settings.replay_fast_forward_optimization_enabled
        ):
            return {
                "status": "DISABLED",
                "reason_code": "OPTIMIZATION_DISABLED",
                "summary": None,
            }
        cursor = _stored_mapping(snapshot.get("cursor"), field_name="adapter cursor")
        session_id = str(binding["adapter_session_id"])
        authority = await self.replay_service.summary_authority(session_id)
        if authority.get("has_active_trading_path") is True:
            return {
                "status": "INCOMPATIBLE",
                "reason_code": "ACTIVE_TRADING_PATH",
                "summary": None,
            }
        integrity = await self.store.integrity(run_id)
        lookup = await self.store.period_summary_candidate(
            run_id=run_id,
            current_source_sequence=_stored_counter(
                cursor.get("source_sequence"),
                field_name="source_sequence",
            ),
            target_virtual_time_ms=target_virtual_time_ms,
            identity={
                "session_id": session_id,
                "source_kind": str(binding["source_kind"]),
                "data_epoch": str(authority["data_epoch"]),
                "snapshot_ref_hash": str(authority["snapshot_ref_hash"]),
                "session_config_hash": str(authority["session_config_hash"]),
                "execution_version": str(authority["execution_version"]),
                "rule_revision": int(integrity["active_rule_revision"]),
                "rule_hash": str(integrity["active_rule_hash"]),
            },
        )
        candidate = lookup.get("summary")
        if not isinstance(candidate, ReplayPeriodSummary):
            return lookup
        if candidate.base_domain_command_position != int(
            authority["domain_command_position"]
        ):
            return {
                "status": "INCOMPATIBLE",
                "reason_code": "SUMMARY_DOMAIN_LINEAGE_MISMATCH",
                "summary": None,
            }
        current_sequence = _stored_counter(
            cursor.get("source_sequence"),
            field_name="source_sequence",
        )
        if current_sequence == candidate.base_source_sequence and (
            candidate.base_event_chain_hash != authority["event_chain_hash"]
            or candidate.base_component_state_hash != authority["component_state_hash"]
        ):
            return {
                "status": "INCOMPATIBLE",
                "reason_code": "SUMMARY_BASE_STATE_MISMATCH",
                "summary": None,
            }
        return lookup

    @staticmethod
    def _fast_forward_plan_payload(
        decision: FastForwardDecision,
        *,
        summary_lookup: Mapping[str, object],
    ) -> dict[str, object]:
        payload = decision.to_dict()
        candidate = summary_lookup.get("summary")
        payload["period_summary"] = {
            "status": str(summary_lookup.get("status", "UNAVAILABLE")),
            "reason_code": str(
                summary_lookup.get("reason_code", "SUMMARY_UNAVAILABLE")
            ),
            **(
                {
                    "set_id": str(summary_lookup["set_id"]),
                    "summary_id": candidate.summary_id,
                    "summary_hash": candidate.summary_hash,
                    "build_proof_hash": str(summary_lookup["build_proof_hash"]),
                    "base_source_sequence": candidate.base_source_sequence,
                    "end_source_sequence": candidate.end_source_sequence,
                    "skippable_source_events": candidate.event_count,
                    "algorithm_version": candidate.algorithm_version,
                }
                if isinstance(candidate, ReplayPeriodSummary)
                else {}
            ),
        }
        return payload

    async def get_advance_progress(
        self,
        run_id: str,
        command_id: str,
    ) -> dict[str, object]:
        normalized_run = self._identifier(run_id, field_name="run_id")
        normalized_command = self._identifier(command_id, field_name="command_id")
        job = self._advance_jobs.get((normalized_run, normalized_command))
        if job is None:
            raise TrainingRunError(
                "ADVANCE_NOT_ACTIVE",
                "advance command is not active",
                status_code=404,
            )
        return {
            "protocol": "replay.v3",
            "run_id": normalized_run,
            "command_id": normalized_command,
            "progress": self._public_progress(job),
        }

    async def _execute_target_scan(
        self,
        *,
        command: ReplayV2Command,
        session_id: str,
        target_virtual_time_ms: int,
        plan: Mapping[str, object],
        summary: ReplayPeriodSummary | None,
        resuming: bool = False,
    ) -> dict[str, object]:
        key = (command.run_id, command.command_id)
        if key in self._advance_jobs:
            raise TrainingRunError(
                "ADVANCE_ALREADY_ACTIVE",
                "advance command is already active",
                status_code=409,
            )
        initial_cursor = command.expected_cursor.to_dict()
        intent = await self.store.begin_advance_intent(
            run_id=command.run_id,
            command_id=command.command_id,
            command=command.to_dict(),
            session_id=session_id,
            initial_cursor=initial_cursor,
            target_virtual_time_ms=target_virtual_time_ms,
            plan=plan,
            summary=summary,
        )
        if str(intent["status"]) in {"COMPLETED", "CANCELLED"}:
            result = intent.get("result")
            if not isinstance(result, Mapping):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "completed advance intent is missing its result",
                    status_code=503,
                )
            return dict(result)
        if (
            str(intent["session_id"]) != session_id
            or int(intent["target_virtual_time_ms"]) != target_virtual_time_ms
        ):
            raise TrainingRunError(
                "COMMAND_ID_REUSED",
                "durable advance identity changed",
                status_code=409,
            )
        stored_initial_cursor = _stored_mapping(
            intent["initial_cursor"],
            field_name="durable initial cursor",
        )
        initial = _stored_counter(
            stored_initial_cursor.get("virtual_time_ms"),
            field_name="initial_virtual_time_ms",
        )
        if target_virtual_time_ms <= initial:
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "advance target must be ahead of the current cursor",
                status_code=422,
            )
        binding = await self.store.run_binding(command.run_id)
        prepared_book: tuple[tuple[str, HistoricalBookProjection], ...] = ()
        full_tracks: list[Mapping[str, object]] = []
        if (
            str(binding.get("book_mode", "OFF"))
            == BookMode.BOOK_ASSISTED_REQUIRED.value
        ):
            track_projection = await self.store.get_market_tracks(command.run_id)
            raw_tracks = track_projection.get("tracks")
            if not isinstance(raw_tracks, list):
                raise TrainingRunError(
                    "TRAINING_RUN_STORAGE_DEGRADED",
                    "market tracks projection is invalid",
                    status_code=503,
                )
            full_tracks = [
                cast(Mapping[str, object], track)
                for track in raw_tracks
                if isinstance(track, Mapping)
                and track.get("subscription_tier") == "FULL"
            ]
            prepared_book = await self.historical_books.prepare_run_projection(
                run_id=command.run_id,
                tracks=full_tracks,
                actual_time_ms=self._actual_event_time_ms(
                    binding,
                    target_virtual_time_ms,
                ),
                virtual_time_ms=target_virtual_time_ms,
            )
        cancel = asyncio.Event()
        job: dict[str, object] = {
            "cancel": cancel,
            "client_instance_id": command.client_instance_id,
            "status": "RUNNING",
            "initial_virtual_time_ms": initial,
            "target_virtual_time_ms": target_virtual_time_ms,
            "current_virtual_time_ms": initial,
            "consumed": 0,
            "summary_skipped_events": 0,
            "tail_reducer_events": 0,
            "coalesced_projection_events": 0,
            "published_projection_events": 0,
            "batch_reducer_events": 0,
            "chunks": 0,
            "simulated_account_liquidations": 0,
            "cancelable": bool(plan.get("cancelable", False)),
            "plan": dict(plan),
            "chunk_event_limit": _stored_counter(
                plan.get("chunk_event_limit", 32), field_name="chunk_event_limit"
            ),
            "queue_high_water": 0,
            "resumed_from_intent": resuming,
        }
        self._advance_jobs[key] = job
        try:
            summary_applied: ReplayPeriodSummary | None = None
            if (
                summary is not None
                and plan.get("mode") == FastForwardPlan.CHECKPOINT_JUMP.value
            ):
                current = _stored_mapping(
                    await self.replay_service.get_session_state(session_id),
                    field_name="adapter snapshot",
                )
                current_cursor = _stored_mapping(
                    current.get("cursor"),
                    field_name="adapter cursor",
                )
                current_sequence = _stored_counter(
                    current_cursor.get("source_sequence"),
                    field_name="source_sequence",
                )
                if (
                    current_sequence < summary.end_source_sequence
                    and _stored_counter(
                        current_cursor.get("virtual_time_ms"),
                        field_name="virtual_time_ms",
                    )
                    < summary.end_virtual_time_ms
                ):
                    try:
                        jumped = await self.replay_service.apply_period_summary(
                            session_id,
                            summary,
                            client_instance_id=command.client_instance_id,
                            expected_revision=_stored_counter(
                                current.get("revision"),
                                field_name="revision",
                            ),
                        )
                    except ReplayDomainError as exc:
                        fallback_plan = dict(plan)
                        fallback_plan["mode"] = FastForwardPlan.AGGREGATE_SCAN.value
                        fallback_plan["plan"] = FastForwardPlan.AGGREGATE_SCAN.value
                        fallback_plan["period_summary"] = {
                            "status": "RUNTIME_REJECTED",
                            "reason_code": exc.code.value,
                            "fallback": FastForwardPlan.AGGREGATE_SCAN.value,
                        }
                        plan = fallback_plan
                        job["plan"] = fallback_plan
                    else:
                        skipped = _stored_counter(
                            jumped.get("skipped_source_events"),
                            field_name="summary skipped_source_events",
                        )
                        summary_applied = summary
                        job["summary_skipped_events"] = skipped
                        job["consumed"] = skipped
                        jumped_snapshot = _stored_mapping(
                            jumped.get("snapshot"),
                            field_name="summary jump snapshot",
                        )
                        jumped_cursor = _stored_mapping(
                            jumped_snapshot.get("cursor"),
                            field_name="summary jump cursor",
                        )
                        job["current_virtual_time_ms"] = _stored_counter(
                            jumped_cursor.get("virtual_time_ms"),
                            field_name="virtual_time_ms",
                        )
                        await self.store.update_advance_intent_cursor(
                            run_id=command.run_id,
                            command_id=command.command_id,
                            cursor=jumped_cursor,
                        )
            while True:
                if cancel.is_set():
                    job["status"] = "CANCELLED"
                    break
                current = _stored_mapping(
                    await self.replay_service.get_session_state(session_id),
                    field_name="adapter snapshot",
                )
                cursor = _stored_mapping(
                    current.get("cursor"), field_name="adapter cursor"
                )
                current_time = _stored_counter(
                    cursor.get("virtual_time_ms"), field_name="virtual_time_ms"
                )
                job["current_virtual_time_ms"] = current_time
                if (
                    current_time >= target_virtual_time_ms
                    or current["state"] == "ENDED"
                ):
                    job["status"] = "COMPLETED"
                    break
                v1_type: CommandType | InternalCommandType
                payload: dict[str, object]
                if plan.get("projection_delivery") == FINAL_STATE_PROJECTION_DELIVERY:
                    v1_type = InternalCommandType.FAST_FORWARD_FINAL_STATE
                    payload = {
                        "target_virtual_time_ms": target_virtual_time_ms,
                        "max_events": _stored_counter(
                            job.get("chunk_event_limit"),
                            field_name="chunk_event_limit",
                        ),
                        "require_empty_account": (
                            plan.get("path_execution") == "EMPTY_ACCOUNT"
                        ),
                        "snapshot_only": False,
                    }
                else:
                    chunk = await self.replay_service.plan_source_chunk(
                        session_id,
                        target_time_ms=target_virtual_time_ms,
                        max_events=_stored_counter(
                            job.get("chunk_event_limit"),
                            field_name="chunk_event_limit",
                        ),
                    )
                    if cancel.is_set():
                        job["status"] = "CANCELLED"
                        break
                    count = _stored_counter(
                        chunk.get("event_count"), field_name="event_count"
                    )
                    if count > 0:
                        if plan.get("mode") in {
                            FastForwardPlan.AGGREGATE_SCAN.value,
                            FastForwardPlan.CHECKPOINT_JUMP.value,
                        }:
                            v1_type = InternalCommandType.FAST_FORWARD_EMPTY_ACCOUNT
                            payload = {
                                "count": count,
                                "tail_events": min(
                                    count,
                                    _stored_counter(
                                        plan.get("tail_event_count", 0),
                                        field_name="tail_event_count",
                                    ),
                                ),
                            }
                        else:
                            v1_type = CommandType.STEP
                            payload = {"count": count}
                    else:
                        # The v1 adapter bounds one duration command to 30 days.
                        duration = min(
                            target_virtual_time_ms - current_time,
                            30 * 86_400_000,
                        )
                        v1_type = CommandType.ADVANCE_BY
                        payload = {"ms": duration}
                part = ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=self._advance_part_id(
                        command,
                        source_sequence=_stored_counter(
                            cursor.get("source_sequence"),
                            field_name="source_sequence",
                        ),
                        virtual_time_ms=current_time,
                        target_virtual_time_ms=target_virtual_time_ms,
                    ),
                    client_instance_id=command.client_instance_id,
                    expected_revision=_stored_counter(
                        current.get("revision"), field_name="revision"
                    ),
                    type=v1_type,
                    payload=payload,
                )
                try:
                    acknowledged = await self.replay_service.command(
                        session_id,
                        part,
                        _training_internal=isinstance(v1_type, InternalCommandType),
                    )
                except ReplayDomainError as exc:
                    raise TrainingRunError(
                        exc.code.value,
                        exc.message,
                        status_code=exc.http_status,
                        details=exc.details,
                    ) from exc
                acknowledged_data = _stored_mapping(
                    acknowledged.get("data"), field_name="adapter command data"
                )
                acknowledged_cursor = _stored_mapping(
                    acknowledged.get("cursor"), field_name="adapter cursor"
                )
                acknowledged_consumed = _stored_counter(
                    acknowledged_data.get("consumed", 0),
                    field_name="acknowledged consumed",
                )
                acknowledged_time = _stored_counter(
                    acknowledged_cursor.get("virtual_time_ms"),
                    field_name="virtual_time_ms",
                )
                if (
                    acknowledged_consumed == 0
                    and acknowledged_time <= current_time
                    and acknowledged.get("state") != "ENDED"
                ):
                    raise TrainingRunError(
                        ReplayErrorCode.DATASET_MISMATCH.value,
                        "fast-forward chunk made no cursor progress",
                        status_code=409,
                    )
                job["chunks"] = (
                    _stored_counter(job.get("chunks"), field_name="chunks") + 1
                )
                job["queue_high_water"] = max(
                    _stored_counter(
                        job.get("queue_high_water"), field_name="queue_high_water"
                    ),
                    1,
                )
                job["consumed"] = (
                    _stored_counter(job.get("consumed"), field_name="consumed")
                    + acknowledged_consumed
                )
                job["tail_reducer_events"] = (
                    _stored_counter(
                        job.get("tail_reducer_events"),
                        field_name="tail_reducer_events",
                    )
                    + acknowledged_consumed
                )
                job["coalesced_projection_events"] = _stored_counter(
                    job.get("coalesced_projection_events"),
                    field_name="coalesced_projection_events",
                ) + _stored_counter(
                    acknowledged_data.get("coalesced_projection_events", 0),
                    field_name="acknowledged coalesced_projection_events",
                )
                job["published_projection_events"] = _stored_counter(
                    job.get("published_projection_events"),
                    field_name="published_projection_events",
                ) + _stored_counter(
                    acknowledged_data.get("published_projection_events", 0),
                    field_name="acknowledged published_projection_events",
                )
                job["batch_reducer_events"] = _stored_counter(
                    job.get("batch_reducer_events"),
                    field_name="batch_reducer_events",
                ) + _stored_counter(
                    acknowledged_data.get("batch_reducer_events", 0),
                    field_name="acknowledged batch_reducer_events",
                )
                job["current_virtual_time_ms"] = acknowledged_time
                await self.store.update_advance_intent_cursor(
                    run_id=command.run_id,
                    command_id=command.command_id,
                    cursor=acknowledged_cursor,
                )
                job["simulated_account_liquidations"] = _stored_counter(
                    job.get("simulated_account_liquidations"),
                    field_name="simulated_account_liquidations",
                ) + await self._reconcile_liquidations(
                    run_id=command.run_id,
                    client_instance_id=command.client_instance_id,
                    command_id=command.command_id,
                )
                await asyncio.sleep(0)

            if (
                job.get("status") == "CANCELLED"
                and plan.get("projection_delivery") == FINAL_STATE_PROJECTION_DELIVERY
                and _stored_counter(job.get("consumed"), field_name="consumed") > 0
            ):
                cancelled_state = _stored_mapping(
                    await self.replay_service.get_session_state(session_id),
                    field_name="adapter snapshot",
                )
                cancelled_cursor = _stored_mapping(
                    cancelled_state.get("cursor"),
                    field_name="adapter cursor",
                )
                cancelled_time = _stored_counter(
                    cancelled_cursor.get("virtual_time_ms"),
                    field_name="virtual_time_ms",
                )
                sync = ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=self._advance_part_id(
                        command,
                        source_sequence=_stored_counter(
                            cancelled_cursor.get("source_sequence"),
                            field_name="source_sequence",
                        ),
                        virtual_time_ms=cancelled_time,
                        target_virtual_time_ms=cancelled_time,
                    ),
                    client_instance_id=command.client_instance_id,
                    expected_revision=_stored_counter(
                        cancelled_state.get("revision"),
                        field_name="revision",
                    ),
                    type=InternalCommandType.FAST_FORWARD_FINAL_STATE,
                    payload={
                        "target_virtual_time_ms": cancelled_time,
                        "max_events": 1,
                        "require_empty_account": False,
                        "snapshot_only": True,
                    },
                )
                try:
                    synchronized = await self.replay_service.command(
                        session_id,
                        sync,
                        _training_internal=True,
                    )
                except ReplayDomainError as exc:
                    raise TrainingRunError(
                        exc.code.value,
                        exc.message,
                        status_code=exc.http_status,
                        details=exc.details,
                    ) from exc
                synchronized_cursor = _stored_mapping(
                    synchronized.get("cursor"),
                    field_name="adapter cursor",
                )
                await self.store.update_advance_intent_cursor(
                    run_id=command.run_id,
                    command_id=command.command_id,
                    cursor=synchronized_cursor,
                )
                job["cancel_snapshot_published"] = True

            final_response = await self.replay_service.get_session(session_id)
            final = _stored_mapping(
                final_response.get("snapshot"), field_name="adapter snapshot"
            )
            final_cursor = _stored_mapping(
                final.get("cursor"), field_name="adapter cursor"
            )
            if prepared_book:
                final_virtual_time = _stored_counter(
                    final_cursor.get("virtual_time_ms"), field_name="virtual_time_ms"
                )
                if final_virtual_time != target_virtual_time_ms:
                    prepared_book = await self.historical_books.prepare_run_projection(
                        run_id=command.run_id,
                        tracks=full_tracks,
                        actual_time_ms=self._actual_event_time_ms(
                            binding,
                            final_virtual_time,
                        ),
                        virtual_time_ms=final_virtual_time,
                    )
                await self.historical_books.commit_run_projection(
                    run_id=command.run_id,
                    prepared=prepared_book,
                )
            viewer = await self.store.get_viewer_state(command.run_id)
            resolved_plan = dict(plan)
            equivalence = resolved_plan.get("equivalence")
            if isinstance(equivalence, Mapping):
                components = final.get("components")
                component_hash = (
                    canonical_sha256(components)
                    if isinstance(components, Mapping)
                    else None
                )
                report_response = await self.replay_service.report(session_id)
                report_payload = report_response.get("report")
                report_hash = (
                    canonical_sha256(report_payload)
                    if isinstance(report_payload, Mapping)
                    else None
                )
                resolved_plan["equivalence"] = {
                    **dict(equivalence),
                    "status": (
                        "VERIFIED_BY_CHECKPOINT_SUMMARY_TAIL"
                        if summary_applied is not None
                        else (
                            "VERIFIED_BY_EXACT_REDUCER_PATH"
                            if resolved_plan.get("optimized") is True
                            else "REFERENCE_PATH"
                        )
                    ),
                    "observed_state_hash": final["state_hash"],
                    "observed_component_state_hash": component_hash,
                    "observed_report_hash": report_hash,
                    "observed_cursor": dict(final_cursor),
                    "consumed_source_events": _stored_counter(
                        job.get("consumed"), field_name="consumed"
                    ),
                    "summary_skipped_events": _stored_counter(
                        job.get("summary_skipped_events"),
                        field_name="summary_skipped_events",
                    ),
                    "tail_reducer_events": _stored_counter(
                        job.get("tail_reducer_events"),
                        field_name="tail_reducer_events",
                    ),
                    **(
                        {
                            "summary_id": summary_applied.summary_id,
                            "summary_hash": summary_applied.summary_hash,
                            "summary_component_state_hash": (
                                summary_applied.end_component_state_hash
                            ),
                        }
                        if summary_applied is not None
                        else {}
                    ),
                }
            job["plan"] = resolved_plan
            if job.get("status") in {"COMPLETED", "CANCELLED"}:
                job["cancelable"] = False
            progress = self._public_progress(job)
            result = {
                "protocol": "replay.v3",
                "run_id": command.run_id,
                "session_id": session_id,
                "command_id": command.command_id,
                "revision": final["revision"],
                "sequence": final["sequence"],
                "state": final["state"],
                "state_hash": final["state_hash"],
                "cursor": final["cursor"],
                "viewer_state": viewer.to_dict(),
                "data": {
                    "consumed": _stored_counter(
                        job.get("consumed"), field_name="consumed"
                    ),
                    "summary_skipped_events": _stored_counter(
                        job.get("summary_skipped_events"),
                        field_name="summary_skipped_events",
                    ),
                    "tail_reducer_events": _stored_counter(
                        job.get("tail_reducer_events"),
                        field_name="tail_reducer_events",
                    ),
                    "coalesced_projection_events": _stored_counter(
                        job.get("coalesced_projection_events"),
                        field_name="coalesced_projection_events",
                    ),
                    "published_projection_events": _stored_counter(
                        job.get("published_projection_events"),
                        field_name="published_projection_events",
                    ),
                    "batch_reducer_events": _stored_counter(
                        job.get("batch_reducer_events"),
                        field_name="batch_reducer_events",
                    ),
                    "cancelled": job["status"] == "CANCELLED",
                    "target_virtual_time_ms": target_virtual_time_ms,
                    "plan": resolved_plan,
                    "progress": progress,
                    "simulated_account_liquidations": _stored_counter(
                        job.get("simulated_account_liquidations"),
                        field_name="simulated_account_liquidations",
                    ),
                },
            }
            await self.store.finish_advance_intent(
                run_id=command.run_id,
                command_id=command.command_id,
                result=result,
                cancelled=job["status"] == "CANCELLED",
            )
            return result
        finally:
            if job.get("status") in {"COMPLETED", "CANCELLED"}:
                # The browser starts polling while the command response is still
                # in flight. Retain only terminal progress briefly so that race
                # returns 200 without leaving a completed job cancelable.
                job["cancelable"] = False
                asyncio.get_running_loop().call_later(
                    ADVANCE_PROGRESS_RETENTION_SECONDS,
                    self._advance_jobs.pop,
                    key,
                    None,
                )
            else:
                self._advance_jobs.pop(key, None)

    async def _cancel_advance(
        self,
        command: ReplayV2Command,
        *,
        session_id: str,
    ) -> dict[str, object]:
        payload = self._exact_payload(command.payload, {"advance_command_id"})
        advance_command_id = payload["advance_command_id"]
        if not isinstance(advance_command_id, str):
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "advance_command_id must be a string",
                status_code=422,
            )
        advance_command_id = self._identifier(
            advance_command_id,
            field_name="advance_command_id",
        )
        job = self._advance_jobs.get((command.run_id, advance_command_id))
        if job is None or not bool(job["cancelable"]):
            raise TrainingRunError(
                "ADVANCE_NOT_ACTIVE",
                "cancelable advance command is not active",
                status_code=404,
            )
        if job["client_instance_id"] != command.client_instance_id:
            raise TrainingRunError(
                "CONTROLLER_CONFLICT",
                "only the client that started an advance can cancel it",
                status_code=409,
            )
        cancel = job["cancel"]
        if not isinstance(cancel, asyncio.Event):
            raise RuntimeError("advance cancellation state is invalid")
        job["status"] = "CANCEL_REQUESTED"
        cancel.set()
        current_response = await self.replay_service.get_session(session_id)
        current = current_response["snapshot"]
        viewer = await self.store.get_viewer_state(command.run_id)
        return {
            "protocol": "replay.v3",
            "run_id": command.run_id,
            "session_id": session_id,
            "command_id": command.command_id,
            "revision": current["revision"],
            "sequence": current["sequence"],
            "state": current["state"],
            "state_hash": current["state_hash"],
            "cursor": current["cursor"],
            "viewer_state": viewer.to_dict(),
            "data": {
                "cancel_requested": True,
                "advance_command_id": advance_command_id,
                "progress": self._public_progress(job),
            },
        }

    @staticmethod
    def _public_progress(job: Mapping[str, object]) -> dict[str, object]:
        initial = _stored_counter(
            job.get("initial_virtual_time_ms"), field_name="initial_virtual_time_ms"
        )
        target = _stored_counter(
            job.get("target_virtual_time_ms"), field_name="target_virtual_time_ms"
        )
        current = min(
            target,
            max(
                initial,
                _stored_counter(
                    job.get("current_virtual_time_ms"),
                    field_name="current_virtual_time_ms",
                ),
            ),
        )
        span = target - initial
        ratio_ppm = (
            1_000_000 if span <= 0 else ((current - initial) * 1_000_000) // span
        )
        return {
            "status": str(job["status"]),
            "current_virtual_time_ms": current,
            "target_virtual_time_ms": target,
            "ratio_ppm": ratio_ppm,
            "consumed": _stored_counter(job.get("consumed"), field_name="consumed"),
            "summary_skipped_events": _stored_counter(
                job.get("summary_skipped_events", 0),
                field_name="summary_skipped_events",
            ),
            "tail_reducer_events": _stored_counter(
                job.get("tail_reducer_events", 0),
                field_name="tail_reducer_events",
            ),
            "coalesced_projection_events": _stored_counter(
                job.get("coalesced_projection_events", 0),
                field_name="coalesced_projection_events",
            ),
            "published_projection_events": _stored_counter(
                job.get("published_projection_events", 0),
                field_name="published_projection_events",
            ),
            "batch_reducer_events": _stored_counter(
                job.get("batch_reducer_events", 0),
                field_name="batch_reducer_events",
            ),
            "chunks": _stored_counter(job.get("chunks"), field_name="chunks"),
            "cancelable": bool(job["cancelable"]),
            "commit_boundary": "COMPLETE_ACTOR_COMMAND",
            "chunk_event_limit": _stored_counter(
                job.get("chunk_event_limit", 32), field_name="chunk_event_limit"
            ),
            "queue_high_water": _stored_counter(
                job.get("queue_high_water", 0), field_name="queue_high_water"
            ),
            "plan": dict(
                _stored_mapping(job.get("plan"), field_name="fast-forward plan")
            ),
        }

    @staticmethod
    def _advance_part_id(
        command: ReplayV2Command,
        *,
        source_sequence: int,
        virtual_time_ms: int,
        target_virtual_time_ms: int,
    ) -> str:
        material = (
            f"{command.run_id}:{command.command_id}:{source_sequence}:"
            f"{virtual_time_ms}:{target_virtual_time_ms}"
        ).encode("utf-8")
        return f"v2part-{hashlib.sha256(material).hexdigest()[:40]}"

    async def _set_display_interval(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        snapshot: Mapping[str, object],
    ) -> dict[str, object]:
        payload = self._exact_payload(
            command.payload,
            {"display_interval", "expected_viewer_revision"},
        )
        interval = payload["display_interval"]
        if not isinstance(interval, str):
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "display_interval must be a string",
                status_code=422,
            )
        base_interval = str(binding["base_interval"])
        compatible_step_interval_ms(
            base_interval=base_interval,
            step_interval=interval,
        )
        expected_viewer_revision = payload["expected_viewer_revision"]
        if (
            isinstance(expected_viewer_revision, bool)
            or not isinstance(expected_viewer_revision, int)
            or expected_viewer_revision < 0
        ):
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "expected_viewer_revision must be a non-negative integer",
                status_code=422,
            )
        viewer = await self.store.set_display_interval(
            run_id=command.run_id,
            display_interval=interval,
            expected_revision=expected_viewer_revision,
            command_id=command.command_id,
            command=command.to_dict(),
        )
        cursor = dict(snapshot["cursor"])  # type: ignore[arg-type]
        return {
            "protocol": "replay.v3",
            "run_id": command.run_id,
            "session_id": snapshot["session_id"],
            "command_id": command.command_id,
            "revision": snapshot["revision"],
            "sequence": snapshot["sequence"],
            "state": snapshot["state"],
            "state_hash": snapshot["state_hash"],
            "cursor": cursor,
            "viewer_state": viewer.to_dict(),
            "data": {
                "source_events_consumed": 0,
                "domain_hash_unchanged": True,
                "display_interval": interval,
            },
        }

    async def _validate_display_binding(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        base_interval: str,
        display_interval: object,
        viewer_revision: object,
    ) -> tuple[str, int]:
        if (
            not isinstance(display_interval, str)
            or isinstance(viewer_revision, bool)
            or not isinstance(viewer_revision, int)
            or viewer_revision < 0
        ):
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "display control binding is invalid",
                status_code=422,
            )
        compatible_step_interval_ms(
            base_interval=base_interval,
            step_interval=display_interval,
        )
        submitted_view = await self.store.viewer_state_at_revision(
            command.run_id,
            viewer_revision,
        )
        if (
            submitted_view.display_interval != display_interval
            or submitted_view.selected_track_id != str(binding["selected_track_id"])
        ):
            raise TrainingRunError(
                "VIEWER_REVISION_CONFLICT",
                "display control does not match the bound viewer revision",
                status_code=409,
            )
        return display_interval, viewer_revision

    async def _display_advance_target(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        base_interval: str,
        current_time: int,
        count: int,
        display_interval: object,
        viewer_revision: object,
    ) -> tuple[int, str, int]:
        interval, revision = await self._validate_display_binding(
            command=command,
            binding=binding,
            base_interval=base_interval,
            display_interval=display_interval,
            viewer_revision=viewer_revision,
        )
        return (
            await self._source_aligned_display_target(
                binding=binding,
                current_virtual_time_ms=current_time,
                base_interval=base_interval,
                display_interval=interval,
                count=count,
            ),
            interval,
            revision,
        )

    async def _display_source_bucket_anchor_ms(
        self,
        *,
        binding: Mapping[str, object],
        display_interval: str,
    ) -> int | None:
        if display_interval == str(binding["base_interval"]):
            return None
        history_binding = await self.store.history_binding(
            session_id=str(binding["adapter_session_id"]),
            track_id=str(binding["selected_track_id"]),
        )
        cache_key = (
            str(history_binding["run_id"]),
            str(history_binding["track_id"]),
            display_interval,
            str(history_binding["track_dataset_epoch"]),
        )
        cached = self._display_source_grid_anchors.get(cache_key)
        if cached is not None:
            return cached
        grid_binding = await self._attach_native_display_archive_pin(
            history_binding,
            display_interval=display_interval,
            require_projection_grid=True,
        )
        raw_anchor = grid_binding.get("display_source_bucket_anchor_ms")
        if raw_anchor is None:
            return None
        if isinstance(raw_anchor, bool) or not isinstance(raw_anchor, int):
            raise TrainingRunError(
                "HISTORY_SOURCE_INCOMPLETE",
                "pinned native display grid anchor is invalid",
                status_code=503,
            )
        self._display_source_grid_anchors[cache_key] = raw_anchor
        return raw_anchor

    async def _source_aligned_display_target(
        self,
        *,
        binding: Mapping[str, object],
        current_virtual_time_ms: int,
        base_interval: str,
        display_interval: str,
        count: int,
    ) -> int:
        actual_start_ms = _stored_counter(
            binding["actual_replay_start_ms"],
            field_name="actual_replay_start_ms",
        )
        synthetic_origin_ms = binding.get("synthetic_origin_ms")
        public_start_ms = (
            actual_start_ms
            if synthetic_origin_ms is None
            else _stored_counter(
                synthetic_origin_ms,
                field_name="synthetic_origin_ms",
            )
        )
        source_bucket_anchor_ms = await self._display_source_bucket_anchor_ms(
            binding=binding,
            display_interval=display_interval,
        )
        return source_aligned_step_target_ms(
            current_virtual_time_ms=current_virtual_time_ms,
            actual_replay_start_ms=actual_start_ms,
            public_replay_start_ms=public_start_ms,
            source_bucket_anchor_ms=source_bucket_anchor_ms,
            base_interval=base_interval,
            step_interval=display_interval,
            count=count,
        )

    @staticmethod
    def _legacy_playback_rate(value: object) -> int:
        return control_rate(
            10_000 if value == "MAX" else value,
            field_name="rate",
        )

    async def _playback_profile(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        selected_snapshot: Mapping[str, object],
        full_track_count: int,
        actor: TrainingRunActor,
    ) -> tuple[AdvanceBasis, int, str | None, int | None, bool]:
        """Validate one canonical profile or resolve a legacy default.

        The returned boolean marks the old empty-PLAY / speed-only contract.
        It is used only to preserve adapter compatibility; the public clock is
        always normalized to replay.playback.v1.
        """

        source_kind = str(binding["source_kind"])
        base_interval = str(binding["base_interval"])
        allowed = supported_playback_bases(
            source_kind=source_kind,
            full_track_count=full_track_count,
        )
        payload = command.payload
        legacy = not payload or set(payload) == {"speed"}
        if legacy:
            actor_profile = actor.playback_snapshot()
            profile_revision = actor_profile.get("profile_revision")
            candidate_basis: AdvanceBasis
            if (
                isinstance(profile_revision, int)
                and not isinstance(profile_revision, bool)
                and profile_revision > 0
                and actor_profile.get("basis") is not None
            ):
                candidate_basis = advance_basis(actor_profile["basis"])
            else:
                candidate_basis = default_playback_basis(source_kind)
            basis = (
                candidate_basis
                if candidate_basis in allowed
                else default_playback_basis(source_kind)
            )
            if set(payload) == {"speed"}:
                rate = self._legacy_playback_rate(payload["speed"])
            elif (
                isinstance(profile_revision, int)
                and not isinstance(profile_revision, bool)
                and profile_revision > 0
            ):
                rate = control_rate(actor_profile.get("rate"))
            else:
                rate = self._legacy_playback_rate(selected_snapshot.get("speed", 1))
            display_interval = (
                actor_profile.get("display_interval")
                if basis is AdvanceBasis.DISPLAY_BAR
                else None
            )
            viewer_revision = (
                actor_profile.get("viewer_revision")
                if basis is AdvanceBasis.DISPLAY_BAR
                else None
            )
            if basis is AdvanceBasis.DISPLAY_BAR:
                (
                    display_interval,
                    viewer_revision,
                ) = await self._validate_display_binding(
                    command=command,
                    binding=binding,
                    base_interval=base_interval,
                    display_interval=display_interval,
                    viewer_revision=viewer_revision,
                )
            return basis, rate, display_interval, viewer_revision, True

        basis = advance_basis(payload.get("basis"))
        if basis not in allowed:
            raise TrainingRunError(
                "REPLAY_CONTROL_UNSUPPORTED",
                "playback basis is unavailable for the current source and FULL-track topology",
                status_code=409,
                details={
                    "basis": basis.value,
                    "playback_bases": [item.value for item in allowed],
                    "full_track_count": full_track_count,
                },
            )
        expected = {"basis", "rate"}
        if basis is AdvanceBasis.DISPLAY_BAR:
            expected.update({"display_interval", "viewer_revision"})
        normalized = self._exact_payload(payload, expected)
        rate = control_rate(normalized["rate"])
        if basis is AdvanceBasis.DISPLAY_BAR:
            display_interval, viewer_revision = await self._validate_display_binding(
                command=command,
                binding=binding,
                base_interval=base_interval,
                display_interval=normalized["display_interval"],
                viewer_revision=normalized["viewer_revision"],
            )
        else:
            display_interval = None
            viewer_revision = None
        return basis, rate, display_interval, viewer_revision, False

    async def _translate_control(
        self,
        *,
        command: ReplayV2Command,
        binding: Mapping[str, object],
        snapshot: Mapping[str, object],
    ) -> tuple[CommandType, dict[str, object], dict[str, object]]:
        source_kind = str(binding["source_kind"])
        base_interval = str(binding["base_interval"])
        cursor = snapshot["cursor"]
        if not isinstance(cursor, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "adapter cursor is invalid",
                status_code=503,
            )
        current_time = int(cursor["virtual_time_ms"])
        command_type = command.type
        plan: dict[str, object] = {
            "contract": ADVANCE_CONTRACT_VERSION,
            "mode": "DIRECT_ADAPTER",
            "cancelable": False,
            "source_kind": source_kind,
        }

        if command_type is ReplayV2CommandType.ACQUIRE_CONTROLLER:
            payload = self._exact_payload(command.payload, {"takeover"})
            if not isinstance(payload["takeover"], bool):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "takeover must be a boolean",
                    status_code=422,
                )
            return CommandType.ACQUIRE_CONTROLLER, dict(payload), plan
        if command_type is ReplayV2CommandType.TAKEOVER_CONTROLLER:
            self._exact_payload(command.payload, set())
            return CommandType.ACQUIRE_CONTROLLER, {"takeover": True}, plan
        direct_empty = {
            ReplayV2CommandType.RELEASE_CONTROLLER: CommandType.RELEASE_CONTROLLER,
            ReplayV2CommandType.PLAY: CommandType.PLAY,
            ReplayV2CommandType.PAUSE: CommandType.PAUSE,
        }
        if command_type in direct_empty:
            self._exact_payload(command.payload, set())
            return direct_empty[command_type], {}, plan
        if command_type is ReplayV2CommandType.SET_SPEED:
            payload = self._exact_payload(command.payload, {"speed"})
            return CommandType.SET_SPEED, dict(payload), plan
        if command_type is ReplayV2CommandType.END:
            payload = self._exact_payload(
                command.payload,
                {"open_order_disposition", "position_disposition"},
            )
            return CommandType.END_SESSION, dict(payload), plan
        if command_type is ReplayV2CommandType.ADVANCE:
            payload = command.payload
            basis = advance_basis(payload.get("basis"))
            allowed = supported_advance_bases(
                source_kind=source_kind,
                full_track_count=1,
            )
            if basis not in allowed:
                raise TrainingRunError(
                    "REPLAY_CONTROL_UNSUPPORTED",
                    "advance basis is unavailable for the current source",
                    status_code=409,
                    details={
                        "basis": basis.value,
                        "supported_bases": [item.value for item in allowed],
                    },
                )
            if basis is AdvanceBasis.DISPLAY_BAR:
                normalized = self._exact_payload(
                    payload,
                    {"basis", "count", "display_interval", "viewer_revision"},
                )
                count = control_count(normalized["count"])
                target, interval, viewer_revision = await self._display_advance_target(
                    command=command,
                    binding=binding,
                    base_interval=base_interval,
                    current_time=current_time,
                    count=count,
                    display_interval=normalized["display_interval"],
                    viewer_revision=normalized["viewer_revision"],
                )
                return (
                    CommandType.ADVANCE_BY,
                    {"ms": target - current_time},
                    {
                        **plan,
                        "basis": basis.value,
                        "count": count,
                        "display_interval": interval,
                        "viewer_revision": viewer_revision,
                        "target_virtual_time_ms": target,
                    },
                )
            if basis is AdvanceBasis.BASE_BAR:
                normalized = self._exact_payload(payload, {"basis", "count"})
                count = control_count(normalized["count"])
                if source_kind == "BAR":
                    return (
                        CommandType.STEP,
                        {"count": count},
                        {**plan, "basis": basis.value, "count": count},
                    )
                target = aligned_step_target_ms(
                    current_virtual_time_ms=current_time,
                    base_interval=base_interval,
                    step_interval=base_interval,
                    count=count,
                )
                return (
                    CommandType.ADVANCE_BY,
                    {"ms": target - current_time},
                    {
                        **plan,
                        "basis": basis.value,
                        "count": count,
                        "target_virtual_time_ms": target,
                    },
                )
            if basis is AdvanceBasis.SOURCE_EVENT:
                normalized = self._exact_payload(payload, {"basis", "count"})
                count = control_count(normalized["count"])
                return (
                    CommandType.STEP,
                    {"count": count},
                    {**plan, "basis": basis.value, "count": count},
                )
            normalized = self._exact_payload(payload, {"basis", "duration_ms"})
            duration = virtual_duration_ms(
                normalized["duration_ms"],
                source_kind=source_kind,
                base_interval=base_interval,
            )
            if current_time > MAX_TIMESTAMP_MS - duration:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "advance target exceeds the timestamp range",
                    status_code=422,
                )
            target = current_time + duration
            return (
                CommandType.ADVANCE_BY,
                {"ms": duration},
                {
                    **plan,
                    "basis": basis.value,
                    "duration_ms": duration,
                    "mode": "FULL_EVENT_SCAN",
                    "cancelable": True,
                    "target_virtual_time_ms": target,
                },
            )
        if command_type is ReplayV2CommandType.STEP_EVENT:
            if source_kind != "AGG_TRADE":
                raise TrainingRunError(
                    "REPLAY_CONTROL_UNSUPPORTED",
                    "STEP_EVENT is available only for AGG_TRADE runs",
                    status_code=409,
                )
            payload = self._exact_payload(command.payload, {"count"})
            count = control_count(payload["count"])
            return (
                CommandType.STEP,
                {"count": count},
                {
                    **plan,
                    "basis": AdvanceBasis.SOURCE_EVENT.value,
                    "count": count,
                    "grain": "EVENT",
                    "legacy_alias": command_type.value,
                },
            )
        if command_type is ReplayV2CommandType.STEP_BASE:
            payload = self._exact_payload(command.payload, {"count"})
            count = control_count(payload["count"])
            if source_kind == "BAR":
                return (
                    CommandType.STEP,
                    {"count": count},
                    {
                        **plan,
                        "basis": AdvanceBasis.BASE_BAR.value,
                        "count": count,
                        "grain": "BASE",
                        "legacy_alias": command_type.value,
                    },
                )
            target = aligned_step_target_ms(
                current_virtual_time_ms=current_time,
                base_interval=base_interval,
                step_interval=base_interval,
                count=count,
            )
            return (
                CommandType.ADVANCE_BY,
                {"ms": target - current_time},
                {
                    **plan,
                    "basis": AdvanceBasis.BASE_BAR.value,
                    "count": count,
                    "grain": "BASE",
                    "legacy_alias": command_type.value,
                    "target_virtual_time_ms": target,
                },
            )
        if command_type is ReplayV2CommandType.STEP_DISPLAY:
            payload = self._exact_payload(
                command.payload,
                {"count", "display_interval", "viewer_revision"},
            )
            count = control_count(payload["count"])
            target, interval, viewer_revision = await self._display_advance_target(
                command=command,
                binding=binding,
                base_interval=base_interval,
                current_time=current_time,
                count=count,
                display_interval=payload["display_interval"],
                viewer_revision=payload["viewer_revision"],
            )
            return (
                CommandType.ADVANCE_BY,
                {"ms": target - current_time},
                {
                    **plan,
                    "basis": AdvanceBasis.DISPLAY_BAR.value,
                    "count": count,
                    "grain": "DISPLAY",
                    "legacy_alias": command_type.value,
                    "display_interval": interval,
                    "viewer_revision": viewer_revision,
                    "target_virtual_time_ms": target,
                },
            )
        if command_type is ReplayV2CommandType.ADVANCE_BY:
            payload = self._exact_payload(command.payload, {"ms"})
            duration = payload["ms"]
            if source_kind == "BAR":
                duration = validate_bar_duration_ms(
                    duration_ms=duration,
                    base_interval=base_interval,
                )
            elif (
                isinstance(duration, bool)
                or not isinstance(duration, int)
                or duration <= 0
            ):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "advance duration must be a positive integer",
                    status_code=422,
                )
            if current_time > MAX_TIMESTAMP_MS - duration:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "advance target exceeds the timestamp range",
                    status_code=422,
                )
            target = current_time + duration
            return (
                CommandType.ADVANCE_BY,
                {"ms": duration},
                {
                    **plan,
                    "basis": AdvanceBasis.VIRTUAL_TIME.value,
                    "duration_ms": duration,
                    "legacy_alias": command_type.value,
                    "mode": "FULL_EVENT_SCAN",
                    "cancelable": True,
                    "target_virtual_time_ms": target,
                },
            )
        if command_type is ReplayV2CommandType.ADVANCE_TO:
            payload = self._exact_payload(command.payload, {"virtual_time_ms"})
            target = payload["virtual_time_ms"]
            if (
                isinstance(target, bool)
                or not isinstance(target, int)
                or target <= current_time
                or target > MAX_TIMESTAMP_MS
            ):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "advance target must be ahead of the current cursor",
                    status_code=422,
                )
            duration = target - current_time
            if source_kind == "BAR":
                validate_bar_duration_ms(
                    duration_ms=duration,
                    base_interval=base_interval,
                )
            return (
                CommandType.ADVANCE_BY,
                {"ms": duration},
                {
                    **plan,
                    "basis": AdvanceBasis.VIRTUAL_TIME.value,
                    "duration_ms": duration,
                    "legacy_alias": command_type.value,
                    "mode": "FULL_EVENT_SCAN",
                    "cancelable": True,
                    "target_virtual_time_ms": target,
                },
            )
        raise TrainingRunError(
            "REPLAY_CONTROL_UNSUPPORTED",
            f"command {command_type.value} is not implemented in Phase 3",
            status_code=409,
        )

    @staticmethod
    def _snapshot(session: Mapping[str, object]) -> Mapping[str, object]:
        snapshot = session.get("snapshot")
        if not isinstance(snapshot, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "adapter snapshot is invalid",
                status_code=503,
            )
        return snapshot

    @staticmethod
    def _assert_expected_cursor(
        command: ReplayV2Command,
        session: Mapping[str, object],
    ) -> Mapping[str, object]:
        snapshot = TrainingRunService._snapshot(session)
        cursor = snapshot.get("cursor")
        if not isinstance(cursor, Mapping):
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "adapter cursor is invalid",
                status_code=503,
            )
        actual = {
            "virtual_time_ms": cursor.get("virtual_time_ms"),
            "source_sequence": cursor.get("source_sequence"),
            "revision": snapshot.get("revision"),
        }
        if actual != command.expected_cursor.to_dict():
            raise TrainingRunError(
                "REVISION_CONFLICT",
                "command cursor does not match the authoritative run cursor",
                status_code=409,
                details={
                    "expected": command.expected_cursor.to_dict(),
                    "actual": actual,
                },
            )
        return snapshot

    @staticmethod
    def _exact_payload(
        payload: Mapping[str, object],
        expected: set[str],
    ) -> Mapping[str, object]:
        missing = expected - set(payload)
        unknown = set(payload) - expected
        if missing or unknown:
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "command payload fields do not match the control contract",
                status_code=422,
                details={"missing": sorted(missing), "unknown": sorted(unknown)},
            )
        return payload

    @classmethod
    def _order_payload_with_optional_leverage(
        cls,
        payload: Mapping[str, object],
        expected: set[str],
    ) -> Mapping[str, object]:
        """Exact payload contract with optional per-order leverage ≤ max."""

        data = dict(payload)
        leverage = data.pop("leverage", None)
        position_side = data.pop("position_side", None)
        validated = dict(cls._exact_payload(data, expected))
        if position_side is not None:
            if position_side not in {"LONG", "SHORT"}:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "position_side must be LONG or SHORT",
                    status_code=422,
                )
            validated["position_side"] = position_side
        if leverage is not None:
            if not isinstance(leverage, str):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "leverage must be a canonical Decimal string",
                    status_code=422,
                )
            try:
                normalized = normalize_decimal_string(leverage, field_name="leverage")
            except (TypeError, ValueError) as exc:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "leverage is invalid",
                    status_code=422,
                ) from exc
            if Decimal(normalized) < 1:
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "leverage must be at least 1",
                    status_code=422,
                )
            validated["leverage"] = normalized
        return validated

    @staticmethod
    def _selection_warmup_bars(request: TrainingRunCreateRequest) -> int:
        visible = request.visible_history_lookback
        if visible is None or visible.mode is VisibleHistoryMode.ALL_AVAILABLE:
            return request.indicator_warmup_bars
        assert visible.duration_ms is not None
        interval_ms = parse_interval_ms(request.base_interval)
        if interval_ms is None:
            raise TrainingRunError(
                "VISIBLE_HISTORY_INTERVAL_MISMATCH",
                "visible history requires a fixed base interval",
                status_code=422,
            )
        if visible.duration_ms % interval_ms:
            raise TrainingRunError(
                "VISIBLE_HISTORY_INTERVAL_MISMATCH",
                "visible history duration must be an exact base-interval multiple",
                status_code=422,
                details={"base_interval_ms": interval_ms},
            )
        return max(
            request.indicator_warmup_bars,
            visible.duration_ms // interval_ms,
        )

    @staticmethod
    def _adapter_config(
        request: TrainingRunCreateRequest,
        *,
        warmup_bars: int | None = None,
    ) -> ReplaySessionConfig:
        return ReplaySessionConfig(
            protocol=REPLAY_PROTOCOL,
            source_kind=(
                SourceKind.BAR
                if request.source_kind is ReplaySource.BAR
                else SourceKind.AGG_TRADE
            ),
            exchange=request.exchange,
            market_type=request.market_type,
            symbol=request.symbol,
            base_interval=request.base_interval,
            # Phase 3 keeps the adapter projection at the atomic base interval.
            # Mutable display projection lives in replay_training_viewer_state.
            display_interval=request.base_interval,
            start_policy=(
                StartPolicy.MANUAL
                if request.start_mode is StartMode.MANUAL
                else StartPolicy.RANDOM_ELIGIBLE
            ),
            requested_start_ms=request.requested_start_ms,
            warmup_bars=(
                request.indicator_warmup_bars if warmup_bars is None else warmup_bars
            ),
            horizon_ms=request.forward_cache_ms,
            random_seed=0 if request.random_seed is None else request.random_seed,
            quality_mode=QualityMode.EXACT,
            blind_mode=(
                request.time_disclosure_policy is not TimeDisclosurePolicy.NONE
            ),
            initial_equity=request.initial_equity,
            quote_asset=request.settlement_asset,
            execution_model=ExecutionModel.PAPER_LINEAR_V1,
            fee_model=FeeModel(request.maker_fee_bps, request.taker_fee_bps),
            slippage_model=SlippageModel(
                SlippageKind.FIXED_BPS,
                request.market_slippage_bps,
            ),
            max_leverage=request.max_leverage,
            pause_on_controller_loss=True,
            position_mode=request.position_mode.value,
        )

    @staticmethod
    def _identifier(value: object, *, field_name: str) -> str:
        try:
            return validate_identifier(value, field_name=field_name)
        except (TypeError, ValueError) as exc:
            raise TrainingRunError(
                "TRAINING_RUN_INVALID",
                f"{field_name} is invalid",
                status_code=422,
            ) from exc

    @staticmethod
    def _digest(value: object, *, field_name: str) -> str:
        if (
            not isinstance(value, str)
            or len(value) != 71
            or not value.startswith("sha256:")
        ):
            raise TrainingRunError(
                "TRAINING_RUN_INVALID",
                f"{field_name} is invalid",
                status_code=422,
            )
        try:
            int(value[7:], 16)
        except ValueError as exc:
            raise TrainingRunError(
                "TRAINING_RUN_INVALID",
                f"{field_name} is invalid",
                status_code=422,
            ) from exc
        return value

    def _authoritative_start_request(
        self,
        request: TrainingRunCreateRequest,
    ) -> TrainingRunCreateRequest:
        if request.start_mode is StartMode.MANUAL:
            return replace(request, random_seed=None)
        return replace(request, random_seed=self._authoritative_random_seed())

    def _authoritative_random_seed(self) -> int:
        try:
            seed = validate_v2_counter(
                self._random_seed_factory(),
                field_name="server random_seed",
            )
        except (TypeError, ValueError, RuntimeError, StopIteration) as exc:
            raise TrainingRunError(
                "TRAINING_RANDOM_SEED_UNAVAILABLE",
                "server could not generate an authoritative random start seed",
                status_code=503,
            ) from exc
        return seed

    @staticmethod
    def _catalog_identity_key(entry: Mapping[str, object]) -> tuple[str, str, str]:
        identity = entry.get("identity")
        if not isinstance(identity, Mapping):
            return ("", "", "")
        return (
            str(identity.get("exchange", "")),
            str(identity.get("market_type", "")),
            str(identity.get("symbol", "")),
        )

    @staticmethod
    def _market_start_compatibility(
        entry: Mapping[str, object],
        committed_start_ms: int,
    ) -> dict[str, object]:
        interval = entry.get("selected_base_interval")
        if not isinstance(interval, str):
            return {
                "state": "UNSUPPORTED",
                "code": "MARKET_MODE_INCOMPATIBLE",
                "message": "当前训练参数没有可用的精确基础周期。",
            }
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None:
            return {
                "state": "UNSUPPORTED",
                "code": "START_NOT_ALIGNED",
                "message": "本局固定开始时间无法对齐该商品的基础周期。",
            }
        raw_ranges = entry.get("eligible_ranges")
        within_range_but_unaligned = False
        if isinstance(raw_ranges, list):
            for raw_range in raw_ranges:
                if not isinstance(raw_range, Mapping):
                    continue
                first = raw_range.get("first_start_ms")
                last = raw_range.get("last_start_ms")
                step = raw_range.get("interval_ms")
                if (
                    isinstance(first, int)
                    and not isinstance(first, bool)
                    and isinstance(last, int)
                    and not isinstance(last, bool)
                    and isinstance(step, int)
                    and not isinstance(step, bool)
                    and step > 0
                    and first <= committed_start_ms <= last
                ):
                    if (committed_start_ms - first) % step == 0:
                        return {
                            "state": "READY",
                            "code": "TIME_COMPATIBLE",
                            "message": "该商品支持本局已冻结的开始时间。",
                        }
                    within_range_but_unaligned = True
        if within_range_but_unaligned:
            return {
                "state": "UNSUPPORTED",
                "code": "START_NOT_ALIGNED",
                "message": "本局固定开始时间无法对齐该商品的基础周期。",
            }
        bounds = entry.get("bounds")
        earliest = (
            bounds.get("earliest_open_ms") if isinstance(bounds, Mapping) else None
        )
        if isinstance(earliest, int) and committed_start_ms < earliest:
            return {
                "state": "UNSUPPORTED",
                "code": "MARKET_NOT_LISTED_AT_START",
                "message": "本局开始时该商品尚未上市或尚无历史数据。",
            }
        return {
            "state": "UNSUPPORTED",
            "code": "MARKET_COVERAGE_INSUFFICIENT",
            "message": "该商品在本局固定开始时间缺少预热、连续历史或前向覆盖。",
        }

    async def _require_market_at_committed_start(
        self,
        *,
        selection: TrainingRunMarketSelectionRequest,
        setup: TrainingRunSetupRequest,
        commitment: Mapping[str, object],
    ) -> None:
        settings = setup.to_dict()
        catalog = await self.replay_service.catalog(
            warmup_bars=int(settings["indicator_warmup_bars"]),
            horizon_ms=int(settings["forward_cache_ms"]),
            quality_mode="exact",
            blind_mode=False,
        )
        if catalog["catalog_epoch"] != selection.catalog_epoch:
            raise TrainingRunError(
                "CATALOG_EPOCH_MISMATCH",
                "data capability changed after validation; refresh and try again",
                status_code=409,
            )
        identity = (selection.exchange, selection.market_type, selection.symbol)
        entry = next(
            (
                item
                for item in cast(list[Mapping[str, object]], catalog["entries"])
                if self._catalog_identity_key(item) == identity
            ),
            None,
        )
        if entry is None:
            compatibility = {
                "state": "UNSUPPORTED",
                "code": "MARKET_NOT_IN_CATALOG",
                "message": "该商品不在当前回放能力目录中。",
            }
        elif entry.get("selected_base_interval") != selection.base_interval:
            compatibility = {
                "state": "UNSUPPORTED",
                "code": "MARKET_MODE_INCOMPATIBLE",
                "message": "所选基础周期与当前精确回放能力不兼容。",
            }
        else:
            compatibility = self._market_start_compatibility(
                entry,
                int(commitment["committed_start_ms"]),
            )
        if compatibility["state"] != "READY":
            raise TrainingRunError(
                str(compatibility["code"]),
                str(compatibility["message"]),
                status_code=409,
                details={
                    "requires_new_run": True,
                    "time_commitment_hash": commitment["commitment_hash"],
                },
            )

    @staticmethod
    def _public_time_commitment(
        commitment: Mapping[str, object],
        *,
        disclose_start: bool,
    ) -> dict[str, object]:
        return {
            "schema_version": "replay.time-commitment.v1",
            "start_mode": commitment["start_mode"],
            "committed": True,
            "committed_start_ms": (
                commitment["committed_start_ms"] if disclose_start else None
            ),
            "random_range_start_ms": (
                commitment["random_range_start_ms"] if disclose_start else None
            ),
            "random_range_end_ms": (
                commitment["random_range_end_ms"] if disclose_start else None
            ),
            "commitment_hash": commitment["commitment_hash"],
        }


__all__ = ["TrainingRunService"]
