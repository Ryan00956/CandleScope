"""TrainingRun lifecycle, ViewerState, and replay.v2 control adaptation."""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import uuid
from collections.abc import Callable, Mapping
from decimal import Decimal
from typing import TYPE_CHECKING

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
    TimeDisclosurePolicy,
    TrainingRunCreateRequest,
    validate_v2_counter,
)
from .storage import TrainingRunStore

if TYPE_CHECKING:
    from app.replay.service import ReplayService


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

    async def start(self) -> None:
        await self.store.start()

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
        journal = await self.replay_service.journal(
            str(binding["adapter_session_id"])
        )
        return {
            "protocol": "replay.v2",
            "run_id": normalized,
            "entries": journal["entries"],
            "integrity": await self.store.integrity(normalized),
        }

    async def report(self, run_id: str) -> dict[str, object]:
        normalized = self._identifier(run_id, field_name="run_id")
        binding = await self.store.run_binding(normalized)
        report = await self.replay_service.report(
            str(binding["adapter_session_id"])
        )
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
        if not isinstance(snapshot, Mapping) or snapshot.get("state_hash") != event["state_hash"]:
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

    async def create_run(
        self, request: TrainingRunCreateRequest
    ) -> dict[str, object]:
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
        try:
            await self.replay_service.release_session_to_hub(normalized)
        except ReplayDomainError as exc:
            raise TrainingRunError(
                "TRAINING_RUN_BUSY",
                "training run cannot return to the Hub while another mutation is active",
                status_code=409,
                details={"reason": exc.code.value},
            ) from exc
        record = await self.replay_service.store.get_session(normalized)
        if record is None or record["state"] != "PAUSED":
            raise TrainingRunError(
                "TRAINING_RUN_STORAGE_DEGRADED",
                "training run did not durably pause before returning to the Hub",
                status_code=503,
            )
        return {
            "protocol": "replay.v2",
            "run_id": run_id,
            "state": "PAUSED",
            "checkpointed": True,
            "released": True,
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

        snapshot = self._assert_expected_cursor(command, session)
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
                **dict(adapter_result["data"]),
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
            if not isinstance(reason, str) or not reason.strip() or len(reason.strip()) > 500:
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
                if current_time >= target_virtual_time_ms or current["state"] == "ENDED":
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
                    duration = min(target_virtual_time_ms - current_time, 30 * 86_400_000)
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
        ratio_ppm = 1_000_000 if span <= 0 else ((current - initial) * 1_000_000) // span
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
                    "REPLAY_CONTROL_INVALID", "takeover must be a boolean", status_code=422
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
            elif isinstance(duration, bool) or not isinstance(duration, int) or duration <= 0:
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
                details={"expected": command.expected_cursor.to_dict(), "actual": actual},
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
