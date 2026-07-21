"""Phase 1 TrainingRun orchestration over the validated replay.v1 adapter."""

from __future__ import annotations

import sqlite3
import uuid
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING

from app.replay.constants import (
    REPLAY_PROTOCOL,
    ExecutionModel,
    QualityMode,
    SlippageKind,
    SourceKind,
    StartPolicy,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import (
    FeeModel,
    ReplaySessionConfig,
    SlippageModel,
    validate_identifier,
)

from .errors import TrainingRunError
from .models import ReplaySource, StartMode, TimeDisclosurePolicy, TrainingRunCreateRequest
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

    async def create_run(
        self, request: TrainingRunCreateRequest
    ) -> dict[str, object]:
        if not isinstance(request, TrainingRunCreateRequest):
            raise TypeError("request must be TrainingRunCreateRequest")
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
            display_interval=request.display_interval,
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
