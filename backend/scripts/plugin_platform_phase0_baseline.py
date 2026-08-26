"""Capture reproducible Plugin Platform v2 Phase 0 baselines.

This script is deliberately outside production startup. It exercises the
existing v1 contracts and real bounded components, writes one machine-readable
artifact, and never touches the user's normal plugin registry or CandleScope
databases.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, TypeVar


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPOSITORY_ROOT / "backend"
SDK_SOURCE = REPOSITORY_ROOT / "packages" / "candlescope-plugin-sdk" / "src"
SCRIPT_PATH = Path(__file__).resolve()
OFFICIAL_RELEASE_LOCK = (
    BACKEND_ROOT
    / "tests"
    / "fixtures"
    / "plugin_platform_v2"
    / "official-plugin-releases-phase0-v1.json"
)
CURRENT_OFFICIAL_RELEASE_LOCK = (
    BACKEND_ROOT / "app" / "official-plugin-releases.json"
)
SDK_TRANSCRIPT_FIXTURE = (
    REPOSITORY_ROOT
    / "packages"
    / "candlescope-plugin-sdk"
    / "tests"
    / "fixtures"
    / "hello_transcript_v1.json"
)
TRANSPORT_FIXTURE = (
    BACKEND_ROOT / "tests" / "fixtures" / "plugin_runtime" / "pyne_transport_v1.json"
)

SCHEMA_VERSION = "candlescope.plugin-platform.phase0-baseline.v1"
FROZEN_FILE_SHA256 = {
    "sdkTranscript": "sha256:dd217159ab14af660481610cef5c369edbde3e7577bcf78e85bfad16cab5cf9c",
    "indicatorTransport": "sha256:b0db39165b888522ec27055ac1bfaf949b65a34a5d42932728d37aa767d77a47",
    "officialReleaseLock": "sha256:23e03c28a32b42a0d523aefc0bd19db34d33fb840b41cbf44e0348fc263249f2",
}
CURRENT_OFFICIAL_RELEASE_LOCK_SHA256 = (
    "sha256:369c52cdd92a51f939bab295311715323cd6b6baf858ff1d6ff5691d0ea313d6"
)
FROZEN_WIRE_SHA256 = {
    "sdkTranscript": "sha256:021825fb264a63555e0eb331f24f6ea0632b0d2a0c962ef89a35673526391ba2",
    "httpCompute": "sha256:b2467295cc14ec0e772e97fce195f236739cecb260e967190d73af305ab6f7ee",
    "httpRange": "sha256:ba66866f0330d62f1121c3a5ff77d6339d786df796672c9795e78a293c1ebb26",
    "indicatorWebSocket": "sha256:6326a43822000618fe2feddcfe9b28b5a02e3663be106ef1dabfa511f6e418f2",
}

_T = TypeVar("_T")


class BaselineError(RuntimeError):
    """The current repository no longer matches the frozen Phase 0 contract."""


def _ensure_import_paths() -> None:
    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from plugin_sdk_isolation import pin_in_repo_plugin_sdk

    pin_in_repo_plugin_sdk(BACKEND_ROOT)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise BaselineError(f"expected a JSON object: {path.name}")
    return value


def frozen_contracts() -> dict[str, Any]:
    """Verify the immutable Phase 0 files and the current release lock."""

    files = {
        "sdkTranscript": SDK_TRANSCRIPT_FIXTURE,
        "indicatorTransport": TRANSPORT_FIXTURE,
        "officialReleaseLock": OFFICIAL_RELEASE_LOCK,
    }
    actual_files = {name: _sha256_file(path) for name, path in files.items()}
    if actual_files != FROZEN_FILE_SHA256:
        raise BaselineError(
            "Phase 0 fixture drift detected: "
            + json.dumps(
                {"expected": FROZEN_FILE_SHA256, "actual": actual_files},
                sort_keys=True,
            )
        )

    current_release_lock_sha256 = _sha256_file(CURRENT_OFFICIAL_RELEASE_LOCK)
    if current_release_lock_sha256 != CURRENT_OFFICIAL_RELEASE_LOCK_SHA256:
        raise BaselineError(
            "current official release lock drift detected: "
            f"expected={CURRENT_OFFICIAL_RELEASE_LOCK_SHA256} "
            f"actual={current_release_lock_sha256}"
        )

    sdk = _read_json(SDK_TRANSCRIPT_FIXTURE)
    transport = _read_json(TRANSPORT_FIXTURE)
    actual_wire = {
        "sdkTranscript": sdk["expected"]["transcriptSha256"],
        "httpCompute": transport["httpCompute"]["expected"]["canonicalSha256"],
        "httpRange": transport["httpRange"]["expected"]["canonicalSha256"],
        "indicatorWebSocket": transport["websocket"]["expected"]["canonicalSha256"],
    }
    if actual_wire != FROZEN_WIRE_SHA256:
        raise BaselineError(
            "Phase 0 wire hash drift detected: "
            + json.dumps(
                {"expected": FROZEN_WIRE_SHA256, "actual": actual_wire},
                sort_keys=True,
            )
        )
    return {
        "status": "verified",
        "fileSha256": actual_files,
        "currentOfficialReleaseLockSha256": current_release_lock_sha256,
        "wireSha256": actual_wire,
        "schemas": {
            "sdkTranscript": sdk.get("schemaVersion"),
            "indicatorTransport": transport.get("schemaVersion"),
        },
    }


def _run_text(command: list[str], *, cwd: Path = REPOSITORY_ROOT) -> str | None:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = completed.stdout.strip()
    return value or None


def _git_metadata() -> dict[str, Any]:
    return {
        "head": _run_text(["git", "rev-parse", "HEAD"]),
        "branch": _run_text(["git", "branch", "--show-current"]),
    }


def _distribution_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def environment_metadata(browser: str | None) -> dict[str, Any]:
    return {
        "system": platform.system(),
        "release": platform.release(),
        "version": platform.version(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "pythonImplementation": platform.python_implementation(),
        "node": _run_text(["node", "--version"]),
        "browser": browser,
        "cpuCount": os.cpu_count(),
        "dependencies": {
            "fastapi": _distribution_version("fastapi"),
            "pytest": _distribution_version("pytest"),
        },
    }


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(
        0, min(len(ordered) - 1, int((percentile / 100) * len(ordered) + 0.999) - 1)
    )
    return ordered[index]


def _duration_summary(values: list[float]) -> dict[str, Any]:
    return {
        "samples": len(values),
        "minMs": round(min(values), 3) if values else None,
        "medianMs": round(statistics.median(values), 3) if values else None,
        "p95Ms": round(_percentile(values, 95) or 0.0, 3) if values else None,
        "maxMs": round(max(values), 3) if values else None,
    }


def _disabled_registry(count: int) -> Any:
    _ensure_import_paths()
    from app.plugin_runtime.registry import RuntimeProcessSpec, RuntimeRegistry

    executable = Path(sys.executable).resolve()
    plugins = tuple(
        RuntimeProcessSpec(
            runtime_id=f"phase0.disabled-{index:03d}",
            expected_package=f"phase0-disabled-{index:03d}",
            expected_version="0.0.0",
            executable=executable,
            arguments=("-I", "-c", "raise SystemExit(0)"),
            enabled=False,
            auto_start=False,
            required=False,
        )
        for index in range(count)
    )
    return RuntimeRegistry(plugins=plugins)


async def _registry_child(count: int) -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_runtime.service import RuntimeHostService

    started = time.perf_counter()
    service = RuntimeHostService(
        _disabled_registry(count),
        host_name="CandleScope",
        host_version="0.3.0",
    )
    await service.start()
    summary = service.health_summary()
    await service.stop()
    return {
        "configured": summary["configured"],
        "enabled": summary["enabled"],
        "ready": summary["ready"],
        "internalElapsedMs": round((time.perf_counter() - started) * 1000, 3),
    }


def benchmark_fresh_registry_processes(repeats: int) -> dict[str, Any]:
    scenarios: dict[str, Any] = {}
    for count in (0, 10, 50):
        durations: list[float] = []
        child_payload: dict[str, Any] | None = None
        for _ in range(repeats):
            started = time.perf_counter()
            completed = subprocess.run(
                [sys.executable, str(SCRIPT_PATH), "--registry-child", str(count)],
                cwd=REPOSITORY_ROOT,
                check=True,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
            )
            durations.append((time.perf_counter() - started) * 1000)
            child_payload = json.loads(completed.stdout)
        scenarios[str(count)] = {
            "status": "measured",
            "processColdStart": _duration_summary(durations),
            "lastChild": child_payload,
        }
    return {
        "status": "measured",
        "definition": (
            "Fresh Python process import plus RuntimeHostService construction, "
            "start, health snapshot, and stop. All entries are disabled."
        ),
        "scenarios": scenarios,
    }


def _bar_batch(count: int) -> tuple[Any, ...]:
    _ensure_import_paths()
    from candlescope_plugin_sdk import Bar

    start = 1_700_000_000
    return tuple(
        Bar(
            time=start + index * 60,
            open=100.0 + index * 0.01,
            high=101.0 + index * 0.01,
            low=99.0 + index * 0.01,
            close=100.5 + index * 0.01,
            volume=10.0 + index,
            is_closed=True,
        )
        for index in range(count)
    )


async def benchmark_control_and_indicator(
    *,
    control_iterations: int,
    indicator_iterations: int,
    indicator_bars: int,
) -> dict[str, Any]:
    _ensure_import_paths()
    from candlescope_plugin_sdk import ExecuteBatchRequest, MarketContext

    from app.indicator.runtime_routes import (
        IndicatorRuntimeRoute,
        IndicatorRuntimeRoutes,
        ROUTE_MODE_LEGACY,
        ROUTE_MODE_SIDECAR,
    )
    from app.indicator.runtime_service import (
        IndicatorRuntimeRequest,
        IndicatorRuntimeService,
    )
    from app.plugin_runtime.registry import RuntimeProcessSpec, RuntimeRegistry
    from app.plugin_runtime.service import RuntimeHostService

    runner = (
        BACKEND_ROOT / "tests" / "fixtures" / "plugin_runtime" / "run_hello_runtime.py"
    )
    spec = RuntimeProcessSpec(
        runtime_id="hello-runtime",
        expected_package="candlescope-plugin-sdk",
        expected_version="0.2.0",
        executable=Path(sys.executable).resolve(),
        arguments=("-I", "-u", str(runner.resolve())),
        working_directory=REPOSITORY_ROOT,
        enabled=True,
        auto_start=False,
        required=False,
    )
    host = RuntimeHostService(
        RuntimeRegistry(plugins=(spec,)),
        host_name="CandleScope",
        host_version="0.3.0",
    )
    await host.start()
    context = MarketContext(
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
    )
    control_request = ExecuteBatchRequest(
        source="plot(close)",
        context=context,
        bars=_bar_batch(10),
    )
    started = time.perf_counter()
    descriptor = await host.descriptor("hello-runtime")
    startup_ms = (time.perf_counter() - started) * 1000
    control_latencies: list[float] = []
    control_result = None
    for _ in range(control_iterations):
        started = time.perf_counter()
        control_result = await host.execute_batch("hello-runtime", control_request)
        control_latencies.append((time.perf_counter() - started) * 1000)

    routes = IndicatorRuntimeRoutes(
        (
            IndicatorRuntimeRoute(language="pyne", mode=ROUTE_MODE_LEGACY),
            IndicatorRuntimeRoute(
                language="hello",
                mode=ROUTE_MODE_SIDECAR,
                runtime_id="hello-runtime",
            ),
        )
    )
    indicator_service = IndicatorRuntimeService(routes, host=host)
    await indicator_service.start()
    indicator_request = IndicatorRuntimeRequest(
        language="hello",
        source="plot(close)",
        exchange="binance",
        market_type="spot",
        symbol="BTCUSDT",
        interval="1m",
        bars=_bar_batch(indicator_bars),
        transport="phase0-benchmark",
    )

    async def legacy_must_not_run() -> dict[str, Any]:
        raise AssertionError("sidecar benchmark must not run the legacy adapter")

    def adapt_sidecar(result: Any) -> dict[str, Any]:
        series = result.output.series if result.output is not None else ()
        return {
            "ok": result.ok,
            "series": len(series),
            "points": sum(len(item.points) for item in series),
        }

    indicator_latencies: list[float] = []
    indicator_result: dict[str, Any] | None = None
    for _ in range(indicator_iterations):
        started = time.perf_counter()
        indicator_result = await indicator_service.execute(
            indicator_request,
            legacy=legacy_must_not_run,
            adapt_sidecar=adapt_sidecar,
        )
        indicator_latencies.append((time.perf_counter() - started) * 1000)

    await indicator_service.stop()
    diagnostics = host.diagnostics()
    await host.stop()
    if control_result is None or indicator_result is None:
        raise BaselineError("control or indicator benchmark produced no result")
    return {
        "status": "measured",
        "runtime": {
            "id": descriptor.id,
            "version": descriptor.version,
            "languageIds": [item.id for item in descriptor.languages],
        },
        "startupMs": round(startup_ms, 3),
        "controlRpc": {
            "iterations": control_iterations,
            "barsPerRequest": 10,
            "latency": _duration_summary(control_latencies),
            "lastPointCount": len(control_result.output.series[0].points),
        },
        "indicatorBatch": {
            "iterations": indicator_iterations,
            "barsPerRequest": indicator_bars,
            "latency": _duration_summary(indicator_latencies),
            "lastResult": indicator_result,
        },
        "hostRequestCount": diagnostics["runtimes"][0]["requests"],
    }


async def benchmark_kline_event_bus(event_count: int) -> dict[str, Any]:
    _ensure_import_paths()
    from app.data_engine.data_manager.config import EventBusConfig
    from app.data_engine.data_manager.event_bus import DataEventBus
    from app.data_engine.data_manager.models import (
        BarData,
        DataEvent,
        DataEventType,
        SeriesKey,
    )

    bus = DataEventBus(EventBusConfig(subscriber_queue_size=event_count + 16))
    key = SeriesKey("BTCUSDT", "1m", exchange="binance", market_type="spot")
    delivered = 0
    completed = asyncio.Event()

    async def consume(_event: DataEvent) -> None:
        nonlocal delivered
        delivered += 1
        if delivered == event_count:
            completed.set()

    bus.subscribe(callback=consume, key=key, event_types={DataEventType.BAR_CLOSED})
    events = [
        DataEvent(
            event_type=DataEventType.BAR_CLOSED,
            key=key,
            bar=BarData(
                time=1_700_000_000 + index * 60,
                open=100.0,
                high=101.0,
                low=99.0,
                close=100.5,
                volume=10.0,
                is_closed=True,
                source="binance_ws",
            ),
            timestamp_ms=1_700_000_000_000 + index * 60_000,
        )
        for index in range(event_count)
    ]
    started = time.perf_counter()
    await bus.emit_many(events)
    enqueue_ms = (time.perf_counter() - started) * 1000
    await asyncio.wait_for(completed.wait(), timeout=30)
    delivery_ms = (time.perf_counter() - started) * 1000
    snapshot = bus.snapshot()
    await bus.close()
    return {
        "status": "measured",
        "events": event_count,
        "enqueueMs": round(enqueue_ms, 3),
        "deliveryMs": round(delivery_ms, 3),
        "delivered": delivered,
        "enqueueEventsPerSecond": round(event_count / max(enqueue_ms / 1000, 1e-9), 3),
        "deliveryEventsPerSecond": round(
            event_count / max(delivery_ms / 1000, 1e-9), 3
        ),
        "eventsDropped": snapshot["events_dropped"],
    }


def benchmark_trade_flow(event_count: int) -> dict[str, Any]:
    _ensure_import_paths()
    from app.data_engine.ingestion.models import DataSource
    from app.data_engine.market_data.trade_flow import (
        NormalizedAggTrade,
        TradeFlowEngine,
    )

    engine = TradeFlowEngine(
        raw_ring_size=event_count,
        max_buckets_per_stream=max(2, event_count // 60_000 + 2),
        initial_bucket_complete=True,
    )
    started = time.perf_counter()
    accepted = 0
    base = 1_700_000_000_000
    for index in range(event_count):
        trade_id = index + 1
        result = engine.ingest(
            NormalizedAggTrade(
                exchange="binance",
                market_type="futures",
                symbol="BTCUSDT",
                agg_trade_id=trade_id,
                price=30_000.0 + (index % 100) * 0.1,
                quantity=0.001 + (index % 10) * 0.0001,
                trade_time_ms=base + index,
                event_time_ms=base + index + 1,
                received_at_ms=base + index + 2,
                is_buyer_maker=bool(index % 2),
                source=DataSource.WEBSOCKET,
                first_trade_id=trade_id,
                last_trade_id=trade_id,
            )
        )
        accepted += int(result.accepted)
    elapsed_ms = (time.perf_counter() - started) * 1000
    diagnostics = engine.diagnostics()
    return {
        "status": "measured",
        "events": event_count,
        "accepted": accepted,
        "elapsedMs": round(elapsed_ms, 3),
        "eventsPerSecond": round(event_count / max(elapsed_ms / 1000, 1e-9), 3),
        "duplicatesRejected": diagnostics["duplicates_rejected"],
        "outOfOrderRejected": diagnostics["out_of_order_rejected"],
        "rawTradesRetained": diagnostics["raw_trades"],
        "bucketsRetained": diagnostics["buckets"],
    }


def benchmark_full_order_book(*, levels: int, deltas: int) -> dict[str, Any]:
    _ensure_import_paths()
    from app.data_engine.ingestion.models import DataSource
    from app.data_engine.market_data.full_order_book import (
        DepthDelta,
        FullOrderBookEngine,
        FullOrderBookSeed,
    )

    identity = ("binance", "futures", "BTCUSDT", 100)
    mid = 30_000.0
    bids = tuple(
        (mid - index * 0.1, 1.0 + index * 0.001) for index in range(1, levels + 1)
    )
    asks = tuple(
        (mid + index * 0.1, 1.0 + index * 0.001) for index in range(1, levels + 1)
    )
    engine = FullOrderBookEngine(
        max_streams=1,
        max_levels_per_side=levels,
        max_updates_per_delta=8,
    )
    engine.activate_stream(identity)
    epoch = engine.begin_sync(identity)
    engine.install_snapshot(
        identity,
        FullOrderBookSeed(
            exchange=identity[0],
            market_type=identity[1],
            symbol=identity[2],
            update_interval_ms=identity[3],
            snapshot_limit=levels,
            last_update_id=100,
            bids=bids,
            asks=asks,
            event_time_ms=1_700_000_000_000,
            received_at_ms=1_700_000_000_001,
            source=DataSource.HTTP,
        ),
        epoch=epoch,
    )

    started = time.perf_counter()
    accepted = 0
    previous = 99
    for index in range(deltas):
        final_id = 101 + index
        level_index = index % levels + 1
        result = engine.apply_delta(
            identity,
            DepthDelta(
                exchange=identity[0],
                market_type=identity[1],
                symbol=identity[2],
                update_interval_ms=identity[3],
                first_update_id=100 if index == 0 else final_id,
                final_update_id=final_id,
                previous_final_update_id=previous,
                bids=((mid - level_index * 0.1, 2.0 + index * 0.0001),),
                asks=((mid + level_index * 0.1, 2.5 + index * 0.0001),),
                event_time_ms=1_700_000_001_000 + index,
                transaction_time_ms=1_700_000_001_000 + index,
                received_at_ms=1_700_000_001_001 + index,
                source=DataSource.WEBSOCKET,
            ),
            epoch=epoch,
        )
        accepted += int(result.accepted)
        previous = final_id
    elapsed_ms = (time.perf_counter() - started) * 1000
    projection_started = time.perf_counter()
    snapshot = engine.snapshot(identity, depth=min(100, levels))
    projection_ms = (time.perf_counter() - projection_started) * 1000
    diagnostics = engine.diagnostics()
    state = diagnostics["stream_states"][0]
    return {
        "status": "measured",
        "levelsPerSide": levels,
        "deltas": deltas,
        "accepted": accepted,
        "elapsedMs": round(elapsed_ms, 3),
        "deltasPerSecond": round(deltas / max(elapsed_ms / 1000, 1e-9), 3),
        "projectionDepth": min(100, levels),
        "projectionMs": round(projection_ms, 3),
        "snapshotAvailable": snapshot is not None,
        "state": state["state"],
        "revision": state["revision"],
        "gaps": diagnostics["gaps"],
    }


def _timed_call(callback: Callable[[], _T]) -> tuple[_T, float]:
    started = time.perf_counter()
    result = callback()
    return result, (time.perf_counter() - started) * 1000


def benchmark_installer_lifecycle() -> dict[str, Any]:
    _ensure_import_paths()
    from app.plugin_runtime.installer import PluginInstaller
    from app.plugin_runtime.registry import load_runtime_registry
    from tests.plugin_runtime_bundle_testkit import build_hello_bundle

    with tempfile.TemporaryDirectory(
        prefix="candlescope-phase0-installer-"
    ) as temporary:
        root = Path(temporary)
        first_bundle = build_hello_bundle(root / "bundle-v1", version="0.1.0")
        second_bundle = build_hello_bundle(root / "bundle-v2", version="0.2.0")
        installer = PluginInstaller(root=root / "plugins")
        first, first_ms = _timed_call(
            lambda: installer.install(
                first_bundle.bundle.path,
                expected_sha256=first_bundle.bundle.sha256,
            )
        )
        repeat, repeat_ms = _timed_call(
            lambda: installer.install(
                first_bundle.bundle.path,
                expected_sha256=first_bundle.bundle.sha256,
            )
        )
        check, check_ms = _timed_call(lambda: installer.check("hello-runtime"))
        upgraded, upgrade_ms = _timed_call(
            lambda: installer.install(
                second_bundle.bundle.path,
                expected_sha256=second_bundle.bundle.sha256,
            )
        )
        rolled_back, rollback_ms = _timed_call(
            lambda: installer.rollback("hello-runtime")
        )
        active = load_runtime_registry(installer.registry_path).by_id()["hello-runtime"]
        return {
            "status": "measured",
            "firstInstall": {
                "elapsedMs": round(first_ms, 3),
                "changed": first.changed,
                "reusedInstallation": first.reused_installation,
            },
            "quickRepeat": {
                "elapsedMs": round(repeat_ms, 3),
                "changed": repeat.changed,
                "reusedInstallation": repeat.reused_installation,
            },
            "check": {
                "elapsedMs": round(check_ms, 3),
                "version": check.version,
            },
            "upgrade": {
                "elapsedMs": round(upgrade_ms, 3),
                "changed": upgraded.changed,
                "version": upgraded.version,
            },
            "rollback": {
                "elapsedMs": round(rollback_ms, 3),
                "fromActivationIdChanged": (
                    rolled_back.from_activation_id != rolled_back.to_activation_id
                ),
                "restoredVersion": active.expected_version,
            },
        }


async def benchmark_official_runtimes(bundle_directory: Path | None) -> dict[str, Any]:
    if bundle_directory is None:
        return {
            "status": "not_run",
            "reason": "Pass --official-bundle-dir with both pinned .cspkg files.",
        }
    _ensure_import_paths()
    from app.plugin_runtime.bundle import verify_plugin_bundle
    from app.plugin_runtime.installer import PluginInstaller
    from app.plugin_runtime.registry import load_runtime_registry
    from app.plugin_runtime.service import RuntimeHostService

    release_lock = _read_json(OFFICIAL_RELEASE_LOCK)
    plugins = release_lock.get("plugins")
    if not isinstance(plugins, list) or len(plugins) != 2:
        raise BaselineError("Phase 0 expects exactly two pinned official runtimes")

    verified: list[tuple[dict[str, Any], Any]] = []
    for release in plugins:
        path = bundle_directory / str(release["filename"])
        if not path.is_file():
            raise BaselineError(f"missing official bundle: {release['filename']}")
        if path.stat().st_size != int(release["size"]):
            raise BaselineError(f"official bundle size mismatch: {release['filename']}")
        bundle = verify_plugin_bundle(path, expected_sha256=str(release["sha256"]))
        verified.append((release, bundle))

    with tempfile.TemporaryDirectory(
        prefix="candlescope-phase0-official-"
    ) as temporary:
        installer = PluginInstaller(root=Path(temporary) / "plugins")
        installs: list[dict[str, Any]] = []
        total_started = time.perf_counter()
        for release, bundle in verified:
            result, elapsed_ms = await asyncio.to_thread(
                _timed_call,
                lambda bundle=bundle: installer.install(
                    bundle.path,
                    expected_sha256=bundle.sha256,
                    enabled=True,
                    auto_start=True,
                    required=True,
                ),
            )
            installs.append(
                {
                    "runtimeId": result.runtime_id,
                    "version": result.version,
                    "elapsedMs": round(elapsed_ms, 3),
                    "changed": result.changed,
                }
            )
        install_total_ms = (time.perf_counter() - total_started) * 1000
        registry = load_runtime_registry(installer.registry_path)
        host = RuntimeHostService(
            registry,
            host_name="CandleScope",
            host_version="0.3.0",
        )
        started = time.perf_counter()
        await host.start()
        host_startup_ms = (time.perf_counter() - started) * 1000
        probes: list[dict[str, Any]] = []
        for release, bundle in verified:
            runtime_id = str(release["runtimeId"])
            descriptor = await host.descriptor(runtime_id)
            result = await host.execute_batch(
                runtime_id, bundle.manifest.probe.execute_request
            )
            series = result.output.series if result.output is not None else ()
            probes.append(
                {
                    "runtimeId": runtime_id,
                    "version": descriptor.version,
                    "languageIds": [item.id for item in descriptor.languages],
                    "ok": result.ok,
                    "series": len(series),
                    "points": sum(len(item.points) for item in series),
                }
            )
        health = host.health_summary()
        await host.stop()
        return {
            "status": "measured",
            "freshInstallTotalMs": round(install_total_ms, 3),
            "hostStartupMs": round(host_startup_ms, 3),
            "installs": installs,
            "health": health,
            "probes": probes,
        }


async def run_baseline(args: argparse.Namespace) -> dict[str, Any]:
    quick = bool(args.quick)
    repeats = args.repeats or (2 if quick else 5)
    control_iterations = 5 if quick else 50
    indicator_iterations = 2 if quick else 10
    indicator_bars = 200 if quick else 1_500
    kline_events = 500 if quick else 10_000
    trades = 1_000 if quick else 20_000
    order_book_levels = 100 if quick else 1_000
    order_book_deltas = 500 if quick else 10_000

    official_directory = (
        Path(args.official_bundle_dir).expanduser().resolve()
        if args.official_bundle_dir
        else None
    )
    artifact = {
        "schemaVersion": SCHEMA_VERSION,
        "capturedAt": datetime.now(UTC).isoformat(),
        "mode": "quick" if quick else "standard",
        "git": _git_metadata(),
        "environment": environment_metadata(args.browser),
        "contracts": frozen_contracts(),
        "baselines": {
            "registryColdStart": benchmark_fresh_registry_processes(repeats),
            "controlAndIndicator": await benchmark_control_and_indicator(
                control_iterations=control_iterations,
                indicator_iterations=indicator_iterations,
                indicator_bars=indicator_bars,
            ),
            "klineEventBus": await benchmark_kline_event_bus(kline_events),
            "tradeFlow": benchmark_trade_flow(trades),
            "fullOrderBook": benchmark_full_order_book(
                levels=order_book_levels,
                deltas=order_book_deltas,
            ),
            "installerLifecycle": (
                {"status": "not_run", "reason": "--skip-installer"}
                if args.skip_installer
                else await asyncio.to_thread(benchmark_installer_lifecycle)
            ),
            "officialRuntimes": await benchmark_official_runtimes(official_directory),
        },
    }
    validate_baseline_invariants(
        artifact,
        require_official=bool(args.fail_on_missing_official),
    )
    return artifact


def validate_baseline_invariants(
    artifact: dict[str, Any],
    *,
    require_official: bool,
) -> None:
    """Reject measured output that violates a Phase 0 correctness invariant."""

    baselines = artifact["baselines"]
    registry = baselines["registryColdStart"]["scenarios"]
    expected_registry = {"0": 0, "10": 10, "50": 50}
    actual_registry = {
        name: scenario["lastChild"]["configured"] for name, scenario in registry.items()
    }
    if actual_registry != expected_registry:
        raise BaselineError(f"registry scenarios are incomplete: {actual_registry!r}")

    control = baselines["controlAndIndicator"]
    indicator_result = control["indicatorBatch"]["lastResult"]
    if (
        control["runtime"]["id"] != "hello-runtime"
        or control["controlRpc"]["lastPointCount"]
        != control["controlRpc"]["barsPerRequest"]
        or not indicator_result["ok"]
        or indicator_result["series"] != 1
        or indicator_result["points"] != control["indicatorBatch"]["barsPerRequest"]
    ):
        raise BaselineError("control/indicator correctness invariant failed")

    kline = baselines["klineEventBus"]
    if kline["delivered"] != kline["events"] or kline["eventsDropped"] != 0:
        raise BaselineError("kline event bus lost or dropped events")

    trade_flow = baselines["tradeFlow"]
    if (
        trade_flow["accepted"] != trade_flow["events"]
        or trade_flow["duplicatesRejected"] != 0
        or trade_flow["outOfOrderRejected"] != 0
    ):
        raise BaselineError("trade-flow correctness invariant failed")

    order_book = baselines["fullOrderBook"]
    if (
        order_book["accepted"] != order_book["deltas"]
        or order_book["gaps"] != 0
        or order_book["state"] != "live"
        or not order_book["snapshotAvailable"]
    ):
        raise BaselineError("full-order-book correctness invariant failed")

    installer = baselines["installerLifecycle"]
    if installer["status"] == "measured" and (
        not installer["firstInstall"]["changed"]
        or installer["firstInstall"]["reusedInstallation"]
        or installer["quickRepeat"]["changed"]
        or not installer["quickRepeat"]["reusedInstallation"]
        or not installer["upgrade"]["changed"]
        or installer["upgrade"]["version"] != "0.2.0"
        or not installer["rollback"]["fromActivationIdChanged"]
        or installer["rollback"]["restoredVersion"] != "0.1.0"
    ):
        raise BaselineError("installer lifecycle correctness invariant failed")

    official = baselines["officialRuntimes"]
    if require_official and official["status"] != "measured":
        raise BaselineError(
            "official runtime baseline is required but was not measured"
        )
    if official["status"] == "measured":
        health = official["health"]
        probes = official["probes"]
        if (
            health["status"] != "ok"
            or health["configured"] != 2
            or health["enabled"] != 2
            or health["ready"] != 2
            or health["failed"] != 0
            or len(official["installs"]) != 2
            or not all(item["changed"] for item in official["installs"])
            or len(probes) != 2
            or not all(
                probe["ok"] and probe["series"] > 0 and probe["points"] > 0
                for probe in probes
            )
        ):
            raise BaselineError("official runtime correctness invariant failed")


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.part")
    encoded = (
        json.dumps(
            payload, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False
        )
        + "\n"
    ).encode("utf-8")
    try:
        temporary.write_bytes(encoded)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", help="Machine-readable JSON artifact path.")
    parser.add_argument(
        "--quick", action="store_true", help="Use reduced repeat/event counts."
    )
    parser.add_argument(
        "--repeats", type=int, help="Fresh-process repetitions per registry size."
    )
    parser.add_argument("--skip-installer", action="store_true")
    parser.add_argument("--official-bundle-dir")
    parser.add_argument("--fail-on-missing-official", action="store_true")
    parser.add_argument(
        "--browser", help="Browser/version label recorded in the artifact."
    )
    parser.add_argument("--registry-child", type=int, help=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.registry_child is not None:
        if args.registry_child < 0:
            raise SystemExit("--registry-child must be non-negative")
        print(
            json.dumps(
                asyncio.run(_registry_child(args.registry_child)),
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 0
    if not args.output:
        raise SystemExit("--output is required")
    if args.repeats is not None and args.repeats < 1:
        raise SystemExit("--repeats must be positive")
    try:
        artifact = asyncio.run(run_baseline(args))
    except BaselineError as exc:
        print(f"Phase 0 baseline failed: {exc}", file=sys.stderr)
        return 2
    output = Path(args.output)
    _write_json_atomic(output, artifact)
    print(
        json.dumps(
            {
                "ok": True,
                "schemaVersion": artifact["schemaVersion"],
                "output": str(output.resolve()),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
