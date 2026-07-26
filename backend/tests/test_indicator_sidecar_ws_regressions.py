from __future__ import annotations

import asyncio
from collections import OrderedDict
from types import SimpleNamespace
from typing import Any, Callable

import pytest
from candlescope_plugin_sdk import (
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    LanguageDescriptor,
    LinePoint,
    LineSeries,
    RenderOutput,
    RuntimeDescriptor,
)

from app.api.v1 import stream_indicators as stream_api
from app.api.v1 import stream_pyne_subscriptions as pyne_stream_api
from app.data_engine.data_manager.models import BarData, DataEventType
from app.indicator.runtime_routes import (
    IndicatorRuntimeRoute,
    IndicatorRuntimeRoutes,
)
from app.indicator.runtime_service import IndicatorRuntimeService


def _bars(times: list[int]) -> list[BarData]:
    return [
        BarData(
            time=time,
            open=100 + index,
            high=102 + index,
            low=99 + index,
            close=101 + index,
            volume=10 + index,
            is_closed=True,
        )
        for index, time in enumerate(times)
    ]


class _RecordingSidecarHost:
    def __init__(self, *, blocked_calls: set[int] | None = None) -> None:
        self.requests: list[ExecuteBatchRequest] = []
        self.blocked_calls = set(blocked_calls or ())
        self.started: asyncio.Queue[int] = asyncio.Queue()
        self.releases = {
            call_index: asyncio.Event() for call_index in self.blocked_calls
        }

    async def descriptor(self, runtime_id: str) -> RuntimeDescriptor:
        assert runtime_id == "test.pyne"
        return RuntimeDescriptor(
            id="test.pyne",
            name="Test Pyne",
            version="1.0.0",
            package="test-pyne",
            languages=(LanguageDescriptor(id="pyne", name="Pyne"),),
            features=(
                FEATURE_BATCH_EXECUTION_V1,
                FEATURE_RENDER_LINE_SERIES_V1,
            ),
            required_host_features=(),
        )

    async def execute_batch(
        self,
        runtime_id: str,
        request: ExecuteBatchRequest,
    ) -> ExecuteBatchResult:
        assert runtime_id == "test.pyne"
        call_index = len(self.requests)
        self.requests.append(request)
        if call_index in self.blocked_calls:
            self.started.put_nowait(call_index)
            await self.releases[call_index].wait()
        return ExecuteBatchResult(
            ok=True,
            output=RenderOutput(
                series=(
                    LineSeries(
                        id="close",
                        title="Close",
                        pane="main",
                        style={"color": "#22c55e", "lineWidth": 1},
                        points=tuple(
                            LinePoint(time=bar.time, value=bar.close)
                            for bar in request.bars
                        ),
                    ),
                ),
                meta={"title": "Sidecar", "overlay": True},
            ),
        )


def _sidecar_service(
    host: _RecordingSidecarHost,
) -> IndicatorRuntimeService:
    return IndicatorRuntimeService(
        IndicatorRuntimeRoutes(
            (
                IndicatorRuntimeRoute(
                    language="pyne",
                    mode="sidecar",
                    runtime_id="test.pyne",
                ),
            )
        ),
        host=host,
    )


class _RecordingDataManager:
    def __init__(
        self,
        bars: list[BarData],
        *,
        query_hook: Callable[[int, "_RecordingDataManager"], list[BarData]]
        | None = None,
    ) -> None:
        self.bars = list(bars)
        self.query_hook = query_hook
        self.query_calls: list[dict[str, Any]] = []
        self.subscriptions: list[dict[str, Any]] = []
        self.unsubscribed: list[str] = []
        self.ensure_stream_calls: list[dict[str, Any]] = []
        self.release_stream_calls: list[dict[str, Any]] = []

    async def ensure_stream(self, *args: Any, **kwargs: Any) -> None:
        self.ensure_stream_calls.append({"args": args, "kwargs": dict(kwargs)})

    async def release_stream(self, *args: Any, **kwargs: Any) -> None:
        self.release_stream_calls.append({"args": args, "kwargs": dict(kwargs)})

    def query_latest(self, *args: Any, **kwargs: Any) -> SimpleNamespace:
        self.query_calls.append({"args": args, "kwargs": dict(kwargs)})
        call_number = len(self.query_calls)
        bars = (
            self.query_hook(call_number, self)
            if self.query_hook is not None
            else self.bars
        )
        return SimpleNamespace(
            bars=list(bars),
            missing_ranges=[],
            retryable=False,
            complete=True,
        )

    def subscribe(self, **kwargs: Any) -> str:
        handle = f"handle-{len(self.subscriptions) + 1}"
        self.subscriptions.append({"handle": handle, **kwargs})
        return handle

    def unsubscribe(self, handle: str) -> None:
        self.unsubscribed.append(handle)


