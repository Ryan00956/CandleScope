"""
Backfill Planner — converts detected gaps into an optimized fetch plan.

Responsibilities:
  * Accept ``GapInfo`` objects from the Gap Detector
  * For standard intervals: create direct ``BackfillTask`` objects
  * For custom intervals (e.g. 91m): decompose into standard intervals,
    align bucket boundaries, and create fetch tasks for each component
  * Deduplicate and sort tasks for efficient execution
  * Estimate total API requests and bars

Decomposition strategies:
  * **greedy_descending** — use the largest standard interval that fits,
    then fill the remainder with smaller ones.  Fast, minimal requests.
    Example: 91m → 1×60m + 1×30m + 1×1m
  * **min_requests** — pick the single standard interval that minimizes
    total REST pages (considering batch_size / interval ratio).
  * **single_base** — use only the smallest fitting standard interval
    (simple but may produce many requests).

Alignment modes:
  * **epoch** — bucket boundaries are multiples of custom_duration_ms
    offset from alignment_epoch_ms.
  * **midnight** — align to UTC midnight.
  * **none** — no alignment; start from gap_start.

Extension points:
  * ``set_decomposition_fn(fn)``         — fully override decomposition
  * ``set_alignment_fn(fn)``            — fully override alignment
  * ``add_interval_mapping(custom, [])`` — hardcode a decomposition

Usage::

    planner = BackfillPlanner(config)
    plan = planner.plan(gaps)
"""
from __future__ import annotations

import logging
import math
from typing import Callable, Any

from ..ingestion.metrics import LayerMetrics
from .config import BackfillConfig
from .models import (
    GapInfo,
    GapType,
    BackfillPlan,
    BackfillTask,
    IntervalComponent,
    IntervalDecomposition,
    AlignmentMode,
    DecompStrategy,
    STANDARD_INTERVAL_MS,
    parse_interval_ms,
    is_standard_interval,
)

logger = logging.getLogger("backfill.Planner")

# Type aliases
DecompositionFn = Callable[[str, int], list[IntervalComponent]]
AlignmentFn = Callable[[int, int, int], int]  # (timestamp_ms, bucket_ms, epoch_ms) → aligned_ms


