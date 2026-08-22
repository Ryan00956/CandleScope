from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from candlescope_plugin_sdk import (
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    Bar,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    LanguageDescriptor,
    LinePoint,
    LineSeries,
    RenderOutput,
    RuntimeDescriptor,
)

from app.indicator.runtime_routes import (
    IndicatorRuntimeRoute,
    IndicatorRuntimeRoutes,
    IndicatorRuntimeRoutesError,
)
from app.indicator.runtime_service import (
    IndicatorRuntimeRequest,
    IndicatorRuntimeService,
    build_indicator_runtime_service_from_environment,
)
from app.plugin_runtime.errors import PluginTransportError


def _descriptor(
    *,
    languages: tuple[str, ...] = ("pyne",),
    features: tuple[str, ...] = (
        FEATURE_BATCH_EXECUTION_V1,
        FEATURE_RENDER_LINE_SERIES_V1,
    ),
) -> RuntimeDescriptor:
    return RuntimeDescriptor(
        id="pyne.runtime",
        name="Pyne Test Runtime",
        version="1.0.0",
        package="pyne-test-runtime",
        languages=tuple(
            LanguageDescriptor(id=item, name=item.title()) for item in languages
        ),
        features=features,
        required_host_features=(),
    )


def _result(value: float = 2.0) -> ExecuteBatchResult:
    return ExecuteBatchResult(
        ok=True,
        output=RenderOutput(
            series=(
                LineSeries(
                    id="value",
                    title="Value",
                    points=(LinePoint(time=1, value=value),),
                ),
            ),
        ),
    )


@dataclass
class _Host:
    runtime_descriptor: RuntimeDescriptor = field(default_factory=_descriptor)
    result: ExecuteBatchResult = field(default_factory=_result)
    gate: asyncio.Event | None = None
    error: Exception | None = None
    descriptor_error: Exception | None = None
    requests: list[tuple[str, ExecuteBatchRequest]] = field(default_factory=list)
    cancelled: int = 0

    async def descriptor(self, runtime_id: str) -> RuntimeDescriptor:
        assert runtime_id == "pyne.runtime"
        if self.descriptor_error is not None:
            raise self.descriptor_error
        return self.runtime_descriptor

    async def execute_batch(
        self,
        runtime_id: str,
        request: ExecuteBatchRequest,
    ) -> ExecuteBatchResult:
        self.requests.append((runtime_id, request))
        if self.gate is not None:
            try:
                await self.gate.wait()
            except asyncio.CancelledError:
                self.cancelled += 1
                raise
        if self.error is not None:
            raise self.error
        return self.result


def _routes(mode: str) -> IndicatorRuntimeRoutes:
    return IndicatorRuntimeRoutes(
        (
            IndicatorRuntimeRoute(
                language="pyne",
                mode=mode,
                runtime_id=("pyne.runtime" if mode != "legacy" else None),
            ),
        )
    )


def _request(*, transport: str = "http.compute") -> IndicatorRuntimeRequest:
    return IndicatorRuntimeRequest(
        language="pyne",
        source="plot(close)",
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        bars=(
            {
                "time": 1,
                "open": 1,
                "high": 2,
                "low": 0.5,
                "close": 1.5,
                "volume": 10,
                "is_closed": False,
            },
        ),
        params={"length": 2},
        options={"securityMode": "safe"},
        transport=transport,
    )


def test_diagnostics_do_not_expose_the_route_file_path(tmp_path: Path) -> None:
    routes = IndicatorRuntimeRoutes(
        (IndicatorRuntimeRoute(language="pyne", mode="legacy"),),
        source=tmp_path / "private" / "routes.json",
    )

    snapshot = IndicatorRuntimeService(routes).snapshot()

    assert snapshot["source"] == "configured-file"
    assert str(tmp_path) not in str(snapshot)


@pytest.mark.anyio
async def test_legacy_route_never_touches_plugin_host() -> None:
    host = _Host()
    service = IndicatorRuntimeService(_routes("legacy"), host=host)
    payload = {"ok": True, "lines": [{"id": "legacy"}]}

    async def legacy() -> dict[str, Any]:
        return payload

    actual = await service.execute(
        _request(),
        legacy=legacy,
        adapt_sidecar=lambda result: {"ok": result.ok},
    )

    assert actual is payload
    assert host.requests == []
    assert service.snapshot()["counts"]["legacy"] == 1


