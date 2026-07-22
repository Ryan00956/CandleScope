"""Strict replay.v1 HTTP routes and stable transport error envelopes."""

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
    ExecutionModel,
    QualityMode,
    SlippageKind,
    SourceKind,
    StartPolicy,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode
from app.replay.models import (
    MAX_COUNTER,
    MAX_RANDOM_SEED,
    MAX_TIMESTAMP_MS,
    ReplayCommand,
    ReplaySessionConfig,
    validate_identifier,
)
from app.replay.service import ReplayService
from app.replay.training.errors import TrainingRunError
from app.replay.training.commands import ReplayV2Command
from app.replay.training.models import (
    REPLAY_V2_PROTOCOL,
    BookMode,
    FundingMode,
    IntegrityMode,
    MarginMode,
    ReplaySource,
    StartMode,
    TimeDisclosurePolicy,
    TrainingRunCreateRequest,
)
from app.replay.training.service import TrainingRunService


MAX_REPLAY_REQUEST_BYTES = 64 * 1024
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


def replay_v2_unavailable_payload() -> dict[str, object]:
    if REPLAY_SETTINGS.product_v2_available:
        code = "REPLAY_PRODUCT_V2_UNAVAILABLE"
        message = "Replay training v2 runtime is unavailable"
    else:
        code = "REPLAY_PRODUCT_V2_DISABLED"
        message = "Replay training v2 is disabled"
    return {
        "protocol": REPLAY_V2_PROTOCOL,
        "error": {"code": code, "message": message, "details": {}},
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


class FeeModelPayload(_StrictModel):
    maker_bps: str = Field(min_length=1, max_length=128)
    taker_bps: str = Field(min_length=1, max_length=128)


class SlippageModelPayload(_StrictModel):
    kind: SlippageKind
    market_bps: str = Field(min_length=1, max_length=128)


class ReplaySessionCreatePayload(_StrictModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "protocol": REPLAY_PROTOCOL,
                    "source_kind": "bar",
                    "exchange": "binance",
                    "market_type": "spot",
                    "symbol": "BTCUSDT",
                    "base_interval": "1m",
                    "display_interval": "5m",
                    "start_policy": "random_eligible",
                    "requested_start_ms": None,
                    "warmup_bars": 200,
                    "horizon_ms": 86_400_000,
                    "random_seed": 42,
                    "quality_mode": "exact",
                    "blind_mode": True,
                    "initial_equity": "10000",
                    "quote_asset": "USDT",
                    "execution_model": "paper_linear_v1",
                    "fee_model": {"maker_bps": "2", "taker_bps": "5"},
                    "slippage_model": {
                        "kind": "fixed_bps",
                        "market_bps": "1",
                    },
                    "max_leverage": "3",
                    "pause_on_controller_loss": True,
                }
            ]
        },
    )

    protocol: Literal["replay.v1"]
    source_kind: SourceKind
    exchange: str = Field(min_length=1, max_length=128)
    market_type: str = Field(min_length=1, max_length=128)
    symbol: str = Field(min_length=1, max_length=128)
    base_interval: str = Field(min_length=1, max_length=128)
    display_interval: str = Field(min_length=1, max_length=128)
    start_policy: StartPolicy
    requested_start_ms: int | None = Field(default=None, ge=0, le=MAX_TIMESTAMP_MS)
    warmup_bars: int = Field(ge=0, le=REPLAY_SETTINGS.max_warmup_bars)
    horizon_ms: int = Field(ge=1, le=_MAX_HORIZON_MS)
    random_seed: int = Field(ge=0, le=MAX_RANDOM_SEED)
    quality_mode: QualityMode
    blind_mode: bool
    initial_equity: str = Field(min_length=1, max_length=128)
    quote_asset: str = Field(min_length=1, max_length=128)
    execution_model: ExecutionModel
    fee_model: FeeModelPayload
    slippage_model: SlippageModelPayload
    max_leverage: str = Field(min_length=1, max_length=128)
    pause_on_controller_loss: bool


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


class TrainingRunCreatePayload(_StrictModel):
    protocol: Literal["replay.v2"]
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
    warmup_bars: int = Field(ge=1, le=REPLAY_SETTINGS.max_warmup_bars)
    forward_cache_ms: int = Field(ge=1, le=_MAX_HORIZON_MS)
    random_seed: int = Field(ge=0, le=MAX_RANDOM_SEED)
    initial_equity: str = Field(min_length=1, max_length=128)
    max_leverage: str = Field(min_length=1, max_length=128)
    maker_fee_bps: str = Field(min_length=1, max_length=128)
    taker_fee_bps: str = Field(min_length=1, max_length=128)
    market_slippage_bps: str = Field(min_length=1, max_length=128)
    integrity_mode: IntegrityMode
    time_disclosure_policy: TimeDisclosurePolicy
    book_mode: BookMode
    margin_mode: MarginMode
    funding_mode: FundingMode
    fixed_funding_rate: str | None = Field(default=None, min_length=1, max_length=128)
    funding_interval_ms: int | None = Field(default=None, ge=60_000, le=2_592_000_000)
    allow_rule_changes: bool
    allowed_mutations: list[str] = Field(default_factory=list, max_length=6)


class TrainingRunMigrationPayload(_StrictModel):
    protocol: Literal["replay.v2"]
    name: str | None = Field(default=None, min_length=1, max_length=80)


class TrainingCursorPayload(_StrictModel):
    virtual_time_ms: int = Field(ge=0, le=MAX_TIMESTAMP_MS)
    source_sequence: int = Field(ge=0, le=MAX_COUNTER)
    revision: int = Field(ge=0, le=MAX_COUNTER)


