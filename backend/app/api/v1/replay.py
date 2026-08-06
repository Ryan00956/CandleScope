"""Replay v3 product routes and its gated internal adapter transport."""

from __future__ import annotations

from typing import Awaitable, Callable, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from app.core.config import REPLAY_SETTINGS
from app.replay.constants import (
    REPLAY_PROTOCOL,
    CommandType,
    QualityMode,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import (
    MAX_COUNTER,
    MAX_RANDOM_SEED,
    MAX_TIMESTAMP_MS,
    ReplayCommand,
    validate_identifier,
)
from app.replay.service import ReplayService
from app.replay.training.errors import TrainingRunError
from app.replay.training.commands import ReplayV2Command
from app.replay.training.models import (
    HEDGE_ACCOUNT_FIDELITY,
    HEDGE_INSURANCE_ADL_FIDELITY,
    REPLAY_V2_PROTOCOL,
    AccountDataMode,
    BookMode,
    FundingMode,
    IntegrityMode,
    MarginMode,
    PositionMode,
    ReplaySource,
    StartMode,
    TimeDisclosurePolicy,
    TrainingCursor,
    TrainingRunCreateRequest,
    TrainingRunMarketSelectionRequest,
    TrainingRunSetupRequest,
)
from app.replay.training.service import TrainingRunService


MAX_REPLAY_REQUEST_BYTES = 64 * 1024
MAX_REPLAY_DRAWING_REQUEST_BYTES = 2_100_000
_MAX_HORIZON_MS = REPLAY_SETTINGS.max_horizon_days * 86_400_000


def replay_error_payload(error: ReplayDomainError) -> dict[str, object]:
    return {
        "protocol": REPLAY_PROTOCOL,
        "error": {
            "code": error.code.value,
            "message": error.message,
            "details": dict(error.details),
        },
    }


def replay_training_unavailable_payload() -> dict[str, object]:
    return {
        "protocol": REPLAY_V2_PROTOCOL,
        "error": {
            "code": "REPLAY_TRAINING_UNAVAILABLE",
            "message": "Replay training runtime is unavailable",
            "details": {},
        },
    }


class ReplayAPIRoute(APIRoute):
    """Keep v1 and v2 validation failures on their respective wire contracts."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                if request.method in {"POST", "PUT", "PATCH"}:
                    await enforce_replay_request_limit(request)
                return await original(request)
            except TrainingRunError as exc:
                return JSONResponse(
                    status_code=exc.status_code,
                    content=exc.to_payload(),
                )
            except ReplayDomainError as exc:
                if _is_training_run_request(request):
                    error = TrainingRunError(
                        "TRAINING_RUN_INVALID",
                        "training run request is invalid",
                        status_code=exc.http_status,
                        details={"reason": exc.code.value},
                    )
                    return JSONResponse(
                        status_code=error.status_code,
                        content=error.to_payload(),
                    )
                return JSONResponse(
                    status_code=exc.http_status,
                    content=replay_error_payload(exc),
                )
            except RequestValidationError as exc:
                details = [
                    {
                        "location": [str(value) for value in item.get("loc", ())],
                        "message": str(item.get("msg", "invalid value")),
                        "type": str(item.get("type", "validation_error")),
                    }
                    for item in exc.errors()
                ]
                if _is_training_run_request(request):
                    error = TrainingRunError(
                        "TRAINING_RUN_INVALID",
                        "training run request validation failed",
                        status_code=422,
                        details={"validation": details},
                    )
                    return JSONResponse(
                        status_code=error.status_code,
                        content=error.to_payload(),
                    )
                error = ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "replay request validation failed",
                    details={"validation": details},
                )
                return JSONResponse(
                    status_code=422,
                    content=replay_error_payload(error),
                )
            except (TypeError, ValueError) as exc:
                if _is_training_run_request(request):
                    error = TrainingRunError(
                        "TRAINING_RUN_INVALID",
                        "training run request is invalid",
                        status_code=422,
                        details={"reason": str(exc)},
                    )
                    return JSONResponse(
                        status_code=error.status_code,
                        content=error.to_payload(),
                    )
                error = ReplayDomainError(
                    ReplayErrorCode.INVALID_STATE_TRANSITION,
                    "replay request is invalid",
                    details={"reason": str(exc)},
                )
                return JSONResponse(
                    status_code=422,
                    content=replay_error_payload(error),
                )

        return handler


def _is_training_run_request(request: Request) -> bool:
    return "/replay/runs" in request.url.path


router = APIRouter(
    prefix="/replay",
    tags=["replay"],
    route_class=ReplayAPIRoute,
)


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReplayCommandPayload(_StrictModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "protocol": REPLAY_PROTOCOL,
                    "command_id": "cmd-01J00000000000000000000000",
                    "client_instance_id": "browser-tab-01",
                    "expected_revision": 2,
                    "type": "step",
                    "payload": {"count": 1},
                }
            ]
        },
    )

    protocol: Literal["replay.v1"]
    command_id: str = Field(min_length=1, max_length=128)
    client_instance_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=0, le=MAX_COUNTER)
    type: CommandType
    payload: dict[str, object]


class ReplayLaunchWatchlistItemPayload(_StrictModel):
    exchange: str = Field(min_length=1, max_length=128)
    market_type: str = Field(min_length=1, max_length=128)
    symbol: str = Field(min_length=1, max_length=128)


class ReplayLaunchWatchlistGroupPayload(_StrictModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(min_length=1, max_length=32)
    items: list[ReplayLaunchWatchlistItemPayload] = Field(max_length=100)


class ReplayWatchlistSnapshotPayload(_StrictModel):
    schema_version: Literal["replay.watchlist-snapshot.v1"]
    groups: list[ReplayLaunchWatchlistGroupPayload] = Field(max_length=32)


class ReplayLaunchContextPayload(_StrictModel):
    schema_version: Literal["replay.launch-context.v1"]
    source: Literal["LIVE_PAGE", "DIRECT_HUB"]
    exchange: str = Field(min_length=1, max_length=128)
    market_type: str = Field(min_length=1, max_length=128)
    symbol: str = Field(min_length=1, max_length=128)
    display_interval: str = Field(min_length=1, max_length=128)
    watchlist_snapshot: ReplayWatchlistSnapshotPayload


class VisibleHistoryLookbackPayload(_StrictModel):
    mode: Literal["DURATION", "ALL_AVAILABLE"]
    duration_ms: int | None = Field(default=None, ge=1, le=MAX_TIMESTAMP_MS)


class AccountHistoryRefPayload(_StrictModel):
    schema_version: Literal["replay.account-history-ref.v1"]
    archive_id: str = Field(min_length=1, max_length=128)
    dataset_epoch: str = Field(min_length=71, max_length=71)
    checksum_sha256: str = Field(min_length=71, max_length=71)


class HedgePublicHistoryRefPayload(_StrictModel):
    schema_version: Literal["replay.hedge-public-history-ref.v1"]
    archive_id: str = Field(min_length=1, max_length=128)
    dataset_epoch: str = Field(min_length=71, max_length=71)
    checksum_sha256: str = Field(min_length=71, max_length=71)


class HedgeSimulationManifestRefPayload(_StrictModel):
    schema_version: Literal["replay.hedge-simulation-manifest-ref.v1"]
    manifest_id: str = Field(min_length=1, max_length=128)
    dataset_epoch: str = Field(min_length=71, max_length=71)
    checksum_sha256: str = Field(min_length=71, max_length=71)
    contract_hash: str = Field(min_length=71, max_length=71)
    model_version: str = Field(min_length=1, max_length=128)


class TrainingRunPreparationPayload(_StrictModel):
    protocol: Literal["replay.v3"]
    catalog_epoch: str = Field(min_length=71, max_length=71)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    source_kind: ReplaySource
    start_mode: StartMode
    exchange: str = Field(min_length=1, max_length=128)
    market_type: str = Field(min_length=1, max_length=128)
    symbol: str = Field(min_length=1, max_length=128)
    settlement_asset: str = Field(min_length=1, max_length=128)
    base_interval: str = Field(min_length=1, max_length=128)
    display_interval: str = Field(min_length=1, max_length=128)
    requested_start_ms: int | None = Field(default=None, ge=0, le=MAX_TIMESTAMP_MS)
    warmup_bars: int | None = Field(
        default=None,
        ge=1,
        le=REPLAY_SETTINGS.max_warmup_bars,
    )
    indicator_warmup_bars: int | None = Field(
        default=None,
        ge=1,
        le=REPLAY_SETTINGS.max_warmup_bars,
    )
    visible_history_lookback: VisibleHistoryLookbackPayload | None = None
    forward_cache_ms: int = Field(ge=1, le=_MAX_HORIZON_MS)
    random_seed: int | None = Field(default=None, ge=0, le=MAX_RANDOM_SEED)
    initial_equity: str = Field(min_length=1, max_length=128)
    max_leverage: str = Field(min_length=1, max_length=128)
    maker_fee_bps: str = Field(min_length=1, max_length=128)
    taker_fee_bps: str = Field(min_length=1, max_length=128)
    market_slippage_bps: str = Field(min_length=1, max_length=128)
    integrity_mode: IntegrityMode
    time_disclosure_policy: TimeDisclosurePolicy
    book_mode: BookMode
    margin_mode: MarginMode
    position_mode: PositionMode = PositionMode.HEDGE
    funding_mode: FundingMode
    account_data_mode: AccountDataMode = AccountDataMode.DETERMINISTIC_SIMULATION
    account_history_ref: AccountHistoryRefPayload | None = None
    hedge_public_history_ref: HedgePublicHistoryRefPayload | None = None
    simulation_manifest_ref: HedgeSimulationManifestRefPayload | None = None
    account_fidelity: str | None = Field(
        default=HEDGE_ACCOUNT_FIDELITY,
        max_length=128,
    )
    insurance_adl_fidelity: str | None = Field(
        default=HEDGE_INSURANCE_ADL_FIDELITY,
        max_length=128,
    )
    fixed_funding_rate: str | None = Field(default=None, min_length=1, max_length=128)
    funding_interval_ms: int | None = Field(default=None, ge=60_000, le=2_592_000_000)
    allow_rule_changes: bool
    allowed_mutations: list[str] = Field(default_factory=list, max_length=6)
    launch_context: ReplayLaunchContextPayload | None = None


class TrainingRunSetupPayload(_StrictModel):
    protocol: Literal["replay.v3"]
    name: str | None = Field(default=None, min_length=1, max_length=80)
    source_kind: ReplaySource
    start_mode: StartMode
    settlement_asset: str = Field(min_length=1, max_length=128)
    requested_start_ms: int | None = Field(default=None, ge=0, le=MAX_TIMESTAMP_MS)
    random_range_start_ms: int | None = Field(default=None, ge=0, le=MAX_TIMESTAMP_MS)
    random_range_end_ms: int | None = Field(default=None, ge=0, le=MAX_TIMESTAMP_MS)
    indicator_warmup_bars: int = Field(
        ge=1,
        le=REPLAY_SETTINGS.max_warmup_bars,
    )
    visible_history_lookback: VisibleHistoryLookbackPayload
    forward_cache_ms: int = Field(ge=1, le=_MAX_HORIZON_MS)
    random_seed: int | None = Field(default=None, ge=0, le=MAX_RANDOM_SEED)
    initial_equity: str = Field(min_length=1, max_length=128)
    max_leverage: str = Field(min_length=1, max_length=128)
    maker_fee_bps: str = Field(min_length=1, max_length=128)
    taker_fee_bps: str = Field(min_length=1, max_length=128)
    market_slippage_bps: str = Field(min_length=1, max_length=128)
    integrity_mode: IntegrityMode
    time_disclosure_policy: TimeDisclosurePolicy
    book_mode: BookMode
    margin_mode: MarginMode
    position_mode: PositionMode = PositionMode.HEDGE
    funding_mode: FundingMode
    account_data_mode: AccountDataMode = AccountDataMode.DETERMINISTIC_SIMULATION
    account_fidelity: str | None = Field(default=None, max_length=128)
    insurance_adl_fidelity: str | None = Field(default=None, max_length=128)
    fixed_funding_rate: str | None = Field(default=None, min_length=1, max_length=128)
    funding_interval_ms: int | None = Field(default=None, ge=60_000, le=2_592_000_000)
    allow_rule_changes: bool
    allowed_mutations: list[str] = Field(default_factory=list, max_length=6)
    market_selection_hint: ReplayLaunchContextPayload | None = None


class TrainingRunMarketSelectionPayload(_StrictModel):
    catalog_epoch: str = Field(min_length=71, max_length=71)
    exchange: str = Field(min_length=1, max_length=128)
    market_type: str = Field(min_length=1, max_length=128)
    symbol: str = Field(min_length=1, max_length=128)
    base_interval: str = Field(min_length=1, max_length=128)
    display_interval: str = Field(min_length=1, max_length=128)
    account_history_ref: AccountHistoryRefPayload | None = None
    hedge_public_history_ref: HedgePublicHistoryRefPayload | None = None
    simulation_manifest_ref: HedgeSimulationManifestRefPayload | None = None


class TrainingCursorPayload(_StrictModel):
    virtual_time_ms: int = Field(ge=0, le=MAX_TIMESTAMP_MS)
    source_sequence: int = Field(ge=0, le=MAX_COUNTER)
    revision: int = Field(ge=0, le=MAX_COUNTER)


class ReplayV2CommandPayload(_StrictModel):
    protocol: Literal["replay.v3"]
    run_id: str = Field(min_length=1, max_length=128)
    command_id: str = Field(min_length=1, max_length=128)
    client_instance_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=0, le=MAX_COUNTER)
    expected_cursor: TrainingCursorPayload
    type: str = Field(min_length=1, max_length=64)
    payload: dict[str, object]


class ReplayOrderRequestPayload(_StrictModel):
    client_order_id: str = Field(min_length=1, max_length=128)
    side: Literal["BUY", "SELL"]
    order_type: Literal[
        "MARKET",
        "LIMIT",
        "STOP_MARKET",
        "TAKE_PROFIT_MARKET",
    ]
    quantity: str = Field(min_length=1, max_length=128)
    reduce_only: bool
    limit_price: str | None = Field(default=None, min_length=1, max_length=128)
    stop_price: str | None = Field(default=None, min_length=1, max_length=128)
    leverage: str | None = Field(default=None, min_length=1, max_length=128)
    position_side: Literal["LONG", "SHORT"] | None = None


class ReplayTradePlanDraftPayload(_StrictModel):
    sizing_mode: Literal["RISK_AMOUNT", "ACCOUNT_RISK_PERCENT"]
    risk_amount: str | None = Field(default=None, min_length=1, max_length=128)
    risk_percent: str | None = Field(default=None, min_length=1, max_length=128)
    invalidation_price: str = Field(min_length=1, max_length=128)
    target_price: str = Field(min_length=1, max_length=128)
    reason: str = Field(min_length=1, max_length=500)


class ReplayOrderPreviewPayload(_StrictModel):
    protocol: Literal["replay.v3"]
    expected_revision: int = Field(ge=0, le=MAX_COUNTER)
    expected_cursor: TrainingCursorPayload
    position_intent: Literal["NET", "OPEN"]
    order: ReplayOrderRequestPayload
    trade_plan: ReplayTradePlanDraftPayload | None = None


class ReplayOrderCapacityContextPayload(_StrictModel):
    side: Literal["BUY", "SELL"]
    order_type: Literal[
        "MARKET",
        "LIMIT",
        "STOP_MARKET",
        "TAKE_PROFIT_MARKET",
    ]
    reduce_only: bool
    limit_price: str | None = Field(default=None, min_length=1, max_length=128)
    stop_price: str | None = Field(default=None, min_length=1, max_length=128)
    leverage: str | None = Field(default=None, min_length=1, max_length=128)
    position_side: Literal["LONG", "SHORT"] | None = None


class ReplayOrderCapacityPayload(_StrictModel):
    protocol: Literal["replay.v3"]
    expected_revision: int = Field(ge=0, le=MAX_COUNTER)
    expected_cursor: TrainingCursorPayload
    position_intent: Literal["NET", "OPEN"]
    context: ReplayOrderCapacityContextPayload


class ReplayReviewPayload(_StrictModel):
    event_id: str | None = Field(default=None, min_length=1, max_length=128)


class ReplayDrawingDocumentPayload(_StrictModel):
    protocol: Literal["replay.review.drawing-document.v1"]
    command_id: str = Field(min_length=1, max_length=128)
    document_hash: str = Field(min_length=71, max_length=71)
    document: dict[str, object]
    entity_count: int = Field(ge=0, le=512)


class ReplayReviewMarkerPayload(_StrictModel):
    protocol: Literal["replay.review.marker.v1"]
    command_id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=500)


class ReplayReviewControlPayload(_StrictModel):
    action: Literal["JUMP", "NEXT", "PREVIOUS", "PLAY", "PAUSE"]
    event_id: str | None = Field(default=None, min_length=1, max_length=128)
    expected_cursor_revision: int = Field(ge=1, le=MAX_COUNTER)
    playback_rate: str | None = Field(default=None, min_length=1, max_length=8)


class ReplayPublicTimeBatchPayload(_StrictModel):
    timeline_ms: list[int] = Field(min_length=1, max_length=2_000)


class ReplayForkPayload(_StrictModel):
    event_id: str = Field(min_length=1, max_length=128)


class ReplaySegmentGcPlanPayload(_StrictModel):
    protocol: Literal["replay.data.gc.v1"]
    target_reclaim_bytes: int = Field(ge=1, le=1_000_000_000_000)
    max_segments: int = Field(default=100, ge=1, le=10_000)


class ReplaySegmentGcRunPayload(ReplaySegmentGcPlanPayload):
    plan_hash: str = Field(min_length=71, max_length=71)
    confirm: Literal[True]


class ReplayHistoricalBookGcPlanPayload(_StrictModel):
    protocol: Literal["replay.historical-book.gc.v1"]
    target_reclaim_bytes: int = Field(ge=1, le=1_000_000_000_000)
    max_archives: int = Field(default=100, ge=1, le=10_000)


class ReplayHistoricalBookGcRunPayload(ReplayHistoricalBookGcPlanPayload):
    plan_hash: str = Field(min_length=71, max_length=71)
    confirm: Literal[True]


class ReplayAccountHistoryGcPlanPayload(_StrictModel):
    protocol: Literal["replay.account-history.gc.v1"]
    target_reclaim_bytes: int = Field(ge=1, le=1_000_000_000_000)
    max_archives: int = Field(default=100, ge=1, le=10_000)


class ReplayAccountHistoryGcRunPayload(ReplayAccountHistoryGcPlanPayload):
    plan_hash: str = Field(min_length=71, max_length=71)
    confirm: Literal[True]


async def enforce_replay_request_limit(request: Request) -> None:
    limit_bytes = _replay_request_limit(request)
    _validate_declared_replay_length(request, limit_bytes=limit_bytes)
    cached = getattr(request, "_body", None)
    if cached is not None:
        if len(cached) > limit_bytes:
            raise _request_too_large(limit_bytes=limit_bytes)
        return
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > limit_bytes:
            raise _request_too_large(limit_bytes=limit_bytes)
        chunks.append(chunk)
    request._body = b"".join(chunks)


def _replay_request_limit(request: Request) -> int:
    if (
        request.method == "POST"
        and request.url.path.endswith("/drawings")
        and "/replay/runs/" in request.url.path
    ):
        return MAX_REPLAY_DRAWING_REQUEST_BYTES
    return MAX_REPLAY_REQUEST_BYTES


def _validate_declared_replay_length(
    request: Request,
    *,
    limit_bytes: int,
) -> None:
    raw_length = request.headers.get("content-length")
    if raw_length is None:
        return
    try:
        length = int(raw_length)
    except ValueError as exc:
        raise ReplayDomainError(
            ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
            "replay request Content-Length is invalid",
        ) from exc
    if length < 0 or length > limit_bytes:
        raise _request_too_large(limit_bytes=limit_bytes)


def _request_too_large(*, limit_bytes: int) -> ReplayDomainError:
    return ReplayDomainError(
        ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
        "replay request body exceeds the bounded size limit",
        details={"limit_bytes": limit_bytes},
    )


def replay_service_from_state(state: object) -> ReplayService:
    service = getattr(state, "replay_service", None)
    if service is None:
        raise ReplayDomainError(
            ReplayErrorCode.REPLAY_DISABLED,
            "K-line replay is disabled",
        )
    return service


def _service(request: Request) -> ReplayService:
    return replay_service_from_state(request.app.state)


def _session_id(value: str) -> str:
    try:
        return validate_identifier(value, field_name="session_id")
    except (TypeError, ValueError) as exc:
        raise ReplayDomainError(
            ReplayErrorCode.SESSION_NOT_FOUND,
            "replay session does not exist",
        ) from exc


async def _owned_adapter_session_id(request: Request, value: str) -> str:
    session_id = _session_id(value)
    await _training_service(request).store.run_id_for_session(session_id)
    return session_id


@router.get("/capabilities")
async def replay_capabilities(request: Request) -> dict[str, object]:
    service = getattr(request.app.state, "replay_service", None)
    if service is not None:
        return service.capabilities()
    return {
        "protocol": REPLAY_PROTOCOL,
        "enabled": False,
        "available": False,
        "reason": ReplayErrorCode.REPLAY_DISABLED.value,
        "sources": {
            "bar": {"enabled": False, "reason": "REPLAY_DISABLED"},
            "agg_trade": {"enabled": False, "reason": "REPLAY_DISABLED"},
        },
        "execution_models": [],
        "limits": {
            "max_active_sessions": REPLAY_SETTINGS.max_active_sessions,
            "max_warmup_bars": REPLAY_SETTINGS.max_warmup_bars,
            "max_bar_dataset_rows": REPLAY_SETTINGS.max_bar_dataset_rows,
            "max_horizon_days": REPLAY_SETTINGS.max_horizon_days,
            "event_buffer_size": REPLAY_SETTINGS.event_buffer_size,
            "subscriber_queue": REPLAY_SETTINGS.event_subscriber_queue,
        },
        "persistence": {
            "opened": False,
            "schema_version": None,
            "degraded": False,
            "degraded_reason": None,
        },
    }


def _training_service(request: Request) -> TrainingRunService:
    replay_service = getattr(request.app.state, "replay_service", None)
    training = getattr(replay_service, "training", None)
    if training is not None:
        return training
    raise TrainingRunError(
        "REPLAY_TRAINING_UNAVAILABLE",
        "Replay training runtime is unavailable",
        status_code=503,
    )


@router.get("/runs")
async def list_replay_v2_runs(
    request: Request,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1, max_length=1024),
    state: str | None = Query(default=None, min_length=1, max_length=32),
    source_kind: str | None = Query(default=None, min_length=1, max_length=32),
    compatibility: str | None = Query(default=None, min_length=1, max_length=32),
) -> dict[str, object]:
    return await _training_service(request).list_runs(
        limit=limit,
        cursor=cursor,
        state=state,
        source_kind=source_kind,
        compatibility=compatibility,
    )


@router.post(
    "/runs",
    status_code=201,
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def create_replay_v2_run(
    request: Request,
    payload: TrainingRunSetupPayload,
) -> dict[str, object]:
    create_request = TrainingRunSetupRequest.from_dict(
        payload.model_dump(mode="json")
    )
    return await _training_service(request).create_empty_run(create_request)


@router.post(
    "/runs/{run_id}/markets",
    status_code=201,
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def select_initial_replay_v2_market(
    run_id: str,
    request: Request,
    payload: TrainingRunMarketSelectionPayload,
) -> dict[str, object]:
    selection = TrainingRunMarketSelectionRequest.from_dict(
        payload.model_dump(mode="json")
    )
    return await _training_service(request).select_initial_market(
        run_id,
        selection,
    )


@router.get("/runs/{run_id}/market-catalog")
async def replay_v2_run_market_catalog(
    run_id: str,
    request: Request,
) -> dict[str, object]:
    return await _training_service(request).market_catalog(run_id)


@router.post(
    "/runs/{run_id}/markets/plan",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def plan_initial_replay_v2_market(
    run_id: str,
    request: Request,
    payload: TrainingRunMarketSelectionPayload,
) -> dict[str, object]:
    selection = TrainingRunMarketSelectionRequest.from_dict(
        payload.model_dump(mode="json")
    )
    return await _training_service(request).initial_market_plan(run_id, selection)


@router.post(
    "/runs/data-segments/plan",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def plan_replay_v2_data_segment(
    request: Request,
    payload: TrainingRunPreparationPayload,
) -> dict[str, object]:
    create_request = TrainingRunCreateRequest.from_dict(
        payload.model_dump(mode="json")
    )
    return await _training_service(request).segment_plan(create_request)


@router.get("/runs/data-segments")
async def list_replay_v2_data_segments(request: Request) -> dict[str, object]:
    return await _training_service(request).list_data_segments()


@router.get("/runs/preparations/{preparation_id}")
async def get_replay_v2_selection_preparation(
    request: Request,
    preparation_id: str,
) -> dict[str, object]:
    return await _training_service(request).get_selection_preparation(
        preparation_id
    )


@router.post(
    "/runs/preparations/{preparation_id}/retry",
    status_code=201,
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def retry_replay_v2_selection_preparation(
    request: Request,
    preparation_id: str,
) -> dict[str, object]:
    return await _training_service(request).retry_selection_preparation(
        preparation_id
    )


@router.get("/runs/historical-books")
async def list_replay_v2_historical_books(request: Request) -> dict[str, object]:
    return await _training_service(request).list_historical_book_archives()


@router.get("/runs/account-history")
async def list_replay_v2_account_history(request: Request) -> dict[str, object]:
    return await _training_service(request).list_account_history_archives()


@router.get("/runs/storage")
async def replay_v2_storage_inventory(request: Request) -> dict[str, object]:
    return await _training_service(request).storage_inventory()


@router.post("/runs/{run_id}/account-audit")
async def audit_replay_v2_account(
    run_id: str,
    request: Request,
) -> dict[str, object]:
    return await _training_service(request).audit_account(run_id)


@router.post(
    "/runs/historical-books/gc/dry-run",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def dry_run_replay_v2_historical_book_gc(
    request: Request,
    payload: ReplayHistoricalBookGcPlanPayload,
) -> dict[str, object]:
    return await _training_service(request).historical_book_gc_plan(
        target_reclaim_bytes=payload.target_reclaim_bytes,
        max_archives=payload.max_archives,
    )


@router.post(
    "/runs/historical-books/gc/run",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def run_replay_v2_historical_book_gc(
    request: Request,
    payload: ReplayHistoricalBookGcRunPayload,
) -> dict[str, object]:
    return await _training_service(request).historical_book_gc_run(
        plan_hash=payload.plan_hash,
        target_reclaim_bytes=payload.target_reclaim_bytes,
        max_archives=payload.max_archives,
    )


@router.post(
    "/runs/historical-books/{archive_id}/rehydrate",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def rehydrate_replay_v2_historical_book(
    request: Request,
    archive_id: str,
) -> dict[str, object]:
    return await _training_service(request).rehydrate_historical_book_archive(
        archive_id
    )


@router.post(
    "/runs/account-history/gc/dry-run",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def dry_run_replay_v2_account_history_gc(
    request: Request,
    payload: ReplayAccountHistoryGcPlanPayload,
) -> dict[str, object]:
    return await _training_service(request).account_history_gc_plan(
        target_reclaim_bytes=payload.target_reclaim_bytes,
        max_archives=payload.max_archives,
    )


@router.post(
    "/runs/account-history/gc/run",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def run_replay_v2_account_history_gc(
    request: Request,
    payload: ReplayAccountHistoryGcRunPayload,
) -> dict[str, object]:
    return await _training_service(request).account_history_gc_run(
        plan_hash=payload.plan_hash,
        target_reclaim_bytes=payload.target_reclaim_bytes,
        max_archives=payload.max_archives,
    )


@router.post(
    "/runs/account-history/{archive_id}/rehydrate",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def rehydrate_replay_v2_account_history(
    request: Request,
    archive_id: str,
) -> dict[str, object]:
    return await _training_service(request).rehydrate_account_history_archive(
        archive_id
    )


@router.post(
    "/runs/data-segments/gc/dry-run",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def dry_run_replay_v2_data_segment_gc(
    request: Request,
    payload: ReplaySegmentGcPlanPayload,
) -> dict[str, object]:
    return await _training_service(request).data_segment_gc_plan(
        target_reclaim_bytes=payload.target_reclaim_bytes,
        max_segments=payload.max_segments,
    )


@router.post(
    "/runs/data-segments/gc/run",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def run_replay_v2_data_segment_gc(
    request: Request,
    payload: ReplaySegmentGcRunPayload,
) -> dict[str, object]:
    return await _training_service(request).data_segment_gc_run(
        plan_hash=payload.plan_hash,
        target_reclaim_bytes=payload.target_reclaim_bytes,
        max_segments=payload.max_segments,
    )


@router.get("/runs/data-segments/jobs/{job_id}")
async def get_replay_v2_data_segment_job(
    request: Request,
    job_id: str,
) -> dict[str, object]:
    normalized = validate_identifier(job_id, field_name="job_id")
    return await _training_service(request).segments.get_prepare_job(normalized)


@router.post(
    "/runs/data-segments/jobs/{job_id}/cancel",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def cancel_replay_v2_data_segment_job(
    request: Request,
    job_id: str,
) -> dict[str, object]:
    normalized = validate_identifier(job_id, field_name="job_id")
    return await _training_service(request).segments.cancel_prepare(normalized)


@router.post(
    "/runs/data-segments/{segment_id}/rehydrate",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def rehydrate_replay_v2_data_segment(
    request: Request,
    segment_id: str,
) -> dict[str, object]:
    normalized = validate_identifier(segment_id, field_name="segment_id")
    return await _training_service(request).segments.rehydrate(normalized)


@router.post(
    "/runs/session/{session_id}/commands",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def command_replay_adapter_session(
    request: Request,
    session_id: str,
    payload: ReplayCommandPayload,
) -> dict[str, object]:
    owned_session_id = await _owned_adapter_session_id(request, session_id)
    command = ReplayCommand.from_dict(payload.model_dump(mode="json"))
    return await _service(request).command(owned_session_id, command)


@router.get(
    "/runs/session/{session_id}",
    dependencies=[Depends(_training_service)],
)
async def get_replay_adapter_session(
    request: Request,
    session_id: str,
) -> dict[str, object]:
    owned_session_id = await _owned_adapter_session_id(request, session_id)
    return await _service(request).get_session(owned_session_id)


@router.post(
    "/runs/{run_id}/return-to-hub",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def return_replay_v2_run_to_hub(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).return_to_hub(run_id)


@router.get("/runs/session/{session_id}/history")
async def replay_v2_training_history(
    request: Request,
    session_id: str,
    track_id: str = Query(min_length=1, max_length=128),
    before_ms: int = Query(ge=0, le=MAX_TIMESTAMP_MS),
    revealed_boundary_ms: int = Query(ge=0, le=MAX_TIMESTAMP_MS),
    limit: int = Query(default=500, ge=1, le=1_000),
    data_epoch: str = Query(min_length=71, max_length=71),
    history_epoch: str | None = Query(default=None, min_length=71, max_length=71),
    display_interval: str | None = Query(default=None, min_length=1, max_length=32),
) -> dict[str, object]:
    return await _training_service(request).history_page(
        session_id,
        track_id=track_id,
        before_ms=before_ms,
        revealed_boundary_ms=revealed_boundary_ms,
        limit=limit,
        data_epoch=data_epoch,
        history_epoch=history_epoch,
        display_interval=display_interval,
    )


@router.get("/runs/session/{session_id}/display-projection")
async def replay_v2_training_display_projection(
    request: Request,
    session_id: str,
    track_id: str = Query(min_length=1, max_length=128),
    revealed_boundary_ms: int = Query(ge=0, le=MAX_TIMESTAMP_MS),
    limit: int = Query(default=1_000, ge=1, le=1_000),
    data_epoch: str = Query(min_length=71, max_length=71),
    display_interval: str = Query(min_length=1, max_length=32),
) -> dict[str, object]:
    return await _training_service(request).display_projection(
        session_id,
        track_id=track_id,
        revealed_boundary_ms=revealed_boundary_ms,
        limit=limit,
        data_epoch=data_epoch,
        display_interval=display_interval,
    )


@router.get("/runs/session/{session_id}/viewer")
async def replay_v2_training_viewer_by_session(
    request: Request,
    session_id: str,
) -> dict[str, object]:
    viewer = await _training_service(request).get_viewer_state_by_session(session_id)
    return {"protocol": REPLAY_V2_PROTOCOL, "viewer_state": viewer}


@router.get("/runs/session/{session_id}/tracks")
async def replay_v2_training_tracks_by_session(
    request: Request,
    session_id: str,
) -> dict[str, object]:
    return await _training_service(request).get_market_tracks_by_session(session_id)


@router.get("/runs/{run_id}/viewer")
async def replay_v2_training_viewer(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    viewer = await _training_service(request).get_viewer_state(run_id)
    return {"protocol": REPLAY_V2_PROTOCOL, "viewer_state": viewer}


@router.get("/runs/{run_id}/data-segments")
async def replay_v2_training_data_segments(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).list_data_segments(run_id=run_id)


@router.post(
    "/runs/{run_id}/historical-book/resync",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def resync_replay_v2_historical_book(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).resync_historical_book(run_id)


@router.get("/runs/{run_id}/tracks")
async def replay_v2_training_tracks(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).get_market_tracks(run_id)


@router.get("/runs/{run_id}/fast-forward-plan")
async def replay_v2_fast_forward_plan(
    request: Request,
    run_id: str,
    target_virtual_time_ms: int = Query(ge=0, le=MAX_TIMESTAMP_MS),
) -> dict[str, object]:
    return await _training_service(request).get_fast_forward_plan(
        run_id,
        target_virtual_time_ms=target_virtual_time_ms,
    )


@router.get("/runs/{run_id}/fast-forward-summaries")
async def replay_v2_fast_forward_summary_status(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).get_period_summary_status(run_id)


@router.post(
    "/runs/{run_id}/fast-forward-summaries/prepare",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def prepare_replay_v2_fast_forward_summaries(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).prepare_period_summaries(run_id)


@router.get("/runs/{run_id}/trade-flow")
async def replay_v2_trade_flow_page(
    request: Request,
    run_id: str,
    track_id: str | None = Query(default=None, min_length=1, max_length=128),
    after_sequence: int | None = Query(default=None, ge=0, le=MAX_COUNTER),
    limit: int = Query(default=200, ge=1, le=1_000),
) -> dict[str, object]:
    return await _training_service(request).trade_flow_page(
        run_id,
        track_id=track_id,
        after_sequence=after_sequence,
        limit=limit,
    )


@router.get("/runs/{run_id}/advances/{command_id}")
async def replay_v2_advance_progress(
    request: Request,
    run_id: str,
    command_id: str,
) -> dict[str, object]:
    return await _training_service(request).get_advance_progress(run_id, command_id)


@router.post(
    "/runs/{run_id}/commands",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def command_replay_v2_run(
    request: Request,
    run_id: str,
    payload: ReplayV2CommandPayload,
) -> dict[str, object]:
    command = ReplayV2Command.from_dict(payload.model_dump(mode="json"))
    return await _training_service(request).command(run_id, command)


@router.post(
    "/runs/{run_id}/order-preview",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def preview_replay_v2_order(
    request: Request,
    run_id: str,
    payload: ReplayOrderPreviewPayload,
) -> dict[str, object]:
    return await _training_service(request).preview_order(
        run_id,
        expected_revision=payload.expected_revision,
        expected_cursor=TrainingCursor.from_dict(
            payload.expected_cursor.model_dump(mode="json")
        ),
        position_intent=payload.position_intent,
        order=payload.order.model_dump(mode="json"),
        trade_plan=(
            None
            if payload.trade_plan is None
            else payload.trade_plan.model_dump(mode="json")
        ),
    )


@router.post(
    "/runs/{run_id}/order-capacity",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def replay_v2_order_capacity(
    request: Request,
    run_id: str,
    payload: ReplayOrderCapacityPayload,
) -> dict[str, object]:
    return await _training_service(request).order_capacity(
        run_id,
        expected_revision=payload.expected_revision,
        expected_cursor=TrainingCursor.from_dict(
            payload.expected_cursor.model_dump(mode="json")
        ),
        position_intent=payload.position_intent,
        context=payload.context.model_dump(mode="json"),
    )


@router.get("/runs/{run_id}/account-records")
async def replay_v2_account_record_page(
    request: Request,
    run_id: str,
    record_type: Literal["ORDERS", "FILLS", "LEDGER"] = Query(),
    order_scope: Literal["ACTIVE", "HISTORY", "ALL"] = Query(default="ALL"),
    track_id: str | None = Query(default=None, min_length=1, max_length=128),
    cursor: str | None = Query(default=None, min_length=1, max_length=2_048),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, object]:
    return await _training_service(request).account_record_page(
        run_id,
        record_type=record_type,
        order_scope=order_scope,
        track_id=track_id,
        cursor=cursor,
        limit=limit,
    )


@router.get("/runs/{run_id}/integrity")
async def replay_v2_training_integrity(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).integrity(run_id)


@router.post(
    "/runs/{run_id}/public-times",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def replay_v2_training_public_times(
    request: Request,
    run_id: str,
    payload: ReplayPublicTimeBatchPayload,
) -> dict[str, object]:
    return await _training_service(request).public_times(
        run_id,
        timeline_ms=tuple(payload.timeline_ms),
    )


@router.get("/runs/{run_id}/equity")
async def replay_v2_training_equity(
    request: Request,
    run_id: str,
    resolution: str = Query(default="AUTO", min_length=1, max_length=16),
    limit: int = Query(default=1_000, ge=1, le=5_000),
) -> dict[str, object]:
    return await _training_service(request).equity(
        run_id,
        resolution=resolution,
        limit=limit,
    )


@router.get("/runs/{run_id}/rules")
async def replay_v2_training_rules(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).rules(run_id)


@router.get("/runs/{run_id}/drawings/current")
async def replay_v2_training_current_drawing_document(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).current_drawing_document(run_id)


@router.post(
    "/runs/{run_id}/drawings",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def replay_v2_training_drawing_document(
    request: Request,
    run_id: str,
    payload: ReplayDrawingDocumentPayload,
) -> dict[str, object]:
    return await _training_service(request).record_drawing_document(
        run_id,
        command_id=payload.command_id,
        document_hash=payload.document_hash,
        document=payload.document,
        entity_count=payload.entity_count,
    )


@router.post(
    "/runs/{run_id}/markers",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def replay_v2_training_review_marker(
    request: Request,
    run_id: str,
    payload: ReplayReviewMarkerPayload,
) -> dict[str, object]:
    return await _training_service(request).record_review_marker(
        run_id,
        command_id=payload.command_id,
        text=payload.text,
    )


@router.get("/runs/{run_id}/journal")
async def replay_v2_training_journal(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).journal(run_id)


@router.get("/runs/{run_id}/report")
async def replay_v2_training_report(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).report(run_id)


@router.get("/runs/{run_id}/training-results")
async def replay_v2_training_results(
    request: Request,
    run_id: str,
    limit: int = Query(default=500, ge=1, le=2_000),
) -> dict[str, object]:
    return await _training_service(request).training_results(run_id, limit=limit)


@router.post(
    "/runs/{run_id}/review",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def review_replay_v2_run(
    request: Request,
    run_id: str,
    payload: ReplayReviewPayload,
) -> dict[str, object]:
    return await _training_service(request).start_review(
        run_id,
        event_id=payload.event_id,
    )


@router.post(
    "/runs/{run_id}/reviews/{review_id}/cursor",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def control_replay_v2_review(
    request: Request,
    run_id: str,
    review_id: str,
    payload: ReplayReviewControlPayload,
) -> dict[str, object]:
    return await _training_service(request).control_review(
        run_id,
        review_id,
        action=payload.action,
        event_id=payload.event_id,
        expected_cursor_revision=payload.expected_cursor_revision,
        playback_rate=payload.playback_rate,
    )


@router.post(
    "/runs/{run_id}/fork",
    status_code=201,
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def fork_replay_v2_run(
    request: Request,
    run_id: str,
    payload: ReplayForkPayload,
) -> dict[str, object]:
    return await _training_service(request).fork_run(
        run_id,
        event_id=payload.event_id,
    )


@router.get("/runs/{run_id}")
async def get_replay_v2_run(request: Request, run_id: str) -> dict[str, object]:
    return await _training_service(request).get_run(run_id)


@router.delete(
    "/runs/{run_id}",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def delete_replay_v2_run(request: Request, run_id: str) -> dict[str, object]:
    return await _training_service(request).delete_run(run_id)


@router.get(
    "/catalog",
    dependencies=[Depends(_training_service)],
)
async def replay_catalog(
    request: Request,
    warmup_bars: int = Query(default=200, ge=0, le=REPLAY_SETTINGS.max_warmup_bars),
    horizon_ms: int = Query(default=86_400_000, ge=1, le=_MAX_HORIZON_MS),
    quality_mode: QualityMode = Query(default=QualityMode.EXACT),
    blind_mode: bool = Query(default=False),
) -> dict[str, object]:
    return await _service(request).catalog(
        warmup_bars=warmup_bars,
        horizon_ms=horizon_ms,
        quality_mode=quality_mode.value,
        blind_mode=blind_mode,
    )


__all__ = [
    "MAX_REPLAY_REQUEST_BYTES",
    "ReplayCommandPayload",
    "ReplayV2CommandPayload",
    "TrainingRunPreparationPayload",
    "TrainingRunMarketSelectionPayload",
    "TrainingRunSetupPayload",
    "replay_error_payload",
    "replay_training_unavailable_payload",
    "replay_service_from_state",
    "router",
]