class _RevisionService:
    def __init__(self, *, closed_through: int) -> None:
        self.closed_through = closed_through
        self.revision = 0
        self.correction_calls: list[dict[str, Any]] = []
        self.put_calls: list[dict[str, Any]] = []

    def data_revision_for_meta(self, _meta: dict[str, Any]) -> dict[str, Any]:
        return {
            "serverEpoch": "sidecar-test",
            "correctionRevision": self.revision,
            "closedThrough": self.closed_through,
            "revisionToken": f"sidecar-test:{self.revision}",
        }

    def note_correction(self, **kwargs: Any) -> dict[str, Any]:
        self.revision += 1
        self.correction_calls.append(dict(kwargs))
        return {
            **self.data_revision_for_meta({}),
            "dirtyRange": {
                "start": int(kwargs["start"]),
                "end": int(kwargs["end"]),
            },
        }

    def put_payload(
        self,
        _meta: dict[str, Any],
        _payload: dict[str, Any],
        *,
        start: int,
        end: int,
        revision_token: str,
    ) -> None:
        self.put_calls.append(
            {
                "start": start,
                "end": end,
                "revision_token": revision_token,
            }
        )


class _SidecarConnection:
    def __init__(
        self,
        *,
        dm: _RecordingDataManager,
        service: IndicatorRuntimeService,
        range_service: _RevisionService | None = None,
        coordinator: Any | None = None,
    ) -> None:
        self.dm = dm
        self.service = service
        self.range_service = range_service
        self.coordinator = coordinator
        self.custom_handles: dict[str, Any] = {}
        self.custom_tasks: dict[str, asyncio.Task[Any]] = {}
        self.client_meta: dict[str, dict[str, Any]] = {}
        self.correction_state: dict[str, Any] = {
            "handle": None,
            "callbacks": {},
            "snapshot_tasks": OrderedDict(),
        }
        self.seed_query_cache: dict[tuple[str, str, str, str, int], dict] = {}
        self.sent: list[dict[str, Any]] = []
        self.droppable: list[dict[str, Any]] = []
        self.critical: list[dict[str, Any]] = []
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def send_json(self, payload: dict[str, Any]) -> bool:
        self.sent.append(payload)
        return True

    def queue_message(
        self,
        _queue: asyncio.Queue[dict[str, Any]],
        payload: dict[str, Any],
    ) -> None:
        self.droppable.append(payload)

    async def queue_critical_message(
        self,
        _queue: asyncio.Queue[dict[str, Any]],
        payload: dict[str, Any],
    ) -> None:
        self.critical.append(payload)

    async def unsubscribe(self, client_id: str) -> None:
        await stream_api._unsubscribe_indicator_client(
            client_id,
            dm=self.dm,
            indicator_engine=None,
            subscribed={},
            custom_handles=self.custom_handles,
            custom_tasks=self.custom_tasks,
            client_meta=self.client_meta,
        )

    async def subscribe(
        self,
        client_id: str,
        *,
        interval: str = "3m",
        history_limit: int = 100,
    ) -> None:
        data_revision = (
            self.range_service.data_revision_for_meta({})
            if self.range_service is not None
            else None
        )
        await pyne_stream_api.handle_pyne_indicator_subscribe(
            dm=self.dm,
            custom_handles=self.custom_handles,
            custom_tasks=self.custom_tasks,
            queue=self.queue,
            client_meta=self.client_meta,
            client_id=client_id,
            symbol="BTCUSDT",
            interval=interval,
            exchange="binance",
            market_type="spot",
            name=client_id,
            custom_id="",
            script='plot(close, title="Close")',
            params={},
            security_mode="safe",
            history_limit=history_limit,
            send_json=self.send_json,
            stream_consumer_id=f"consumer-{client_id}",
            unsubscribe_client=self.unsubscribe,
            queue_message=self.queue_message,
            queue_critical_message=self.queue_critical_message,
            range_service=self.range_service,
            backfill_coordinator=self.coordinator,
            data_revision=data_revision,
            runtime_service=self.service,
            pyne_correction_state=self.correction_state,
            seed_query_cache=self.seed_query_cache,
        )

    def realtime_callback(self) -> Any:
        return next(
            item["callback"] for item in self.dm.subscriptions if "symbol" in item
        )

    def correction_callback(self) -> Any:
        return next(
            item["callback"] for item in self.dm.subscriptions if "symbol" not in item
        )


