"""
Backfill Engine — orchestrates gap detection, planning, fetching, reconciliation, and publishing.

Architecture::

    ┌─────────────────────────────────────────────────────────────────┐
    │                      BackfillEngine                            │
    │                                                                │
    │  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐   │
    │  │ Gap Detector  │──▶│   Planner    │──▶│ Historical       │   │
    │  │              │   │              │   │ Fetcher          │   │
    │  └──────────────┘   └──────────────┘   └────────┬─────────┘   │
    │                                                  │             │
    │                                        ┌─────────▼─────────┐  │
    │                                        │    Reconciler      │  │
    │                                        │  (dedup + write)   │  │
    │                                        └─────────┬─────────┘  │
    │                                                  │             │
    │                                        ┌─────────▼─────────┐  │
    │                                        │ Repair Publisher   │  │
    │                                        └───────────────────┘  │
    └─────────────────────────────────────────────────────────────────┘

Usage::

    from app.data_engine.backfill import BackfillEngine, BackfillConfig

    config = BackfillConfig(fetch_concurrency=5)
    engine = BackfillEngine(config, storage=my_storage, transport=my_transport)

    # Simple one-shot backfill
    report = await engine.run("BTCUSDT")

    # With custom intervals and explicit range
    report = await engine.run(
        symbol="BTCUSDT",
        intervals=["1m", "5m", "91m"],
        range_start_ms=1700000000000,
        range_end_ms=1700100000000,
    )

    # Access sub-components for advanced customization
    engine.planner.add_interval_mapping("91m", [...])
    engine.detector.set_gap_filter(lambda g: g.missing_bars >= 10)
    engine.publisher.on_report(my_webhook)
"""
from __future__ import annotations

import logging
import time
from typing import Any

from ..ingestion.config import IngestionConfig
from ..ingestion.metrics import LayerMetrics
from ..ingestion.transport import TransportLayer

from .config import BackfillConfig
from .models import (
    BackfillPlan,
    BackfillStatus,
    CacheBackend,
    FetchResult,
    GapInfo,
    ReconcileResult,
    RepairReport,
    StorageBackend,
)
from .gap_detector import GapDetector
from .planner import BackfillPlanner
from .fetcher import HistoricalFetcher
from .reconciler import Reconciler
from .publisher import RepairPublisher

logger = logging.getLogger("backfill.Engine")

__all__ = [
    # Engine
    "BackfillEngine",
    # Config
    "BackfillConfig",
    # Sub-components (for direct access / testing)
    "GapDetector",
    "BackfillPlanner",
    "HistoricalFetcher",
    "Reconciler",
    "RepairPublisher",
    # Models & Protocols
    "BackfillPlan",
    "BackfillStatus",
    "CacheBackend",
    "FetchResult",
    "GapInfo",
    "ReconcileResult",
    "RepairReport",
    "StorageBackend",
]


