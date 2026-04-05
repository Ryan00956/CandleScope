"""
Repair Publisher — broadcasts backfill results via logs, callbacks, and events.

Responsibilities:
  * Build a ``RepairReport`` from the completed pipeline run
  * Publish via configurable modes: "log", "callback", "both"
  * Optionally include a data preview (first N bars)
  * Fire user-registered event handlers

Extension points:
  * ``on_report(callback)``         — register report listeners
  * ``set_report_formatter(fn)``    — custom report formatting
  * ``set_report_filter(fn)``       — filter which reports get published

Usage::

    publisher = RepairPublisher(config)
    publisher.on_report(my_webhook_handler)
    await publisher.publish(report)
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Callable, Awaitable, Any

from ..ingestion.metrics import LayerMetrics
from .config import BackfillConfig
from .models import (
    BackfillPlan,
    BackfillStatus,
    FetchResult,
    ReconcileResult,
    RepairReport,
    FetchedBar,
)

logger = logging.getLogger("backfill.Publisher")

# Type aliases
ReportCallback = Callable[[RepairReport], Awaitable[None]]
ReportFormatter = Callable[[RepairReport], dict]
ReportFilter = Callable[[RepairReport], bool]


class RepairPublisher:
    """Publishes backfill repair reports to logs and callbacks."""

    def __init__(self, config: BackfillConfig) -> None:
        self._cfg = config
        self._metrics = LayerMetrics("RepairPublisher")

        # Extension points
        self._report_callbacks: list[ReportCallback] = []
        self._report_formatter: ReportFormatter | None = None
        self._report_filter: ReportFilter | None = None

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        return {
            "component": "RepairPublisher",
            "publish_mode": self._cfg.publish_mode,
            "include_preview": self._cfg.publish_include_data_preview,
            "registered_callbacks": len(self._report_callbacks),
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Extension points ─────────────────────────────

    def on_report(self, callback: ReportCallback) -> None:
        """Register a callback to receive repair reports.

        The callback is an async function that receives a ``RepairReport``.
        Multiple callbacks can be registered.

        Example — send to webhook::

            async def webhook_handler(report):
                await httpx.post("https://hooks.example.com/backfill",
                                 json=report.to_dict())
            publisher.on_report(webhook_handler)
        """
        self._report_callbacks.append(callback)

    def remove_report_callback(self, callback: ReportCallback) -> None:
        """Remove a previously registered report callback."""
        self._report_callbacks = [
            cb for cb in self._report_callbacks if cb is not callback
        ]

    def set_report_formatter(self, fn: ReportFormatter) -> None:
        """Override how the report is formatted for logging.

        The formatter receives a ``RepairReport`` and returns a dict
        that will be logged as JSON.

        Example::

            def compact_format(report):
                return {
                    "id": report.run_id,
                    "status": report.status.value,
                    "bars": report.reconcile_result.bars_written
                            if report.reconcile_result else 0,
                }
            publisher.set_report_formatter(compact_format)
        """
        self._report_formatter = fn

    def set_report_filter(self, fn: ReportFilter) -> None:
        """Set a filter to decide which reports get published.

        The filter receives a ``RepairReport`` and returns ``True`` to
        publish, ``False`` to suppress.

        Example — only publish failures::

            publisher.set_report_filter(
                lambda r: r.status in (BackfillStatus.FAILED, BackfillStatus.PARTIAL)
            )
        """
        self._report_filter = fn

    # ── Public: Build Report ─────────────────────────────────

    def build_report(
        self,
        symbol: str,
        exchange: str,
        status: BackfillStatus,
        plan: BackfillPlan | None,
        fetch_results: list[FetchResult],
        reconcile_result: ReconcileResult | None,
        started_at_ms: int,
        errors: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RepairReport:
        """Build a ``RepairReport`` from pipeline results.

        This method also attaches a data preview if configured.
        """
        now_ms = int(time.time() * 1000)
        elapsed = now_ms - started_at_ms

        # Build data preview
        preview: list[dict] = []
        if self._cfg.publish_include_data_preview:
            preview = self._build_preview(fetch_results)

        report = RepairReport(
            run_id=uuid.uuid4().hex[:12],
            symbol=symbol,
            exchange=exchange,
            status=status,
            plan=plan,
            fetch_results=fetch_results,
            reconcile_result=reconcile_result,
            started_at_ms=started_at_ms,
            completed_at_ms=now_ms,
            elapsed_ms=elapsed,
            data_preview=preview,
            errors=errors or [],
            metadata=metadata or {},
        )
        return report

    # ── Public: Publish ──────────────────────────────────────

    async def publish(self, report: RepairReport) -> None:
        """Publish a repair report according to the configured mode.

        Modes:
          - "log"      — log only
          - "callback" — fire callbacks only
          - "both"     — log + callbacks (default)
        """
        self._metrics.inc("publish_runs")
        self._metrics.mark("last_publish_at")

        # Apply filter
        if self._report_filter is not None:
            if not self._report_filter(report):
                self._metrics.inc("reports_filtered")
                logger.debug("Report %s filtered out", report.run_id)
                return

        mode = self._cfg.publish_mode

        # Log
        if mode in ("log", "both"):
            self._log_report(report)

        # Callbacks
        if mode in ("callback", "both"):
            await self._fire_callbacks(report)

        self._metrics.inc("reports_published")

    # ── Internal: Logging ────────────────────────────────────

    def _log_report(self, report: RepairReport) -> None:
        """Log the report at appropriate level."""
        if self._report_formatter is not None:
            formatted = self._report_formatter(report)
        else:
            formatted = self._default_format(report)

        if report.status == BackfillStatus.FAILED:
            logger.error("Backfill FAILED: %s", formatted)
        elif report.status == BackfillStatus.PARTIAL:
            logger.warning("Backfill PARTIAL: %s", formatted)
        else:
            logger.info("Backfill completed: %s", formatted)

    @staticmethod
    def _default_format(report: RepairReport) -> dict:
        """Default compact format for logging."""
        rec = report.reconcile_result
        return {
            "run_id": report.run_id,
            "symbol": report.symbol,
            "exchange": report.exchange,
            "status": report.status.value,
            "elapsed_ms": report.elapsed_ms,
            "gaps": len(report.plan.gaps) if report.plan else 0,
            "tasks": len(report.plan.tasks) if report.plan else 0,
            "bars_fetched": sum(fr.bars_count for fr in report.fetch_results),
            "bars_written": rec.bars_written if rec else 0,
            "bars_skipped": rec.bars_skipped if rec else 0,
            "custom_generated": rec.custom_bars_generated if rec else 0,
            "bars_cached": rec.bars_cached if rec else 0,
            "errors": report.errors[:5],  # first 5 errors
        }

    # ── Internal: Callbacks ──────────────────────────────────

    async def _fire_callbacks(self, report: RepairReport) -> None:
        """Fire all registered report callbacks."""
        for cb in self._report_callbacks:
            try:
                await cb(report)
            except Exception as exc:
                self._metrics.inc("callback_errors")
                logger.error(
                    "Report callback error: %s", exc, exc_info=True,
                )

    # ── Internal: Data preview ───────────────────────────────

    def _build_preview(
        self, fetch_results: list[FetchResult],
    ) -> list[dict]:
        """Build a data preview from fetch results."""
        max_rows = self._cfg.publish_max_preview_rows
        preview: list[dict] = []

        for fr in fetch_results:
            if fr.status == BackfillStatus.FAILED:
                continue
            for bar in fr.bars:
                if len(preview) >= max_rows:
                    return preview
                preview.append(bar.to_dict())

        return preview