@pytest.mark.anyio
async def test_sidecar_route_uses_typed_request_and_never_calls_legacy() -> None:
    host = _Host()
    service = IndicatorRuntimeService(_routes("sidecar"), host=host)
    legacy_called = False

    async def legacy() -> dict[str, Any]:
        nonlocal legacy_called
        legacy_called = True
        return {"ok": True, "backend": "legacy"}

    actual = await service.execute(
        _request(),
        legacy=legacy,
        adapt_sidecar=lambda result: {
            "ok": result.ok,
            "backend": "sidecar",
        },
    )

    assert actual == {"ok": True, "backend": "sidecar"}
    assert legacy_called is False
    runtime_id, request = host.requests[0]
    assert runtime_id == "pyne.runtime"
    assert request.context.to_wire() == {
        "exchange": "binance",
        "marketType": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
    }
    assert request.bars == (Bar(1, 1, 2, 0.5, 1.5, 10, is_closed=False),)
    assert request.params == {"length": 2}
    assert request.options == {"securityMode": "safe"}


@pytest.mark.anyio
async def test_shadow_returns_legacy_without_waiting_and_records_match() -> None:
    gate = asyncio.Event()
    host = _Host(gate=gate)
    service = IndicatorRuntimeService(_routes("shadow"), host=host)
    legacy_payload = {"ok": True, "lines": [{"value": 2.0}]}

    async def legacy() -> dict[str, Any]:
        return legacy_payload

    actual = await asyncio.wait_for(
        service.execute(
            _request(transport="websocket.snapshot"),
            legacy=legacy,
            adapt_sidecar=lambda result: {
                "ok": result.ok,
                "lines": [{"value": result.output.series[0].points[0].value}],
            },
        ),
        timeout=0.2,
    )

    assert actual is legacy_payload
    assert service.snapshot()["recent"] == []
    legacy_payload["dataRevision"] = {"serverEpoch": "after-service-return"}
    gate.set()
    await service.drain_shadow()
    snapshot = service.snapshot()
    assert snapshot["counts"]["shadow"] == 1
    assert snapshot["counts"]["shadowMatched"] == 1
    assert snapshot["recent"][-1]["status"] == "matched"
    assert "source" not in snapshot["recent"][-1]
    assert "bars" not in snapshot["recent"][-1]


@pytest.mark.anyio
async def test_shadow_capacity_is_bounded_and_skips_extra_sidecar_work() -> None:
    gate = asyncio.Event()
    host = _Host(gate=gate)
    service = IndicatorRuntimeService(
        _routes("shadow"),
        host=host,
        max_pending_shadow_tasks=1,
    )
    legacy_payload = {"ok": True, "backend": "legacy"}

    async def legacy() -> dict[str, Any]:
        return legacy_payload

    first = await service.execute(
        _request(transport="websocket.snapshot"),
        legacy=legacy,
        adapt_sidecar=lambda result: {"ok": result.ok, "backend": "sidecar"},
    )
    second = await service.execute(
        _request(transport="websocket.snapshot"),
        legacy=legacy,
        adapt_sidecar=lambda result: {"ok": result.ok, "backend": "sidecar"},
    )

    assert first is legacy_payload
    assert second is legacy_payload
    assert len(host.requests) == 1
    snapshot = service.snapshot()
    assert snapshot["pendingShadow"] == 1
    assert snapshot["maxPendingShadow"] == 1
    assert snapshot["counts"]["shadow"] == 2
    assert snapshot["counts"]["shadowSkipped"] == 1
    assert snapshot["recent"][-1]["status"] == "skipped_capacity"

    gate.set()
    await service.drain_shadow()
    assert service.snapshot()["pendingShadow"] == 0


@pytest.mark.anyio
async def test_stop_cancels_pending_shadow_and_releases_capacity() -> None:
    gate = asyncio.Event()
    host = _Host(gate=gate)
    service = IndicatorRuntimeService(
        _routes("shadow"),
        host=host,
        max_pending_shadow_tasks=1,
    )

    async def legacy() -> dict[str, Any]:
        return {"ok": True, "backend": "legacy"}

    await service.execute(
        _request(),
        legacy=legacy,
        adapt_sidecar=lambda result: {"ok": result.ok},
    )
    assert service.snapshot()["pendingShadow"] == 1

    await service.stop()

    assert service.snapshot()["pendingShadow"] == 0
    assert host.cancelled == 1


@pytest.mark.anyio
async def test_shadow_legacy_failure_cancels_sidecar_and_releases_capacity() -> None:
    gate = asyncio.Event()
    host = _Host(gate=gate)
    service = IndicatorRuntimeService(
        _routes("shadow"),
        host=host,
        max_pending_shadow_tasks=1,
    )

    async def legacy() -> dict[str, Any]:
        raise RuntimeError("legacy failed")

    with pytest.raises(RuntimeError, match="legacy failed"):
        await service.execute(
            _request(),
            legacy=legacy,
            adapt_sidecar=lambda result: {"ok": result.ok},
        )

    assert service.snapshot()["pendingShadow"] == 0
    assert host.cancelled == 1