def _backfill_event(
    *,
    request_id: str,
    interval: str,
    request_start: int,
    request_end: int,
    earliest: int | None = None,
    latest: int | None = None,
    derived_repair_targets: list[dict[str, Any]] | None = None,
) -> SimpleNamespace:
    detail: dict[str, Any] = {
        "request_id": request_id,
        "bars_count": 2,
        "request_start_ms": request_start * 1000,
        "request_end_ms": request_end * 1000,
        "range_start_ms": (earliest if earliest is not None else request_start) * 1000,
        "range_end_ms": (latest if latest is not None else request_end) * 1000,
    }
    if earliest is not None:
        detail["earliest"] = earliest
    if latest is not None:
        detail["latest"] = latest
    if derived_repair_targets is not None:
        detail["derived_repair_targets"] = derived_repair_targets
    return SimpleNamespace(
        event_type=DataEventType.BACKFILL_COMPLETED,
        key=SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval=interval,
        ),
        detail=detail,
        timestamp_ms=request_end * 1000,
    )


def _amendment_event(*, interval: str, time: int) -> SimpleNamespace:
    return SimpleNamespace(
        event_type=DataEventType.BAR_AMENDED,
        key=SimpleNamespace(
            exchange="binance",
            market_type="spot",
            symbol="BTCUSDT",
            interval=interval,
        ),
        bar=SimpleNamespace(time=time),
        detail={},
        timestamp_ms=time * 1000,
    )


def _realtime_event(event_type: DataEventType, bar: BarData) -> SimpleNamespace:
    return SimpleNamespace(event_type=event_type, bar=bar)


@pytest.mark.anyio
async def test_sidecar_ws_subscription_replaces_incremental_seed_with_read_only_handoff() -> (
    None
):
    dm = _RecordingDataManager(_bars([300, 480, 660]))
    host = _RecordingSidecarHost()
    connection = _SidecarConnection(dm=dm, service=_sidecar_service(host))

    await connection.subscribe("read-only-seed")

    acknowledgement = connection.sent[0]
    assert acknowledgement["type"] == "indicator.subscribed"
    assert acknowledgement["seeded"] is False
    assert acknowledgement["seedBars"] == 0
    assert dm.query_calls == []
    assert host.requests == []
    assert dm.ensure_stream_calls[0]["kwargs"]["consumer_id"] == (
        "consumer-read-only-seed"
    )

    preview = BarData(
        time=840,
        open=103,
        high=105,
        low=102,
        close=104,
        volume=13,
        is_closed=False,
    )
    dm.bars.append(preview)
    await connection.realtime_callback()(
        _realtime_event(DataEventType.BAR_UPDATED, preview)
    )
    await connection.custom_tasks["read-only-seed"]

    assert len(dm.query_calls) == 1
    assert dm.query_calls[0]["kwargs"]["auto_backfill"] is False
    assert len(host.requests) == 1
    assert host.requests[0].context.interval == "3m"
    assert connection.droppable[0]["range"] == {"start": 840, "end": 840}


