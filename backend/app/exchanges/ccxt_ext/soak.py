"""End-to-end soak runner for the CCXT transport plus CandleScope quality kernel."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.factory import ExchangeIngestionFactory
from app.data_engine.ingestion.models import (
    DataSource,
    GapMarker,
    MarketEvent,
    SessionHealth,
    StreamDescriptor,
    StreamType,
)
from app.data_engine.market_data.full_order_book_service import (
    FullOrderBookRateLimited,
    FullOrderBookService,
)
from app.data_engine.market_data.models import MarketChannel, MarketStreamKey

from .runtime import get_shared_ccxt_runtime_pool

logger = logging.getLogger("ccxt.integrated_soak")
SOAK_SCHEMA_VERSION = "candlescope.ccxt.integrated_soak/2"


@dataclass(slots=True)
class SequenceAudit:
    step: int
    same_key_is_duplicate: bool = True
    events: int = 0
    recovered_events: int = 0
    first_key: int | None = None
    last_key: int | None = None
    transitions: int = 0
    duplicates: int = 0
    out_of_order: int = 0
    gaps: int = 0
    missing: int = 0
    largest_gap: int = 0
    gap_samples: list[dict[str, int]] = field(default_factory=list)

    def observe(self, key: int, source: DataSource) -> None:
        key = int(key)
        self.events += 1
        if source == DataSource.HTTP_BACKFILL:
            self.recovered_events += 1
        if self.first_key is None:
            self.first_key = key
            self.last_key = key
            return
        assert self.last_key is not None
        if key == self.last_key:
            if self.same_key_is_duplicate:
                self.duplicates += 1
            return
        if key < self.last_key:
            self.out_of_order += 1
            return
        self.transitions += 1
        expected = self.last_key + self.step
        if key > expected:
            missing = max(0, (key - expected) // self.step)
            self.gaps += 1
            self.missing += missing
            self.largest_gap = max(self.largest_gap, missing)
            if len(self.gap_samples) < 20:
                self.gap_samples.append(
                    {"previous": self.last_key, "current": key, "missing": missing}
                )
        self.last_key = key

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class GapAudit:
    total: int = 0
    filled: int = 0
    unfilled: int = 0
    expected_events: int = 0
    samples: list[dict[str, Any]] = field(default_factory=list)

    def observe(self, gap: GapMarker) -> None:
        self.total += 1
        self.expected_events += int(gap.expected_count)
        if gap.filled:
            self.filled += 1
        else:
            self.unfilled += 1
        if len(self.samples) < 20:
            self.samples.append(gap.to_dict())

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class HealthAudit:
    transitions: int = 0
    states: dict[str, int] = field(default_factory=dict)
    last_state: str | None = None
    last_reason: str | None = None
    samples: list[dict[str, Any]] = field(default_factory=list)

    def observe(self, health: SessionHealth, reason: str) -> None:
        value = health.value
        self.transitions += 1
        self.states[value] = self.states.get(value, 0) + 1
        self.last_state = value
        self.last_reason = reason
        if len(self.samples) < 20:
            self.samples.append(
                {
                    "state": value,
                    "reason": reason,
                    "observed_at_ms": int(time.time() * 1000),
                }
            )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class FullBookAudit:
    samples: int = 0
    live_samples: int = 0
    stale_samples: int = 0
    missing_samples: int = 0
    empty_side_samples: int = 0
    crossed_samples: int = 0
    update_id_regressions: int = 0
    first_update_id: int | None = None
    last_update_id: int | None = None

    def observe(self, record: Any | None) -> None:
        self.samples += 1
        if record is None:
            self.missing_samples += 1
            return
        data = record.event.data
        if not bool(data.get("live")):
            self.stale_samples += 1
            return
        self.live_samples += 1
        bids = data.get("bids") or []
        asks = data.get("asks") or []
        if not bids or not asks:
            self.empty_side_samples += 1
        else:
            best_bid = max(_level_price(level) for level in bids)
            best_ask = min(_level_price(level) for level in asks)
            if best_bid >= best_ask:
                self.crossed_samples += 1
        update_id = data.get("last_update_id")
        if update_id is None:
            return
        update_id = int(update_id)
        if self.first_update_id is None:
            self.first_update_id = update_id
        if self.last_update_id is not None and update_id < self.last_update_id:
            self.update_id_regressions += 1
        self.last_update_id = update_id

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class BinanceCcxtIntegratedSoakRunner:
    """Exercise the real provider through recovery and strict full-book service."""

    def __init__(
        self,
        *,
        symbol: str = "BTCUSDT",
        interval: str = "1m",
        depth_update_interval_ms: int = 250,
        duration_seconds: float = 14_400.0,
        startup_timeout_seconds: float = 45.0,
        heartbeat_seconds: float = 30.0,
        full_book_max_levels_per_side: int = 5_000,
        disconnect_at_seconds: tuple[float, ...] = (),
        progress_path: Path | None = None,
    ) -> None:
        if duration_seconds <= 0 or startup_timeout_seconds <= 0:
            raise ValueError("soak duration and startup timeout must be positive")
        if heartbeat_seconds <= 0:
            raise ValueError("heartbeat interval must be positive")
        if full_book_max_levels_per_side < 1_000:
            raise ValueError("full-book level capacity must be at least 1000")
        disconnect_schedule = tuple(sorted(float(value) for value in disconnect_at_seconds))
        if any(value <= 0 or value >= duration_seconds for value in disconnect_schedule):
            raise ValueError("disconnect injections must fall inside the soak duration")
        self.symbol = symbol.upper().strip()
        self.interval = interval
        self.depth_update_interval_ms = int(depth_update_interval_ms)
        self.duration_seconds = float(duration_seconds)
        self.startup_timeout_seconds = float(startup_timeout_seconds)
        self.heartbeat_seconds = float(heartbeat_seconds)
        self.full_book_max_levels_per_side = int(full_book_max_levels_per_side)
        self.disconnect_at_seconds = disconnect_schedule
        self.progress_path = progress_path
        self.config = IngestionConfig(ccxt_stream_enabled=True)
        interval_ms = _fixed_interval_ms(interval)
        self.kline = SequenceAudit(step=interval_ms, same_key_is_duplicate=False)
        self.agg_trade = SequenceAudit(step=1)
        self.kline_gaps = GapAudit()
        self.agg_trade_gaps = GapAudit()
        self.agg_trade_health = HealthAudit()
        self.full_book = FullBookAudit()
        self.fatal_errors: list[dict[str, Any]] = []
        self._factory: ExchangeIngestionFactory | None = None
        self._full_book_service: FullOrderBookService | None = None
        self._full_book_key = self._book_key()
        self._kline_ready = asyncio.Event()
        self._agg_trade_ready = asyncio.Event()
        self._full_book_ready = False
        self._observation_started_at_ms: int | None = None
        self._started_at_ms: int | None = None
        self._completed_at_ms: int | None = None
        self._completed_duration = False
        self._fault_injections: list[dict[str, Any]] = []
        self._shutdown_report: dict[str, Any] | None = None

    async def run(self) -> dict[str, Any]:
        self._started_at_ms = int(time.time() * 1000)
        factory = ExchangeIngestionFactory(self.config)
        service = FullOrderBookService(
            factory,
            max_levels_per_side=self.full_book_max_levels_per_side,
        )
        self._factory = factory
        self._full_book_service = service
        kline_handle = None
        agg_trade_handle = None
        report: dict[str, Any] | None = None
        try:
            kline_handle = await factory.start(
                self.symbol,
                self.interval,
                self._on_kline,
                exchange="binance",
                market_type="futures",
                on_gap=self._on_kline_gap,
            )
            agg_trade_handle = await factory.start_market(
                StreamDescriptor(
                    self.symbol,
                    StreamType.AGG_TRADE,
                    exchange="binance",
                    market_type="futures",
                ),
                self._on_agg_trade,
                on_gap=self._on_agg_trade_gap,
                on_health=self._on_agg_trade_health,
            )
            await service.ensure_stream(self._full_book_key, consumer_id="ccxt-soak")
            await asyncio.wait_for(
                asyncio.gather(
                    self._kline_ready.wait(),
                    self._agg_trade_ready.wait(),
                    self._wait_for_full_book_live(),
                ),
                timeout=self.startup_timeout_seconds,
            )
            self._full_book_ready = True
            self._observation_started_at_ms = int(time.time() * 1000)
            await self._write_progress()
            loop = asyncio.get_running_loop()
            observation_started = loop.time()
            deadline = observation_started + self.duration_seconds
            disconnect_index = 0
            while True:
                now = loop.time()
                remaining = deadline - now
                if remaining <= 0:
                    break
                sleep_for = min(self.heartbeat_seconds, remaining)
                if disconnect_index < len(self.disconnect_at_seconds):
                    injection_deadline = (
                        observation_started
                        + self.disconnect_at_seconds[disconnect_index]
                    )
                    sleep_for = min(sleep_for, max(0.0, injection_deadline - now))
                if sleep_for > 0:
                    await asyncio.sleep(sleep_for)
                elapsed = loop.time() - observation_started
                while (
                    disconnect_index < len(self.disconnect_at_seconds)
                    and elapsed >= self.disconnect_at_seconds[disconnect_index]
                ):
                    await self._inject_disconnect(
                        self.disconnect_at_seconds[disconnect_index],
                    )
                    disconnect_index += 1
                self._sample_full_book()
                await self._write_progress()
            self._completed_duration = True
            self._sample_full_book()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("Integrated CCXT soak failed")
            self.fatal_errors.append(
                {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "observed_at_ms": int(time.time() * 1000),
                }
            )
        finally:
            self._completed_at_ms = int(time.time() * 1000)
            report = self.report()
            self._shutdown_report = await self._shutdown(
                factory=factory,
                service=service,
                agg_trade_handle=agg_trade_handle,
                kline_handle=kline_handle,
            )
            report["shutdown"] = self._shutdown_report
            report["fatal_errors"] = list(self.fatal_errors)
            report["failure_reasons"] = integrated_soak_failure_reasons(report)
            if report["failure_reasons"]:
                report["overall_verdict"] = "FAIL"
            elif self._completed_duration:
                report["overall_verdict"] = "PASS"
        assert report is not None
        await self._write_json(self.progress_path, report)
        return report

    def report(self) -> dict[str, Any]:
        service_diagnostics = (
            self._full_book_service.diagnostics()
            if self._full_book_service is not None
            else None
        )
        pipelines = self._pipeline_snapshots()
        ready = (
            self._kline_ready.is_set()
            and self._agg_trade_ready.is_set()
            and self._full_book_ready
        )
        report: dict[str, Any] = {
            "schema_version": SOAK_SCHEMA_VERSION,
            "overall_verdict": "INCOMPLETE",
            "ready": ready,
            "completed_duration": self._completed_duration,
            "config": {
                "exchange": "binance",
                "market_type": "futures",
                "symbol": self.symbol,
                "interval": self.interval,
                "depth_update_interval_ms": self.depth_update_interval_ms,
                "duration_seconds": self.duration_seconds,
                "startup_timeout_seconds": self.startup_timeout_seconds,
                "heartbeat_seconds": self.heartbeat_seconds,
                "full_book_max_levels_per_side": self.full_book_max_levels_per_side,
                "disconnect_at_seconds": list(self.disconnect_at_seconds),
                "ccxt_version_required": "4.5.60",
                "recovery_attempt_timeout_seconds": (
                    self.config.ccxt_recovery_timeout_seconds
                ),
                "recovery_retry_deadline_seconds": (
                    self.config.ccxt_recovery_retry_deadline_seconds
                ),
                "recovery_buffer_max_events": (
                    self.config.ccxt_recovery_buffer_max_events
                ),
            },
            "started_at_ms": self._started_at_ms,
            "observation_started_at_ms": self._observation_started_at_ms,
            "completed_at_ms": self._completed_at_ms,
            "fatal_errors": list(self.fatal_errors),
            "kline": self.kline.to_dict(),
            "agg_trade": self.agg_trade.to_dict(),
            "gap_recovery": {
                "kline": self.kline_gaps.to_dict(),
                "agg_trade": self.agg_trade_gaps.to_dict(),
            },
            "agg_trade_health": self.agg_trade_health.to_dict(),
            "fault_injection": {
                "requested": len(self.disconnect_at_seconds),
                "completed": sum(
                    event.get("status") == "completed"
                    for event in self._fault_injections
                ),
                "failed": sum(
                    event.get("status") == "failed"
                    for event in self._fault_injections
                ),
                "events": list(self._fault_injections),
            },
            "full_order_book": {
                "audit": self.full_book.to_dict(),
                "service": service_diagnostics,
            },
            "pipelines": pipelines,
            "shutdown": self._shutdown_report,
        }
        report["failure_reasons"] = integrated_soak_failure_reasons(report)
        if report["failure_reasons"]:
            report["overall_verdict"] = "FAIL"
        elif self._completed_duration:
            report["overall_verdict"] = "PASS"
        return report

    async def _on_kline(self, event: MarketEvent) -> None:
        key = event.continuity_key
        if key is None:
            return
        self.kline.observe(key, event.source)
        self._kline_ready.set()

    async def _on_agg_trade(self, event: MarketEvent) -> None:
        key = event.continuity_key
        if key is None:
            return
        self.agg_trade.observe(key, event.source)
        self._agg_trade_ready.set()

    async def _on_kline_gap(self, gap: GapMarker) -> None:
        self.kline_gaps.observe(gap)

    async def _on_agg_trade_gap(self, gap: GapMarker) -> None:
        self.agg_trade_gaps.observe(gap)

    async def _on_agg_trade_health(
        self,
        health: SessionHealth,
        reason: str,
    ) -> None:
        self.agg_trade_health.observe(health, reason)

    async def _inject_disconnect(self, scheduled_at_seconds: float) -> None:
        event: dict[str, Any] = {
            "scheduled_at_seconds": scheduled_at_seconds,
            "started_at_ms": int(time.time() * 1000),
            "status": "running",
        }
        self._fault_injections.append(event)
        try:
            recycled = await get_shared_ccxt_runtime_pool().recycle_all_websockets()
            if not recycled or sum(recycled.values()) <= 0:
                raise RuntimeError("disconnect injection found no active WS clients")
            event.update(
                {
                    "status": "completed",
                    "completed_at_ms": int(time.time() * 1000),
                    "closed_clients": recycled,
                }
            )
        except Exception as exc:
            event.update(
                {
                    "status": "failed",
                    "completed_at_ms": int(time.time() * 1000),
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
            raise

    async def _shutdown(
        self,
        *,
        factory: ExchangeIngestionFactory,
        service: FullOrderBookService,
        agg_trade_handle: Any,
        kline_handle: Any,
    ) -> dict[str, Any]:
        started_at_ms = int(time.time() * 1000)
        operations: list[tuple[str, Any]] = [("full_order_book", service.shutdown())]
        if agg_trade_handle is not None:
            operations.append(("agg_trade", agg_trade_handle.stop()))
        if kline_handle is not None:
            operations.append(("kline", kline_handle.stop()))
        results = await asyncio.gather(
            *(operation for _name, operation in operations),
            return_exceptions=True,
        )
        operation_results: dict[str, dict[str, Any]] = {}
        for (name, _operation), result in zip(operations, results, strict=True):
            if isinstance(result, BaseException):
                operation_results[name] = {
                    "ok": False,
                    "error": f"{type(result).__name__}: {result}",
                }
                self.fatal_errors.append(
                    {
                        "type": type(result).__name__,
                        "message": f"shutdown {name}: {result}",
                        "observed_at_ms": int(time.time() * 1000),
                    }
                )
            else:
                ok = result is not False
                operation_results[name] = {"ok": ok, "result": result}
                if not ok:
                    self.fatal_errors.append(
                        {
                            "type": "ShutdownError",
                            "message": f"shutdown {name} returned false",
                            "observed_at_ms": int(time.time() * 1000),
                        }
                    )
        factory_error: str | None = None
        try:
            await factory.shutdown()
        except Exception as exc:  # noqa: BLE001 - shutdown evidence is report data
            factory_error = f"{type(exc).__name__}: {exc}"
            self.fatal_errors.append(
                {
                    "type": type(exc).__name__,
                    "message": f"factory shutdown: {exc}",
                    "observed_at_ms": int(time.time() * 1000),
                }
            )
        service_diagnostics = service.diagnostics()
        runtime_pool = get_shared_ccxt_runtime_pool().snapshot()
        completed = (
            factory_error is None
            and all(value["ok"] for value in operation_results.values())
            and service_diagnostics.get("state") == "closed"
            and not runtime_pool.get("runtimes")
            and not factory.get_transports()
        )
        return {
            "started_at_ms": started_at_ms,
            "completed_at_ms": int(time.time() * 1000),
            "completed": completed,
            "operations": operation_results,
            "factory_error": factory_error,
            "factory_active_transports": len(factory.get_transports()),
            "ccxt_runtime_pool": runtime_pool,
            "full_order_book": service_diagnostics,
        }

    def _sample_full_book(self) -> None:
        if self._full_book_service is None:
            self.full_book.observe(None)
            return
        self.full_book.observe(
            self._full_book_service.current(
                self._full_book_key,
                require_live=False,
            )
        )

    async def _wait_for_full_book_live(self) -> Any:
        assert self._full_book_service is not None
        deadline = asyncio.get_running_loop().time() + self.startup_timeout_seconds
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError("full order-book startup timed out")
            try:
                return await self._full_book_service.wait_for_live(
                    self._full_book_key,
                    timeout_seconds=min(5.0, remaining),
                )
            except FullOrderBookRateLimited as exc:
                delay = max(0.05, (exc.retry_at_ms - int(time.time() * 1000)) / 1000)
                await asyncio.sleep(min(delay, remaining))
            except asyncio.TimeoutError:
                continue

    def _pipeline_snapshots(self) -> dict[str, Any]:
        ingress = getattr(self._factory, "_ingress", None)
        if ingress is None:
            return {}
        return {key: pipeline.snapshot() for key, pipeline in ingress.pipelines.items()}

    def _book_key(self) -> MarketStreamKey:
        return MarketStreamKey.build(
            "binance",
            "futures",
            self.symbol,
            MarketChannel.FULL_DEPTH,
            params={
                "mode": "full",
                "snapshot_limit": 1000,
                "update_interval_ms": self.depth_update_interval_ms,
            },
        )

    async def _write_progress(self) -> None:
        await self._write_json(self.progress_path, self.report())

    @staticmethod
    async def _write_json(path: Path | None, payload: dict[str, Any]) -> None:
        if path is None:
            return
        import json

        rendered = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        await asyncio.to_thread(temporary.write_text, rendered + "\n", encoding="utf-8")
        await asyncio.to_thread(temporary.replace, path)


def integrated_soak_failure_reasons(report: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    if not report.get("ready"):
        reasons.append("startup_not_ready")
    if report.get("fatal_errors"):
        reasons.append("fatal_errors")
    for channel in ("kline", "agg_trade"):
        audit = report[channel]
        for field_name in ("duplicates", "out_of_order", "gaps", "missing"):
            if int(audit[field_name]) > 0:
                reasons.append(f"{channel}_{field_name}")
    recovery = report["gap_recovery"]
    for channel in ("kline", "agg_trade"):
        if int(recovery[channel]["unfilled"]) > 0:
            reasons.append(f"{channel}_unfilled_gaps")
    full_book = report["full_order_book"]
    audit = full_book["audit"]
    for field_name in (
        "missing_samples",
        "empty_side_samples",
        "crossed_samples",
        "update_id_regressions",
    ):
        if int(audit[field_name]) > 0:
            reasons.append(f"full_book_{field_name}")
    service = full_book.get("service") or {}
    for field_name in (
        "deltas_invalid",
        "upstream_queue_overflows",
        "hub_publish_rejected",
    ):
        if int(service.get(field_name, 0)) > 0:
            reasons.append(f"full_book_{field_name}")
    engine = service.get("engine") or {}
    if int(engine.get("capacity_failures", 0)) > 0:
        reasons.append("full_book_capacity_failures")
    actors = service.get("actors") or []
    if not actors or any(actor.get("state") != "live" for actor in actors):
        reasons.append("full_book_not_live_at_end")
    pipelines = report.get("pipelines") or {}
    for stream_key, pipeline in pipelines.items():
        session = (pipeline.get("feed_control") or {}).get("session") or {}
        metrics = session.get("metrics") or {}
        counters = metrics.get("counters") or {}
        if int(counters.get("raw_queue_overflows", 0)) > 0:
            reasons.append(f"raw_queue_overflow:{stream_key}")
        if session.get("health") != SessionHealth.CONNECTED.value:
            reasons.append(f"session_not_connected:{stream_key}")
        recovery_state = pipeline.get("recovery") or {}
        if recovery_state.get("enabled") and (
            recovery_state.get("state") != "healthy"
            or int(recovery_state.get("terminal_failures", 0)) > 0
        ):
            reasons.append(f"recovery_not_healthy:{stream_key}")
    fault = report.get("fault_injection") or {}
    requested_faults = int(fault.get("requested", 0))
    if report.get("completed_duration") and requested_faults:
        if int(fault.get("completed", 0)) != requested_faults:
            reasons.append("fault_injection_incomplete")
        if int(fault.get("failed", 0)) > 0:
            reasons.append("fault_injection_failed")
        for stream_key, pipeline in pipelines.items():
            session = (pipeline.get("feed_control") or {}).get("session") or {}
            counters = ((session.get("metrics") or {}).get("counters") or {})
            cancellations = int(counters.get("watch_cancellations", 0))
            disconnects = int(counters.get("lifecycle_disconnected", 0))
            if cancellations < requested_faults and disconnects < requested_faults:
                reasons.append(f"fault_not_observed:{stream_key}")
    shutdown = report.get("shutdown")
    if shutdown is not None and not bool(shutdown.get("completed")):
        reasons.append("shutdown_incomplete")
    return list(dict.fromkeys(reasons))


def _fixed_interval_ms(interval: str) -> int:
    from app.data_engine.interval_policy import parse_interval_ms

    value = parse_interval_ms(interval)
    if value is None or value <= 0:
        raise ValueError(f"soak requires a fixed-width interval: {interval}")
    return int(value)


def _level_price(level: Any) -> float:
    price = getattr(level, "price", None)
    if price is not None:
        return float(price)
    return float(level[0])