class ReplayV2CommandPayload(_StrictModel):
    protocol: Literal["replay.v2"]
    run_id: str = Field(min_length=1, max_length=128)
    command_id: str = Field(min_length=1, max_length=128)
    client_instance_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=0, le=MAX_COUNTER)
    expected_cursor: TrainingCursorPayload
    type: str = Field(min_length=1, max_length=64)
    payload: dict[str, object]


class ReplayReviewPayload(_StrictModel):
    event_id: str | None = Field(default=None, min_length=1, max_length=128)


class ReplayForkPayload(_StrictModel):
    event_id: str = Field(min_length=1, max_length=128)


async def enforce_replay_request_limit(request: Request) -> None:
    _validate_declared_replay_length(request)
    cached = getattr(request, "_body", None)
    if cached is not None:
        if len(cached) > MAX_REPLAY_REQUEST_BYTES:
            raise _request_too_large()
        return
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_REPLAY_REQUEST_BYTES:
            raise _request_too_large()
        chunks.append(chunk)
    request._body = b"".join(chunks)


def _validate_declared_replay_length(request: Request) -> None:
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
    if length < 0 or length > MAX_REPLAY_REQUEST_BYTES:
        raise _request_too_large()


def _request_too_large() -> ReplayDomainError:
    return ReplayDomainError(
        ReplayErrorCode.SCAN_LIMIT_EXCEEDED,
        "replay request body exceeds the bounded size limit",
        details={"limit_bytes": MAX_REPLAY_REQUEST_BYTES},
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
        (
            "REPLAY_PRODUCT_V2_UNAVAILABLE"
            if REPLAY_SETTINGS.product_v2_available
            else "REPLAY_PRODUCT_V2_DISABLED"
        ),
        (
            "Replay training v2 runtime is unavailable"
            if REPLAY_SETTINGS.product_v2_available
            else "Replay training v2 is disabled"
        ),
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
    payload: TrainingRunCreatePayload,
) -> dict[str, object]:
    create_request = TrainingRunCreateRequest.from_dict(
        payload.model_dump(mode="json")
    )
    return await _training_service(request).create_run(create_request)


@router.post(
    "/runs/session/{session_id}/return-to-hub",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def return_replay_v2_run_to_hub(
    request: Request,
    session_id: str,
) -> dict[str, object]:
    return await _training_service(request).return_to_hub_by_session(session_id)


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
) -> dict[str, object]:
    return await _training_service(request).history_page(
        session_id,
        track_id=track_id,
        before_ms=before_ms,
        revealed_boundary_ms=revealed_boundary_ms,
        limit=limit,
        data_epoch=data_epoch,
        history_epoch=history_epoch,
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


@router.post(
    "/runs/{legacy_session_id}/migrate",
    dependencies=[Depends(_training_service), Depends(enforce_replay_request_limit)],
)
async def migrate_legacy_replay_v2_run(
    request: Request,
    legacy_session_id: str,
    payload: TrainingRunMigrationPayload,
) -> Response:
    result = await _training_service(request).migrate_legacy(
        legacy_session_id,
        name=payload.name,
    )
    return JSONResponse(status_code=201 if result["created"] else 200, content=result)


@router.get("/runs/{run_id}/viewer")
async def replay_v2_training_viewer(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    viewer = await _training_service(request).get_viewer_state(run_id)
    return {"protocol": REPLAY_V2_PROTOCOL, "viewer_state": viewer}


@router.get("/runs/{run_id}/tracks")
async def replay_v2_training_tracks(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).get_market_tracks(run_id)


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


@router.get("/runs/{run_id}/integrity")
async def replay_v2_training_integrity(
    request: Request,
    run_id: str,
) -> dict[str, object]:
    return await _training_service(request).integrity(run_id)


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


@router.get("/catalog")
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


@router.post(
    "/sessions",
    status_code=201,
    dependencies=[Depends(enforce_replay_request_limit)],
)
async def create_replay_session(
    request: Request,
    payload: ReplaySessionCreatePayload,
) -> dict[str, object]:
    config = ReplaySessionConfig.from_dict(payload.model_dump(mode="json"))
    return await _service(request).create_session(config)


@router.get("/sessions/{session_id}")
async def get_replay_session(request: Request, session_id: str) -> dict[str, object]:
    return await _service(request).get_session(_session_id(session_id))


@router.post(
    "/sessions/{session_id}/commands",
    dependencies=[Depends(enforce_replay_request_limit)],
)
async def command_replay_session(
    request: Request,
    session_id: str,
    payload: ReplayCommandPayload,
) -> dict[str, object]:
    command = ReplayCommand.from_dict(payload.model_dump(mode="json"))
    return await _service(request).command(_session_id(session_id), command)


@router.post("/sessions/{session_id}/fork", status_code=201)
async def fork_replay_session(request: Request, session_id: str) -> dict[str, object]:
    return await _service(request).fork_session(_session_id(session_id))


@router.get("/sessions/{session_id}/report")
async def replay_session_report(request: Request, session_id: str) -> dict[str, object]:
    return await _service(request).report(_session_id(session_id))


@router.get("/sessions/{session_id}/journal")
async def replay_session_journal(
    request: Request, session_id: str
) -> dict[str, object]:
    return await _service(request).journal(_session_id(session_id))


__all__ = [
    "MAX_REPLAY_REQUEST_BYTES",
    "ReplayCommandPayload",
    "ReplayV2CommandPayload",
    "ReplaySessionCreatePayload",
    "TrainingRunCreatePayload",
    "TrainingRunMigrationPayload",
    "replay_error_payload",
    "replay_v2_unavailable_payload",
    "replay_service_from_state",
    "router",
]