@pytest.mark.anyio
async def test_sidecar_correction_burst_uses_parent_barriers_and_bounded_flushes() -> (
    None
):
    class BarrierCoordinator:
        def __init__(self) -> None:
            self.releases = {
                "parent-a": asyncio.Event(),
                "parent-b": asyncio.Event(),
            }
            self.started: asyncio.Queue[str] = asyncio.Queue()
            self.wait_calls: list[str] = []

        async def wait_for_request(self, request_id: str) -> SimpleNamespace:
            self.wait_calls.append(request_id)
            self.started.put_nowait(request_id)
            await self.releases[request_id].wait()
            return SimpleNamespace(
                bars_loaded=4,
                verified_contiguous=True,
                retryable=False,
            )

    coordinator = BarrierCoordinator()
    dm = _RecordingDataManager(_bars([180, 360, 540, 720]))
    host = _RecordingSidecarHost()
    revisions = _RevisionService(closed_through=720)
    connection = _SidecarConnection(
        dm=dm,
        service=_sidecar_service(host),
        range_service=revisions,
        coordinator=coordinator,
    )
    await connection.subscribe("burst", interval="3m")
    callback = connection.correction_callback()

    first_chunk = _backfill_event(
        request_id="parent-a",
        interval="3m",
        request_start=180,
        request_end=720,
        earliest=180,
        latest=360,
    )
    second_chunk = _backfill_event(
        request_id="parent-a",
        interval="3m",
        request_start=180,
        request_end=720,
        earliest=540,
        latest=720,
    )
    await callback(first_chunk)
    assert await asyncio.wait_for(coordinator.started.get(), timeout=1) == "parent-a"
    await callback(second_chunk)

    assert coordinator.wait_calls == ["parent-a"]
    assert len(revisions.correction_calls) == 1
    assert host.requests == []

    next_parent = _backfill_event(
        request_id="parent-b",
        interval="3m",
        request_start=1_200,
        request_end=1_800,
    )
    await callback(next_parent)
    await callback(_amendment_event(interval="3m", time=900))
    await callback(_amendment_event(interval="3m", time=2_100))

    assert len(revisions.correction_calls) == 4
    coordinator.releases["parent-a"].set()
    assert await asyncio.wait_for(coordinator.started.get(), timeout=1) == "parent-b"
    assert coordinator.wait_calls == ["parent-a", "parent-b"]
    assert len(host.requests) == 1
    assert len(connection.critical) == 1

    coordinator.releases["parent-b"].set()
    await connection.custom_tasks["burst"]

    assert len(host.requests) == 2
    assert len(dm.query_calls) == 2
    assert [item["dirtyRange"] for item in connection.critical] == [
        {"start": 180, "end": 720},
        {"start": 900, "end": 2_100},
    ]
    assert connection.critical[-1]["dataRevision"]["correctionRevision"] == 4
    assert revisions.put_calls[-1] == {
        "start": 180,
        "end": 720,
        "revision_token": "sidecar-test:4",
    }

    await callback(second_chunk)
    await callback(next_parent)
    await asyncio.sleep(0)
    assert coordinator.wait_calls == ["parent-a", "parent-b"]
    assert len(host.requests) == 2
    assert len(connection.critical) == 2


