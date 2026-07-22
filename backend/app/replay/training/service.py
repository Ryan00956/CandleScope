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
    aligned_step_target_ms,
    compatible_step_interval_ms,
    control_count,
    validate_bar_duration_ms,
)
from .history import build_history_page
from .models import (
    IntegrityMode,
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

if TYPE_CHECKING:
    from app.replay.service import ReplayService


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
    ) -> None:
        self.replay_service = replay_service
        self.store = TrainingRunStore(replay_service.store)
        self._run_id_factory = run_id_factory
        self._advance_jobs: dict[tuple[str, str], dict[str, object]] = {}
        self._run_actors: dict[str, TrainingRunActor] = {}

    async def start(self) -> None:
        await self.store.start()

    async def shutdown(self) -> None:
        """Stop server-owned ordered playback before replay.v1 actors close."""

        tasks: list[asyncio.Task[None]] = []
        for actor in tuple(self._run_actors.values()):
            async with actor.serialized():
                task = actor.request_ordered_pause(reason="SERVICE_SHUTDOWN")
                if task is not None:
                    tasks.append(task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

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
        full_count = sum(
            1
            for track in tracks
            if isinstance(track, Mapping) and track.get("subscription_tier") == "FULL"
        )
        actor = self._run_actors.get(run_id)
        actor_clock = actor.playback_snapshot() if actor is not None else None
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
        preserve_actor_terminal = (
            actor_clock is not None
            and actor_generation > 0
            and actor_clock.get("state") in {"PLAYING", "ENDED", "ERROR"}
        )
        if full_count > 1 and preserve_actor_terminal and actor_clock is not None:
            global_clock = dict(actor_clock)
        else:
            global_clock = {
                "mode": "ORDERED" if full_count > 1 else "ADAPTER",
                "state": selected_snapshot["state"],
                "speed": selected_snapshot["speed"],
                "reason": None,
                "generation": actor_generation,
                "tick": actor_tick,
            }
        return {**dict(projection), "global_clock": global_clock}

    async def integrity(self, run_id: str) -> dict[str, object]:
        return await self.store.integrity(self._identifier(run_id, field_name="run_id"))

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
        return {
            "protocol": "replay.v2",
            "run_id": normalized,
            "data_fidelity": report["data_fidelity"],
            "execution_fidelity": report["execution_fidelity"],
            "revealed": report["revealed"],
            "report": report["report"],
            "integrity": await self.store.integrity(normalized),
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
        compatible_step_interval_ms(
            base_interval=request.base_interval,
            step_interval=request.display_interval,
        )
        run_id = self._identifier(self._run_id_factory(), field_name="run_id")
        config = self._adapter_config(request)

        def extension_factory(
            *,
            session_id: str,
            session_state: Mapping[str, object],
            component_state: Mapping[str, object],
        ):
            return self.store.initial_run_writer(
                run_id=run_id,
                request=request,
                adapter_session_id=session_id,
                session_state=session_state,
                component_state=component_state,
            )

        try:
            await self.replay_service.create_session(
                config,
                _expected_catalog_epoch=request.catalog_epoch,
                _extension_factory=extension_factory,
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
            raise TrainingRunError(
                "REPLAY_CONTROL_UNAVAILABLE",
                "Phase 3 controls require a base-interval v2 adapter",
                status_code=409,
                details={"compatibility": binding["compatibility"]},
            )
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
        multi_track_command = len(full_tracks) > 1 or (
            command.type is ReplayV2CommandType.END and len(all_tracks) > 1
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
        viewer = await self.store.get_viewer_state(normalized_run)
        result = {
            "protocol": "replay.v2",
            "run_id": normalized_run,
            "session_id": session_id,
            "command_id": command.command_id,
            "revision": adapter_result["revision"],
            "sequence": adapter_result["sequence"],
            "state": adapter_result["state"],
            "state_hash": adapter_result["state_hash"],
            "cursor": adapter_result["cursor"],
            "viewer_state": viewer.to_dict(),
            "data": {
                **dict(
                    _stored_mapping(
                        adapter_result.get("data"), field_name="adapter_result.data"
                    )
                ),
                "plan": plan,
                "adapter_command": v1_type.value,
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
                        target_virtual_time_ms=self._cursor_time(selected_snapshot),
                    )
                except TrainingRunError:
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
        extension_factory = self.store.attach_market_track_writer(
            run_id=command.run_id,
            track_id=str(track["track_id"]),
            requested_tier=requested_tier.value,
        )
        try:
            created = await self.replay_service.create_session(
                config,
                _extension_factory=extension_factory,
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
        checkpoint = await self.store.checkpoint_market_tracks(command.run_id)
        refreshed = await self.store.get_market_tracks(command.run_id)
        viewer = await self.store.get_viewer_state(command.run_id)
        return self._result_payload(
            command=command,
            session_id=session_id,
            snapshot=acknowledged,
            viewer=viewer.to_dict(),
            data={
                **dict(
                    _stored_mapping(
                        acknowledged.get("data"), field_name="adapter_result.data"
                    )
                ),
                "selected_track_id": selected_track_id,
                "portfolio": refreshed["portfolio"],
                "global_checkpoint": checkpoint,
                "account_contract": "SHARED_SETTLEMENT_OVERLAY_V1",
            },
        )

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
                self._exact_payload(command.payload, set())
                if actor.playback_is_active():
                    raise TrainingRunError(
                        "REPLAY_CONTROL_INVALID",
                        "ordered playback is already running",
                        status_code=409,
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
                speed = selected_snapshot.get("speed", 1)
                generation, stop = actor.begin_ordered_playback(
                    client_instance_id=command.client_instance_id,
                    speed=speed if isinstance(speed, (int, str)) else 1,
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
            if command.type is ReplayV2CommandType.ACQUIRE_CONTROLLER:
                v1_type = CommandType.ACQUIRE_CONTROLLER
                payload = dict(self._exact_payload(command.payload, {"takeover"}))
            elif command.type is ReplayV2CommandType.TAKEOVER_CONTROLLER:
                self._exact_payload(command.payload, set())
                v1_type = CommandType.ACQUIRE_CONTROLLER
                payload = {"takeover": True}
            elif command.type is ReplayV2CommandType.SET_SPEED:
                v1_type = CommandType.SET_SPEED
                payload = dict(self._exact_payload(command.payload, {"speed"}))
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
                ReplayV2CommandType.SET_SPEED,
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
            if command.type is ReplayV2CommandType.SET_SPEED:
                actor.update_ordered_speed(payload["speed"])  # type: ignore[arg-type]
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
            if command.type is ReplayV2CommandType.STEP_BASE and target is None:
                step_base_payload = self._exact_payload(command.payload, {"count"})
                target = aligned_step_target_ms(
                    current_virtual_time_ms=current_time,
                    base_interval=str(binding["base_interval"]),
                    step_interval=str(binding["base_interval"]),
                    count=control_count(step_base_payload["count"]),
                )
            if not isinstance(target, int):
                raise TrainingRunError(
                    "REPLAY_CONTROL_UNSUPPORTED",
                    "multi-track control requires an exact global target",
                    status_code=409,
                )
            total_events = list(
                await self._advance_full_tracks_to(
                    command=command,
                    binding=binding,
                    tracks=ordered,
                    target_virtual_time_ms=target,
                )
            )
        selected = await self.replay_service.get_session(selected_session_id)
        final = self._snapshot(selected)
        viewer = await self.store.get_viewer_state(command.run_id)
        return self._result_payload(
            command=command,
            session_id=selected_session_id,
            snapshot=final,
            viewer=viewer.to_dict(),
            data={
                "consumed": len(total_events),
                "full_track_count": len(ordered),
                "ordering_version": GLOBAL_ORDERING_VERSION,
                "stable_order": [event.to_dict() for event in total_events],
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
                    if len(tracks) < 2:
                        terminal_reason = (
                            "ORDERED_PLAYBACK_REQUIRES_MULTIPLE_FULL_TRACKS"
                        )
                        break
                    selected_session_id = str(binding["adapter_session_id"])
                    selected = await self.replay_service.get_session(
                        selected_session_id
                    )
                    selected_snapshot = self._snapshot(selected)
                    current_time = self._cursor_time(selected_snapshot)
                    speed = actor.playback_snapshot()["speed"]
                    if speed == "MAX":
                        target = await self._ordered_batch_target(
                            tracks,
                            max_events=128,
                        )
                        if target is None:
                            terminal_state = "ENDED"
                            terminal_reason = "SOURCE_EXHAUSTED"
                            break
                    else:
                        if isinstance(speed, bool) or not isinstance(speed, int):
                            raise TrainingRunError(
                                "REPLAY_CONTROL_INVALID",
                                "ordered playback speed is invalid",
                                status_code=409,
                            )
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
                            int(
                                (event_loop.time() - last_advance_wall) * 1_000 * speed
                            ),
                        )
                        if current_time + elapsed_ms < next_time:
                            timeout = min(
                                0.25,
                                max(0.001, (next_time - current_time) / speed / 1_000),
                            )
                            target = None
                        else:
                            target = max(next_time, current_time + elapsed_ms)
                            timeout = 0.0
                    if target is not None:
                        cursor = selected_snapshot.get("cursor")
                        if not isinstance(cursor, Mapping):
                            raise TrainingRunError(
                                "TRAINING_RUN_STORAGE_DEGRADED",
                                "adapter cursor is invalid",
                                status_code=503,
                            )
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
            terminal_state = "ERROR"
            terminal_reason = (
                exc.code.value if isinstance(exc, ReplayDomainError) else exc.code
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
    ) -> tuple[StableMarketEvent, ...]:
        all_events: list[StableMarketEvent] = []
        for _wave_index in range(10_000):
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
            if wave_events:
                ordered_wave = stable_market_event_order(wave_events)
                await self.store.record_global_events(command.run_id, ordered_wave)
                all_events.extend(ordered_wave)
            else:
                await self.store.checkpoint_market_tracks(command.run_id)
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
            return
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
            raise TrainingRunError(
                "REPLAY_POLICY_UNSUPPORTED",
                "the v1 execution adapter cannot revise this rule without changing historical semantics",
                status_code=409,
                details={
                    "command": command_value,
                    "atomic": True,
                    "applied": False,
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
            "cancelable": bool(plan.get("cancelable", False)),
        }
        self._advance_jobs[key] = job
        try:
            while True:
                if cancel.is_set():
                    job["status"] = "CANCELLED"
                    break
                current_response = await self.replay_service.get_session(session_id)
                current = current_response["snapshot"]
                cursor = current["cursor"]
                current_time = int(cursor["virtual_time_ms"])
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
                    max_events=32,
                )
                if cancel.is_set():
                    job["status"] = "CANCELLED"
                    break
                count = int(chunk["event_count"])
                if count > 0:
                    v1_type = CommandType.STEP
                    payload: dict[str, object] = {"count": count}
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
                        source_sequence=int(cursor["source_sequence"]),
                        virtual_time_ms=current_time,
                        target_virtual_time_ms=target_virtual_time_ms,
                    ),
                    client_instance_id=command.client_instance_id,
                    expected_revision=int(current["revision"]),
                    type=v1_type,
                    payload=payload,
                )
                try:
                    acknowledged = await self.replay_service.command(session_id, part)
                except ReplayDomainError as exc:
                    raise TrainingRunError(
                        exc.code.value,
                        exc.message,
                        status_code=exc.http_status,
                        details=exc.details,
                    ) from exc
                job["chunks"] = int(job["chunks"]) + 1
                job["consumed"] = int(job["consumed"]) + int(
                    acknowledged["data"].get("consumed", 0)
                )
                job["current_virtual_time_ms"] = int(
                    acknowledged["cursor"]["virtual_time_ms"]
                )
                await asyncio.sleep(0)

            final_response = await self.replay_service.get_session(session_id)
            final = final_response["snapshot"]
            viewer = await self.store.get_viewer_state(command.run_id)
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
                    "consumed": int(job["consumed"]),
                    "cancelled": job["status"] == "CANCELLED",
                    "target_virtual_time_ms": target_virtual_time_ms,
                    "plan": dict(plan),
                    "progress": progress,
                },
            }
        finally:
            # Keep a completed snapshot available through the end of this event
            # loop turn so a racing cancel/progress request gets a stable answer.
            await asyncio.sleep(0)
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
        initial = int(job["initial_virtual_time_ms"])
        target = int(job["target_virtual_time_ms"])
        current = min(target, max(initial, int(job["current_virtual_time_ms"])))
        span = target - initial
        ratio_ppm = (
            1_000_000 if span <= 0 else ((current - initial) * 1_000_000) // span
        )
        return {
            "status": str(job["status"]),
            "current_virtual_time_ms": current,
            "target_virtual_time_ms": target,
            "ratio_ppm": ratio_ppm,
            "consumed": int(job["consumed"]),
            "chunks": int(job["chunks"]),
            "cancelable": bool(job["cancelable"]),
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
        if command_type is ReplayV2CommandType.STEP_EVENT:
            if source_kind != "AGG_TRADE":
                raise TrainingRunError(
                    "REPLAY_CONTROL_UNSUPPORTED",
                    "STEP_EVENT is available only for AGG_TRADE runs",
                    status_code=409,
                )
            payload = self._exact_payload(command.payload, {"count"})
            count = control_count(payload["count"])
            return CommandType.STEP, {"count": count}, {**plan, "grain": "EVENT"}
        if command_type is ReplayV2CommandType.STEP_BASE:
            payload = self._exact_payload(command.payload, {"count"})
            count = control_count(payload["count"])
            if source_kind == "BAR":
                return CommandType.STEP, {"count": count}, {**plan, "grain": "BASE"}
            target = aligned_step_target_ms(
                current_virtual_time_ms=current_time,
                base_interval=base_interval,
                step_interval=base_interval,
                count=count,
            )
            return (
                CommandType.ADVANCE_BY,
                {"ms": target - current_time},
                {**plan, "grain": "BASE", "target_virtual_time_ms": target},
            )
        if command_type is ReplayV2CommandType.STEP_DISPLAY:
            payload = self._exact_payload(
                command.payload,
                {"count", "display_interval", "viewer_revision"},
            )
            count = control_count(payload["count"])
            interval = payload["display_interval"]
            viewer_revision = payload["viewer_revision"]
            if (
                not isinstance(interval, str)
                or isinstance(viewer_revision, bool)
                or not isinstance(viewer_revision, int)
                or viewer_revision < 0
            ):
                raise TrainingRunError(
                    "REPLAY_CONTROL_INVALID",
                    "display step binding is invalid",
                    status_code=422,
                )
            submitted_view = await self.store.viewer_state_at_revision(
                command.run_id,
                viewer_revision,
            )
            if submitted_view.display_interval != interval:
                raise TrainingRunError(
                    "VIEWER_REVISION_CONFLICT",
                    "display interval does not match the bound viewer revision",
                    status_code=409,
                )
            target = aligned_step_target_ms(
                current_virtual_time_ms=current_time,
                base_interval=base_interval,
                step_interval=interval,
                count=count,
            )
            return (
                CommandType.ADVANCE_BY,
                {"ms": target - current_time},
                {
                    **plan,
                    "grain": "DISPLAY",
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
    def _adapter_config(request: TrainingRunCreateRequest) -> ReplaySessionConfig:
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
            warmup_bars=request.warmup_bars,
            horizon_ms=request.forward_cache_ms,
            random_seed=request.random_seed,
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


__all__ = ["TrainingRunService"]