class BackfillPlanner:
    """Converts gaps into an optimized, executable backfill plan."""

    def __init__(self, config: BackfillConfig) -> None:
        self._cfg = config
        self._metrics = LayerMetrics("BackfillPlanner")

        # Pre-compute sorted standard intervals (descending by duration)
        self._standard_sorted_desc: list[tuple[str, int]] = sorted(
            [
                (iv, STANDARD_INTERVAL_MS[iv])
                for iv in self._cfg.standard_intervals
                if iv in STANDARD_INTERVAL_MS
            ],
            key=lambda x: x[1],
            reverse=True,
        )

        # Extension points
        self._custom_decomposition_fn: DecompositionFn | None = None
        self._custom_alignment_fn: AlignmentFn | None = None
        self._interval_mappings: dict[str, list[IntervalComponent]] = {}

    # ── Public: Metrics / Snapshot ───────────────────────────

    @property
    def metrics(self) -> LayerMetrics:
        return self._metrics

    def snapshot(self) -> dict:
        return {
            "component": "BackfillPlanner",
            "standard_intervals": [iv for iv, _ in self._standard_sorted_desc],
            "custom_mappings": list(self._interval_mappings.keys()),
            "decomposition_strategy": self._cfg.decomposition_strategy,
            "alignment_mode": self._cfg.custom_alignment_mode,
            "metrics": self._metrics.snapshot(),
        }

    # ── Public: Extension points ─────────────────────────────

    def set_decomposition_fn(self, fn: DecompositionFn) -> None:
        """Fully override the decomposition algorithm.

        The function receives ``(interval_str, duration_ms)`` and must
        return a list of ``IntervalComponent``.

        Example::

            def my_decomp(interval: str, duration_ms: int):
                # Always use 1m as base
                return [IntervalComponent("1m", duration_ms // 60000, 60000)]
            planner.set_decomposition_fn(my_decomp)
        """
        self._custom_decomposition_fn = fn

    def set_alignment_fn(self, fn: AlignmentFn) -> None:
        """Fully override the alignment algorithm.

        The function receives ``(timestamp_ms, bucket_width_ms, epoch_ms)``
        and must return the aligned bucket start timestamp (ms).

        Example::

            def my_align(ts, bucket, epoch):
                return ((ts - epoch) // bucket) * bucket + epoch
            planner.set_alignment_fn(my_align)
        """
        self._custom_alignment_fn = fn

    def add_interval_mapping(
        self,
        custom_interval: str,
        components: list[IntervalComponent],
    ) -> None:
        """Register a hardcoded decomposition for a custom interval.

        This takes priority over algorithmic decomposition.

        Example::

            planner.add_interval_mapping("91m", [
                IntervalComponent("1h", 1, 3_600_000),
                IntervalComponent("30m", 1, 1_800_000),
                IntervalComponent("1m", 1, 60_000),
            ])
        """
        self._interval_mappings[custom_interval] = components
        logger.info("Interval mapping registered: %s → %s",
                     custom_interval, [c.to_dict() for c in components])

    def remove_interval_mapping(self, custom_interval: str) -> None:
        """Remove a previously registered interval mapping."""
        self._interval_mappings.pop(custom_interval, None)

    # ── Public: Plan ─────────────────────────────────────────

    def plan(self, gaps: list[GapInfo]) -> BackfillPlan:
        """Generate a complete backfill plan from detected gaps.

        Args:
            gaps: List of ``GapInfo`` from the Gap Detector.

        Returns:
            A ``BackfillPlan`` with tasks sorted by priority.
        """
        self._metrics.inc("plan_runs")
        self._metrics.mark("last_plan_at")

        if not gaps:
            logger.info("No gaps to plan for")
            return BackfillPlan(gaps=[])

        all_tasks: list[BackfillTask] = []
        decompositions: list[IntervalDecomposition] = []
        custom_intervals: list[str] = []

        for gap in gaps:
            interval = gap.interval
            interval_ms = parse_interval_ms(interval)
            if interval_ms is None:
                logger.warning("Cannot parse interval '%s', skipping gap", interval)
                continue

            if is_standard_interval(interval):
                # Standard interval — direct fetch
                tasks = self._plan_standard_gap(gap, interval_ms)
                all_tasks.extend(tasks)
            else:
                # Custom interval — decompose, then plan
                decomp = self._decompose_interval(interval, interval_ms)
                decompositions.append(decomp)
                if interval not in custom_intervals:
                    custom_intervals.append(interval)

                tasks = self._plan_custom_gap(gap, interval_ms, decomp)
                all_tasks.extend(tasks)

        # Deduplicate tasks (same symbol + interval + time range)
        all_tasks = self._deduplicate_tasks(all_tasks)

        # Sort by priority, then by start_ms
        all_tasks.sort(key=lambda t: (t.priority, t.start_ms))

        # Estimate costs
        total_bars = sum(t.estimated_bars for t in all_tasks)
        batch_size = self._cfg.fetch_batch_size
        total_requests = sum(
            max(1, math.ceil(t.estimated_bars / batch_size)) for t in all_tasks
        )

        plan = BackfillPlan(
            gaps=gaps,
            decompositions=decompositions,
            tasks=all_tasks,
            estimated_requests=total_requests,
            estimated_bars=total_bars,
            custom_intervals=custom_intervals,
        )

        self._metrics.inc("tasks_planned", len(all_tasks))
        self._metrics.set("last_plan_tasks", len(all_tasks))
        self._metrics.set("last_plan_estimated_bars", total_bars)
        logger.info(
            "Backfill plan created: %d gaps → %d tasks, ~%d bars, ~%d requests",
            len(gaps), len(all_tasks), total_bars, total_requests,
        )
        return plan

    # ── Internal: Standard gap planning ──────────────────────

    def _plan_standard_gap(
        self, gap: GapInfo, interval_ms: int,
    ) -> list[BackfillTask]:
        """Create fetch tasks for a standard-interval gap."""
        tasks: list[BackfillTask] = []
        batch_size = self._cfg.fetch_batch_size
        batch_ms = batch_size * interval_ms

        cursor = gap.start_ms
        priority = self._gap_priority(gap)

        while cursor <= gap.end_ms:
            batch_end = min(cursor + batch_ms - interval_ms, gap.end_ms)
            estimated = max(1, (batch_end - cursor) // interval_ms + 1)

            task = BackfillTask(
                symbol=gap.symbol,
                interval=gap.interval,
                start_ms=cursor,
                end_ms=batch_end,
                priority=priority,
                parent_gap=gap,
                estimated_bars=estimated,
            )
            tasks.append(task)
            cursor = batch_end + interval_ms

        return tasks

    # ── Internal: Custom gap planning ────────────────────────

    def _plan_custom_gap(
        self,
        gap: GapInfo,
        custom_ms: int,
        decomp: IntervalDecomposition,
    ) -> list[BackfillTask]:
        """Create fetch tasks for a custom-interval gap.

        For each component in the decomposition, we need to fetch the
        corresponding standard-interval data that covers the gap range,
        properly aligned to custom bucket boundaries.
        """
        tasks: list[BackfillTask] = []
        priority = self._gap_priority(gap)

        # Align the gap start to custom bucket boundaries
        aligned_start = self._align_timestamp(gap.start_ms, custom_ms)
        # Align the gap end to the next bucket boundary
        aligned_end_exclusive = self._align_timestamp(gap.end_ms, custom_ms) + custom_ms

        # For each component, create fetch tasks
        for component in decomp.components:
            comp_ms = component.duration_ms
            comp_interval = component.interval
            batch_size = self._cfg.fetch_batch_size

            # The entire aligned range needs this component's data
            # But we fetch at the component's own granularity
            total_comp_bars = max(
                1,
                ((aligned_end_exclusive - aligned_start) // comp_ms) * component.count,
            )
            batch_ms = batch_size * comp_ms

            cursor = aligned_start
            while cursor < aligned_end_exclusive:
                batch_end = min(cursor + batch_ms - comp_ms, aligned_end_exclusive - comp_ms)
                estimated = max(1, (batch_end - cursor) // comp_ms + 1)

                task = BackfillTask(
                    symbol=gap.symbol,
                    interval=comp_interval,
                    start_ms=cursor,
                    end_ms=batch_end,
                    priority=priority,
                    parent_gap=gap,
                    estimated_bars=estimated,
                    metadata={"custom_interval": gap.interval},
                )
                tasks.append(task)
                cursor = batch_end + comp_ms

        return tasks

    # ── Internal: Interval decomposition ─────────────────────

    def _decompose_interval(
        self, interval: str, duration_ms: int,
    ) -> IntervalDecomposition:
        """Decompose a custom interval into standard interval components.

        Priority:
          1. Pre-registered mappings (add_interval_mapping)
          2. User-supplied decomposition function
          3. Algorithmic decomposition per config strategy
        """
        alignment_mode = AlignmentMode(self._cfg.custom_alignment_mode)

        # 1. Check pre-registered mappings
        if interval in self._interval_mappings:
            components = self._interval_mappings[interval]
            logger.debug("Using pre-registered mapping for %s", interval)
            return IntervalDecomposition(
                custom_interval=interval,
                custom_duration_ms=duration_ms,
                components=components,
                is_standard=False,
                alignment_mode=alignment_mode,
                alignment_epoch_ms=self._cfg.alignment_epoch_ms,
            )

        # 2. Check user-supplied function
        if self._custom_decomposition_fn is not None:
            try:
                components = self._custom_decomposition_fn(interval, duration_ms)
                logger.debug("Using custom decomposition function for %s", interval)
                return IntervalDecomposition(
                    custom_interval=interval,
                    custom_duration_ms=duration_ms,
                    components=components,
                    is_standard=False,
                    alignment_mode=alignment_mode,
                    alignment_epoch_ms=self._cfg.alignment_epoch_ms,
                )
            except Exception as exc:
                logger.warning(
                    "Custom decomposition function failed for %s: %s, "
                    "falling back to algorithmic", interval, exc,
                )

        # 3. Algorithmic decomposition
        strategy = self._cfg.decomposition_strategy
        if strategy == DecompStrategy.GREEDY_DESCENDING.value:
            components = self._decompose_greedy(duration_ms)
        elif strategy == DecompStrategy.MIN_REQUESTS.value:
            components = self._decompose_min_requests(duration_ms)
        elif strategy == DecompStrategy.SINGLE_BASE.value:
            components = self._decompose_single_base(duration_ms)
        else:
            logger.warning("Unknown strategy '%s', using greedy", strategy)
            components = self._decompose_greedy(duration_ms)

        self._metrics.inc("decompositions_computed")
        logger.info(
            "Decomposed %s (%dms) → %s",
            interval, duration_ms,
            [(c.interval, c.count) for c in components],
        )

        return IntervalDecomposition(
            custom_interval=interval,
            custom_duration_ms=duration_ms,
            components=components,
            is_standard=False,
            alignment_mode=alignment_mode,
            alignment_epoch_ms=self._cfg.alignment_epoch_ms,
        )

    def _decompose_greedy(self, duration_ms: int) -> list[IntervalComponent]:
        """Greedy descending decomposition.

        Use the largest standard interval that fits, then fill the
        remainder recursively.

        Example: 91m (5,460,000 ms)
          → 60m fits 1× (remainder 31m = 1,860,000 ms)
          → 30m fits 1× (remainder 1m  = 60,000 ms)
          → 1m  fits 1×
          Result: [(60m, 1), (30m, 1), (1m, 1)]
        """
        components: list[IntervalComponent] = []
        remaining = duration_ms
        max_components = self._cfg.max_decomposition_components

        for iv_str, iv_ms in self._standard_sorted_desc:
            if len(components) >= max_components:
                break
            if iv_ms > remaining:
                continue
            count = remaining // iv_ms
            if count > 0:
                components.append(IntervalComponent(
                    interval=iv_str,
                    count=count,
                    duration_ms=iv_ms,
                ))
                remaining -= count * iv_ms
            if remaining == 0:
                break

        if remaining > 0:
            logger.warning(
                "Greedy decomposition has %dms remainder — "
                "no standard interval small enough", remaining,
            )

        return components

    def _decompose_min_requests(self, duration_ms: int) -> list[IntervalComponent]:
        """Pick the single standard interval that minimizes total REST pages.

        For a gap of N custom buckets, each bucket needs ``duration_ms / iv_ms``
        bars of interval ``iv``.  We want the interval that minimizes
        ``ceil(total_bars / batch_size)``.

        Falls back to greedy if no single interval divides evenly.
        """
        batch_size = self._cfg.fetch_batch_size
        best_interval: str | None = None
        best_pages = float("inf")
        best_ms = 0

        for iv_str, iv_ms in self._standard_sorted_desc:
            if iv_ms > duration_ms:
                continue
            if duration_ms % iv_ms != 0:
                continue  # skip if it doesn't divide evenly
            bars_per_bucket = duration_ms // iv_ms
            # For estimation, assume 1 bucket; actual pages scale linearly
            pages = math.ceil(bars_per_bucket / batch_size)
            if pages < best_pages:
                best_pages = pages
                best_interval = iv_str
                best_ms = iv_ms

        if best_interval is not None:
            count = duration_ms // best_ms
            return [IntervalComponent(
                interval=best_interval,
                count=count,
                duration_ms=best_ms,
            )]

        # Fallback to greedy
        logger.debug("min_requests: no single interval divides evenly, "
                      "falling back to greedy")
        return self._decompose_greedy(duration_ms)

    def _decompose_single_base(self, duration_ms: int) -> list[IntervalComponent]:
        """Use the smallest standard interval that divides the custom duration.

        Simple but potentially many bars.
        """
        for iv_str, iv_ms in reversed(self._standard_sorted_desc):
            if iv_ms > duration_ms:
                continue
            if duration_ms % iv_ms == 0:
                count = duration_ms // iv_ms
                return [IntervalComponent(
                    interval=iv_str,
                    count=count,
                    duration_ms=iv_ms,
                )]

        # Last resort: use 1s or 1m
        fallback = self._standard_sorted_desc[-1] if self._standard_sorted_desc else ("1m", 60_000)
        iv_str, iv_ms = fallback
        count = duration_ms // iv_ms
        if count == 0:
            count = 1
        return [IntervalComponent(
            interval=iv_str,
            count=count,
            duration_ms=iv_ms,
        )]

    # ── Internal: Alignment ──────────────────────────────────

    def _align_timestamp(self, ts_ms: int, bucket_ms: int) -> int:
        """Align a timestamp to the nearest bucket boundary.

        Uses the configured alignment mode or user-supplied function.
        """
        # User override
        if self._custom_alignment_fn is not None:
            return self._custom_alignment_fn(
                ts_ms, bucket_ms, self._cfg.alignment_epoch_ms,
            )

        mode = self._cfg.custom_alignment_mode

        if mode == AlignmentMode.EPOCH.value:
            epoch = self._cfg.alignment_epoch_ms
            return ((ts_ms - epoch) // bucket_ms) * bucket_ms + epoch

        if mode == AlignmentMode.MIDNIGHT.value:
            # Align to UTC midnight (86_400_000 ms granularity)
            day_ms = 86_400_000
            day_start = (ts_ms // day_ms) * day_ms
            # Then align within the day
            offset = ts_ms - day_start
            aligned_offset = (offset // bucket_ms) * bucket_ms
            return day_start + aligned_offset

        if mode == AlignmentMode.NONE.value:
            return ts_ms

        # Default: epoch alignment with epoch=0
        return (ts_ms // bucket_ms) * bucket_ms

    # ── Internal: Task deduplication ─────────────────────────

    def _deduplicate_tasks(
        self, tasks: list[BackfillTask],
    ) -> list[BackfillTask]:
        """Remove duplicate tasks (same symbol + interval + time range).

        When duplicates are found, the one with higher priority (lower
        number) is kept.  Overlapping ranges are merged.
        """
        if not tasks:
            return []

        # Group by (symbol, interval)
        groups: dict[tuple[str, str], list[BackfillTask]] = {}
        for task in tasks:
            key = (task.symbol, task.interval)
            groups.setdefault(key, []).append(task)

        deduplicated: list[BackfillTask] = []

        for (symbol, interval), group in groups.items():
            # Sort by start_ms
            group.sort(key=lambda t: t.start_ms)

            merged: list[BackfillTask] = [group[0]]
            for task in group[1:]:
                last = merged[-1]
                interval_ms = parse_interval_ms(interval) or 1

                # Check for overlap or adjacency
                if task.start_ms <= last.end_ms + interval_ms:
                    # Merge: extend the range
                    new_end = max(last.end_ms, task.end_ms)
                    new_estimated = max(
                        1, (new_end - last.start_ms) // interval_ms + 1,
                    )
                    merged[-1] = BackfillTask(
                        symbol=symbol,
                        interval=interval,
                        start_ms=last.start_ms,
                        end_ms=new_end,
                        priority=min(last.priority, task.priority),
                        parent_gap=last.parent_gap,
                        estimated_bars=new_estimated,
                        metadata={**last.metadata, **task.metadata},
                    )
                else:
                    merged.append(task)

            deduplicated.extend(merged)

        before = len(tasks)
        after = len(deduplicated)
        if before != after:
            self._metrics.inc("tasks_merged", before - after)
            logger.debug("Task dedup: %d → %d tasks", before, after)

        return deduplicated

    # ── Internal: Gap priority ───────────────────────────────

    @staticmethod
    def _gap_priority(gap: GapInfo) -> int:
        """Assign a priority to a gap.

        Tail gaps (most recent data) get highest priority (0).
        Interior gaps get medium priority (1).
        Head gaps (oldest data) get lowest priority (2).
        """
        if gap.gap_type == GapType.TAIL:
            return 0
        if gap.gap_type == GapType.INTERIOR:
            return 1
        return 2