@pytest.mark.anyio
async def test_sidecar_correction_seed_retries_closed_race_and_routes_derived_left() -> (
    None
):
    revisions = _RevisionService(closed_through=19_000)
    stale = _bars([10_000, 19_000])
    fresh = _bars([10_000, 20_000])

    def query_hook(
        call_number: int,
        _dm: _RecordingDataManager,
    ) -> list[BarData]:
        if call_number == 1:
            revisions.closed_through = 20_000
            return stale
        return fresh

    dm = _RecordingDataManager(stale, query_hook=query_hook)
    host = _RecordingSidecarHost()
    connection = _SidecarConnection(
        dm=dm,
        service=_sidecar_service(host),
        range_service=revisions,
    )
    await connection.subscribe("derived-89m", interval="89m", history_limit=2_000)
    callback = connection.correction_callback()

    await callback(_amendment_event(interval="89m", time=19_000))
    await connection.custom_tasks["derived-89m"]

    assert len(dm.query_calls) == 2
    assert [request.bars[-1].time for request in host.requests] == [
        19_000,
        20_000,
    ]
    assert connection.client_meta["derived-89m"]["seedRange"] == {
        "start": 10_000,
        "end": 20_000,
    }

    await callback(
        _backfill_event(
            request_id="base-to-89m",
            interval="1m",
            request_start=1_000,
            request_end=2_000,
            derived_repair_targets=[
                {
                    "interval": "89m",
                    "start_ms": 1_000_000,
                    "end_ms": 2_000_000,
                },
                {
                    "interval": "89m",
                    "start_ms": 3_000_000,
                    "end_ms": 4_000_000,
                },
            ],
        )
    )
    await connection.custom_tasks["derived-89m"]

    assert len(dm.query_calls) == 2
    assert len(host.requests) == 2
    assert revisions.correction_calls[-1] == {
        "series_key": "binance:spot:BTCUSDT:89m",
        "start": 1_000,
        "end": 4_000,
        "event_id": "backfill:base-to-89m:89m",
    }
    assert connection.critical[-1]["dirtyRange"] == {
        "start": 1_000,
        "end": 4_000,
    }

    await callback(_amendment_event(interval="1m", time=21_000))
    await connection.custom_tasks["derived-89m"]

    assert len(host.requests) == 3
    assert host.requests[-1].context.interval == "89m"
    assert revisions.correction_calls[-1]["series_key"] == ("binance:spot:BTCUSDT:89m")
    assert revisions.correction_calls[-1]["start"] == 16_020
    assert revisions.correction_calls[-1]["end"] == 16_020
    assert connection.critical[-1]["dirtyRange"] == {
        "start": 16_020,
        "end": 16_020,
    }


@pytest.mark.anyio
async def test_sidecar_connection_uses_one_correction_wildcard_for_many_clients() -> (
    None
):
    dm = _RecordingDataManager(_bars([300, 480, 660]))
    host = _RecordingSidecarHost()
    connection = _SidecarConnection(dm=dm, service=_sidecar_service(host))

    for index in range(7):
        await connection.subscribe(f"client-{index}", interval="89m")

    wildcard_subscriptions = [item for item in dm.subscriptions if "symbol" not in item]
    assert len(wildcard_subscriptions) == 1
    assert len(dm.subscriptions) == 8
    assert len(connection.correction_state["callbacks"]) == 7
    assert host.requests == []

    for index in range(7):
        await connection.unsubscribe(f"client-{index}")

    assert connection.correction_state["callbacks"] == {}
    assert connection.correction_state["handle"] is None
    assert wildcard_subscriptions[0]["handle"] in dm.unsubscribed
    assert len(dm.release_stream_calls) == 7


@pytest.mark.anyio
async def test_sidecar_correction_seed_query_is_shared_per_connection() -> None:
    dm = _RecordingDataManager(_bars([300, 480, 600]))
    host = _RecordingSidecarHost()
    revisions = _RevisionService(closed_through=600)
    connection = _SidecarConnection(
        dm=dm,
        service=_sidecar_service(host),
        range_service=revisions,
    )
    await connection.subscribe("shared-a")
    await connection.subscribe("shared-b")
    assert dm.query_calls == []

    callback = connection.correction_callback()
    await callback(_amendment_event(interval="3m", time=600))
    await asyncio.gather(*tuple(connection.custom_tasks.values()))

    assert len(dm.query_calls) == 1
    assert dm.query_calls[0]["kwargs"]["limit"] == 101
    assert dm.query_calls[0]["kwargs"]["auto_backfill"] is False
    assert len(host.requests) == 2
    assert {request.context.interval for request in host.requests} == {"3m"}

    await callback(_amendment_event(interval="3m", time=780))
    await asyncio.gather(*tuple(connection.custom_tasks.values()))

    assert len(dm.query_calls) == 2
    assert len(host.requests) == 4