class BackfillEngine:
    """Top-level orchestrator for the Backfill Engine.

    Wires together Gap Detector → Planner → Fetcher → Reconciler → Publisher
    into a single ``run()`` call, while exposing every sub-component for
    advanced customization.

    Args:
        config:           Backfill configuration.
        storage:          Storage backend (implements ``StorageBackend`` protocol).
        transport:        Ingestion TransportLayer for REST fetching.
        cache:            Optional cache backend (implements ``CacheBackend`` protocol).
        ingestion_config: Optional ingestion config (for NormalizeLayer reuse).
    """

    def __init__(
        self,
        config: BackfillConfig | None = None,
        storage: StorageBackend | None = None,
        transport: TransportLayer | None = None,
        cache: CacheBackend | None = None,
        ingestion_config: IngestionConfig | None = None,
    ) -> None:
        self._cfg = config or BackfillConfig()
        self._storage = storage
        self._transport = transport
        self._cache = cache
        self._ingestion_cfg = ingestion_config
        self._metrics = LayerMetrics("BackfillEngine")

        # Lazily initialized sub-components
        self._detector: GapDetector | None = None
        self._planner: BackfillPlanner | None = None
        self._fetcher: HistoricalFetcher | None = None
        self._reconciler: Reconciler | None = None
        self._publisher: RepairPublisher | None = None

    # ── Public: Sub-component access ─────────────────────────

    @property
    def config(self) -> BackfillConfig:
        """Access the engine configuration."""
        return self._cfg

    @property
    def detector(self) -> GapDetector:
        """Access the Gap Detector sub-component."""
        if self._detector is None:
            if self._storage is None:
                raise RuntimeError(
                    "StorageBackend is required for GapDetector. "
                    "Pass storage= to BackfillEngine()."
                )
            self._detector = GapDetector(self._cfg, self._storage)
        return self._detector

    @property
    def planner(self) -> BackfillPlanner:
        """Access the Backfill Planner sub-component."""
        if self._planner is None:
            self._planner = BackfillPlanner(self._cfg)
        return self._planner

    @property
    def fetcher(self) -> HistoricalFetcher:
        """Access the Historical Fetcher sub-component."""
        if self._fetcher is None:
            if self._transport is None:
                raise RuntimeError(
                    "TransportLayer is required for HistoricalFetcher. "
                    "Pass transport= to BackfillEngine()."
                )
            self._fetcher = HistoricalFetcher(
                self._cfg, self._transport, self._ingestion_cfg,
            )
        return self._fetcher

    @property
    def reconciler(self) -> Reconciler:
        """Access the Reconciler sub-component."""
        if self._reconciler is None:
            if self._storage is None:
                raise RuntimeError(
                    "StorageBackend is required for Reconciler. "
                    "Pass storage= to BackfillEngine()."
                )
            self._reconciler = Reconciler(self._cfg, self._storage, self._cache)
        return self._reconciler

    @property
    def publisher(self) -> RepairPublisher:
        """Access the Repair Publisher sub-component."""
        if self._publisher is None:
            self._publisher = RepairPublisher(self._cfg)
        return self._publisher

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        """Return a JSON-serializable snapshot of the entire engine state."""
        return {
            "component": "BackfillEngine",
            "config": self._cfg.snapshot(),
            "detector": self._detector.snapshot() if self._detector else None,
            "planner": self._planner.snapshot() if self._planner else None,
            "fetcher": self._fetcher.snapshot() if self._fetcher else None,
            "reconciler": self._reconciler.snapshot() if self._reconciler else None,
            "publisher": self._publisher.snapshot() if self._publisher else None,
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Run ──────────────────────────────────────────

    async def run(
        self,
        symbol: str,
        intervals: list[str] | None = None,
        range_start_ms: int | None = None,
        range_end_ms: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RepairReport:
        """Execute a complete backfill run.

        Pipeline: Detect → Plan → Fetch → Reconcile → Publish

        Args:
            symbol:         Trading pair, e.g. "BTCUSDT".
            intervals:      Intervals to backfill (default: config.gap_scan_intervals).
            range_start_ms: Start of desired data range (ms).
            range_end_ms:   End of desired data range (ms).
            metadata:       Arbitrary metadata to attach to the report.

        Returns:
            A ``RepairReport`` describing what happened.
        """
        started_at_ms = int(time.time() * 1000)
        self._metrics.inc("runs")
        self._metrics.mark("last_run_at")

        logger.info(
            "Backfill run started: symbol=%s intervals=%s",
            symbol, intervals or "default",
        )

        errors: list[str] = []
        plan: BackfillPlan | None = None
        fetch_results: list[FetchResult] = []
        reconcile_result: ReconcileResult | None = None
        status = BackfillStatus.PENDING

        try:
            # ── Phase 1: Detect ──
            status = BackfillStatus.DETECTING
            gaps = await self.detector.detect(
                symbol=symbol,
                intervals=intervals,
                range_start_ms=range_start_ms,
                range_end_ms=range_end_ms,
            )

            if not gaps:
                logger.info("No gaps detected for %s — nothing to do", symbol)
                status = BackfillStatus.COMPLETED
                report = self.publisher.build_report(
                    symbol=symbol,
                    status=status,
                    plan=None,
                    fetch_results=[],
                    reconcile_result=None,
                    started_at_ms=started_at_ms,
                    metadata=metadata,
                )
                await self.publisher.publish(report)
                return report

            # ── Phase 2: Plan ──
            status = BackfillStatus.PLANNING
            plan = self.planner.plan(gaps)

            if not plan.tasks:
                logger.info("Planner produced no tasks for %s", symbol)
                status = BackfillStatus.COMPLETED
                report = self.publisher.build_report(
                    symbol=symbol,
                    status=status,
                    plan=plan,
                    fetch_results=[],
                    reconcile_result=None,
                    started_at_ms=started_at_ms,
                    metadata=metadata,
                )
                await self.publisher.publish(report)
                return report

            # ── Phase 3: Fetch ──
            status = BackfillStatus.FETCHING
            fetch_results = await self.fetcher.fetch(plan.tasks)

            # Check if all tasks failed
            all_failed = all(
                fr.status == BackfillStatus.FAILED for fr in fetch_results
            )
            if all_failed:
                status = BackfillStatus.FAILED
                errors.append("All fetch tasks failed")
                logger.error("All fetch tasks failed for %s", symbol)
            else:
                # ── Phase 4: Reconcile ──
                status = BackfillStatus.RECONCILING
                reconcile_result = await self.reconciler.reconcile(
                    fetch_results, plan,
                )

                if reconcile_result.errors:
                    errors.extend(reconcile_result.errors)

                # Determine final status
                any_failed = any(
                    fr.status == BackfillStatus.FAILED for fr in fetch_results
                )
                if any_failed or reconcile_result.errors:
                    status = BackfillStatus.PARTIAL
                else:
                    status = BackfillStatus.COMPLETED

        except Exception as exc:
            status = BackfillStatus.FAILED
            errors.append(str(exc))
            self._metrics.inc("run_errors")
            logger.error(
                "Backfill run failed for %s: %s", symbol, exc, exc_info=True,
            )

        # ── Phase 5: Publish ──
        report = self.publisher.build_report(
            symbol=symbol,
            status=status,
            plan=plan,
            fetch_results=fetch_results,
            reconcile_result=reconcile_result,
            started_at_ms=started_at_ms,
            errors=errors,
            metadata=metadata,
        )

        try:
            await self.publisher.publish(report)
        except Exception as exc:
            logger.error("Failed to publish report: %s", exc, exc_info=True)

        self._metrics.inc(f"runs_{status.value}")
        logger.info(
            "Backfill run finished: symbol=%s status=%s elapsed=%dms",
            symbol, status.value, report.elapsed_ms,
        )
        return report

    # ── Public: Detect-only (dry run) ────────────────────────

    async def detect_only(
        self,
        symbol: str,
        intervals: list[str] | None = None,
        range_start_ms: int | None = None,
        range_end_ms: int | None = None,
    ) -> list[GapInfo]:
        """Run gap detection only, without planning or fetching.

        Useful for diagnostics and dry runs.
        """
        return await self.detector.detect(
            symbol=symbol,
            intervals=intervals,
            range_start_ms=range_start_ms,
            range_end_ms=range_end_ms,
        )

    # ── Public: Plan-only (dry run) ──────────────────────────

    async def plan_only(
        self,
        symbol: str,
        intervals: list[str] | None = None,
        range_start_ms: int | None = None,
        range_end_ms: int | None = None,
    ) -> BackfillPlan:
        """Run gap detection + planning only, without fetching.

        Useful for cost estimation and previewing what would happen.
        """
        gaps = await self.detector.detect(
            symbol=symbol,
            intervals=intervals,
            range_start_ms=range_start_ms,
            range_end_ms=range_end_ms,
        )
        return self.planner.plan(gaps)
