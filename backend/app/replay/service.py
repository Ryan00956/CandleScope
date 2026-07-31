"""Application service owning replay datasets, actors, persistence and recovery."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import secrets
import time
import uuid
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from decimal import Decimal, localcontext
from typing import Callable, Mapping, Sequence, TypeVar

from app.core.config import ReplaySettings
from app.data_engine.interval_policy import (
    compute_bucket_start_ms,
    parse_interval_ms,
)
from app.data_engine.storage.raw_trade_archive import (
    DisabledRawAggTradeArchive,
    RawAggTradeArchive,
    RawAggTradeDatasetRef,
)
from app.data_engine.storage.klines_repo import KlinesRepoAdapter

from .actor import (
    ActorMutation,
    ActorRecoveryTarget,
    ActorSnapshot,
    ActorStreamSubscription,
    ReplaySessionActor,
)
from .bars.builder import ReplayBarBuilder, assess_bar_builder_capability
from .bars.trade_builder import TradeReplayBarBuilder
from .bars.trade_parity import assert_trade_bar_parity
from .broker.execution import ConservativeBarBroker
from .broker.models import (
    BrokerConfig,
    BrokerLimits,
    InstrumentFilters,
    PAPER_LINEAR_EXECUTION_MODE,
)
from .canonical import canonical_json_bytes, canonical_sha256
from .checkpoints import CheckpointCodec, CheckpointError
from .catalog import (
    KlinesReadRepository,
    ReplayCatalog,
    ReplayCatalogEntry,
    ReplaySeriesIdentity,
)
from .commands import CommandResult
from .constants import (
    REPLAY_PROTOCOL,
    CommandType,
    DataFidelity,
    ExecutionFidelity,
    ExecutionModel,
    SessionState,
    SourceKind,
    StartPolicy,
)
from .dataset import (
    BarDatasetBuilder,
    BarDatasetPool,
    BarDatasetSnapshot,
    remap_bar_snapshot_time,
)
from .errors import ReplayDomainError, ReplayErrorCode
from .internal_commands import InternalCommandType
from .models import ReplayCommand, ReplayCursor, ReplaySessionConfig
from .period_summary import (
    EncodedPeriodSummaryCandidate,
    MAX_PERIOD_SUMMARY_CANDIDATES,
    MAX_PERIOD_SUMMARY_TOTAL_COMPRESSED_BYTES,
    PERIOD_SUMMARY_ALGORITHM_VERSION,
    PERIOD_SUMMARY_MIN_SKIP_EVENTS,
    PERIOD_SUMMARY_MIN_TAIL_EVENTS,
    PERIOD_SUMMARY_YIELD_EVENTS,
    ReplayPeriodSummary,
    encode_component_state,
)
from .source_chain import next_source_chain_hash
from .sources.bar_source import BarReplaySource
from .sources.trade_reader import PagedReplayTradeReader
from .sources.trade_source import TradeReplaySource
from .storage.sqlite_store import ReplaySQLiteStore, StoredCheckpoint, StoredCommand
from .training.service import TrainingRunService


SYNTHETIC_TIME_ANCHOR_MS = 946_684_800_000
_DATASET_POOL_MAX_BYTES = 512 * 1024 * 1024
_EVICTION_SHUTDOWN_STEP_TIMEOUT_SECONDS = 5.0
_ENDED_SESSION_HANDOFF_GRACE_MS = 5_000
TRADE_SESSION_DATASET_SCHEMA_VERSION = "replay-trade-session-dataset.v1"
TRADE_SESSION_REF_SCHEMA_VERSION = "replay-trade-session-ref.v1"
_TaskResult = TypeVar("_TaskResult")


@dataclass(slots=True)
class ReplaySessionHandle:
    session_id: str
    actor: ReplaySessionActor
    config: ReplaySessionConfig
    broker_config: BrokerConfig
    actual_dataset: BarDatasetSnapshot
    actor_dataset: BarDatasetSnapshot
    synthetic_origin_ms: int | None
    created_at_ms: int
    last_activity_ms: int
    in_flight: int = 0
    activity_generation: int = 0
    evicting: bool = False
    eviction_complete: asyncio.Event = field(
        default_factory=asyncio.Event,
        repr=False,
    )
    trade_dataset_ref: RawAggTradeDatasetRef | None = None
    trade_pin_token: str | None = None


@dataclass(slots=True)
class ReplayRecoveryClaim:
    complete: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    error: ReplayDomainError | None = None


class ReplayService:
    """Independent replay composition root; never depends on ``DataManager``."""

    def __init__(
        self,
        *,
        settings: ReplaySettings,
        store: ReplaySQLiteStore,
        repository: object | None = None,
        raw_trade_archive: RawAggTradeArchive | None = None,
        now_ms: Callable[[], int] = lambda: int(time.time() * 1_000),
        session_id_factory: Callable[[], str] = lambda: uuid.uuid4().hex,
        training_run_id_factory: Callable[[], str] = lambda: uuid.uuid4().hex,
        training_random_seed_factory: Callable[[], int] = (
            lambda: secrets.randbits(53)
        ),
        native_intervals: Callable[[ReplaySeriesIdentity], Sequence[str]] | None = None,
    ) -> None:
        if not settings.enabled:
            raise ValueError(
                "ReplayService cannot be constructed while replay is disabled"
            )
        self.settings = settings
        self.store = store
        self._repository = repository or KlinesRepoAdapter()
        self._raw_trade_archive = raw_trade_archive or DisabledRawAggTradeArchive()
        self._now_ms = now_ms
        self._session_id_factory = session_id_factory
        self.training = (
            TrainingRunService(
                replay_service=self,
                run_id_factory=training_run_id_factory,
                random_seed_factory=training_random_seed_factory,
            )
            if settings.product_v2_available
            else None
        )
        self._native_intervals = native_intervals or self._all_local_intervals
        self._catalog = ReplayCatalog(
            self._repository,  # type: ignore[arg-type]
            native_intervals=self._native_intervals,
            now_ms=self._now_ms,
            max_scan_rows=settings.trade_page_rows,
            max_warmup_bars=settings.max_warmup_bars,
            max_horizon_days=settings.max_horizon_days,
            max_dataset_rows=settings.max_bar_dataset_rows,
        )
        self._training_history_catalog = ReplayCatalog(
            self._repository,  # type: ignore[arg-type]
            native_intervals=self._native_intervals,
            now_ms=self._now_ms,
            max_scan_rows=settings.trade_page_rows,
            max_warmup_bars=settings.max_bar_dataset_rows,
            max_horizon_days=settings.max_horizon_days,
            max_dataset_rows=settings.max_bar_dataset_rows,
        )
        self._dataset_builder = BarDatasetBuilder(
            self._repository,
            now_ms=self._now_ms,
            max_rows=settings.max_bar_dataset_rows,
        )
        pool_budget = min(
            _DATASET_POOL_MAX_BYTES,
            settings.max_active_sessions * settings.max_bar_dataset_rows * 2_048,
        )
        self._datasets = BarDatasetPool(
            max_active_snapshots=settings.max_active_sessions,
            max_total_bytes=max(1, pool_budget),
        )
        self._sessions: dict[str, ReplaySessionHandle] = {}
        self._session_generation = 0
        self._pending_session_reservations = 0
        self._pending_handle_acquisitions = 0
        self._pending_recoveries: dict[str, ReplayRecoveryClaim] = {}
        self._pending_session_deletions: dict[str, asyncio.Event] = {}
        self._pending_lifecycle_owners: dict[asyncio.Task[object], int] = {}
        self._lease_owners: dict[asyncio.Task[object], int] = {}
        self._unavailable_sessions: dict[str, ReplayDomainError] = {}
        self._accepting = True
        self._closed = False
        self._lifecycle_lock = asyncio.Lock()
        self._prune_lock = asyncio.Lock()
        self._shutdown_lock = asyncio.Lock()
        self._lifecycle_changed = asyncio.Event()
        self._prune_abort = asyncio.Event()
        self._reaper_stop = asyncio.Event()
        self._reaper_task: asyncio.Task[None] | None = None
        self._metrics: dict[str, int | str | None] = {
            "sessions_created": 0,
            "sessions_recovered": 0,
            "startup_recoveries_deferred": 0,
            "sessions_evicted": 0,
            "ended_sessions_evicted": 0,
            "idle_sessions_evicted": 0,
            "hub_sessions_evicted": 0,
            "reaper_failures": 0,
            "last_reaper_error": None,
            "recovery_failures": 0,
            "commands": 0,
            "forks": 0,
            "report_persistence_failures": 0,
            "shutdown_failures": 0,
            "last_shutdown_error": None,
        }

    @property
    def history_repository(self) -> KlinesReadRepository:
        """Expose the replay-owned read repository for chart-only history pages."""

        return self._repository  # type: ignore[return-value]

    async def start(self) -> None:
        """Recover non-ended sessions without ever resuming PLAYING."""

        if self.training is not None:
            await self.training.start()
        records = await self.store.load_recoverable_sessions()
        for index, record in enumerate(records):
            if len(self._sessions) >= self.settings.max_active_sessions:
                self._metrics["startup_recoveries_deferred"] = len(records) - index
                break
            session_id = str(record["session_id"])
            blind_mode = self._persisted_blind_mode(record)
            try:
                await self._recover_record(record)
            except asyncio.CancelledError:
                # Startup cancellation is lifecycle control, not durable data
                # corruption.  _recover_record owns candidate cleanup; never
                # convert cancellation into a sticky degraded session row.
                raise
            except BaseException as exc:
                error = self._recovery_error(exc, blind_mode=blind_mode)
                if error.code is ReplayErrorCode.SCAN_LIMIT_EXCEEDED:
                    # Capacity pressure is not durable corruption. Leave this
                    # and later records healthy for on-demand lazy recovery.
                    self._metrics["startup_recoveries_deferred"] = (
                        len(records) - index
                    )
                    break
                self._unavailable_sessions[session_id] = error
                self._metrics["recovery_failures"] = (
                    int(self._metrics["recovery_failures"] or 0) + 1
                )
                try:
                    await self.store.mark_degraded(session_id, error.message)
                except Exception:
                    pass
        if self._reaper_task is None:
            self._reaper_task = asyncio.create_task(
                self._session_reaper_loop(),
                name="replay-session-reaper",
            )

    def capabilities(self) -> dict[str, object]:
        persistence_degraded = self.store.degraded_reason is not None
        archive_diagnostics = self._raw_trade_archive.diagnostics()
        archive_enabled = bool(archive_diagnostics.get("enabled"))
        archive_ready = archive_diagnostics.get("state") == "ready"
        exact_dataset_available = bool(
            archive_diagnostics.get("verified_partitions_available")
        )
        if not archive_enabled:
            trade_capability: dict[str, object] = {
                "enabled": False,
                "reason": ReplayErrorCode.ARCHIVE_DISABLED.value,
            }
        elif not archive_ready:
            trade_capability = {
                "enabled": False,
                "reason": ReplayErrorCode.ARCHIVE_DEGRADED.value,
            }
        elif not exact_dataset_available:
            trade_capability = {
                "enabled": False,
                "reason": ReplayErrorCode.DATASET_INCOMPLETE.value,
            }
        else:
            trade_capability = {
                "enabled": True,
                "fidelity": DataFidelity.EXACT_AGG_TRADE_COVERAGE.value,
                "execution_fidelity": ExecutionFidelity.AGG_TRADE_TAPE.value,
                "requires_exact_dataset": True,
                "reader": "paged",
            }
        return {
            "protocol": REPLAY_PROTOCOL,
            "enabled": True,
            "available": (
                not persistence_degraded and self._accepting and not self._closed
            ),
            "sources": {
                "bar": {"enabled": True, "fidelity": "EXACT_BAR_COVERAGE"},
                "agg_trade": trade_capability,
            },
            "execution_models": [ExecutionModel.PAPER_LINEAR_V1.value],
            "limits": {
                "max_active_sessions": self.settings.max_active_sessions,
                "max_warmup_bars": self.settings.max_warmup_bars,
                "max_bar_dataset_rows": self.settings.max_bar_dataset_rows,
                "max_horizon_days": self.settings.max_horizon_days,
                "event_buffer_size": self.settings.event_buffer_size,
                "subscriber_queue": self.settings.event_subscriber_queue,
            },
            "persistence": {
                "schema_version": self.store.schema_version,
                "degraded": persistence_degraded,
                # Capabilities are public and have no session/blind context.
                # Never copy a driver exception, database path, or real timestamp
                # from the persistence layer into this response.
                "degraded_reason": (
                    ReplayErrorCode.PERSISTENCE_DEGRADED.value
                    if persistence_degraded
                    else None
                ),
            },
        }

    async def catalog(
        self,
        *,
        warmup_bars: int,
        horizon_ms: int,
        quality_mode: str,
        blind_mode: bool,
    ) -> dict[str, object]:
        self._ensure_available(blind_mode=blind_mode)
        try:
            snapshot = await asyncio.to_thread(
                self._catalog.build,
                warmup_bars=warmup_bars,
                horizon_ms=horizon_ms,
                quality_mode=quality_mode,
            )
        except ReplayDomainError as exc:
            raise self._blind_safe_dataset_error(blind_mode, exc) from exc
        except Exception as exc:
            if blind_mode:
                raise self._blind_unexpected_dataset_error() from exc
            raise
        entries = [
            self._catalog_entry_payload(entry, blind_mode=blind_mode)
            for entry in snapshot.entries
        ]
        return {
            "protocol": REPLAY_PROTOCOL,
            "catalog_epoch": snapshot.catalog_epoch,
            "warmup_bars": snapshot.warmup_bars,
            "horizon_ms": snapshot.horizon_ms,
            "quality_mode": snapshot.quality_mode.value,
            "blind_mode": blind_mode,
            "entries": entries,
        }

    async def select_training_window(
        self,
        config: ReplaySessionConfig,
        *,
        expected_catalog_epoch: str,
    ) -> dict[str, object]:
        """Freeze the start choice before Phase 14 expands visible history.

        The public catalog remains bound to indicator warmup.  The returned
        source fingerprint and exact selected start are then used to prove that
        the larger internal snapshot did not re-randomize or cross source drift.
        """

        if not isinstance(config, ReplaySessionConfig):
            raise TypeError("config must be ReplaySessionConfig")
        self._ensure_available(blind_mode=config.blind_mode)
        try:
            catalog = await asyncio.to_thread(
                self._catalog.build,
                warmup_bars=config.warmup_bars,
                horizon_ms=config.horizon_ms,
                quality_mode=config.quality_mode,
            )
        except ReplayDomainError as exc:
            raise self._blind_safe_dataset_error(config, exc) from exc
        if catalog.catalog_epoch != expected_catalog_epoch:
            # The client already supplied the opaque epoch, so reporting this
            # comparison does not disclose source dates or a hidden start.
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay catalog changed after capability validation",
                details={"reason": "CATALOG_EPOCH_MISMATCH"},
            )
        try:
            identity = ReplaySeriesIdentity(
                config.exchange,
                config.market_type,
                config.symbol,
            )
            entry = catalog.require_entry(identity)
            window = (
                self._catalog.select_random(entry, seed=config.random_seed)
                if config.start_policy is StartPolicy.RANDOM_ELIGIBLE
                else self._catalog.select_manual(
                    entry,
                    start_ms=self._required_manual_start(config),
                )
            )
        except ReplayDomainError as exc:
            raise self._blind_safe_dataset_error(config, exc) from exc
        if entry.bounds is None:
            raise self._blind_safe_dataset_error(
                config,
                ReplayDomainError(
                    ReplayErrorCode.NO_ELIGIBLE_WINDOW,
                    "training source has no exact history bounds",
                ),
            )
        continuous_start_ms = entry.bounds.earliest_open_ms
        for gap in entry.gap_summary.gaps:
            if gap.end_ms < window.replay_start_ms:
                continuous_start_ms = max(
                    continuous_start_ms,
                    gap.end_ms + window.interval_ms,
                )
        return {
            "catalog_epoch": catalog.catalog_epoch,
            "source_fingerprint": entry.source_fingerprint,
            "selected_start_ms": window.replay_start_ms,
            "continuous_history_start_ms": continuous_start_ms,
            "interval_ms": window.interval_ms,
        }

    async def create_session(
        self,
        config: ReplaySessionConfig,
        *,
        _expected_catalog_epoch: str | None = None,
        _internal_forced_start_ms: int | None = None,
        _internal_expected_source_fingerprint: str | None = None,
        _internal_training_history: bool = False,
        _extension_factory: Callable[..., object] | None = None,
        _internal_execution_mode: str = PAPER_LINEAR_EXECUTION_MODE,
    ) -> dict[str, object]:
        if not isinstance(config, ReplaySessionConfig):
            raise TypeError("config must be ReplaySessionConfig")
        self._ensure_available(blind_mode=config.blind_mode)
        if config.source_kind is SourceKind.AGG_TRADE:
            self._require_trade_capability()
        if config.execution_model is not ExecutionModel.PAPER_LINEAR_V1:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_EXECUTION_MODEL,
                "unsupported replay execution model",
            )
        capability = assess_bar_builder_capability(
            config.base_interval, config.display_interval
        )
        if not capability.enabled:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "base/display intervals cannot be reconstructed exactly",
                details={"reason": capability.reason},
            )

        await self._reserve_session_capacity(blind_mode=config.blind_mode)
        try:
            try:
                catalog_owner = (
                    self._training_history_catalog
                    if _internal_training_history
                    else self._catalog
                )
                catalog = await asyncio.to_thread(
                    catalog_owner.build,
                    warmup_bars=config.warmup_bars,
                    horizon_ms=config.horizon_ms,
                    quality_mode=config.quality_mode,
                )
                if (
                    _expected_catalog_epoch is not None
                    and catalog.catalog_epoch != _expected_catalog_epoch
                ):
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "replay catalog changed after capability validation",
                        details={"reason": "CATALOG_EPOCH_MISMATCH"},
                    )
            except ReplayDomainError as exc:
                raise self._blind_safe_dataset_error(config, exc) from exc
            identity = ReplaySeriesIdentity(
                config.exchange, config.market_type, config.symbol
            )
            entry = catalog.require_entry(identity)
            if (
                _internal_expected_source_fingerprint is not None
                and entry.source_fingerprint
                != _internal_expected_source_fingerprint
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "training source changed after start selection",
                    details={"reason": "SOURCE_FINGERPRINT_MISMATCH"},
                )
            if entry.selected_base_interval != config.base_interval:
                raise ReplayDomainError(
                    ReplayErrorCode.UNSUPPORTED_INTERVAL,
                    "requested base_interval is not the catalog-selected exact base",
                    details={
                        "requested": config.base_interval,
                        "selected": entry.selected_base_interval,
                    },
                )
            try:
                if _internal_forced_start_ms is not None:
                    window = catalog_owner.select_manual(
                        entry,
                        start_ms=_internal_forced_start_ms,
                    )
                else:
                    window = (
                        catalog_owner.select_random(entry, seed=config.random_seed)
                        if config.start_policy is StartPolicy.RANDOM_ELIGIBLE
                        else catalog_owner.select_manual(
                            entry,
                            start_ms=self._required_manual_start(config),
                        )
                    )
                actual_dataset = await asyncio.to_thread(
                    self._dataset_builder.create, entry, window
                )
            except ReplayDomainError as exc:
                raise self._blind_safe_dataset_error(config, exc) from exc
            trade_dataset_ref: RawAggTradeDatasetRef | None = None
            if config.source_kind is SourceKind.AGG_TRADE:
                trade_dataset_ref = await self._freeze_trade_dataset(
                    config,
                    actual_dataset,
                )
                await asyncio.to_thread(
                    self._assert_trade_dataset_parity,
                    config,
                    actual_dataset,
                    trade_dataset_ref,
                )
            return await self._create_from_dataset(
                config=config,
                actual_dataset=actual_dataset,
                trade_dataset_ref=trade_dataset_ref,
                restore_checkpoint=None,
                forked=False,
                extension_factory=_extension_factory,
                execution_mode=_internal_execution_mode,
            )
        except ReplayDomainError as exc:
            if config.blind_mode:
                raise self._blind_safe_dataset_error(config, exc) from exc
            raise
        except Exception as exc:
            # A dependency exception may embed a database path, partition name,
            # or real timestamp.  The blind service boundary must therefore
            # convert even unexpected data-access failures to a fixed envelope.
            if config.blind_mode:
                raise self._blind_unexpected_dataset_error() from exc
            raise
        finally:
            self._release_session_capacity_reservation()

    async def get_session(self, session_id: str) -> dict[str, object]:
        async with self._lease_handle(session_id) as handle:
            return await self._session_payload(handle)

    async def get_session_state(self, session_id: str) -> dict[str, object]:
        """Return cursor/state authority without serializing component history."""

        async with self._lease_handle(session_id) as handle:
            return (await handle.actor.snapshot()).to_dict()

    async def plan_source_chunk(
        self,
        session_id: str,
        *,
        target_time_ms: int,
        max_events: int,
    ) -> dict[str, object]:
        """Return one bounded, read-only source scan plan for replay.v2."""

        async with self._lease_handle(session_id) as handle:
            return await handle.actor.source_chunk_plan(
                target_time_ms=target_time_ms,
                max_events=max_events,
            )

    async def source_events_page(
        self,
        session_id: str,
        *,
        after_sequence: int,
        limit: int,
    ) -> dict[str, object]:
        """Return one actor-serialized page from the revealed source prefix."""

        async with self._lease_handle(session_id) as handle:
            return await handle.actor.source_events_page(
                after_sequence=after_sequence,
                limit=limit,
            )

    async def summary_authority(self, session_id: str) -> dict[str, object]:
        """Expose trusted hashes to the replay.v2 planner, never component data."""

        async with self._lease_handle(session_id) as handle:
            return await handle.actor.summary_authority()

    async def ensure_advance_recovery_controller(
        self,
        session_id: str,
        *,
        client_instance_id: str,
    ) -> None:
        """Restore only the original durable advance client's expired lease."""

        async with self._lease_handle(session_id) as handle:
            snapshot = await handle.actor.public_snapshot()
            owner = snapshot.get("controller_client_id")
            if owner == client_instance_id:
                await handle.actor.heartbeat(client_instance_id)
                return
            if owner is not None:
                raise ReplayDomainError(
                    ReplayErrorCode.CONTROLLER_CONFLICT,
                    "another client owns the replay controller lease",
                    details={"controller_client_id": owner},
                )
            await handle.actor.submit(
                ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=f"advance-recovery-{uuid.uuid4().hex}",
                    client_instance_id=client_instance_id,
                    expected_revision=int(snapshot["revision"]),
                    type=CommandType.ACQUIRE_CONTROLLER,
                    payload={},
                )
            )

    async def prepare_period_summaries(
        self,
        session_id: str,
        *,
        run_id: str,
        set_id: str,
        rule_revision: int,
        rule_hash: str,
    ) -> dict[str, object]:
        """Build bounded exact-reducer summaries from one trusted paused seed."""

        started_wall = time.perf_counter()
        started_cpu = time.process_time()
        async with self._lease_handle(session_id) as handle:
            public = await handle.actor.public_snapshot()
            if public.get("state") != SessionState.PAUSED.value:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "period summaries can be prepared only while replay is paused",
                )
            if not isinstance(rule_revision, int) or isinstance(rule_revision, bool):
                raise TypeError("rule_revision must be an integer")
            if rule_revision < 1:
                raise ValueError("rule_revision must be positive")

            codec = CheckpointCodec()
            payload: dict[str, object] | None = None
            authority: dict[str, object] | None = None
            for _attempt in range(3):
                try:
                    checkpoint = codec.decode(await handle.actor.checkpoint())
                except CheckpointError as exc:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "period-summary seed checkpoint is invalid",
                    ) from exc
                observed = await handle.actor.summary_authority()
                source_cursor = checkpoint.get("source_cursor")
                if not isinstance(source_cursor, Mapping):
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "period-summary seed cursor is invalid",
                    )
                if (
                    checkpoint.get("session_state") == SessionState.PAUSED.value
                    and checkpoint.get("source_sequence")
                    == observed.get("source_cursor", {}).get("source_sequence")  # type: ignore[union-attr]
                    and checkpoint.get("event_chain_hash")
                    == observed.get("event_chain_hash")
                    and checkpoint.get("domain_command_position")
                    == observed.get("domain_command_position")
                    and canonical_sha256(
                        checkpoint.get("component_state", {})  # type: ignore[arg-type]
                    )
                    == observed.get("component_state_hash")
                ):
                    payload = checkpoint
                    authority = observed
                    break
                await asyncio.sleep(0)
            if payload is None or authority is None:
                raise ReplayDomainError(
                    ReplayErrorCode.REVISION_CONFLICT,
                    "replay changed while capturing the period-summary seed",
                )
            if authority.get("has_active_trading_path") is True:
                raise ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "period summaries cannot skip an active trading path",
                )
            component_state = payload.get("component_state")
            source_cursor = payload.get("source_cursor")
            if not isinstance(component_state, Mapping) or not isinstance(
                source_cursor, Mapping
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "period-summary seed components are invalid",
                )

            if handle.trade_dataset_ref is None:
                source = BarReplaySource(handle.actor_dataset)
                total_events = len(handle.actor_dataset.replay_rows)
                source_kind = "BAR"
            else:
                source = TradeReplaySource(
                    PagedReplayTradeReader(
                        self._raw_trade_archive,
                        handle.trade_dataset_ref,
                        page_rows=self.settings.trade_page_rows,
                    ),
                    time_offset_ms=(
                        handle.actor_dataset.replay_start_ms
                        - handle.trade_dataset_ref.start_time_ms
                    ),
                    blind_mode=handle.config.blind_mode,
                )
                total_events = handle.trade_dataset_ref.row_count
                source_kind = "AGG_TRADE"
            base_sequence = int(source_cursor["source_sequence"])
            try:
                source = source.fork_at_sequence(
                    base_sequence,
                    last_event_time_ms=source_cursor["last_event_time_ms"],  # type: ignore[arg-type]
                )
            except (TypeError, ValueError, ReplayDomainError) as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "period-summary source cannot restore the seed cursor",
                ) from exc

            eligible_events = (
                total_events - base_sequence - PERIOD_SUMMARY_MIN_TAIL_EVENTS
            )
            if eligible_events < PERIOD_SUMMARY_MIN_SKIP_EVENTS:
                raise ReplayDomainError(
                    ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                    "not enough future source events remain for a period summary",
                    details={
                        "required_skip_events": PERIOD_SUMMARY_MIN_SKIP_EVENTS,
                        "required_tail_events": PERIOD_SUMMARY_MIN_TAIL_EVENTS,
                        "remaining_events": max(0, total_events - base_sequence),
                    },
                )
            candidate_count = min(
                MAX_PERIOD_SUMMARY_CANDIDATES,
                max(1, eligible_events // PERIOD_SUMMARY_MIN_SKIP_EVENTS),
            )
            candidate_sequences = tuple(
                sorted(
                    {
                        base_sequence
                        + max(
                            PERIOD_SUMMARY_MIN_SKIP_EVENTS,
                            (eligible_events * index) // candidate_count,
                        )
                        for index in range(1, candidate_count + 1)
                    }
                )
            )

            reducer = self._broker(
                handle.config,
                handle.actor_dataset,
                handle.broker_config,
                trade_dataset_ref=handle.trade_dataset_ref,
            )
            try:
                reducer.restore(component_state)
            except Exception as exc:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "period-summary reducer rejected the seed components",
                ) from exc

            chain = str(payload["event_chain_hash"])
            base_component_hash = canonical_sha256(component_state)
            candidates: list[EncodedPeriodSummaryCandidate] = []
            total_compressed = 0
            endpoint_index = 0
            while endpoint_index < len(candidate_sequences):
                event = source.next()
                if event is None:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "period-summary source ended before its candidate boundary",
                    )
                projection = reducer.apply_source_event(event)
                if inspect.isawaitable(projection):
                    await projection
                cursor = source.cursor()
                chain = next_source_chain_hash(
                    chain,
                    event,
                    cursor.source_sequence,
                )
                if cursor.source_sequence == candidate_sequences[endpoint_index]:
                    state = dict(reducer.snapshot())
                    blob, raw_bytes, blob_hash, state_hash = (
                        encode_component_state(state)
                    )
                    total_compressed += len(blob)
                    if (
                        total_compressed
                        > MAX_PERIOD_SUMMARY_TOTAL_COMPRESSED_BYTES
                    ):
                        raise ReplayDomainError(
                            ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                            "period-summary compressed cache budget was exceeded",
                            details={
                                "limit_bytes": (
                                    MAX_PERIOD_SUMMARY_TOTAL_COMPRESSED_BYTES
                                )
                            },
                        )
                    summary = ReplayPeriodSummary(
                        summary_id=f"{set_id}-{endpoint_index + 1:02d}",
                        run_id=run_id,
                        session_id=session_id,
                        source_kind=source_kind,
                        data_epoch=str(authority["data_epoch"]),
                        snapshot_ref_hash=str(authority["snapshot_ref_hash"]),
                        session_config_hash=str(authority["session_config_hash"]),
                        execution_version=str(authority["execution_version"]),
                        rule_revision=rule_revision,
                        rule_hash=rule_hash,
                        base_source_sequence=base_sequence,
                        base_domain_command_position=int(
                            payload["domain_command_position"]
                        ),
                        base_event_chain_hash=str(payload["event_chain_hash"]),
                        base_component_state_hash=base_component_hash,
                        end_source_sequence=cursor.source_sequence,
                        end_virtual_time_ms=int(cursor.last_event_time_ms),
                        end_source_cursor={
                            "source_sequence": cursor.source_sequence,
                            "last_event_time_ms": cursor.last_event_time_ms,
                            "last_base_bar_open_ms": (
                                cursor.last_base_bar_open_ms
                            ),
                            "at_end": cursor.at_end,
                        },
                        end_event_chain_hash=chain,
                        end_component_state=state,
                        end_component_state_hash=state_hash,
                    )
                    candidates.append(
                        EncodedPeriodSummaryCandidate.from_summary(
                            summary,
                            component_blob=blob,
                            component_raw_bytes=raw_bytes,
                            component_blob_hash=blob_hash,
                        )
                    )
                    endpoint_index += 1
                if (
                    cursor.source_sequence - base_sequence
                ) % PERIOD_SUMMARY_YIELD_EVENTS == 0:
                    await asyncio.sleep(0)

            elapsed_wall_ms = max(
                0,
                int(round((time.perf_counter() - started_wall) * 1_000)),
            )
            elapsed_cpu_ms = max(
                0,
                int(round((time.process_time() - started_cpu) * 1_000)),
            )
            build_metadata = {
                "schema_version": "replay.period-summary-build-proof.v1",
                "algorithm_version": PERIOD_SUMMARY_ALGORITHM_VERSION,
                "set_id": set_id,
                "run_id": run_id,
                "session_id": session_id,
                "source_kind": source_kind,
                "data_epoch": str(authority["data_epoch"]),
                "snapshot_ref_hash": str(authority["snapshot_ref_hash"]),
                "session_config_hash": str(authority["session_config_hash"]),
                "execution_version": str(authority["execution_version"]),
                "rule_revision": rule_revision,
                "rule_hash": rule_hash,
                "base_source_sequence": base_sequence,
                "base_domain_command_position": int(
                    payload["domain_command_position"]
                ),
                "base_event_chain_hash": str(payload["event_chain_hash"]),
                "base_component_state_hash": base_component_hash,
                "candidate_summary_hashes": [
                    candidate.summary_hash for candidate in candidates
                ],
                "source_event_count": (
                    candidates[-1].end_source_sequence - base_sequence
                ),
                "candidate_count": len(candidates),
                "compressed_bytes": total_compressed,
            }
            return {
                "metadata": build_metadata,
                "build_proof_hash": canonical_sha256(build_metadata),
                "candidates": tuple(candidates),
                "source_event_count": build_metadata["source_event_count"],
                "build_wall_ms": elapsed_wall_ms,
                "build_cpu_ms": elapsed_cpu_ms,
            }

    async def apply_period_summary(
        self,
        session_id: str,
        summary: ReplayPeriodSummary,
        *,
        client_instance_id: str,
        expected_revision: int,
    ) -> dict[str, object]:
        async with self._lease_handle(session_id) as handle:
            return await handle.actor.apply_period_summary(
                summary,
                client_instance_id=client_instance_id,
                expected_revision=expected_revision,
            )

    async def command(
        self,
        session_id: str,
        command: ReplayCommand,
        *,
        _training_internal: bool = False,
    ) -> dict[str, object]:
        if command.type in {
            InternalCommandType.ADJUST_CAPITAL,
            InternalCommandType.REVEAL_HISTORY_AUTHORIZED,
            InternalCommandType.FAST_FORWARD_EMPTY_ACCOUNT,
            InternalCommandType.FAST_FORWARD_FINAL_STATE,
        } and not _training_internal:
            raise ReplayDomainError(
                ReplayErrorCode.INVALID_STATE_TRANSITION,
                "internal training command is unavailable on replay.v1",
            )
        async with self._lease_handle(session_id) as handle:
            try:
                existing = await self.store.get_command(
                    session_id, command.command_id
                )
                if existing is not None:
                    result = self._replay_stored_command(existing, command)
                else:
                    # A durable command ACK remains readable even if a later,
                    # derived report write put persistence in sticky degraded
                    # mode.  Only genuinely new mutations require availability.
                    self._ensure_available(blind_mode=handle.config.blind_mode)
                    result = await handle.actor.submit(command)
                self._metrics["commands"] = int(self._metrics["commands"] or 0) + 1
                payload = self._command_result_payload(result)
                if command.type in {
                    CommandType.REVEAL_HISTORY,
                    InternalCommandType.REVEAL_HISTORY_AUTHORIZED,
                } and result.data.get("revealed"):
                    payload["data"] = {
                        **dict(payload["data"]),  # type: ignore[arg-type]
                        "actual_history": self._actual_history(handle),
                    }
                if existing is None and result.state is SessionState.ENDED:
                    await self._persist_report_after_command(handle)
                return {
                    "protocol": REPLAY_PROTOCOL,
                    "session_id": session_id,
                    **payload,
                }
            except ReplayDomainError as exc:
                if (
                    handle.config.blind_mode
                    and exc.code is ReplayErrorCode.PERSISTENCE_DEGRADED
                ):
                    raise self._blind_safe_internal_error(exc.code) from exc
                raise
            except Exception as exc:
                if handle.config.blind_mode:
                    raise self._blind_safe_internal_error(
                        ReplayErrorCode.PERSISTENCE_DEGRADED
                    ) from exc
                raise

    async def fork_session(self, session_id: str) -> dict[str, object]:
        blind_mode = False
        try:
            async with self._lease_handle(session_id) as source:
                blind_mode = source.config.blind_mode
                checkpoint = await source.actor.checkpoint()
                await self._reserve_session_capacity(blind_mode=blind_mode)
                try:
                    result = await self._create_from_dataset(
                        config=source.config,
                        actual_dataset=source.actual_dataset,
                        restore_checkpoint=checkpoint,
                        forked=True,
                        synthetic_origin_ms=source.synthetic_origin_ms,
                        broker_config=source.broker_config,
                        trade_dataset_ref=source.trade_dataset_ref,
                    )
                finally:
                    self._release_session_capacity_reservation()
                self._metrics["forks"] = int(self._metrics["forks"] or 0) + 1
                result["forked_from_session_id"] = session_id
                return result
        except ReplayDomainError as exc:
            if blind_mode:
                raise self._blind_safe_dataset_error(True, exc) from exc
            raise
        except Exception as exc:
            if blind_mode:
                raise self._blind_unexpected_dataset_error() from exc
            raise

    async def fork_session_at_checkpoint(
        self,
        session_id: str,
        *,
        checkpoint_id: int,
        extension_factory: Callable[..., object],
    ) -> dict[str, object]:
        """Create an isolated session from one exact durable checkpoint."""

        blind_mode = False
        try:
            async with self._lease_handle(session_id) as source:
                blind_mode = source.config.blind_mode
                checkpoints = await self.store.load_valid_checkpoints(session_id)
                checkpoint = next(
                    (
                        candidate
                        for candidate in checkpoints
                        if candidate.checkpoint_id == checkpoint_id
                    ),
                    None,
                )
                if checkpoint is None:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "review checkpoint is unavailable",
                    )
                await self._reserve_session_capacity(blind_mode=blind_mode)
                try:
                    result = await self._create_from_dataset(
                        config=source.config,
                        actual_dataset=source.actual_dataset,
                        restore_checkpoint=checkpoint.payload,
                        forked=True,
                        synthetic_origin_ms=source.synthetic_origin_ms,
                        broker_config=source.broker_config,
                        trade_dataset_ref=source.trade_dataset_ref,
                        extension_factory=extension_factory,
                    )
                finally:
                    self._release_session_capacity_reservation()
                self._metrics["forks"] = int(self._metrics["forks"] or 0) + 1
                result["forked_from_session_id"] = session_id
                result["forked_from_checkpoint_id"] = checkpoint_id
                return result
        except ReplayDomainError as exc:
            if blind_mode:
                raise self._blind_safe_dataset_error(True, exc) from exc
            raise
        except Exception as exc:
            if blind_mode:
                raise self._blind_unexpected_dataset_error() from exc
            raise

    async def fork_session_from_checkpoint_blob(
        self,
        session_id: str,
        *,
        checkpoint: bytes,
        extension_factory: Callable[..., object] | None = None,
    ) -> dict[str, object]:
        """Fork from a checksum-verified ReviewMode anchor, not the recent ring."""

        blind_mode = False
        checkpoint_bytes = bytes(checkpoint)
        try:
            # Decode before reserving capacity so malformed persisted evidence
            # cannot create a partial child session.
            CheckpointCodec().decode(checkpoint_bytes)
            async with self._lease_handle(session_id) as source:
                blind_mode = source.config.blind_mode
                await self._reserve_session_capacity(blind_mode=blind_mode)
                try:
                    result = await self._create_from_dataset(
                        config=source.config,
                        actual_dataset=source.actual_dataset,
                        restore_checkpoint=checkpoint_bytes,
                        forked=True,
                        synthetic_origin_ms=source.synthetic_origin_ms,
                        broker_config=source.broker_config,
                        trade_dataset_ref=source.trade_dataset_ref,
                        extension_factory=extension_factory,
                    )
                finally:
                    self._release_session_capacity_reservation()
                self._metrics["forks"] = int(self._metrics["forks"] or 0) + 1
                result["forked_from_session_id"] = session_id
                result["forked_from_anchor_sha256"] = (
                    f"sha256:{hashlib.sha256(checkpoint_bytes).hexdigest()}"
                )
                return result
        except ReplayDomainError as exc:
            if blind_mode:
                raise self._blind_safe_dataset_error(True, exc) from exc
            raise
        except Exception as exc:
            if blind_mode:
                raise self._blind_unexpected_dataset_error() from exc
            raise

    async def report(self, session_id: str) -> dict[str, object]:
        async with self._lease_handle(session_id) as handle:
            report = dict(await handle.actor.report())
            if report:
                report_hash = str(report.get("report_hash", ""))
                if report_hash:
                    await self.store.save_report(session_id, report, report_hash)
            payload: dict[str, object] = {
                "protocol": REPLAY_PROTOCOL,
                "session_id": session_id,
                "data_fidelity": self._data_fidelity(handle.config),
                "execution_fidelity": self._execution_fidelity(handle.config),
                "revealed": (await handle.actor.public_snapshot())["revealed"],
                "report": report,
            }
            if payload["revealed"]:
                payload["actual_history"] = self._actual_history(handle)
            return payload

    async def journal(self, session_id: str) -> dict[str, object]:
        async with self._lease_handle(session_id) as handle:
            snapshot = await handle.actor.public_snapshot()
            return {
                "protocol": REPLAY_PROTOCOL,
                "session_id": session_id,
                "entries": snapshot["journal"],
            }

    async def subscribe(
        self,
        session_id: str,
        *,
        after_sequence: int | None,
        data_epoch: str | None,
    ) -> tuple[ReplaySessionActor, ActorStreamSubscription]:
        actor: ReplaySessionActor | None = None
        subscription: ActorStreamSubscription | None = None
        try:
            async with self._lease_handle(session_id) as handle:
                actor = handle.actor
                snapshot = await actor.snapshot()
                if data_epoch is not None and data_epoch != snapshot.data_epoch:
                    raise ReplayDomainError(
                        ReplayErrorCode.DATASET_MISMATCH,
                        "replay stream data_epoch does not match the session",
                    )
                subscription = await actor.subscribe(
                    after_sequence=after_sequence,
                    max_pending=self.settings.event_subscriber_queue,
                )
                return actor, subscription
        except BaseException:
            if actor is not None and subscription is not None:
                # Once actor.subscribe returns, this service coroutine owns the
                # token until the tuple reaches the WebSocket layer.  Context
                # manager exit is an await/cancellation point, so transfer
                # cleanup synchronously before propagating any handoff failure.
                actor.request_unsubscribe(subscription.token)
            raise

    async def heartbeat(self, session_id: str, client_instance_id: str) -> None:
        async with self._lease_handle(session_id) as handle:
            await handle.actor.heartbeat(client_instance_id)

    async def release_session_to_hub(self, session_id: str) -> None:
        """Pause, checkpoint and evict one adapter before the Hub becomes visible."""

        self._ensure_accepting()
        # Lazy recovery must remain leased until ownership is transferred to the
        # eviction lane. Otherwise an idle reaper can evict the freshly
        # recovered handle after get_session() releases its transient lease but
        # before this method acquires _prune_lock.
        handle = await self._acquire_handle_lease(session_id)
        lease_active = True
        try:
            async with self._prune_lock:
                async with self._lifecycle_lock:
                    if self._sessions.get(session_id) is not handle:
                        raise ReplayDomainError(
                            ReplayErrorCode.REVISION_CONFLICT,
                            "replay session ownership changed before Hub release",
                        )
                    # This method owns exactly one lease. Any additional lease
                    # represents a concurrent request and preserves the existing
                    # fail-closed busy contract.
                    if handle.evicting or handle.in_flight != 1:
                        raise ReplayDomainError(
                            ReplayErrorCode.REVISION_CONFLICT,
                            "replay session is busy",
                        )
                    # No await is permitted between releasing our lease and
                    # claiming eviction. _prune_lock excludes the reaper while
                    # the lifecycle lock protects the handle state transition.
                    self._release_handle_lease(handle)
                    lease_active = False
                    handle.evicting = True
                    handle.eviction_complete.clear()
                await self._evict_claimed_handle(session_id, handle, reason="hub")
        finally:
            if lease_active:
                self._release_handle_lease(handle)

    async def discard_session(self, session_id: str) -> None:
        """Evict and delete one non-primary training adapter after detachment."""

        self._ensure_accepting()
        durable = await self.store.get_session(session_id)
        if durable is None:
            return
        deleted = await self.delete_sessions_atomically(
            (session_id,),
            lambda: self.store.delete_session(session_id),
        )
        if not deleted:
            raise ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "detached replay session could not be deleted",
                details={"session_id": session_id},
            )

    async def delete_sessions_atomically(
        self,
        session_ids: Sequence[str],
        delete: Callable[[], Awaitable[_TaskResult]],
    ) -> _TaskResult:
        """Fence recovery while actors and their durable archive are deleted.

        The fence spans actor eviction and the caller-owned SQLite transaction.
        Requests already using a target make deletion fail closed as busy, while
        requests that arrive after the claim wait and then perform a fresh
        durable lookup.
        """

        self._ensure_accepting()
        normalized = tuple(dict.fromkeys(session_ids))
        if not normalized or any(not session_id for session_id in normalized):
            raise ValueError("session_ids must contain non-empty identifiers")

        deletion_complete = asyncio.Event()
        claimed: dict[str, ReplaySessionHandle] = {}
        delete_succeeded = False
        async with self._prune_lock:
            try:
                while True:
                    pending_recoveries: tuple[ReplayRecoveryClaim, ...]
                    async with self._lifecycle_lock:
                        self._ensure_accepting()
                        pending_recoveries = tuple(
                            claim
                            for session_id in normalized
                            if (
                                claim := self._pending_recoveries.get(session_id)
                            )
                            is not None
                        )
                    if not pending_recoveries:
                        break
                    await asyncio.gather(
                        *(claim.complete.wait() for claim in pending_recoveries)
                    )

                async with self._lifecycle_lock:
                    self._ensure_accepting()
                    for session_id in normalized:
                        if session_id in self._pending_session_deletions:
                            raise ReplayDomainError(
                                ReplayErrorCode.REVISION_CONFLICT,
                                "replay session deletion is already in progress",
                                details={"session_id": session_id},
                            )
                        handle = self._sessions.get(session_id)
                        if handle is not None and (
                            handle.evicting or handle.in_flight != 0
                        ):
                            raise ReplayDomainError(
                                ReplayErrorCode.REVISION_CONFLICT,
                                "replay session is busy",
                                details={"session_id": session_id},
                            )

                    for session_id in normalized:
                        self._pending_session_deletions[session_id] = (
                            deletion_complete
                        )
                        handle = self._sessions.get(session_id)
                        if handle is not None:
                            handle.evicting = True
                            handle.eviction_complete.clear()
                            claimed[session_id] = handle
                    self._lifecycle_changed.set()

                for session_id, handle in claimed.items():
                    await self._evict_claimed_handle(
                        session_id,
                        handle,
                        reason="hub",
                    )

                async def execute_delete() -> _TaskResult:
                    return await delete()

                delete_task = asyncio.create_task(
                    execute_delete(),
                    name="replay-session-archive-delete",
                )
                try:
                    result = await asyncio.shield(delete_task)
                except asyncio.CancelledError:
                    try:
                        await self._await_task_uninterruptibly(delete_task)
                    except BaseException:
                        pass
                    else:
                        delete_succeeded = True
                    raise
                delete_succeeded = True
                return result
            finally:
                cleanup_task = asyncio.create_task(
                    self._finish_session_deletion(
                        normalized,
                        deletion_complete=deletion_complete,
                        claimed=claimed,
                        delete_succeeded=delete_succeeded,
                    ),
                    name="replay-session-deletion-fence-release",
                )
                try:
                    await asyncio.shield(cleanup_task)
                except asyncio.CancelledError:
                    await self._await_task_uninterruptibly(cleanup_task)
                    raise

    async def _finish_session_deletion(
        self,
        session_ids: Sequence[str],
        *,
        deletion_complete: asyncio.Event,
        claimed: Mapping[str, ReplaySessionHandle],
        delete_succeeded: bool,
    ) -> None:
        """Release a deletion fence without leaving cancellation-visible ghosts."""

        async with self._lifecycle_lock:
            for session_id, handle in claimed.items():
                if self._sessions.get(session_id) is handle and handle.evicting:
                    handle.evicting = False
                    handle.eviction_complete.set()
            for session_id in session_ids:
                if (
                    self._pending_session_deletions.get(session_id)
                    is deletion_complete
                ):
                    self._pending_session_deletions.pop(session_id, None)
                if delete_succeeded:
                    self._unavailable_sessions.pop(session_id, None)
            # Invalidate durable rows captured by an acquisition before this
            # fence was claimed. That acquisition must loop and read SQLite
            # again instead of recovering a deleted record.
            self._session_generation += 1
            deletion_complete.set()
            self._lifecycle_changed.set()

    async def shutdown(self, *, step_timeout: float = 5.0) -> None:
        async with self._shutdown_lock:
            if self._closed:
                return
            async with self._lifecycle_lock:
                self._accepting = False
                self._prune_abort.set()
            errors: list[str] = []
            force_shutdown_pause_sessions: frozenset[str] = frozenset()
            self._reaper_stop.set()
            reaper = self._reaper_task
            if reaper is not None:
                try:
                    await reaper
                except Exception as exc:
                    errors.append(f"reaper: {exc}")
                self._reaper_task = None

            if self.training is not None:
                try:
                    force_shutdown_pause_sessions = await self.training.shutdown()
                except Exception as exc:
                    errors.append(f"training: {exc}")

            # Close the prune lane before draining accepted work. A capacity
            # request that was queued before shutdown will observe accepting=0
            # when it enters this serialized section and cannot touch an actor.
            async with self._prune_lock:
                pass
            if not await self._wait_for_pending_lifecycle_drain(
                timeout=step_timeout
            ):
                owners = tuple(self._pending_lifecycle_owners)
                for owner in owners:
                    owner.cancel()
                # A cancelled create may already have committed its row and must
                # retain store ownership until its compensating delete finishes.
                # ``step_timeout`` bounds the graceful drain before cancellation;
                # abandoning cancellation cleanup would close SQLite underneath
                # an accepted transaction and can leave an invisible orphan.
                await self._wait_for_pending_lifecycle_drain(timeout=None)

            handles = tuple(self._sessions.items())
            for session_id, handle in handles:
                try:
                    await handle.actor.shutdown(
                        step_timeout=step_timeout,
                        force_pause_reason=(
                            session_id in force_shutdown_pause_sessions
                        ),
                    )
                except Exception as exc:
                    errors.append(f"{session_id}: {exc}")
                finally:
                    self._datasets.release(session_id)
                    if handle.trade_pin_token is not None:
                        self._raw_trade_archive.release_dataset(
                            handle.trade_pin_token
                        )
            if not await self._wait_for_lease_drain(timeout=step_timeout):
                owners = tuple(self._lease_owners)
                for owner in owners:
                    owner.cancel()
                if not await self._wait_for_lease_drain(timeout=step_timeout):
                    errors.append(
                        "leases: replay requests did not release after cancellation"
                    )
            async with self._lifecycle_lock:
                self._sessions.clear()
                self._session_generation += 1
            try:
                await self.store.close()
            except Exception as exc:
                errors.append(f"store: {exc}")
            self._closed = True
            if errors:
                self._metrics["shutdown_failures"] = len(errors)
                self._metrics["last_shutdown_error"] = "; ".join(errors)[:500]
                raise ReplayDomainError(
                    ReplayErrorCode.PERSISTENCE_DEGRADED,
                    "ReplayService shutdown failed",
                    details={"errors": tuple(errors)},
                )

    def diagnostics(self, *, redact_paths: bool = False) -> dict[str, object]:
        persistence = self.store.diagnostics()
        if redact_paths:
            persistence = {**persistence, "path": "<redacted>"}
        return {
            **self._metrics,
            "enabled": True,
            "accepting": self._accepting,
            "closed": self._closed,
            "sessions": {
                session_id: handle.actor.diagnostics()
                for session_id, handle in self._sessions.items()
            },
            "pending_session_reservations": self._pending_session_reservations,
            "pending_handle_acquisitions": self._pending_handle_acquisitions,
            "pending_recoveries": tuple(sorted(self._pending_recoveries)),
            "pending_session_deletions": tuple(
                sorted(self._pending_session_deletions)
            ),
            "pending_lifecycle_owners": len(self._pending_lifecycle_owners),
            "active_lease_owners": len(self._lease_owners),
            "unavailable_sessions": {
                session_id: error.code.value
                for session_id, error in self._unavailable_sessions.items()
            },
            "catalog": self._catalog.diagnostics(),
            "dataset_pins": dict(self._datasets.diagnostics()),
            "training_product_v2": self.training is not None,
            "persistence": persistence,
        }

    @staticmethod
    async def _await_task_uninterruptibly(
        task: asyncio.Task[_TaskResult],
    ) -> _TaskResult:
        """Resolve an owned cleanup task despite repeated outer cancellation."""

        while True:
            if task.done():
                return task.result()
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                if task.done():
                    return task.result()

    async def _pin_trade_dataset(
        self,
        dataset_ref: RawAggTradeDatasetRef,
        *,
        task_name: str,
    ) -> str:
        """Acquire an archive pin without losing ownership on cancellation."""

        pin_task = asyncio.create_task(
            asyncio.to_thread(
                self._raw_trade_archive.pin_dataset,
                dataset_ref,
            ),
            name=task_name,
        )
        try:
            return await asyncio.shield(pin_task)
        except asyncio.CancelledError:
            # ``to_thread`` cannot stop an in-progress checksum validation.  It
            # may therefore publish a pin after this request is cancelled.  Take
            # back the eventual token and release it before cancellation escapes.
            try:
                token = await self._await_task_uninterruptibly(pin_task)
            except BaseException:
                pass
            else:
                self._raw_trade_archive.release_dataset(token)
            raise

    async def _shutdown_actor_uninterruptibly(
        self,
        actor: ReplaySessionActor,
        *,
        step_timeout: float,
        task_name: str,
    ) -> None:
        shutdown_error: BaseException | None = None
        shutdown_task = asyncio.create_task(
            actor.shutdown(step_timeout=step_timeout),
            name=task_name,
        )
        try:
            await self._await_task_uninterruptibly(shutdown_task)
        except BaseException as exc:
            shutdown_error = exc
        actor_task = actor.task
        if actor_task is not None and not actor_task.done():
            actor_task.cancel()
            try:
                await self._await_task_uninterruptibly(actor_task)
            except BaseException:
                pass
        if shutdown_error is not None:
            raise shutdown_error

    async def _abort_unregistered_actor_uninterruptibly(
        self,
        actor: ReplaySessionActor,
    ) -> None:
        """Stop an unpublished actor without issuing a durable shutdown mutation."""

        actor_task = actor.task
        if actor_task is None:
            return
        if not actor_task.done():
            actor_task.cancel()
        try:
            await self._await_task_uninterruptibly(actor_task)
        except BaseException:
            # Cancellation is the expected physical stop for an actor whose
            # session is being rolled back before service registration.
            pass

    async def _create_from_dataset(
        self,
        *,
        config: ReplaySessionConfig,
        actual_dataset: BarDatasetSnapshot,
        trade_dataset_ref: RawAggTradeDatasetRef | None = None,
        restore_checkpoint: bytes | None,
        forked: bool,
        synthetic_origin_ms: int | None = None,
        broker_config: BrokerConfig | None = None,
        extension_factory: Callable[..., object] | None = None,
        execution_mode: str = PAPER_LINEAR_EXECUTION_MODE,
    ) -> dict[str, object]:
        session_id = self._session_id_factory()
        if (
            session_id in self._sessions
            or await self.store.get_session(session_id) is not None
        ):
            raise ReplayDomainError(
                ReplayErrorCode.REVISION_CONFLICT,
                "replay session id collision",
            )
        origin = synthetic_origin_ms
        actor_config = config
        actor_dataset = actual_dataset
        if config.blind_mode:
            if origin is None:
                origin = self._synthetic_origin(config.base_interval)
            actor_dataset = remap_bar_snapshot_time(
                actual_dataset,
                synthetic_replay_start_ms=origin,
            )
            if config.start_policy is StartPolicy.MANUAL:
                actor_config = replace(config, requested_start_ms=origin)
        broker = broker_config or self._broker_config(actor_config, actor_dataset)
        if config.source_kind is SourceKind.AGG_TRADE and trade_dataset_ref is None:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "aggregate-trade session is missing its immutable dataset ref",
            )
        reducer = self._broker(
            actor_config,
            actor_dataset,
            broker,
            trade_dataset_ref=trade_dataset_ref,
            execution_mode=execution_mode,
        )
        self._datasets.pin(session_id, actor_dataset)
        trade_pin_token: str | None = None
        actor: ReplaySessionActor | None = None
        persisted = False
        registered = False
        try:
            if trade_dataset_ref is not None:
                trade_pin_token = await self._pin_trade_dataset(
                    trade_dataset_ref,
                    task_name=f"replay-create-pin-{session_id}",
                )
            actor = self._actor(
                session_id=session_id,
                config=actor_config,
                dataset=actor_dataset,
                trade_dataset_ref=trade_dataset_ref,
                reducer=reducer,
                restore_checkpoint=restore_checkpoint,
                recovery_target=None,
            )
            await actor.start()
            initial_checkpoint = actor.latest_checkpoint_blob()
            if initial_checkpoint is None:
                raise RuntimeError(
                    "new replay actor did not create an initial checkpoint"
                )
            snapshot = await actor.public_snapshot()
            durable_state = await actor.durable_state()
            persisted_ref, persisted_blob = self._persisted_dataset(
                actual_dataset,
                trade_dataset_ref,
            )
            extension_write = None
            if extension_factory is not None:
                extension_write = extension_factory(
                    session_id=session_id,
                    session_state=durable_state,
                    component_state=snapshot["components"],
                    broker_config=broker.to_dict(),
                    dataset_ref=persisted_ref,
                    dataset_blob=persisted_blob,
                    actual_replay_start_ms=actual_dataset.replay_start_ms,
                    actual_replay_end_ms=actual_dataset.replay_end_open_ms,
                )
                if not callable(extension_write):
                    raise TypeError("replay persistence extension must be callable")
            persist_task = asyncio.create_task(
                self.store.create_session(
                    session_id=session_id,
                    config=actor_config.to_dict(),
                    broker_config=broker.to_dict(),
                    session_state=durable_state,
                    dataset_ref=persisted_ref,
                    dataset_blob=canonical_json_bytes(persisted_blob),
                    actual_replay_start_ms=actual_dataset.replay_start_ms,
                    actual_replay_end_ms=actual_dataset.replay_end_open_ms,
                    synthetic_origin_ms=origin,
                    initial_checkpoint=initial_checkpoint,
                    component_state=snapshot["components"],  # type: ignore[arg-type]
                    extension_write=extension_write,  # type: ignore[arg-type]
                ),
                name=f"replay-create-persist-{session_id}",
            )
            try:
                await asyncio.shield(persist_task)
            except asyncio.CancelledError:
                # sqlite work submitted through to_thread cannot be cancelled.
                # Resolve its actual outcome so a committed row is always
                # compensated before propagating request cancellation.  A second
                # cancellation (for example service shutdown after client
                # disconnect) must not cancel the owned persistence task.
                try:
                    await self._await_task_uninterruptibly(persist_task)
                except BaseException:
                    pass
                else:
                    persisted = True
                raise
            persisted = True

            assert actor is not None
            created_at_ms = self._validated_now_ms()
            handle = ReplaySessionHandle(
                session_id=session_id,
                actor=actor,
                config=actor_config,
                broker_config=broker,
                actual_dataset=actual_dataset,
                actor_dataset=actor_dataset,
                synthetic_origin_ms=origin,
                created_at_ms=created_at_ms,
                last_activity_ms=created_at_ms,
                trade_dataset_ref=trade_dataset_ref,
                trade_pin_token=trade_pin_token,
            )
            payload = {
                "protocol": REPLAY_PROTOCOL,
                "session_id": session_id,
                "data_fidelity": self._data_fidelity(handle.config),
                "execution_fidelity": self._execution_fidelity(handle.config),
                "snapshot": snapshot,
                "forked": forked,
            }

            # The capacity reservation was acquired while accepting.  Once the
            # durable row exists, shutdown must let this accepted transaction
            # publish and return its ID.  Acquire explicitly so there is no await
            # (and therefore no cancellation point) between registration and
            # returning the prebuilt response.
            await self._lifecycle_lock.acquire()
            try:
                # create_session/fork_session already acquired a capacity
                # reservation while the service was accepting work.  Once the
                # durable row exists, shutdown must let that accepted transaction
                # publish and return its ID; rejecting here would strand an
                # unobservable orphan in replay_session.  Shutdown drains the
                # reservation before stopping every published actor.
                if session_id in self._sessions:
                    raise ReplayDomainError(
                        ReplayErrorCode.REVISION_CONFLICT,
                        "replay session id collision",
                    )
                self._sessions[session_id] = handle
                self._session_generation += 1
                self._metrics["sessions_created"] = (
                    int(self._metrics["sessions_created"] or 0) + 1
                )
                registered = True
            finally:
                self._lifecycle_lock.release()
            return payload
        except BaseException:
            if registered:
                # Registration and return are deliberately cancellation-free.
                # This branch protects against an unexpected synchronous failure
                # without tearing down a handle already owned by the service.
                raise
            compensation_error: BaseException | None = None
            if persisted:
                try:
                    delete_task = asyncio.create_task(
                        self.store.delete_session(session_id),
                        name=f"replay-create-compensate-{session_id}",
                    )
                    deleted = await self._await_task_uninterruptibly(delete_task)
                    if not deleted:
                        raise RuntimeError(
                            "persisted replay session disappeared before compensation"
                        )
                except BaseException as exc:
                    compensation_error = exc
            if actor is not None:
                await self._abort_unregistered_actor_uninterruptibly(actor)
            self._datasets.release(session_id)
            if trade_pin_token is not None:
                self._raw_trade_archive.release_dataset(trade_pin_token)
            if compensation_error is not None:
                if config.blind_mode:
                    raise self._blind_safe_internal_error(
                        ReplayErrorCode.PERSISTENCE_DEGRADED
                    ) from compensation_error
                raise ReplayDomainError(
                    ReplayErrorCode.PERSISTENCE_DEGRADED,
                    "failed to compensate an incomplete replay session creation",
                    details={
                        "reason": (
                            f"{type(compensation_error).__name__}: "
                            f"{compensation_error}"
                        )
                    },
                ) from compensation_error
            raise

    async def _recover_record(
        self,
        record: Mapping[str, object],
    ) -> ReplaySessionHandle:
        session_id = str(record["session_id"])
        dataset_record = await self.store.load_dataset(session_id)
        if dataset_record is None:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay dataset reference is missing",
            )
        config_payload = record["config"]
        broker_payload = record["broker_config"]
        if not isinstance(config_payload, Mapping) or not isinstance(
            broker_payload, Mapping
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay config is invalid",
            )
        config = ReplaySessionConfig.from_dict(config_payload)
        broker_config = BrokerConfig.from_dict(broker_payload)
        try:
            decoded = json.loads(bytes(dataset_record["snapshot_blob"]).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay dataset JSON is invalid",
            ) from exc
        if not isinstance(decoded, Mapping):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted replay dataset must be an object",
            )
        trade_dataset_ref: RawAggTradeDatasetRef | None = None
        if config.source_kind is SourceKind.AGG_TRADE:
            expected = {
                "schema_version",
                "bar_dataset",
                "trade_dataset_ref",
            }
            if (
                set(decoded) != expected
                or decoded["schema_version"] != TRADE_SESSION_DATASET_SCHEMA_VERSION
                or not isinstance(decoded["bar_dataset"], Mapping)
                or not isinstance(decoded["trade_dataset_ref"], Mapping)
            ):
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "persisted aggregate-trade dataset bundle is incompatible",
                )
            actual_dataset = BarDatasetSnapshot.from_dict(decoded["bar_dataset"])
            trade_dataset_ref = RawAggTradeDatasetRef.from_dict(
                decoded["trade_dataset_ref"]
            )
            if trade_dataset_ref.data_epoch != record["data_epoch"]:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "persisted trade dataset epoch does not match session",
                )
            await asyncio.to_thread(
                self._assert_trade_dataset_parity,
                config,
                actual_dataset,
                trade_dataset_ref,
            )
        else:
            actual_dataset = BarDatasetSnapshot.from_dict(decoded)
            if actual_dataset.data_epoch != record["data_epoch"]:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_MISMATCH,
                    "persisted BAR dataset epoch does not match session",
                )
        origin_value = dataset_record["synthetic_origin_ms"]
        origin = None if origin_value is None else int(origin_value)
        if config.blind_mode and origin is None:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "blind replay session is missing its synthetic time origin",
            )
        actor_dataset = (
            remap_bar_snapshot_time(actual_dataset, synthetic_replay_start_ms=origin)
            if config.blind_mode
            else actual_dataset
        )
        checkpoints = await self.store.load_valid_checkpoints(session_id)
        if not checkpoints:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay session has no valid checkpoint",
            )
        self._datasets.pin(session_id, actor_dataset)
        trade_pin_token: str | None = None
        last_error: BaseException | None = None
        actor: ReplaySessionActor | None = None
        try:
            if trade_dataset_ref is not None:
                trade_pin_token = await self._pin_trade_dataset(
                    trade_dataset_ref,
                    task_name=f"replay-recovery-pin-{session_id}",
                )
            for checkpoint_index, checkpoint in enumerate(checkpoints):
                if checkpoint.mutation_id is None:
                    if not self._legacy_checkpoint_matches_record(
                        checkpoint,
                        record,
                    ):
                        last_error = ReplayDomainError(
                            ReplayErrorCode.DATASET_MISMATCH,
                            "legacy replay checkpoint has an ambiguous mutation tail",
                        )
                        continue
                    tail: tuple[dict[str, object], ...] = ()
                else:
                    tail = await self.store.recovery_mutations_after(
                        session_id,
                        mutation_id=checkpoint.mutation_id,
                    )
                target = ActorRecoveryTarget(
                    mutations=tail,
                    revision=int(record["revision"]),
                    event_sequence=int(record["event_sequence"]),
                    command_log_offset=int(record["command_log_offset"]),
                    state_hash=str(record["state_hash"]),
                )
                reducer = self._broker(
                    config,
                    actor_dataset,
                    broker_config,
                    trade_dataset_ref=trade_dataset_ref,
                )
                candidate = self._actor(
                    session_id=session_id,
                    config=config,
                    dataset=actor_dataset,
                    trade_dataset_ref=trade_dataset_ref,
                    reducer=reducer,
                    restore_checkpoint=checkpoint.payload,
                    retained_checkpoints=tuple(
                        (item.payload, item.is_initial)
                        for item in checkpoints[checkpoint_index:]
                    ),
                    recovery_target=target,
                )
                try:
                    await candidate.start()
                except asyncio.CancelledError:
                    try:
                        await self._shutdown_actor_uninterruptibly(
                            candidate,
                            step_timeout=0.5,
                            task_name=f"replay-recovery-cleanup-{session_id}",
                        )
                    except BaseException:
                        pass
                    raise
                except BaseException as exc:
                    try:
                        await self._shutdown_actor_uninterruptibly(
                            candidate,
                            step_timeout=0.5,
                            task_name=f"replay-recovery-reject-{session_id}",
                        )
                    except BaseException:
                        pass
                    last_error = exc
                    continue
                actor = candidate
                break
            if actor is None:
                raise last_error or RuntimeError("all replay checkpoints were rejected")
            handle = ReplaySessionHandle(
                session_id=session_id,
                actor=actor,
                config=config,
                broker_config=broker_config,
                actual_dataset=actual_dataset,
                actor_dataset=actor_dataset,
                synthetic_origin_ms=origin,
                created_at_ms=int(record["created_at_ms"]),
                last_activity_ms=int(record["updated_at_ms"]),
                trade_dataset_ref=trade_dataset_ref,
                trade_pin_token=trade_pin_token,
            )
            async with self._lifecycle_lock:
                self._ensure_available(blind_mode=config.blind_mode)
                existing = self._sessions.get(session_id)
                if existing is not None:
                    raise ReplayDomainError(
                        ReplayErrorCode.REVISION_CONFLICT,
                        "replay session recovery raced another actor",
                    )
                self._sessions[session_id] = handle
                self._session_generation += 1
                self._metrics["sessions_recovered"] = (
                    int(self._metrics["sessions_recovered"] or 0) + 1
                )
            return handle
        except BaseException:
            self._datasets.release(session_id)
            if trade_pin_token is not None:
                self._raw_trade_archive.release_dataset(trade_pin_token)
            if actor is not None:
                try:
                    await self._shutdown_actor_uninterruptibly(
                        actor,
                        step_timeout=0.5,
                        task_name=f"replay-recovery-rollback-{session_id}",
                    )
                except BaseException:
                    pass
            raise

    @staticmethod
    def _legacy_checkpoint_matches_record(
        checkpoint: StoredCheckpoint,
        record: Mapping[str, object],
    ) -> bool:
        """Allow V1 recovery only when no unrepresented tail can exist.

        The physical latest-checkpoint requirement is important: if that row
        is corrupt, an older row can have the same public state hash while
        differing in revision, controller, or clock speed.
        """

        return (
            checkpoint.is_latest
            and checkpoint.source_sequence == int(record["source_sequence"])
            and checkpoint.command_log_offset
            == int(record["command_log_offset"])
            and checkpoint.event_sequence == int(record["event_sequence"])
            and checkpoint.state_hash == str(record["state_hash"])
        )

    def _actor(
        self,
        *,
        session_id: str,
        config: ReplaySessionConfig,
        dataset: BarDatasetSnapshot,
        trade_dataset_ref: RawAggTradeDatasetRef | None,
        reducer: ConservativeBarBroker,
        restore_checkpoint: bytes | None,
        retained_checkpoints: Sequence[tuple[bytes, bool]] = (),
        recovery_target: ActorRecoveryTarget | None,
    ) -> ReplaySessionActor:
        if trade_dataset_ref is None:

            def source_factory() -> BarReplaySource:
                return BarReplaySource(dataset)
        else:
            time_offset_ms = dataset.replay_start_ms - trade_dataset_ref.start_time_ms

            def source_factory() -> TradeReplaySource:
                return TradeReplaySource(
                    PagedReplayTradeReader(
                        self._raw_trade_archive,
                        trade_dataset_ref,
                        page_rows=self.settings.trade_page_rows,
                    ),
                    time_offset_ms=time_offset_ms,
                    blind_mode=config.blind_mode,
                )

        return ReplaySessionActor(
            session_id=session_id,
            config=config,
            source_factory=source_factory,
            initial_virtual_time_ms=dataset.replay_start_ms,
            command_queue_size=self.settings.command_queue_size,
            event_buffer_size=self.settings.event_buffer_size,
            max_emit_fps=self.settings.max_emit_fps,
            controller_ttl_seconds=self.settings.controller_ttl_seconds,
            checkpoint_event_interval=self.settings.checkpoint_event_interval,
            checkpoint_virtual_ms=self.settings.checkpoint_virtual_ms,
            reducer=reducer,
            restore_checkpoint=restore_checkpoint,
            retained_checkpoints=retained_checkpoints,
            mutation_hook=self._persist_mutation,
            recovery_target=recovery_target,
        )

    async def _persist_mutation(self, mutation: ActorMutation) -> None:
        if mutation.command is not None:
            result = (
                None
                if mutation.result is None
                else self._command_result_payload(mutation.result)
            )
            error = mutation.error
            await self.store.commit_command(
                session_id=mutation.session_id,
                command=mutation.command.to_dict(),
                accepted=error is None,
                result=result,
                error_code=None if error is None else error.code.value,
                error_message=None if error is None else error.message,
                error_details=None if error is None else dict(error.details),
                session_state=mutation.session_state,
                checkpoint=mutation.checkpoint,
                source_events=mutation.source_events,
                component_state=mutation.component_state,
            )
            return
        if mutation.kind == "source_event":
            if len(mutation.source_events) != 1:
                raise ReplayDomainError(
                    ReplayErrorCode.PERSISTENCE_DEGRADED,
                    "autonomous source transaction must contain exactly one event",
                )
            await self.store.commit_source_event(
                session_id=mutation.session_id,
                source_event=mutation.source_events[0],
                session_state=mutation.session_state,
                checkpoint=mutation.checkpoint,
                component_state=mutation.component_state,
            )
            return
        if mutation.checkpoint is None:
            raise ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "internal replay mutation requires a checkpoint",
            )
        await self.store.commit_state(
            session_id=mutation.session_id,
            kind=mutation.kind,
            payload={"events": [event.to_dict() for event in mutation.events]},
            session_state=mutation.session_state,
            checkpoint=mutation.checkpoint,
            component_state=mutation.component_state,
        )

    @asynccontextmanager
    async def _lease_handle(
        self,
        session_id: str,
    ) -> AsyncIterator[ReplaySessionHandle]:
        handle = await self._acquire_handle_lease(session_id)
        try:
            yield handle
        finally:
            self._release_handle_lease(handle)

    async def _acquire_handle_lease(self, session_id: str) -> ReplaySessionHandle:
        # This counter is event-loop confined and its synchronous finally is
        # deliberately cancellation-safe. Shutdown waits for every accepted
        # acquisition before closing the store.
        self._ensure_accepting()
        self._pending_handle_acquisitions += 1
        self._track_pending_lifecycle_owner()
        try:
            while True:
                wait_for_deletion: asyncio.Event | None = None
                wait_for_eviction: asyncio.Event | None = None
                wait_for_recovery: ReplayRecoveryClaim | None = None
                observed_session_generation = 0
                async with self._lifecycle_lock:
                    self._ensure_accepting()
                    wait_for_deletion = self._pending_session_deletions.get(
                        session_id
                    )
                    if wait_for_deletion is not None:
                        handle = None
                    else:
                        handle = self._sessions.get(session_id)
                        if handle is not None:
                            if handle.evicting:
                                wait_for_eviction = handle.eviction_complete
                            else:
                                self._activate_handle_lease_locked(handle)
                                return handle
                        else:
                            unavailable = self._unavailable_sessions.get(session_id)
                            if unavailable is not None:
                                raise unavailable
                            wait_for_recovery = self._pending_recoveries.get(
                                session_id
                            )
                            observed_session_generation = self._session_generation
                if wait_for_deletion is not None:
                    await wait_for_deletion.wait()
                    continue
                if wait_for_eviction is not None:
                    await wait_for_eviction.wait()
                    continue
                if wait_for_recovery is not None:
                    await wait_for_recovery.complete.wait()
                    if wait_for_recovery.error is not None:
                        raise wait_for_recovery.error
                    continue

                record = await self.store.get_session(session_id)
                if record is None:
                    raise ReplayDomainError(
                        ReplayErrorCode.SESSION_NOT_FOUND,
                        "replay session does not exist",
                        details={"session_id": session_id},
                    )
                blind_mode = self._persisted_blind_mode(record)
                if record["degraded_reason"] is not None:
                    if blind_mode:
                        raise self._blind_safe_internal_error(
                            ReplayErrorCode.PERSISTENCE_DEGRADED
                        )
                    raise ReplayDomainError(
                        ReplayErrorCode.PERSISTENCE_DEGRADED,
                        "replay session is unavailable after a recovery failure",
                        details={"reason": record["degraded_reason"]},
                    )

                await self._prune_reclaimable_sessions()
                recovery_claim: ReplayRecoveryClaim | None = None
                start_recovery = False
                restart_lookup = False
                wait_for_deletion = None
                async with self._lifecycle_lock:
                    self._ensure_available(blind_mode=blind_mode)
                    wait_for_deletion = self._pending_session_deletions.get(
                        session_id
                    )
                    if wait_for_deletion is not None:
                        handle = None
                    elif self._session_generation != observed_session_generation:
                        restart_lookup = True
                    else:
                        handle = self._sessions.get(session_id)
                        if handle is not None:
                            if handle.evicting:
                                wait_for_eviction = handle.eviction_complete
                            else:
                                self._activate_handle_lease_locked(handle)
                                return handle
                        else:
                            recovery_claim = self._pending_recoveries.get(
                                session_id
                            )
                            if recovery_claim is None:
                                self._ensure_session_capacity_locked()
                                self._pending_session_reservations += 1
                                self._track_pending_lifecycle_owner()
                                recovery_claim = ReplayRecoveryClaim()
                                self._pending_recoveries[session_id] = recovery_claim
                                start_recovery = True
                if wait_for_deletion is not None:
                    await wait_for_deletion.wait()
                    continue
                if restart_lookup:
                    continue
                if wait_for_eviction is not None:
                    await wait_for_eviction.wait()
                    continue
                assert recovery_claim is not None
                if not start_recovery:
                    await recovery_claim.complete.wait()
                    if recovery_claim.error is not None:
                        raise recovery_claim.error
                    continue
                try:
                    recovered = await self._recover_record(record)
                    async with self._lifecycle_lock:
                        self._ensure_available(blind_mode=blind_mode)
                        if self._sessions.get(session_id) is not recovered:
                            raise ReplayDomainError(
                                ReplayErrorCode.REVISION_CONFLICT,
                                "replay session recovery lost actor ownership",
                            )
                        self._activate_handle_lease_locked(recovered)
                        self._finish_recovery_claim(session_id, recovery_claim)
                        return recovered
                except asyncio.CancelledError:
                    raise
                except BaseException as exc:
                    error = self._recovery_error(exc, blind_mode=blind_mode)
                    recovery_claim.error = error
                    raise error from exc
                finally:
                    self._finish_recovery_claim(session_id, recovery_claim)
        finally:
            if self._pending_handle_acquisitions < 1:
                raise RuntimeError("replay handle acquisition count underflow")
            self._pending_handle_acquisitions -= 1
            self._untrack_pending_lifecycle_owner()
            self._lifecycle_changed.set()

    def _activate_handle_lease_locked(self, handle: ReplaySessionHandle) -> None:
        if handle.evicting:
            raise RuntimeError("cannot lease an evicting replay session")
        handle.in_flight += 1
        owner = asyncio.current_task()
        if owner is None:
            raise RuntimeError("replay lease requires an asyncio task owner")
        self._lease_owners[owner] = self._lease_owners.get(owner, 0) + 1
        handle.activity_generation += 1
        handle.last_activity_ms = self._validated_now_ms()

    def _release_handle_lease(self, handle: ReplaySessionHandle) -> None:
        if handle.in_flight < 1:
            raise RuntimeError("replay session lease count underflow")
        handle.in_flight -= 1
        owner = asyncio.current_task()
        if owner is None or self._lease_owners.get(owner, 0) < 1:
            raise RuntimeError("replay lease owner count underflow")
        remaining = self._lease_owners[owner] - 1
        if remaining:
            self._lease_owners[owner] = remaining
        else:
            self._lease_owners.pop(owner, None)
        handle.activity_generation += 1
        handle.last_activity_ms = self._validated_now_ms()
        self._lifecycle_changed.set()

    async def _reserve_session_capacity(self, *, blind_mode: bool) -> None:
        # Reaping may await actor mailboxes and shutdown, so it deliberately runs
        # before the short reservation critical section.
        await self._prune_reclaimable_sessions()
        async with self._lifecycle_lock:
            self._ensure_available(blind_mode=blind_mode)
            self._ensure_session_capacity_locked()
            self._pending_session_reservations += 1
            self._track_pending_lifecycle_owner()

    def _release_session_capacity_reservation(self) -> None:
        if self._pending_session_reservations < 1:
            raise RuntimeError("replay session capacity reservation underflow")
        self._pending_session_reservations -= 1
        self._untrack_pending_lifecycle_owner()
        self._lifecycle_changed.set()

    def _finish_recovery_claim(
        self,
        session_id: str,
        claim: ReplayRecoveryClaim,
    ) -> None:
        # No await is permitted here: this is the cancellation-safe release
        # path for both the single-flight claim and its capacity reservation.
        if self._pending_recoveries.get(session_id) is not claim:
            return
        self._pending_recoveries.pop(session_id, None)
        self._release_session_capacity_reservation()
        claim.complete.set()

    def _ensure_session_capacity_locked(self) -> None:
        if (
            len(self._sessions) + self._pending_session_reservations
            >= self.settings.max_active_sessions
        ):
            raise ReplayDomainError(
                ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                "active replay session limit exceeded",
                details={"limit": self.settings.max_active_sessions},
            )

    async def _session_reaper_loop(self) -> None:
        interval_seconds = min(
            30.0,
            max(0.1, self.settings.idle_ttl_seconds / 4),
        )
        while not self._reaper_stop.is_set():
            try:
                await asyncio.wait_for(
                    self._reaper_stop.wait(),
                    timeout=interval_seconds,
                )
                return
            except TimeoutError:
                pass
            try:
                await self._prune_reclaimable_sessions(capacity_pressure=False)
            except Exception as exc:
                self._metrics["reaper_failures"] = (
                    int(self._metrics["reaper_failures"] or 0) + 1
                )
                self._metrics["last_reaper_error"] = (f"{type(exc).__name__}: {exc}")[
                    :500
                ]

    async def _prune_reclaimable_sessions(
        self,
        *,
        capacity_pressure: bool = True,
    ) -> None:
        async with self._prune_lock:
            if not self._accepting or self._closed:
                return
            await self._prune_reclaimable_sessions_exclusive(
                capacity_pressure=capacity_pressure
            )

    async def _prune_reclaimable_sessions_exclusive(
        self,
        *,
        capacity_pressure: bool,
    ) -> None:
        idle_ttl_ms = self.settings.idle_ttl_seconds * 1_000
        async with self._lifecycle_lock:
            candidates = tuple(
                (
                    session_id,
                    handle,
                    handle.activity_generation,
                )
                for session_id, handle in self._sessions.items()
                if (
                    session_id not in self._pending_recoveries
                    and not handle.evicting
                    and handle.in_flight == 0
                )
            )
        for session_id, handle, observed_generation in candidates:
            # A stream subscription materializes the actor's cached snapshot, but
            # later commands are intentionally handled without refreshing that
            # cache.  Capacity and TTL decisions therefore have to enter the
            # mailbox and observe the actor's current state.
            snapshot = await self._snapshot_for_prune(handle.actor)
            if snapshot is None:
                return
            ended = snapshot.state is SessionState.ENDED
            activity_age_ms = (
                self._validated_now_ms() - handle.last_activity_ms
            )
            ended_handoff_complete = (
                activity_age_ms >= _ENDED_SESSION_HANDOFF_GRACE_MS
            )
            idle = (
                snapshot.controller_client_id is None
                and activity_age_ms >= idle_ttl_ms
            )
            if not idle and not (
                ended and (capacity_pressure or ended_handoff_complete)
            ):
                continue
            reason = "ended" if ended else "idle_ttl"
            async with self._lifecycle_lock:
                if (
                    not self._accepting
                    or self._prune_abort.is_set()
                    or self._sessions.get(session_id) is not handle
                    or handle.evicting
                    or handle.in_flight != 0
                    or handle.activity_generation != observed_generation
                ):
                    continue
                activity_age_ms = (
                    self._validated_now_ms() - handle.last_activity_ms
                )
                if (
                    reason == "ended"
                    and not capacity_pressure
                    and activity_age_ms < _ENDED_SESSION_HANDOFF_GRACE_MS
                ):
                    continue
                if reason == "idle_ttl" and activity_age_ms < idle_ttl_ms:
                    continue
                handle.evicting = True
                handle.eviction_complete.clear()
            await self._evict_claimed_handle(
                session_id,
                handle,
                reason=reason,
            )

    async def _evict_claimed_handle(
        self,
        session_id: str,
        handle: ReplaySessionHandle,
        *,
        reason: str,
    ) -> None:
        try:
            await handle.actor.shutdown(
                step_timeout=_EVICTION_SHUTDOWN_STEP_TIMEOUT_SECONDS
            )
        except BaseException:
            async with self._lifecycle_lock:
                if self._sessions.get(session_id) is handle:
                    handle.evicting = False
                    handle.eviction_complete.set()
            raise

        release_error: BaseException | None = None
        try:
            self._datasets.release(session_id)
            if handle.trade_pin_token is not None:
                self._raw_trade_archive.release_dataset(handle.trade_pin_token)
        except BaseException as exc:
            release_error = exc
        finally:
            async with self._lifecycle_lock:
                if self._sessions.get(session_id) is handle:
                    self._sessions.pop(session_id, None)
                    self._session_generation += 1
                    self._metrics["sessions_evicted"] = (
                        int(self._metrics["sessions_evicted"] or 0) + 1
                    )
                    metric = (
                        "ended_sessions_evicted"
                        if reason == "ended"
                        else (
                            "hub_sessions_evicted"
                            if reason == "hub"
                            else "idle_sessions_evicted"
                        )
                    )
                    self._metrics[metric] = int(self._metrics[metric] or 0) + 1
                handle.eviction_complete.set()
        if release_error is not None:
            raise release_error

    async def _snapshot_for_prune(
        self,
        actor: ReplaySessionActor,
    ) -> ActorSnapshot | None:
        snapshot_task = asyncio.create_task(actor.snapshot())
        abort_task = asyncio.create_task(self._prune_abort.wait())
        try:
            done, _pending = await asyncio.wait(
                (snapshot_task, abort_task),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if abort_task in done:
                snapshot_task.cancel()
                await asyncio.gather(snapshot_task, return_exceptions=True)
                return None
            abort_task.cancel()
            await asyncio.gather(abort_task, return_exceptions=True)
            return await snapshot_task
        finally:
            for task in (snapshot_task, abort_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(snapshot_task, abort_task, return_exceptions=True)

    async def _wait_for_pending_lifecycle_drain(
        self,
        *,
        timeout: float | None,
    ) -> bool:
        async def wait() -> None:
            while True:
                async with self._lifecycle_lock:
                    drained = (
                        self._pending_session_reservations == 0
                        and self._pending_handle_acquisitions == 0
                        and not self._pending_recoveries
                        and not self._pending_session_deletions
                    )
                    if drained:
                        return
                    self._lifecycle_changed.clear()
                await self._lifecycle_changed.wait()

        if timeout is None:
            await wait()
        else:
            try:
                await asyncio.wait_for(wait(), timeout=max(0.01, timeout))
            except TimeoutError:
                return False
        return True

    def _track_pending_lifecycle_owner(self) -> None:
        owner = asyncio.current_task()
        if owner is None:
            raise RuntimeError("replay lifecycle work requires an asyncio task owner")
        self._pending_lifecycle_owners[owner] = (
            self._pending_lifecycle_owners.get(owner, 0) + 1
        )

    def _untrack_pending_lifecycle_owner(self) -> None:
        owner = asyncio.current_task()
        if owner is None or self._pending_lifecycle_owners.get(owner, 0) < 1:
            raise RuntimeError("replay lifecycle owner count underflow")
        remaining = self._pending_lifecycle_owners[owner] - 1
        if remaining:
            self._pending_lifecycle_owners[owner] = remaining
        else:
            self._pending_lifecycle_owners.pop(owner, None)

    async def _wait_for_lease_drain(self, *, timeout: float) -> bool:
        async def wait() -> None:
            while self._lease_owners:
                self._lifecycle_changed.clear()
                if not self._lease_owners:
                    return
                await self._lifecycle_changed.wait()

        try:
            await asyncio.wait_for(wait(), timeout=max(0.01, timeout))
        except TimeoutError:
            return False
        return True

    async def _session_payload(self, handle: ReplaySessionHandle) -> dict[str, object]:
        snapshot = await handle.actor.public_snapshot()
        return {
            "protocol": REPLAY_PROTOCOL,
            "session_id": handle.session_id,
            "data_fidelity": self._data_fidelity(handle.config),
            "execution_fidelity": self._execution_fidelity(handle.config),
            "snapshot": snapshot,
        }

    @staticmethod
    def _command_result_payload(result: CommandResult) -> dict[str, object]:
        cursor = result.cursor
        return {
            "command_id": result.command_id,
            "revision": result.revision,
            "sequence": result.sequence,
            "state": result.state.value,
            "state_hash": result.state_hash,
            "cursor": {
                "virtual_time_ms": cursor.virtual_time_ms,
                "source_sequence": cursor.source_sequence,
                "last_base_bar_open_ms": cursor.last_base_bar_open_ms,
                "last_trade_time_ms": cursor.last_trade_time_ms,
                "last_agg_trade_id": cursor.last_agg_trade_id,
                "at_end": cursor.at_end,
            },
            "data": dict(result.data),
        }

    @staticmethod
    def _replay_stored_command(
        stored: StoredCommand, command: ReplayCommand
    ) -> CommandResult:
        fingerprint = canonical_sha256(command.to_dict())
        if fingerprint != stored.fingerprint:
            raise ReplayDomainError(
                ReplayErrorCode.COMMAND_ID_REUSED,
                "command_id was reused with a different canonical command",
                details={"command_id": command.command_id},
            )
        if not stored.accepted:
            code = (
                ReplayErrorCode(stored.error_code)
                if stored.error_code is not None
                else ReplayErrorCode.INVALID_STATE_TRANSITION
            )
            raise ReplayDomainError(
                code,
                stored.error_message or "persisted replay command was rejected",
                details=stored.error_details,
            )
        payload = stored.result
        if not isinstance(payload, Mapping):
            raise ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "persisted accepted command result is missing",
            )
        cursor_payload = payload.get("cursor")
        if not isinstance(cursor_payload, Mapping):
            raise ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "persisted command cursor is invalid",
            )
        return CommandResult(
            command_id=str(payload["command_id"]),
            revision=int(payload["revision"]),
            sequence=int(payload["sequence"]),
            state=SessionState(str(payload["state"])),
            state_hash=str(payload["state_hash"]),
            cursor=ReplayCursor(**cursor_payload),  # type: ignore[arg-type]
            data=payload.get("data", {}),  # type: ignore[arg-type]
        )

    @staticmethod
    def _broker(
        config: ReplaySessionConfig,
        dataset: BarDatasetSnapshot,
        broker_config: BrokerConfig,
        *,
        trade_dataset_ref: RawAggTradeDatasetRef | None = None,
        execution_mode: str = PAPER_LINEAR_EXECUTION_MODE,
    ) -> ConservativeBarBroker:
        max_closed_bars = min(10_000, max(1, dataset.row_count))
        if config.source_kind is SourceKind.AGG_TRADE:
            if trade_dataset_ref is None:
                raise ReplayDomainError(
                    ReplayErrorCode.DATASET_INCOMPLETE,
                    "aggregate-trade broker is missing its dataset ref",
                )
            builder: ReplayBarBuilder | TradeReplayBarBuilder = TradeReplayBarBuilder(
                base_interval=config.base_interval,
                display_interval=config.display_interval,
                replay_start_ms=dataset.replay_start_ms,
                replay_end_time_ms=dataset.replay_rows[-1].close_time_ms,
                warmup_bars=dataset.warmup_rows,
                max_closed_bars=max_closed_bars,
            )
        else:
            builder = ReplayBarBuilder(
                base_interval=config.base_interval,
                display_interval=config.display_interval,
                replay_start_ms=dataset.replay_start_ms,
                warmup_bars=dataset.warmup_rows,
                max_closed_bars=max_closed_bars,
            )
        return ConservativeBarBroker(
            config=broker_config,
            bar_builder=builder,
            execution_mode=execution_mode,
        )

    @staticmethod
    def _broker_config(
        config: ReplaySessionConfig,
        dataset: BarDatasetSnapshot,
    ) -> BrokerConfig:
        first = dataset.replay_rows[0]
        scale = max(
            8,
            *(
                max(0, -Decimal(value).as_tuple().exponent)
                for value in (
                    first.open,
                    first.high,
                    first.low,
                    first.close,
                )
            ),
        )
        scale = min(scale, 18)
        tick = format(Decimal(1).scaleb(-scale), "f")
        with localcontext() as context:
            context.prec = 60
            max_notional = Decimal(config.initial_equity) * Decimal(config.max_leverage)
        max_notional_text = format(max_notional, "f")
        return BrokerConfig(
            initial_equity=config.initial_equity,
            quote_asset=config.quote_asset,
            maker_bps=config.fee_model.maker_bps,
            taker_bps=config.fee_model.taker_bps,
            market_slippage_bps=config.slippage_model.market_bps,
            initial_mark_price=first.open,
            instrument=InstrumentFilters(
                price_tick=tick,
                quantity_step="0.00000001",
                min_quantity="0.00000001",
                max_quantity="1000000000",
                min_notional="0.01",
                max_notional=max_notional_text,
                quote_step="0.00000001",
            ),
            limits=BrokerLimits(
                max_leverage=config.max_leverage,
                max_position_notional=max_notional_text,
                max_order_quantity="1000000000",
                max_open_orders=256,
                max_orders=4_096,
                max_fills=8_192,
                max_ledger_entries=65_536,
                max_warnings=4_096,
            ),
        )

    def _require_trade_capability(self) -> None:
        diagnostics = self._raw_trade_archive.diagnostics()
        if not diagnostics.get("enabled"):
            raise ReplayDomainError(
                ReplayErrorCode.ARCHIVE_DISABLED,
                "aggregate-trade replay archive is disabled",
            )
        if diagnostics.get("state") != "ready":
            raise ReplayDomainError(
                ReplayErrorCode.ARCHIVE_DEGRADED,
                "aggregate-trade replay archive is degraded",
            )
        if not diagnostics.get("verified_partitions_available"):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_INCOMPLETE,
                "aggregate-trade replay archive has no verified exact dataset",
            )

    async def _freeze_trade_dataset(
        self,
        config: ReplaySessionConfig,
        dataset: BarDatasetSnapshot,
    ) -> RawAggTradeDatasetRef:
        try:
            reference = await asyncio.to_thread(
                self._raw_trade_archive.freeze_dataset,
                exchange=config.exchange,
                market_type=config.market_type,
                symbol=config.symbol,
                start_time_ms=dataset.replay_start_ms,
                end_time_ms=dataset.replay_rows[-1].close_time_ms,
                page_rows=self.settings.trade_page_rows,
            )
        except ReplayDomainError as exc:
            raise self._blind_safe_dataset_error(config, exc) from exc
        except Exception as exc:
            diagnostics = self._raw_trade_archive.diagnostics()
            code = (
                ReplayErrorCode.ARCHIVE_DEGRADED
                if diagnostics.get("state") != "ready"
                else ReplayErrorCode.DATASET_INCOMPLETE
            )
            raise ReplayDomainError(
                code,
                "no checksum-verified exact aggregate-trade dataset covers "
                "the selected replay window",
            ) from exc
        expected_identity = (
            config.exchange.lower(),
            config.market_type.lower(),
            config.symbol.upper(),
        )
        if (
            reference.exchange,
            reference.market_type,
            reference.symbol,
        ) != expected_identity or (
            reference.start_time_ms,
            reference.end_time_ms,
        ) != (
            dataset.replay_start_ms,
            dataset.replay_rows[-1].close_time_ms,
        ):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "frozen aggregate-trade dataset identity or time range changed",
            )
        return reference

    def _assert_trade_dataset_parity(
        self,
        config: ReplaySessionConfig,
        dataset: BarDatasetSnapshot,
        trade_dataset_ref: RawAggTradeDatasetRef,
    ) -> None:
        try:
            self._assert_trade_dataset_parity_unredacted(
                config,
                dataset,
                trade_dataset_ref,
            )
        except ReplayDomainError as exc:
            raise self._blind_safe_dataset_error(config, exc) from exc

    def _assert_trade_dataset_parity_unredacted(
        self,
        config: ReplaySessionConfig,
        dataset: BarDatasetSnapshot,
        trade_dataset_ref: RawAggTradeDatasetRef,
    ) -> None:
        reader = PagedReplayTradeReader(
            self._raw_trade_archive,
            trade_dataset_ref,
            page_rows=self.settings.trade_page_rows,
        )
        builder = TradeReplayBarBuilder(
            base_interval=config.base_interval,
            display_interval=config.base_interval,
            replay_start_ms=dataset.replay_start_ms,
            replay_end_time_ms=dataset.replay_rows[-1].close_time_ms,
            warmup_bars=dataset.warmup_rows,
            max_closed_bars=max(1, dataset.row_count),
        )
        count = 0
        for trade in reader.iter_trades():
            builder.apply_trade(trade)
            count += 1
        if count != trade_dataset_ref.row_count:
            raise ReplayDomainError(
                ReplayErrorCode.DATA_GAP,
                "aggregate-trade parity scan did not consume the frozen row count",
            )
        builder.finalize_bars(virtual_time_ms=dataset.replay_rows[-1].close_time_ms)
        replay_count = len(dataset.replay_rows)
        derived = builder.closed_bars[-replay_count:]
        assert_trade_bar_parity(derived, dataset.replay_rows)

    @staticmethod
    def _blind_safe_dataset_error(
        config_or_blind_mode: ReplaySessionConfig | bool,
        error: ReplayDomainError,
    ) -> ReplayDomainError:
        blind_mode = (
            config_or_blind_mode
            if isinstance(config_or_blind_mode, bool)
            else config_or_blind_mode.blind_mode
        )
        if blind_mode:
            return ReplayDomainError(
                error.code,
                "blind replay dataset validation failed",
                details={"blind_redacted": True},
            )
        return ReplayDomainError(
            error.code,
            error.message,
            details=dict(error.details),
        )

    @staticmethod
    def _blind_unexpected_dataset_error() -> ReplayDomainError:
        return ReplayDomainError(
            ReplayErrorCode.DATASET_INCOMPLETE,
            "blind replay dataset validation failed",
            details={"blind_redacted": True},
        )

    @staticmethod
    def _persisted_dataset(
        dataset: BarDatasetSnapshot,
        trade_dataset_ref: RawAggTradeDatasetRef | None,
    ) -> tuple[dict[str, object], dict[str, object]]:
        if trade_dataset_ref is None:
            return dataset.snapshot_ref().to_dict(), dataset.to_dict()
        reference = {
            "schema_version": TRADE_SESSION_REF_SCHEMA_VERSION,
            "data_epoch": trade_dataset_ref.data_epoch,
            "bar_data_epoch": dataset.data_epoch,
            "source_kind": SourceKind.AGG_TRADE.value,
            "trade_dataset_ref": trade_dataset_ref.to_dict(),
        }
        bundle = {
            "schema_version": TRADE_SESSION_DATASET_SCHEMA_VERSION,
            "bar_dataset": dataset.to_dict(),
            "trade_dataset_ref": trade_dataset_ref.to_dict(),
        }
        return reference, bundle

    @staticmethod
    def _data_fidelity(config: ReplaySessionConfig) -> str:
        return (
            DataFidelity.EXACT_AGG_TRADE_COVERAGE.value
            if config.source_kind is SourceKind.AGG_TRADE
            else DataFidelity.EXACT_BAR_COVERAGE.value
        )

    @staticmethod
    def _execution_fidelity(config: ReplaySessionConfig) -> str:
        return (
            ExecutionFidelity.AGG_TRADE_TAPE.value
            if config.source_kind is SourceKind.AGG_TRADE
            else ExecutionFidelity.BAR_CONSERVATIVE.value
        )

    async def _persist_report(self, handle: ReplaySessionHandle) -> None:
        report = dict(await handle.actor.report())
        report_hash = str(report.get("report_hash", ""))
        if report_hash:
            await self.store.save_report(handle.session_id, report, report_hash)

    async def _persist_report_after_command(
        self,
        handle: ReplaySessionHandle,
    ) -> None:
        """Persist the derived report without rewriting a committed command ACK."""

        try:
            await self._persist_report(handle)
        except asyncio.CancelledError:
            # Lifecycle cancellation remains observable.  The accepted command
            # is durable and can be reconciled by command_id after restart.
            raise
        except Exception:
            # The actor mutation and its command result committed atomically
            # before report generation.  A derived/report-table failure must
            # not present that accepted command as rejected or permanently
            # unknown to an idempotent retry.
            self._metrics["report_persistence_failures"] = (
                int(self._metrics["report_persistence_failures"] or 0) + 1
            )

    @staticmethod
    def _actual_history(handle: ReplaySessionHandle) -> dict[str, int]:
        return {
            "replay_start_ms": handle.actual_dataset.replay_start_ms,
            "replay_end_open_ms": handle.actual_dataset.replay_end_open_ms,
        }

    @staticmethod
    def _catalog_entry_payload(
        entry: ReplayCatalogEntry, *, blind_mode: bool
    ) -> dict[str, object]:
        if not blind_mode:
            return {**entry.to_hash_dict(), "catalog_epoch": entry.catalog_epoch}
        return {
            "identity": entry.identity.to_dict(),
            "base_intervals": list(entry.base_intervals),
            "selected_base_interval": entry.selected_base_interval,
            "eligible_window_count": entry.eligible_window_count,
            "quality": entry.quality.value if entry.quality is not None else None,
            "limitations": list(entry.limitations),
            "catalog_epoch": entry.catalog_epoch,
            "bounds": None,
            "eligible_ranges": [],
        }

    @staticmethod
    def _required_manual_start(config: ReplaySessionConfig) -> int:
        if config.requested_start_ms is None:
            raise ReplayDomainError(
                ReplayErrorCode.NO_ELIGIBLE_WINDOW,
                "manual replay start requires requested_start_ms",
            )
        return config.requested_start_ms

    @staticmethod
    def _synthetic_origin(interval: str) -> int:
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None or interval_ms <= 0:
            raise ReplayDomainError(
                ReplayErrorCode.UNSUPPORTED_INTERVAL,
                "cannot align synthetic timeline to base interval",
            )
        return compute_bucket_start_ms(
            SYNTHETIC_TIME_ANCHOR_MS,
            interval_ms,
            interval=interval,
        )

    @staticmethod
    def _all_local_intervals(_identity: ReplaySeriesIdentity) -> tuple[str, ...]:
        from app.data_engine.interval_policy import VALID_INTERVALS

        return tuple(VALID_INTERVALS)

    def _ensure_accepting(self) -> None:
        if self._closed or not self._accepting:
            raise ReplayDomainError(
                ReplayErrorCode.REPLAY_DISABLED,
                "replay service is not accepting new work",
            )

    def _ensure_available(self, *, blind_mode: bool = False) -> None:
        self._ensure_accepting()
        if self.store.degraded_reason is not None:
            details: dict[str, object] = (
                {"blind_redacted": True}
                if blind_mode
                else {"reason": self.store.degraded_reason}
            )
            raise ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "replay persistence is degraded",
                details=details,
            )

    def _validated_now_ms(self) -> int:
        value = self._now_ms()
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError("ReplayService clock must return a non-negative integer")
        return value

    @staticmethod
    def _recovery_error(
        error: BaseException,
        *,
        blind_mode: bool = False,
    ) -> ReplayDomainError:
        if blind_mode:
            code = (
                error.code
                if isinstance(error, ReplayDomainError)
                else ReplayErrorCode.DATASET_MISMATCH
            )
            return ReplayService._blind_safe_internal_error(code)
        if isinstance(error, ReplayDomainError):
            return error
        return ReplayDomainError(
            ReplayErrorCode.DATASET_MISMATCH,
            "replay session recovery failed",
            details={"reason": f"{type(error).__name__}: {error}"},
        )

    @staticmethod
    def _persisted_blind_mode(record: Mapping[str, object]) -> bool:
        config = record.get("config")
        if not isinstance(config, Mapping):
            return True
        # Only an explicit, well-typed False opts out. Corrupt persisted
        # metadata fails closed so recovery errors cannot disclose real data.
        return config.get("blind_mode") is not False

    @staticmethod
    def _blind_safe_internal_error(code: ReplayErrorCode) -> ReplayDomainError:
        return ReplayDomainError(
            code,
            "blind replay internal operation failed",
            details={"blind_redacted": True},
        )