@pytest.mark.anyio
async def test_sidecar_closed_finality_is_not_cancelled_by_following_preview() -> None:
    dm = _RecordingDataManager(_bars([300, 480, 780]))
    host = _RecordingSidecarHost(blocked_calls={0, 1})
    connection = _SidecarConnection(dm=dm, service=_sidecar_service(host))
    await connection.subscribe("finality")
    callback = connection.realtime_callback()

    await callback(_realtime_event(DataEventType.BAR_CLOSED, _bars([780])[0]))
    assert await asyncio.wait_for(host.started.get(), timeout=1) == 0
    await callback(
        _realtime_event(
            DataEventType.BAR_UPDATED,
            BarData(
                time=960,
                open=103,
                high=105,
                low=102,
                close=104,
                volume=13,
                is_closed=False,
            ),
        )
    )
    host.releases[0].set()
    await connection.custom_tasks["finality"]

    assert len(host.requests) == 1
    assert connection.droppable == []
    assert len(connection.critical) == 1
    assert connection.critical[0]["type"] == "indicator.patch"
    # The Phase 0 v1 wire freezes this reason; finality is carried by the
    # lossless queue selected from the authoritative input event type.
    assert connection.critical[0]["reason"] == "bar_update"
    assert connection.critical[0]["range"] == {"start": 780, "end": 780}

    await callback(_realtime_event(DataEventType.BAR_CLOSED, _bars([960])[0]))
    first_close_task = connection.custom_tasks["finality"]
    assert await asyncio.wait_for(host.started.get(), timeout=1) == 1
    await callback(_realtime_event(DataEventType.BAR_CLOSED, _bars([1_140])[0]))
    await connection.unsubscribe("finality")
    host.releases[1].set()
    await first_close_task

    assert len(host.requests) == 2
    assert len(connection.critical) == 1
    assert "finality" not in connection.custom_tasks


@pytest.mark.anyio
async def test_sidecar_correction_snapshot_absorbs_concurrent_close_once() -> None:
    revisions = _RevisionService(closed_through=600)
    dm = _RecordingDataManager(_bars([300, 480, 600]))
    host = _RecordingSidecarHost(blocked_calls={0})
    connection = _SidecarConnection(
        dm=dm,
        service=_sidecar_service(host),
        range_service=revisions,
    )
    await connection.subscribe("correction-close")
    correction_callback = connection.correction_callback()
    realtime_callback = connection.realtime_callback()

    await correction_callback(_amendment_event(interval="3m", time=300))
    correction_task = connection.custom_tasks["correction-close"]
    assert await asyncio.wait_for(host.started.get(), timeout=1) == 0

    closed = _bars([780])[0]
    dm.bars.append(closed)
    revisions.closed_through = 780
    await realtime_callback(_realtime_event(DataEventType.BAR_CLOSED, closed))
    host.releases[0].set()
    await correction_task
    await asyncio.sleep(0)

    assert len(dm.query_calls) == 2
    assert [request.bars[-1].time for request in host.requests] == [600, 780]
    assert len(host.requests) == 2
    assert connection.droppable == []
    assert len(connection.critical) == 1
    assert connection.critical[0]["type"] == "indicator.recomputed"
    assert connection.critical[0]["dirtyRange"] == {"start": 300, "end": 780}


@pytest.mark.anyio
async def test_sidecar_failed_correction_emits_retryable_invalidation() -> None:
    class FailedCoordinator:
        def __init__(self) -> None:
            self.calls = 0

        async def wait_for_request(self, _request_id: str) -> SimpleNamespace:
            self.calls += 1
            return SimpleNamespace(
                bars_loaded=0,
                verified_contiguous=False,
                retryable=True,
            )

    coordinator = FailedCoordinator()
    dm = _RecordingDataManager(_bars([300, 480, 600]))
    host = _RecordingSidecarHost()
    connection = _SidecarConnection(
        dm=dm,
        service=_sidecar_service(host),
        coordinator=coordinator,
    )
    await connection.subscribe("failed-correction")
    callback = connection.correction_callback()
    event = _backfill_event(
        request_id="failed-parent",
        interval="3m",
        request_start=300,
        request_end=600,
    )

    await callback(event)
    await connection.custom_tasks["failed-correction"]
    await callback(event)
    await connection.custom_tasks["failed-correction"]

    assert coordinator.calls == 2
    assert host.requests == []
    assert dm.query_calls == []
    assert len(connection.critical) == 2
    assert all(
        item["type"] == "indicator.recomputed"
        and item["ok"] is False
        and item["recomputed"] is False
        and item["invalidated"] is True
        and item["retryMode"] == "event"
        and item["reason"] == "backfill-invalidated"
        for item in connection.critical
    )
