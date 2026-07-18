"""Application service owning replay datasets, actors, persistence and recovery."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, replace
from decimal import Decimal, localcontext
from typing import Callable, Mapping, Sequence

from app.core.config import ReplaySettings
from app.data_engine.interval_policy import compute_bucket_start_ms, parse_interval_ms
from app.data_engine.storage.klines_repo import KlinesRepoAdapter

from .actor import (
    ActorMutation,
    ActorRecoveryTarget,
    ActorStreamSubscription,
    ReplaySessionActor,
)
from .bars.builder import ReplayBarBuilder, assess_bar_builder_capability
from .broker.execution import ConservativeBarBroker
from .broker.models import BrokerConfig, BrokerLimits, InstrumentFilters
from .canonical import canonical_json_bytes, canonical_sha256
from .catalog import ReplayCatalog, ReplayCatalogEntry, ReplaySeriesIdentity
from .commands import CommandResult
from .constants import (
    REPLAY_PROTOCOL,
    CommandType,
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
from .models import ReplayCommand, ReplayCursor, ReplaySessionConfig
from .sources.bar_source import BarReplaySource
from .storage.sqlite_store import ReplaySQLiteStore, StoredCommand


SYNTHETIC_TIME_ANCHOR_MS = 946_684_800_000
_DATASET_POOL_MAX_BYTES = 512 * 1024 * 1024


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


class ReplayService:
    """Independent replay composition root; never depends on ``DataManager``."""

    def __init__(
        self,
        *,
        settings: ReplaySettings,
        store: ReplaySQLiteStore,
        repository: object | None = None,
        now_ms: Callable[[], int] = lambda: int(time.time() * 1_000),
        session_id_factory: Callable[[], str] = lambda: uuid.uuid4().hex,
        native_intervals: Callable[[ReplaySeriesIdentity], Sequence[str]] | None = None,
    ) -> None:
        if not settings.enabled:
            raise ValueError(
                "ReplayService cannot be constructed while replay is disabled"
            )
        self.settings = settings
        self.store = store
        self._repository = repository or KlinesRepoAdapter()
        self._now_ms = now_ms
        self._session_id_factory = session_id_factory
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
        self._unavailable_sessions: dict[str, ReplayDomainError] = {}
        self._accepting = True
        self._closed = False
        self._lifecycle_lock = asyncio.Lock()
        self._metrics: dict[str, int | str | None] = {
            "sessions_created": 0,
            "sessions_recovered": 0,
            "recovery_failures": 0,
            "commands": 0,
            "forks": 0,
            "shutdown_failures": 0,
            "last_shutdown_error": None,
        }

    async def start(self) -> None:
        """Recover non-ended sessions without ever resuming PLAYING."""

        for record in await self.store.load_recoverable_sessions():
            session_id = str(record["session_id"])
            try:
                await self._recover_record(record)
            except BaseException as exc:
                error = self._recovery_error(exc)
                self._unavailable_sessions[session_id] = error
                self._metrics["recovery_failures"] = (
                    int(self._metrics["recovery_failures"] or 0) + 1
                )
                try:
                    await self.store.mark_degraded(session_id, error.message)
                except Exception:
                    pass

    def capabilities(self) -> dict[str, object]:
        return {
            "protocol": REPLAY_PROTOCOL,
            "enabled": True,
            "available": self.store.degraded_reason is None and not self._closed,
            "sources": {
                "bar": {"enabled": True, "fidelity": "EXACT_BAR_COVERAGE"},
                "agg_trade": {
                    "enabled": False,
                    "reason": "ARCHIVE_DISABLED",
                },
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
                "degraded": self.store.degraded_reason is not None,
                "degraded_reason": self.store.degraded_reason,
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
        self._ensure_available()
        snapshot = await asyncio.to_thread(
            self._catalog.build,
            warmup_bars=warmup_bars,
            horizon_ms=horizon_ms,
            quality_mode=quality_mode,
        )
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

    async def create_session(self, config: ReplaySessionConfig) -> dict[str, object]:
        self._ensure_available()
        if not isinstance(config, ReplaySessionConfig):
            raise TypeError("config must be ReplaySessionConfig")
        async with self._lifecycle_lock:
            self._ensure_available()
            if len(self._sessions) >= self.settings.max_active_sessions:
                raise ReplayDomainError(
                    ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
                    "active replay session limit exceeded",
                    details={"limit": self.settings.max_active_sessions},
                )
            if config.source_kind is not SourceKind.BAR:
                raise ReplayDomainError(
                    ReplayErrorCode.ARCHIVE_DISABLED,
                    "aggregate-trade replay archive is disabled",
                )
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
            catalog = await asyncio.to_thread(
                self._catalog.build,
                warmup_bars=config.warmup_bars,
                horizon_ms=config.horizon_ms,
                quality_mode=config.quality_mode,
            )
            identity = ReplaySeriesIdentity(
                config.exchange, config.market_type, config.symbol
            )
            entry = catalog.require_entry(identity)
            if entry.selected_base_interval != config.base_interval:
                raise ReplayDomainError(
                    ReplayErrorCode.UNSUPPORTED_INTERVAL,
                    "requested base_interval is not the catalog-selected exact base",
                    details={
                        "requested": config.base_interval,
                        "selected": entry.selected_base_interval,
                    },
                )
            window = (
                self._catalog.select_random(entry, seed=config.random_seed)
                if config.start_policy is StartPolicy.RANDOM_ELIGIBLE
                else self._catalog.select_manual(
                    entry,
                    start_ms=self._required_manual_start(config),
                )
            )
            actual_dataset = await asyncio.to_thread(
                self._dataset_builder.create, entry, window
            )
            return await self._create_from_dataset(
                config=config,
                actual_dataset=actual_dataset,
                restore_checkpoint=None,
                forked=False,
            )

    async def get_session(self, session_id: str) -> dict[str, object]:
        handle = await self._require_handle(session_id)
        return await self._session_payload(handle)

    async def command(
        self,
        session_id: str,
        command: ReplayCommand,
    ) -> dict[str, object]:
        self._ensure_available()
        handle = await self._require_handle(session_id)
        existing = await self.store.get_command(session_id, command.command_id)
        if existing is not None:
            result = self._replay_stored_command(existing, command)
        else:
            result = await handle.actor.submit(command)
        self._metrics["commands"] = int(self._metrics["commands"] or 0) + 1
        payload = self._command_result_payload(result)
        if command.type is CommandType.REVEAL_HISTORY and result.data.get("revealed"):
            payload["data"] = {
                **dict(payload["data"]),  # type: ignore[arg-type]
                "actual_history": self._actual_history(handle),
            }
        if result.state is SessionState.ENDED:
            await self._persist_report(handle)
        return {"protocol": REPLAY_PROTOCOL, "session_id": session_id, **payload}

    async def fork_session(self, session_id: str) -> dict[str, object]:
        self._ensure_available()
        source = await self._require_handle(session_id)
        checkpoint = await source.actor.checkpoint()
        async with self._lifecycle_lock:
            result = await self._create_from_dataset(
                config=source.config,
                actual_dataset=source.actual_dataset,
                restore_checkpoint=checkpoint,
                forked=True,
                synthetic_origin_ms=source.synthetic_origin_ms,
                broker_config=source.broker_config,
            )
            self._metrics["forks"] = int(self._metrics["forks"] or 0) + 1
            result["forked_from_session_id"] = session_id
            return result

    async def report(self, session_id: str) -> dict[str, object]:
        handle = await self._require_handle(session_id)
        report = dict(await handle.actor.report())
        if report:
            report_hash = str(report.get("report_hash", ""))
            if report_hash:
                await self.store.save_report(session_id, report, report_hash)
        payload: dict[str, object] = {
            "protocol": REPLAY_PROTOCOL,
            "session_id": session_id,
            "data_fidelity": "EXACT_BAR_COVERAGE",
            "execution_fidelity": "BAR_CONSERVATIVE",
            "revealed": (await handle.actor.public_snapshot())["revealed"],
            "report": report,
        }
        if payload["revealed"]:
            payload["actual_history"] = self._actual_history(handle)
        return payload

    async def journal(self, session_id: str) -> dict[str, object]:
        handle = await self._require_handle(session_id)
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
        handle = await self._require_handle(session_id)
        snapshot = await handle.actor.snapshot()
        if data_epoch is not None and data_epoch != snapshot.data_epoch:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay stream data_epoch does not match the session",
            )
        subscription = await handle.actor.subscribe(
            after_sequence=after_sequence,
            max_pending=self.settings.event_subscriber_queue,
        )
        return handle.actor, subscription

    async def heartbeat(self, session_id: str, client_instance_id: str) -> None:
        handle = await self._require_handle(session_id)
        await handle.actor.heartbeat(client_instance_id)

    async def shutdown(self, *, step_timeout: float = 5.0) -> None:
        if self._closed:
            return
        self._accepting = False
        errors: list[str] = []
        for session_id, handle in tuple(self._sessions.items()):
            try:
                await handle.actor.shutdown(step_timeout=step_timeout)
            except Exception as exc:
                errors.append(f"{session_id}: {exc}")
            finally:
                self._datasets.release(session_id)
        self._sessions.clear()
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
            "unavailable_sessions": {
                session_id: error.code.value
                for session_id, error in self._unavailable_sessions.items()
            },
            "catalog": self._catalog.diagnostics(),
            "dataset_pins": dict(self._datasets.diagnostics()),
            "persistence": persistence,
        }

    async def _create_from_dataset(
        self,
        *,
        config: ReplaySessionConfig,
        actual_dataset: BarDatasetSnapshot,
        restore_checkpoint: bytes | None,
        forked: bool,
        synthetic_origin_ms: int | None = None,
        broker_config: BrokerConfig | None = None,
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
        reducer = self._broker(actor_config, actor_dataset, broker)
        actor = self._actor(
            session_id=session_id,
            config=actor_config,
            dataset=actor_dataset,
            reducer=reducer,
            restore_checkpoint=restore_checkpoint,
            recovery_target=None,
        )
        self._datasets.pin(session_id, actor_dataset)
        try:
            await actor.start()
            initial_checkpoint = actor.latest_checkpoint_blob()
            if initial_checkpoint is None:
                raise RuntimeError(
                    "new replay actor did not create an initial checkpoint"
                )
            snapshot = await actor.public_snapshot()
            durable_state = await actor.durable_state()
            await self.store.create_session(
                session_id=session_id,
                config=actor_config.to_dict(),
                broker_config=broker.to_dict(),
                session_state=durable_state,
                dataset_ref=actual_dataset.snapshot_ref().to_dict(),
                dataset_blob=canonical_json_bytes(actual_dataset.to_dict()),
                actual_replay_start_ms=actual_dataset.replay_start_ms,
                actual_replay_end_ms=actual_dataset.replay_end_open_ms,
                synthetic_origin_ms=origin,
                initial_checkpoint=initial_checkpoint,
                component_state=snapshot["components"],  # type: ignore[arg-type]
            )
        except BaseException:
            self._datasets.release(session_id)
            try:
                await actor.shutdown(step_timeout=0.5)
            except Exception:
                pass
            raise
        handle = ReplaySessionHandle(
            session_id=session_id,
            actor=actor,
            config=actor_config,
            broker_config=broker,
            actual_dataset=actual_dataset,
            actor_dataset=actor_dataset,
            synthetic_origin_ms=origin,
            created_at_ms=self._validated_now_ms(),
        )
        self._sessions[session_id] = handle
        self._metrics["sessions_created"] = (
            int(self._metrics["sessions_created"] or 0) + 1
        )
        payload = await self._session_payload(handle)
        payload["forked"] = forked
        return payload

    async def _recover_record(
        self, record: Mapping[str, object]
    ) -> ReplaySessionHandle:
        session_id = str(record["session_id"])
        if session_id in self._sessions:
            return self._sessions[session_id]
        dataset_record = await self.store.load_dataset(session_id)
        if dataset_record is None:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "replay dataset reference is missing",
            )
        try:
            decoded = json.loads(bytes(dataset_record["snapshot_blob"]).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted BAR dataset JSON is invalid",
            ) from exc
        if not isinstance(decoded, Mapping):
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted BAR dataset must be an object",
            )
        actual_dataset = BarDatasetSnapshot.from_dict(decoded)
        if actual_dataset.data_epoch != record["data_epoch"]:
            raise ReplayDomainError(
                ReplayErrorCode.DATASET_MISMATCH,
                "persisted BAR dataset epoch does not match session",
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
        last_error: BaseException | None = None
        actor: ReplaySessionActor | None = None
        try:
            for checkpoint in checkpoints:
                tail = await self.store.recovery_mutations_after(
                    session_id,
                    command_log_offset=checkpoint.command_log_offset,
                    source_sequence=checkpoint.source_sequence,
                )
                target = ActorRecoveryTarget(
                    mutations=tail,
                    revision=int(record["revision"]),
                    event_sequence=int(record["event_sequence"]),
                    command_log_offset=int(record["command_log_offset"]),
                    state_hash=str(record["state_hash"]),
                )
                reducer = self._broker(config, actor_dataset, broker_config)
                candidate = self._actor(
                    session_id=session_id,
                    config=config,
                    dataset=actor_dataset,
                    reducer=reducer,
                    restore_checkpoint=checkpoint.payload,
                    recovery_target=target,
                )
                try:
                    await candidate.start()
                except BaseException as exc:
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
            )
            self._sessions[session_id] = handle
            self._metrics["sessions_recovered"] = (
                int(self._metrics["sessions_recovered"] or 0) + 1
            )
            return handle
        except BaseException:
            self._datasets.release(session_id)
            raise

    def _actor(
        self,
        *,
        session_id: str,
        config: ReplaySessionConfig,
        dataset: BarDatasetSnapshot,
        reducer: ConservativeBarBroker,
        restore_checkpoint: bytes | None,
        recovery_target: ActorRecoveryTarget | None,
    ) -> ReplaySessionActor:
        return ReplaySessionActor(
            session_id=session_id,
            config=config,
            source_factory=lambda: BarReplaySource(dataset),
            initial_virtual_time_ms=dataset.replay_start_ms,
            command_queue_size=self.settings.command_queue_size,
            event_buffer_size=self.settings.event_buffer_size,
            max_emit_fps=self.settings.max_emit_fps,
            controller_ttl_seconds=self.settings.controller_ttl_seconds,
            checkpoint_event_interval=self.settings.checkpoint_event_interval,
            checkpoint_virtual_ms=self.settings.checkpoint_virtual_ms,
            reducer=reducer,
            restore_checkpoint=restore_checkpoint,
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

    async def _require_handle(self, session_id: str) -> ReplaySessionHandle:
        handle = self._sessions.get(session_id)
        if handle is not None:
            return handle
        unavailable = self._unavailable_sessions.get(session_id)
        if unavailable is not None:
            raise unavailable
        record = await self.store.get_session(session_id)
        if record is not None and record["degraded_reason"] is not None:
            raise ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "replay session is unavailable after a recovery failure",
                details={"reason": record["degraded_reason"]},
            )
        if record is not None and record["state"] == SessionState.ENDED.value:
            async with self._lifecycle_lock:
                handle = self._sessions.get(session_id)
                if handle is None:
                    handle = await self._recover_record(record)
                return handle
        raise ReplayDomainError(
            ReplayErrorCode.SESSION_NOT_FOUND,
            "replay session does not exist",
            details={"session_id": session_id},
        )

    async def _session_payload(self, handle: ReplaySessionHandle) -> dict[str, object]:
        snapshot = await handle.actor.public_snapshot()
        return {
            "protocol": REPLAY_PROTOCOL,
            "session_id": handle.session_id,
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
    ) -> ConservativeBarBroker:
        builder = ReplayBarBuilder(
            base_interval=config.base_interval,
            display_interval=config.display_interval,
            replay_start_ms=dataset.replay_start_ms,
            warmup_bars=dataset.warmup_rows,
            max_closed_bars=min(10_000, max(1, dataset.row_count)),
        )
        return ConservativeBarBroker(config=broker_config, bar_builder=builder)

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

    async def _persist_report(self, handle: ReplaySessionHandle) -> None:
        report = dict(await handle.actor.report())
        report_hash = str(report.get("report_hash", ""))
        if report_hash:
            await self.store.save_report(handle.session_id, report, report_hash)

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

    def _ensure_available(self) -> None:
        if self._closed or not self._accepting:
            raise ReplayDomainError(
                ReplayErrorCode.REPLAY_DISABLED,
                "replay service is not accepting new work",
            )
        if self.store.degraded_reason is not None:
            raise ReplayDomainError(
                ReplayErrorCode.PERSISTENCE_DEGRADED,
                "replay persistence is degraded",
                details={"reason": self.store.degraded_reason},
            )

    def _validated_now_ms(self) -> int:
        value = self._now_ms()
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError("ReplayService clock must return a non-negative integer")
        return value

    @staticmethod
    def _recovery_error(error: BaseException) -> ReplayDomainError:
        if isinstance(error, ReplayDomainError):
            return error
        return ReplayDomainError(
            ReplayErrorCode.DATASET_MISMATCH,
            "replay session recovery failed",
            details={"reason": f"{type(error).__name__}: {error}"},
        )