@pytest.mark.anyio
async def test_shadow_mismatch_and_host_error_never_change_legacy_payload() -> None:
    mismatch = IndicatorRuntimeService(_routes("shadow"), host=_Host())
    legacy_payload = {"ok": True, "value": "legacy"}

    async def legacy() -> dict[str, Any]:
        return legacy_payload

    assert (
        await mismatch.execute(
            _request(),
            legacy=legacy,
            adapt_sidecar=lambda result: {"ok": True, "value": "sidecar"},
        )
        is legacy_payload
    )
    await mismatch.drain_shadow()
    mismatch_snapshot = mismatch.snapshot()
    assert mismatch_snapshot["counts"]["shadowMismatched"] == 1
    assert mismatch_snapshot["recent"][-1]["differingFields"] == ["value"]

    failing_host = _Host(
        error=PluginTransportError(
            code="PLUGIN_PROCESS_EXITED",
            message="private stderr and path",
            runtime_id="pyne.runtime",
        )
    )
    failing = IndicatorRuntimeService(_routes("shadow"), host=failing_host)
    assert (
        await failing.execute(
            _request(),
            legacy=legacy,
            adapt_sidecar=lambda result: {"ok": result.ok},
        )
        is legacy_payload
    )
    await failing.drain_shadow()
    failure_snapshot = failing.snapshot()
    assert failure_snapshot["counts"]["sidecarErrors"] == 1
    assert failure_snapshot["recent"][-1]["causeCode"] == "PLUGIN_PROCESS_EXITED"
    assert "private stderr" not in str(failure_snapshot)


@pytest.mark.anyio
async def test_sidecar_failure_is_public_and_does_not_fallback() -> None:
    host = _Host(
        error=PluginTransportError(
            code="PLUGIN_REQUEST_TIMEOUT",
            message="secret process detail",
            runtime_id="pyne.runtime",
        )
    )
    service = IndicatorRuntimeService(_routes("sidecar"), host=host)

    async def legacy() -> dict[str, Any]:
        raise AssertionError("sidecar must not invoke legacy")

    payload = await service.execute(
        _request(),
        legacy=legacy,
        adapt_sidecar=lambda result: {"ok": result.ok},
    )

    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RUNTIME_UNAVAILABLE"
    assert "secret process detail" not in str(payload)
    assert "_runtimeCause" not in payload
    assert service.snapshot()["counts"]["sidecarErrors"] == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    "descriptor, cause_code",
    [
        (_descriptor(languages=("pine",)), "INDICATOR_RUNTIME_LANGUAGE_UNDECLARED"),
        (
            _descriptor(features=(FEATURE_BATCH_EXECUTION_V1,)),
            "INDICATOR_RUNTIME_FEATURES_MISSING",
        ),
    ],
)
async def test_route_descriptor_mismatch_is_unavailable_before_execution(
    descriptor: RuntimeDescriptor,
    cause_code: str,
) -> None:
    host = _Host(runtime_descriptor=descriptor)
    service = IndicatorRuntimeService(_routes("sidecar"), host=host)
    await service.start()
    snapshot = service.snapshot()
    assert snapshot["started"] is True
    assert snapshot["unavailable"] == [
        {
            "language": "pyne",
            "runtimeId": "pyne.runtime",
            "causeCode": cause_code,
        }
    ]
    catalog = await service.public_catalog()
    assert catalog["languages"][0]["available"] is False
    assert catalog["runtimes"] == []

    async def legacy() -> dict[str, Any]:
        raise AssertionError("sidecar must not invoke legacy")

    payload = await service.execute(
        _request(),
        legacy=legacy,
        adapt_sidecar=lambda result: {"ok": result.ok, "backend": "sidecar"},
    )
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RUNTIME_UNAVAILABLE"
    assert host.requests == []


