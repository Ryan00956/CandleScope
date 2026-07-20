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


class ReplayAPIRoute(APIRoute):
    """Keep validation and domain failures on one replay.v1 wire contract."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                if request.method in {"POST", "PUT", "PATCH"}:
                    await enforce_replay_request_limit(request)
                return await original(request)
            except ReplayDomainError as exc:
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
    "ReplaySessionCreatePayload",
    "replay_error_payload",
    "replay_service_from_state",
    "router",
]
