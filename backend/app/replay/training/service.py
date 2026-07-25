"""TrainingRun lifecycle, ViewerState, and replay.v2 control adaptation."""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import uuid
from collections.abc import Callable, Mapping
from dataclasses import replace
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from typing import TYPE_CHECKING, cast

from app.replay.constants import (
    REPLAY_PROTOCOL,
    CommandType,
    ExecutionModel,
    QualityMode,
    SlippageKind,
    SourceKind,
    StartPolicy,
)
from app.replay.broker.models import TOUCH_OR_TAPE_EXECUTION_MODE
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

from .errors import TrainingRunError
from .commands import ReplayV2Command
from .control import (
    ADVANCE_CONTRACT_VERSION,
    MAX_CONTROL_COUNT,
    PLAYBACK_CONTRACT_VERSION,
    advance_basis,
    aligned_step_target_ms,
    compatible_step_interval_ms,
    control_count,
    control_rate,
    default_playback_basis,
    discrete_playback_units,
    fixed_interval_ms,
    supported_advance_bases,
    supported_playback_bases,
    validate_bar_duration_ms,
    virtual_duration_ms,
)
from .history import build_history_page
from .historical_book import HistoricalBookArchiveManager, HistoricalBookProjection
from .fast_forward import FastForwardContext, FastForwardDecision, FastForwardPlanner
from .models import (
    AdvanceBasis,
    BookMode,
    FastForwardPlan,
    FundingMode,
    IntegrityMode,
    REPLAY_V2_PROTOCOL,
    ReplaySource,
    ReplayV2CommandType,
    StartMode,
    SubscriptionTier,
    TimeDisclosurePolicy,
    TrainingCursor,
    TrainingRunCreateRequest,
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
from .segments import (
    ReplaySegmentManager,
    resolve_history_policy,
)
from .trade_flow import ReplayTradeFlowAdapter

if TYPE_CHECKING:
    from app.replay.service import ReplayService


ADVANCE_PROGRESS_RETENTION_SECONDS = 2.0


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


class TrainingRunService:
    """Own Hub metadata and delegate active single-track execution to replay.v1."""

    def __init__(
        self,
        *,
        replay_service: "ReplayService",
        run_id_factory: Callable[[], str] = lambda: uuid.uuid4().hex,
        random_seed_factory: Callable[[], int] = (
            lambda: uuid.uuid4().int % (1 << 53)
        ),
    ) -> None:
        self.replay_service = replay_service
        self.store = TrainingRunStore(replay_service.store)
        self.segments = ReplaySegmentManager(
            replay_service.store,
            download_worker_enabled=(
                replay_service.settings.replay_segment_download_worker_enabled
            ),
            auto_gc_enabled=replay_service.settings.replay_segment_auto_gc_enabled,
        )
        self.historical_books = HistoricalBookArchiveManager(
            replay_service.store,
            enabled=replay_service.settings.replay_historical_book_enabled,
            max_archive_bytes=(
                replay_service.settings.replay_historical_book_max_archive_bytes
            ),
        )
        self._run_id_factory = run_id_factory
        self._random_seed_factory = random_seed_factory
        self._fast_forward_planner = FastForwardPlanner()
        self._trade_flow_adapter = ReplayTradeFlowAdapter()
        self._advance_jobs: dict[tuple[str, str], dict[str, object]] = {}
        self._run_actors: dict[str, TrainingRunActor] = {}

    async def start(self) -> None:
        await self.store.start()
        await self.segments.start()
        await self.historical_books.start()

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
        }

    async def list_data_segments(
        self, *, run_id: str | None = None
    ) -> dict[str, object]:
        normalized = (
            None
            if run_id is None
            else self._identifier(run_id, field_name="run_id")
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

    async def get_fast_forward_plan(
        self,
        run_id: str,
        *,
        target_virtual_time_ms: int,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        binding = await self.store.run_binding(normalized)
        session = await self.replay_service.get_session(str(binding["adapter_session_id"]))
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
        return {
            "protocol": "replay.v2",
            "run_id": normalized,
            "plan": decision.to_dict(),
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
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1_000:
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
        if track.get("state") in {"DEGRADED", "ERROR"} or track.get(
            "degraded_reason"
        ) is not None:
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
                if isinstance(adapter_speed, int) and not isinstance(adapter_speed, bool)
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
                "playback_bases": [
                    basis.value for basis in playback_supported
                ],
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
            "protocol": "replay.v2",
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
        return {
            "protocol": "replay.v2",
            "run_id": normalized,
            "data_fidelity": report["data_fidelity"],
            "execution_fidelity": report["execution_fidelity"],
            "revealed": report["revealed"],
            "report": report["report"],
            "integrity": integrity,
            "public_time_index": public_time_index,
            **(
                {"actual_history": report["actual_history"]}
                if report.get("revealed") and "actual_history" in report
                else {}
            ),
        }

    async def start_review(
        self,
        run_id: str,
        *,
        event_id: str | None,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
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

    async def fork_run(
        self,
        run_id: str,
        *,
        event_id: str,
    ) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        normalized_event = self._identifier(event_id, field_name="event_id")
        market_tracks = await self.store.get_market_tracks(normalized)
        tracks = market_tracks.get("tracks")
        if isinstance(tracks, list) and len(tracks) > 1:
            raise TrainingRunError(
                "MULTI_TRACK_FORK_UNAVAILABLE",
                "multi-market runs remain v2-only and cannot collapse into one v1 fork",
                status_code=409,
            )
        event = await self.store.checkpoint_for_event(normalized, normalized_event)
        checkpoint_id = validate_v2_counter(
            event["checkpoint_id"],
            field_name="review checkpoint_id",
        )
        child_run_id = self._identifier(self._run_id_factory(), field_name="run_id")
        extension_factory = self.store.fork_run_writer(
            child_run_id=child_run_id,
            parent_run_id=normalized,
            parent_event_id=normalized_event,
            parent_checkpoint_id=checkpoint_id,
        )
        try:
            forked = await self.replay_service.fork_session_at_checkpoint(
                str(event["adapter_session_id"]),
                checkpoint_id=checkpoint_id,
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
        if (
            not isinstance(snapshot, Mapping)
            or snapshot.get("state_hash") != event["state_hash"]
        ):
            raise TrainingRunError(
                "REVIEW_FORK_MISMATCH",
                "forked run state does not match the selected review event",
                status_code=409,
            )
        card = await self.store.get_run(child_run_id)
        return {
            "protocol": "replay.v2",
            "parent_run_id": normalized,
            "parent_event_id": normalized_event,
            "run": {
                **card,
                "dataset_epoch": event["dataset_epoch"],
                "state_hash": snapshot["state_hash"],
            },
        }

    async def create_run(self, request: TrainingRunCreateRequest) -> dict[str, object]:
        if not isinstance(request, TrainingRunCreateRequest):
            raise TypeError("request must be TrainingRunCreateRequest")
        request = self._authoritative_start_request(request)
        selection_config = self._adapter_config(request)
        try:
            selection = await self.replay_service.select_training_window(
                selection_config,
                expected_catalog_epoch=request.catalog_epoch,
            )
        except ReplayDomainError as exc:
            if exc.details.get("reason") == "CATALOG_EPOCH_MISMATCH":
                raise TrainingRunError(
                    "CATALOG_EPOCH_MISMATCH",
                    "data capability changed after validation; refresh and try again",
                    status_code=409,
                ) from exc
            raise TrainingRunError(
                "TRAINING_RUN_CREATE_FAILED",
                "training start could not be selected",
                status_code=409,
                details={"reason": exc.code.value},
            ) from exc
        history_policy = resolve_history_policy(
            request,
            selection,
            max_dataset_rows=self.replay_service.settings.max_bar_dataset_rows,
        )
        base_interval_ms = compatible_step_interval_ms(
            base_interval=request.base_interval,
            step_interval=request.display_interval,
        )
        if request.funding_mode is FundingMode.HISTORICAL_EXACT:
            raise TrainingRunError(
                "HISTORICAL_FUNDING_UNAVAILABLE",
                "historical exact funding requires aligned funding and mark coverage",
                status_code=409,
                details={
                    "funding_rate": "UNSUPPORTED_NO_HISTORY",
                    "historical_mark": "UNSUPPORTED_NO_HISTORY",
                    "fallback_applied": False,
                },
            )
        historical_book_binding = None
        if request.book_mode is BookMode.BOOK_ASSISTED_REQUIRED:
            if request.start_mode is not StartMode.MANUAL or request.requested_start_ms is None:
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
        run_id = self._identifier(self._run_id_factory(), field_name="run_id")
        config = self._adapter_config(
            request,
            warmup_bars=history_policy.effective_warmup_bars,
        )

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
                historical_book_binding=bound_book,
            )

        try:
            await self.replay_service.create_session(
                config,
                _internal_forced_start_ms=history_policy.actual_replay_start_ms,
                _internal_expected_source_fingerprint=str(
                    selection["source_fingerprint"]
                ),
                _internal_training_history=True,
                _extension_factory=extension_factory,
                _internal_execution_mode=TOUCH_OR_TAPE_EXECUTION_MODE,
            )
        except ReplayDomainError as exc:
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
                ) from exc
            raise TrainingRunError(
                "TRAINING_RUN_CREATE_FAILED",
                "training run could not be created",
                status_code=409,
                details={"reason": exc.code.value},
            ) from exc
        except sqlite3.IntegrityError as exc:
            raise TrainingRunError(
                "TRAINING_RUN_CONFLICT",
                "training run identity already exists",
                status_code=409,
            ) from exc
        run = await self.store.get_run(run_id)
        return {
            "protocol": "replay.v2",
            "created": True,
            "migrated": False,
            "run": run,
        }

    async def migrate_legacy(
        self,
        session_id: str,
        *,
        name: str | None,
    ) -> dict[str, object]:
        normalized_session = self._identifier(session_id, field_name="session_id")
        candidate_run = self._identifier(self._run_id_factory(), field_name="run_id")
        try:
            run_id, created = await self.store.migrate_legacy(
                session_id=normalized_session,
                run_id=candidate_run,
                name=name,
            )
        except sqlite3.IntegrityError as exc:
            raise TrainingRunError(
                "TRAINING_RUN_CONFLICT",
                "legacy replay migration conflicts with an existing run",
                status_code=409,
            ) from exc
        return {
            "protocol": "replay.v2",
            "created": created,
            "migrated": created,
            "run": await self.store.get_run(run_id),
        }

    async def return_to_hub_by_session(self, session_id: str) -> dict[str, object]:
        normalized = self._identifier(session_id, field_name="session_id")
        run_id = await self.store.run_id_for_session(normalized)
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
                if record is None or record["state"] != "PAUSED":
                    raise TrainingRunError(
                        "TRAINING_RUN_STORAGE_DEGRADED",
                        "training run did not durably pause before returning to the Hub",
                        status_code=503,
                        details={"track_id": track["track_id"]},
                    )
                released += 1
            checkpoint = await self.store.checkpoint_market_tracks(run_id)
            await self.store.set_actor_segment_refs(run_id, active=False)
        result: dict[str, object] = {
            "protocol": "replay.v2",
            "run_id": run_id,
            "state": "PAUSED",
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
    ) -> dict[str, object]:
        """Return one immutable page without touching the production repository."""

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
        persisted = await self.replay_service.store.load_dataset(normalized_session)
        if persisted is None:
            raise TrainingRunError(
                "HISTORY_SNAPSHOT_UNAVAILABLE",
                "training history snapshot is unavailable",
                status_code=503,
            )
        return build_history_page(
            binding=binding,
            persisted=persisted,
            before_ms=before_ms,
            revealed_boundary_ms=revealed_boundary_ms,
            limit=limit,
            data_epoch=data_epoch,
            expected_history_epoch=history_epoch,
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
        if command.type is ReplayV2CommandType.PAUSE:
            # A pause is a barrier, not ordinary queued work. Signal the
            # server-owned loop before waiting for its serialization lock so a
            # high playback rate cannot consume the remaining dataset first.
            actor.signal_ordered_stop()
        async with actor.serialized():
            return await self._command_serialized(normalized, command)

    async def _command_serialized(
        self,
        run_id: str,
        command: ReplayV2Command,
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
            ReplayV2CommandType.CANCEL_ORDER,
            ReplayV2CommandType.CLOSE_POSITION,
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
            payload = self._exact_payload(command.payload, {"track_id", "amount"})
            track_id = self._identifier(payload["track_id"], field_name="track_id")
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
            viewer = await self.store.get_viewer_state(normalized_run)
            result = self._result_payload(
                command=command,
                session_id=session_id,
                snapshot=snapshot,
                viewer=viewer.to_dict(),
                data={
                    "account_contract": "TOUCH_OR_TAPE_V2_CONTRACT_ACCOUNT",
                    "portfolio": portfolio,
                    "allocated_track_id": track_id,
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
                "protocol": "replay.v2",
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
            if run_actor.playback_is_active()
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
            track
            for track in all_tracks
            if track.get("subscription_tier") == "FULL"
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
        multi_track_command = (
            len(full_tracks) > 1
            or (contract_clock and command.type in contract_ordered_types)
            or (
            command.type is ReplayV2CommandType.END and len(all_tracks) > 1
            )
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
            translated_plan = plan
            plan = {
                **decision.to_dict(),
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
            result = await self._execute_target_scan(
                command=command,
                session_id=session_id,
                target_virtual_time_ms=target,
                plan=plan,
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
            "protocol": "replay.v2",
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
        extension_factory = self.store.attach_market_track_writer(
            run_id=command.run_id,
            track_id=str(track["track_id"]),
            requested_tier=requested_tier.value,
            historical_book_binding=historical_book_binding,
        )
        try:
            created = await self.replay_service.create_session(
                config,
                _internal_forced_start_ms=_stored_counter(
                    binding["actual_replay_start_ms"],
                    field_name="actual_replay_start_ms",
                ),
                _internal_training_history=True,
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
        await self._ensure_track_controller(
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
            ReplayV2CommandType.CANCEL_ORDER: {"order_id"},
            ReplayV2CommandType.CLOSE_POSITION: {"quantity"},
        }
        v1_types = {
            ReplayV2CommandType.PLACE_ORDER: CommandType.PLACE_ORDER,
            ReplayV2CommandType.CANCEL_ORDER: CommandType.CANCEL_ORDER,
            ReplayV2CommandType.CLOSE_POSITION: CommandType.CLOSE_POSITION,
        }
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
        if command.type is ReplayV2CommandType.PLACE_ORDER:
            self._assert_shared_settlement_reservation(
                payload=payload,
                selected_track=selected,
                portfolio=projection.get("portfolio"),
                binding=binding,
            )
        session_id = str(binding["adapter_session_id"])
        adapter = ReplayCommand(
            protocol=REPLAY_PROTOCOL,
            command_id=command.command_id,
            client_instance_id=command.client_instance_id,
            expected_revision=_stored_counter(
                snapshot["revision"], field_name="revision"
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

    async def _reconcile_liquidations(
        self,
        *,
        run_id: str,
        client_instance_id: str,
        command_id: str,
    ) -> int:
        pending = await self.store.pending_liquidations(run_id)
        completed = 0
        for event in pending:
            session_id = event.get("adapter_session_id")
            if not isinstance(session_id, str):
                raise TrainingRunError(
                    "LIQUIDATION_EXECUTION_FAILED",
                    "simulated account liquidation lost its market adapter",
                    status_code=409,
                )
            try:
                await self._ensure_track_controller(
                    session_id=session_id,
                    client_instance_id=client_instance_id,
                    command_id=command_id,
                )
                canceled: list[str] = []
                raw_orders = event.get("open_orders")
                if isinstance(raw_orders, list):
                    for raw in raw_orders:
                        if not isinstance(raw, Mapping) or not isinstance(
                            raw.get("order_id"),
                            str,
                        ):
                            continue
                        session = await self.replay_service.get_session(session_id)
                        snapshot = self._snapshot(session)
                        cancel = ReplayCommand(
                            protocol=REPLAY_PROTOCOL,
                            command_id=self._multi_command_id(
                                command_id,
                                str(event["track_id"]),
                                f"liquidation-cancel-{raw['order_id']}",
                                _stored_counter(
                                    snapshot["revision"],
                                    field_name="revision",
                                ),
                            ),
                            client_instance_id=client_instance_id,
                            expected_revision=_stored_counter(
                                snapshot["revision"],
                                field_name="revision",
                            ),
                            type=CommandType.CANCEL_ORDER,
                            payload={"order_id": raw["order_id"]},
                        )
                        await self.replay_service.command(session_id, cancel)
                        canceled.append(str(raw["order_id"]))
                session = await self.replay_service.get_session(session_id)
                snapshot = self._snapshot(session)
                components = snapshot.get("components")
                position = (
                    components.get("position")
                    if isinstance(components, Mapping)
                    else None
                )
                if not isinstance(position, Mapping) or position.get("quantity") in {
                    None,
                    "0",
                }:
                    raise TrainingRunError(
                        "LIQUIDATION_EXECUTION_FAILED",
                        "simulated liquidation position disappeared before close",
                        status_code=409,
                    )
                close = ReplayCommand(
                    protocol=REPLAY_PROTOCOL,
                    command_id=self._multi_command_id(
                        command_id,
                        str(event["track_id"]),
                        "liquidation-close",
                        _stored_counter(snapshot["revision"], field_name="revision"),
                    ),
                    client_instance_id=client_instance_id,
                    expected_revision=_stored_counter(
                        snapshot["revision"],
                        field_name="revision",
                    ),
                    type=CommandType.CLOSE_POSITION,
                    payload={"quantity": None},
                )
                closed = await self.replay_service.command(session_id, close)
                data = _stored_mapping(
                    closed.get("data"),
                    field_name="liquidation close data",
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
                        "simulated liquidation close order projection is missing",
                        status_code=409,
                    )
                await self.store.complete_liquidation(
                    run_id=run_id,
                    liquidation_id=str(event["liquidation_id"]),
                    canceled_order_ids=canceled,
                    close_order_id=str(orders[0]["order_id"]),
                )
                completed += 1
            except (ReplayDomainError, TrainingRunError) as exc:
                raise TrainingRunError(
                    "LIQUIDATION_EXECUTION_FAILED",
                    "simulated account liquidation failed closed",
                    status_code=409,
                    details={
                        "liquidation_id": event["liquidation_id"],
                        "reason": (
                            exc.code.value
                            if isinstance(exc, ReplayDomainError)
                            else exc.code
                        ),
                    },
                ) from exc
        return completed

    @staticmethod
    def _assert_shared_settlement_reservation(
        *,
        payload: Mapping[str, object],
        selected_track: Mapping[str, object],
        portfolio: object,
        binding: Mapping[str, object],
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
            price_value = selected_track.get("public_price")
        try:
            quantity = Decimal(str(payload["quantity"]))
            price = Decimal(str(price_value))
            leverage = Decimal(str(config["max_leverage"]))
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
                track_id = str(selected_track["track_id"])
                allocated = Decimal(str(allocations.get(track_id, "0")))
                in_use = Decimal(str(track_account.get("margin_used", "0"))) + Decimal(
                    str(track_account.get("reserved_margin", "0"))
                )
                available = allocated - in_use
                if allocated <= 0:
                    raise TrainingRunError(
                        "ISOLATED_MARGIN_REQUIRED",
                        "allocate isolated margin before placing an opening order",
                        status_code=409,
                        details={"track_id": track_id},
                    )
            else:
                available = Decimal(str(portfolio["available_equity"]))
            reservation = (quantity * price / leverage).quantize(
                Decimal("0.00000001"),
                rounding=ROUND_CEILING,
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
        await self._ensure_track_controller(
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
                next_time = await self._next_global_event_time(ordered)
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
            if (
                target is None
                and (
                    command.type is ReplayV2CommandType.STEP_BASE
                    or (
                        command.type is ReplayV2CommandType.ADVANCE
                        and plan.get("basis") == AdvanceBasis.BASE_BAR.value
                    )
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
                    advance_job is not None
                    and advance_job["status"] == "CANCELLED"
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
                        terminal_reason = (
                            "ORDERED_PLAYBACK_REQUIRES_A_FULL_TRACK"
                        )
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
                    elapsed_seconds = max(0.0, now_wall - last_advance_wall)
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
                                "playback_bases": [
                                    item.value for item in allowed
                                ],
                            },
                        )
                    consumed_wall_seconds = 0.0
                    if basis is AdvanceBasis.VIRTUAL_TIME:
                        try:
                            next_time = await self._next_global_event_time(tracks)
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
                                    (next_time - current_time)
                                    / rate
                                    / 1_000,
                                ),
                            )
                            target = None
                        else:
                            target = max(next_time, current_time + elapsed_ms)
                            consumed_wall_seconds = elapsed_seconds
                            timeout = 0.0
                    else:
                        units = discrete_playback_units(
                            elapsed_seconds,
                            rate=rate,
                        )
                        if units == 0:
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
                            protocol="replay.v2",
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
                "PAUSED"
                if terminal_reason.startswith("HISTORICAL_BOOK_")
                else "ERROR"
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
    ) -> tuple[StableMarketEvent, ...]:
        prepared_book: tuple[tuple[str, HistoricalBookProjection], ...] = ()
        if str(binding.get("book_mode", "OFF")) == BookMode.BOOK_ASSISTED_REQUIRED.value:
            prepared_book = await self.historical_books.prepare_run_projection(
                run_id=command.run_id,
                tracks=tracks,
                actual_time_ms=self._actual_event_time_ms(
                    binding,
                    target_virtual_time_ms,
                ),
                virtual_time_ms=target_virtual_time_ms,
            )
        all_events: list[StableMarketEvent] = []
        for _wave_index in range(10_000):
            if job is not None:
                cancel = job.get("cancel")
                if isinstance(cancel, asyncio.Event) and cancel.is_set():
                    job["status"] = "CANCELLED"
                    return tuple(all_events)
            snapshots: list[tuple[Mapping[str, object], Mapping[str, object]]] = []
            times: set[int] = set()
            next_times: list[int] = []
            for track in tracks:
                session_id = self._track_session_id(track)
                session = await self.replay_service.get_session(session_id)
                snapshot = self._snapshot(session)
                snapshots.append((track, snapshot))
                times.add(self._cursor_time(snapshot))
                try:
                    plan = await self.replay_service.plan_source_chunk(
                        session_id,
                        target_time_ms=target_virtual_time_ms,
                        max_events=1,
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
                if _stored_counter(
                    plan["event_count"], field_name="event_count"
                ) == 1:
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
            if current >= target_virtual_time_ms:
                if prepared_book:
                    await self.historical_books.commit_run_projection(
                        run_id=command.run_id,
                        prepared=prepared_book,
                    )
                if job is not None:
                    job["status"] = "COMPLETED"
                    job["current_virtual_time_ms"] = current
                return tuple(all_events)
            wave_time = min(next_times) if next_times else target_virtual_time_ms
            wave_events: list[StableMarketEvent] = []
            try:
                for track, before in snapshots:
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
                        session_id=self._track_session_id(track),
                        target_virtual_time_ms=wave_time,
                        client_instance_id=command.client_instance_id,
                        command_id=command.command_id,
                        track_id=str(track["track_id"]),
                    )
                    after_cursor = after.get("cursor")
                    if not isinstance(after_cursor, Mapping):
                        raise TrainingRunError(
                            "TRAINING_RUN_STORAGE_DEGRADED",
                            "market track cursor is invalid",
                            status_code=503,
                        )
                    for sequence in range(
                        before_sequence + 1,
                        _stored_counter(
                            after_cursor["source_sequence"],
                            field_name="source_sequence",
                        )
                        + 1,
                    ):
                        wave_events.append(
                            StableMarketEvent(
                                actual_event_time_ms=self._actual_event_time_ms(
                                    binding,
                                    wave_time,
                                ),
                                event_phase=MARKET_EVENT_PHASE,
                                market_track_stable_id=str(track["track_id"]),
                                source_sequence=sequence,
                            )
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
                    "a required FULL market track failed during global advance",
                    status_code=409,
                    details={"track_id": track["track_id"]},
                ) from exc
            await self._reconcile_liquidations(
                run_id=command.run_id,
                client_instance_id=command.client_instance_id,
                command_id=command.command_id,
            )
            if wave_events:
                ordered_wave = stable_market_event_order(wave_events)
                await self.store.record_global_events(command.run_id, ordered_wave)
                all_events.extend(ordered_wave)
                if job is not None and len(all_events) > 512:
                    del all_events[:-512]
                    job["stable_order_truncated"] = True
            else:
                await self.store.checkpoint_market_tracks(command.run_id)
            if job is not None:
                job["consumed"] = int(job["consumed"]) + len(wave_events)
                job["chunks"] = int(job["chunks"]) + 1
                job["current_virtual_time_ms"] = wave_time
                job["queue_high_water"] = max(
                    int(job["queue_high_water"]),
                    len(tracks),
                )
                cancel = job.get("cancel")
                if isinstance(cancel, asyncio.Event) and cancel.is_set():
                    job["status"] = "CANCELLED"
                    return tuple(all_events)
            await asyncio.sleep(0)
        raise TrainingRunError(
            "REPLAY_SCAN_LIMIT_EXCEEDED",
            "global advance exceeded the bounded wave budget",
            status_code=409,
        )

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

    async def _guard_historical_book_current(
        self,
        *,
        run_id: str,
        binding: Mapping[str, object],
        snapshot: Mapping[str, object],
        tracks: list[Mapping[str, object]] | None = None,
    ) -> None:
        if str(binding.get("book_mode", "OFF")) != BookMode.BOOK_ASSISTED_REQUIRED.value:
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
            ) == 1 and isinstance(
                plan["last_event_time_ms"], int
            ):
                candidates.append(int(plan["last_event_time_ms"]))
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
    ) -> Mapping[str, object]:
        for _chunk_index in range(100_000):
            await self._ensure_track_controller(
                session_id=session_id,
                client_instance_id=client_instance_id,
                command_id=command_id,
            )
            session = await self.replay_service.get_session(session_id)
            snapshot = self._snapshot(session)
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
                max_events=32,
            )
            count = _stored_counter(plan["event_count"], field_name="event_count")
            if count > 0:
                v1_type = CommandType.STEP
                payload: dict[str, object] = {"count": count}
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
                await self.replay_service.command(session_id, part)
            except ReplayDomainError as exc:
                raise TrainingRunError(
                    exc.code.value,
                    exc.message,
                    status_code=exc.http_status,
                    details=exc.details,
                ) from exc
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
    ) -> None:
        session = await self.replay_service.get_session(session_id)
        snapshot = self._snapshot(session)
        owner = snapshot.get("controller_client_id")
        if owner == client_instance_id:
            try:
                await self.replay_service.heartbeat(
                    session_id,
                    client_instance_id,
                )
                return
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
            await self.replay_service.command(session_id, acquire)
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
                        _stored_counter(
                            snapshot["revision"], field_name="revision"
                        ),
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
            "protocol": "replay.v2",
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
            "protocol": "replay.v2",
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
        if str(binding.get("account_status")) != "ACTIVE":
            dependencies.add("ACCOUNT_RISK_STATE")
        if str(binding.get("book_mode", "OFF")) != "OFF":
            dependencies.add("BOOK_ASSISTED_PATH")
        if snapshot.get("state") == "ERROR" or snapshot.get("degraded_reason") is not None:
            blocking.add("SESSION_DEGRADED")
        terminal_order_states = {"FILLED", "CANCELED", "REJECTED", "EXPIRED"}
        for track in full_tracks or tracks:
            if track.get("state") in {"DEGRADED", "ERROR"} or track.get(
                "degraded_reason"
            ) is not None:
                blocking.add("TRACK_DEGRADED")
            position = track.get("position")
            if isinstance(position, Mapping) and position.get("quantity") not in {
                None,
                "0",
                0,
            }:
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
            if isinstance(position, Mapping) and position.get("quantity") not in {
                None,
                "0",
                0,
            }:
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
            chunk_event_limit=max(1, chunk_event_limit),
            tail_event_count=(min(32, chunk_event_limit) if optimized_candidate else 0),
            track_count=max(1, len(full_tracks)),
        )
        return self._fast_forward_planner.plan(context)

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
            "protocol": "replay.v2",
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
    ) -> dict[str, object]:
        key = (command.run_id, command.command_id)
        if key in self._advance_jobs:
            raise TrainingRunError(
                "ADVANCE_ALREADY_ACTIVE",
                "advance command is already active",
                status_code=409,
            )
        initial = command.expected_cursor.virtual_time_ms
        if target_virtual_time_ms <= initial:
            raise TrainingRunError(
                "REPLAY_CONTROL_INVALID",
                "advance target must be ahead of the current cursor",
                status_code=422,
            )
        binding = await self.store.run_binding(command.run_id)
        prepared_book: tuple[tuple[str, HistoricalBookProjection], ...] = ()
        full_tracks: list[Mapping[str, object]] = []
        if str(binding.get("book_mode", "OFF")) == BookMode.BOOK_ASSISTED_REQUIRED.value:
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
            "chunks": 0,
            "simulated_account_liquidations": 0,
            "cancelable": bool(plan.get("cancelable", False)),
            "plan": dict(plan),
            "chunk_event_limit": _stored_counter(
                plan.get("chunk_event_limit", 32), field_name="chunk_event_limit"
            ),
            "queue_high_water": 0,
        }
        self._advance_jobs[key] = job
        try:
            while True:
                if cancel.is_set():
                    job["status"] = "CANCELLED"
                    break
                current_response = await self.replay_service.get_session(session_id)
                current = _stored_mapping(
                    current_response.get("snapshot"), field_name="adapter snapshot"
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
                chunk = await self.replay_service.plan_source_chunk(
                    session_id,
                    target_time_ms=target_virtual_time_ms,
                    max_events=_stored_counter(
                        job.get("chunk_event_limit"), field_name="chunk_event_limit"
                    ),
                )
                if cancel.is_set():
                    job["status"] = "CANCELLED"
                    break
                count = _stored_counter(
                    chunk.get("event_count"), field_name="event_count"
                )
                v1_type: CommandType | InternalCommandType
                payload: dict[str, object]
                if count > 0:
                    if plan.get("mode") == FastForwardPlan.AGGREGATE_SCAN.value:
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
                        target_virtual_time_ms - current_time, 30 * 86_400_000
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
                job["chunks"] = (
                    _stored_counter(job.get("chunks"), field_name="chunks") + 1
                )
                job["queue_high_water"] = max(
                    _stored_counter(
                        job.get("queue_high_water"), field_name="queue_high_water"
                    ),
                    1,
                )
                job["consumed"] = _stored_counter(
                    job.get("consumed"), field_name="consumed"
                ) + _stored_counter(
                    acknowledged_data.get("consumed", 0),
                    field_name="acknowledged consumed",
                )
                job["current_virtual_time_ms"] = _stored_counter(
                    acknowledged_cursor.get("virtual_time_ms"),
                    field_name="virtual_time_ms",
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
                resolved_plan["equivalence"] = {
                    **dict(equivalence),
                    "status": (
                        "VERIFIED_BY_EXACT_REDUCER_PATH"
                        if resolved_plan.get("optimized") is True
                        else "REFERENCE_PATH"
                    ),
                    "observed_state_hash": final["state_hash"],
                    "observed_cursor": dict(final_cursor),
                    "consumed_source_events": _stored_counter(
                        job.get("consumed"), field_name="consumed"
                    ),
                }
            job["plan"] = resolved_plan
            if job.get("status") in {"COMPLETED", "CANCELLED"}:
                job["cancelable"] = False
            progress = self._public_progress(job)
            return {
                "protocol": "replay.v2",
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
            "protocol": "replay.v2",
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
            "protocol": "replay.v2",
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
        if submitted_view.display_interval != display_interval:
            raise TrainingRunError(
                "VIEWER_REVISION_CONFLICT",
                "display interval does not match the bound viewer revision",
                status_code=409,
            )
        return display_interval, viewer_revision

    async def _display_advance_target(
        self,
        *,
        command: ReplayV2Command,
        base_interval: str,
        current_time: int,
        count: int,
        display_interval: object,
        viewer_revision: object,
    ) -> tuple[int, str, int]:
        interval, revision = await self._validate_display_binding(
            command=command,
            base_interval=base_interval,
            display_interval=display_interval,
            viewer_revision=viewer_revision,
        )
        return (
            aligned_step_target_ms(
                current_virtual_time_ms=current_time,
                base_interval=base_interval,
                step_interval=interval,
                count=count,
            ),
            interval,
            revision,
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
                rate = self._legacy_playback_rate(
                    selected_snapshot.get("speed", 1)
                )
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
                display_interval, viewer_revision = (
                    await self._validate_display_binding(
                        command=command,
                        base_interval=base_interval,
                        display_interval=display_interval,
                        viewer_revision=viewer_revision,
                    )
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
                request.indicator_warmup_bars
                if warmup_bars is None
                else warmup_bars
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

    def _authoritative_start_request(
        self,
        request: TrainingRunCreateRequest,
    ) -> TrainingRunCreateRequest:
        if request.start_mode is StartMode.MANUAL:
            return replace(request, random_seed=None)
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
        return replace(request, random_seed=seed)


__all__ = ["TrainingRunService"]