@pytest.mark.anyio
async def test_public_catalog_is_descriptor_and_route_driven() -> None:
    descriptor = RuntimeDescriptor(
        id="pyne.runtime",
        name="Community Multi Runtime",
        version="1.2.3",
        package="community-multi-runtime",
        languages=(
            LanguageDescriptor(
                id="pyne",
                name="Pyne",
                extensions=(".pyne",),
                aliases=("pyne",),
            ),
            LanguageDescriptor(
                id="community-lang",
                name="Community Lang",
                extensions=(".community",),
                aliases=("community",),
            ),
        ),
        features=(
            FEATURE_BATCH_EXECUTION_V1,
            FEATURE_RENDER_LINE_SERIES_V1,
        ),
        required_host_features=(FEATURE_BATCH_EXECUTION_V1,),
        meta={"ui": {"languages": {"community-lang": {"monacoLanguage": "plaintext"}}}},
    )
    routes = IndicatorRuntimeRoutes(
        (
            IndicatorRuntimeRoute(
                language="pyne",
                mode="sidecar",
                runtime_id="pyne.runtime",
            ),
            IndicatorRuntimeRoute(
                language="community-lang",
                mode="sidecar",
                runtime_id="pyne.runtime",
            ),
        )
    )
    service = IndicatorRuntimeService(routes, host=_Host(runtime_descriptor=descriptor))

    catalog = await service.public_catalog()

    assert catalog == {
        "schemaVersion": 1,
        "defaultLanguage": "pyne",
        "languages": [
            {
                "id": "pyne",
                "name": "Pyne",
                "extensions": [".pyne"],
                "aliases": ["pyne"],
                "runtimeId": "pyne.runtime",
                "routeMode": "sidecar",
                "available": True,
                "features": [
                    FEATURE_BATCH_EXECUTION_V1,
                    FEATURE_RENDER_LINE_SERIES_V1,
                ],
            },
            {
                "id": "community-lang",
                "name": "Community Lang",
                "extensions": [".community"],
                "aliases": ["community"],
                "runtimeId": "pyne.runtime",
                "routeMode": "sidecar",
                "available": True,
                "features": [
                    FEATURE_BATCH_EXECUTION_V1,
                    FEATURE_RENDER_LINE_SERIES_V1,
                ],
            },
        ],
        "runtimes": [descriptor.to_wire()],
    }
    assert "source" not in str(catalog)
    assert "command" not in str(catalog)
    assert "pid" not in str(catalog)


@pytest.mark.anyio
async def test_public_catalog_sanitizes_plugin_host_start_failure() -> None:
    service = IndicatorRuntimeService(
        _routes("sidecar"),
        host=_Host(
            descriptor_error=PluginTransportError(
                code="PLUGIN_PROCESS_EXITED",
                message="private stderr and executable path",
                runtime_id="pyne.runtime",
            )
        ),
    )

    catalog = await service.public_catalog()

    assert catalog["languages"] == [
        {
            "id": "pyne",
            "name": "pyne",
            "extensions": [],
            "aliases": [],
            "runtimeId": "pyne.runtime",
            "routeMode": "sidecar",
            "available": False,
            "features": [],
        }
    ]
    assert catalog["runtimes"] == []
    assert "private stderr" not in str(catalog)
    assert "executable path" not in str(catalog)


@pytest.mark.anyio
async def test_language_without_legacy_adapter_must_use_sidecar() -> None:
    routes = IndicatorRuntimeRoutes(
        (
            IndicatorRuntimeRoute(language="pyne", mode="legacy"),
            IndicatorRuntimeRoute(
                language="pine",
                mode="shadow",
                runtime_id="pyne.runtime",
            ),
        )
    )
    service = IndicatorRuntimeService(
        routes,
        host=_Host(runtime_descriptor=_descriptor(languages=("pine",))),
    )

    with pytest.raises(IndicatorRuntimeRoutesError, match="no legacy adapter"):
        await service.start()


def test_product_runtime_service_exposes_no_in_process_language_adapter(
    tmp_path: Path,
) -> None:
    service = build_indicator_runtime_service_from_environment(
        host=_Host(),
        environ={"LOCALAPPDATA": str(tmp_path)},
    )

    assert service.legacy_languages == frozenset()
    assert service.route_for("pyne").mode == "sidecar"


@pytest.mark.anyio
async def test_missing_plugin_host_starts_degraded_and_keeps_sidecar_fail_closed() -> None:
    service = IndicatorRuntimeService(_routes("sidecar"), host=None)
    await service.start()
    catalog = await service.public_catalog()
    assert catalog["languages"][0]["available"] is False
    assert service.snapshot()["unavailable"][0]["causeCode"] == "PLUGIN_HOST_UNAVAILABLE"

    async def legacy() -> dict[str, Any]:
        raise AssertionError("sidecar must not invoke legacy")

    payload = await service.execute(
        _request(),
        legacy=legacy,
        adapt_sidecar=lambda result: {"ok": True},
    )
    assert payload["ok"] is False
    assert payload["code"] == "INDICATOR_RUNTIME_UNAVAILABLE"
