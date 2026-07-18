"""Retention and startup cleanup service for DataManager."""
from __future__ import annotations

import asyncio
import logging
import math
import time
from collections.abc import Callable
from typing import Any

from app.data_engine.interval_policy import (
    get_tier_for_interval,
    is_custom_interval,
    is_ephemeral_interval,
    parse_interval_ms,
)

from .cache import BarCache
from .event_bus import DataEventBus
from .models import SeriesKey, StorageBackend
from .runtime_pressure import build_storage_watermarks
from .storage_intents import StorageIntentRegistry

logger = logging.getLogger("data_manager.retention")

StorageProvider = Callable[[], StorageBackend | None]
BUDGET_PRESSURE_LEVELS = {"high", "critical", "over_budget"}
AUTO_PROTECTED_RISK_FLAGS = {"active-or-subscribed", "storage-intent", "custom-interval"}
STORAGE_PLAN_TTL_MS = 30_000


class RetentionService:
    """Owns persistent and ephemeral retention maintenance."""

    def __init__(
        self,
        *,
        cache: BarCache,
        event_bus: DataEventBus,
        storage_provider: StorageProvider,
        db_limits: dict[str, int] | None = None,
        sqlite_budget_bytes: int | None = None,
        storage_row_limits_enabled: bool = False,
    ) -> None:
        self._cache = cache
        self._event_bus = event_bus
        self._storage_provider = storage_provider
        self.db_limits: dict[str, int] = db_limits or {
            "minutes": 200_000,
            "hours": 50_000,
            "daily": 0,
        }
        self.sqlite_budget_bytes = _optional_positive_int(sqlite_budget_bytes)
        self.storage_row_limits_enabled = bool(storage_row_limits_enabled)

    def update_limits(
        self,
        *,
        db_limits: dict[str, int] | None = None,
        ephemeral_bars: int | None = None,
        sqlite_budget_bytes: int | None = None,
        storage_row_limits_enabled: bool | None = None,
    ) -> None:
        """Update DB and ephemeral cache retention limits."""
        if db_limits is not None:
            self.db_limits.update(db_limits)
            logger.info("DB retention limits updated: %s", self.db_limits)
        if ephemeral_bars is not None:
            self._cache.set_ephemeral_limit(ephemeral_bars)
            logger.info("Ephemeral cache limit updated: %d bars", ephemeral_bars)
        if sqlite_budget_bytes is not None:
            self.sqlite_budget_bytes = _optional_positive_int(sqlite_budget_bytes)
            logger.info("SQLite storage budget updated: %s bytes", self.sqlite_budget_bytes)
        if storage_row_limits_enabled is not None:
            self.storage_row_limits_enabled = bool(storage_row_limits_enabled)
            logger.info("Storage row limits enabled: %s", self.storage_row_limits_enabled)

    def snapshot(self) -> dict:
        return {
            "db_limits": dict(self.db_limits),
            "ephemeral_bars": self._cache.get_ephemeral_limit(),
            "sqlite_budget_bytes": self.sqlite_budget_bytes,
            "storage_row_limits_enabled": self.storage_row_limits_enabled,
        }

    def plan_storage_gc(
        self,
        *,
        db_limits: dict[str, int] | None = None,
        sqlite_budget_bytes: int | None = None,
        storage_row_limits_enabled: bool | None = None,
        protected_keys: set[SeriesKey] | None = None,
        storage_intents: StorageIntentRegistry | None = None,
        behavior_heat: dict[str, dict[str, Any]] | None = None,
        runtime_pressure: dict[str, Any] | None = None,
        scoring: str = "smart",
        file_snapshot: dict[str, Any] | None = None,
    ) -> dict:
        """Plan SQLite retention cleanup without deleting rows."""
        generated_at_ms = int(time.time() * 1000)
        plan_identity = {
            "generated_at_ms": generated_at_ms,
            "expires_at_ms": generated_at_ms + STORAGE_PLAN_TTL_MS,
            "planner_version": 2,
        }
        storage = self._storage_provider()
        limits = {**self.db_limits, **(db_limits or {})}
        effective_budget = (
            _optional_positive_int(sqlite_budget_bytes)
            if sqlite_budget_bytes is not None
            else self.sqlite_budget_bytes
        )
        row_limits_enabled = (
            bool(storage_row_limits_enabled)
            if storage_row_limits_enabled is not None
            else self.storage_row_limits_enabled
        )
        files = file_snapshot or {}
        runtime_pressure = runtime_pressure or {}
        watermarks = build_storage_watermarks(
            storage_files=files,
            disk=runtime_pressure.get("disk") or {},
            sqlite_budget_bytes=effective_budget,
        )
        unavailable_budget_gap = (
            int(watermarks.get("required_physical_relief_bytes", 0) or 0)
            if watermarks.get("level") in BUDGET_PRESSURE_LEVELS
            else 0
        )
        if storage is None:
            return {
                **plan_identity,
                "mode": "dry-run",
                "owner": "sqlite-storage",
                "available": False,
                "reason": "storage-unavailable",
                "policy": {
                    "db_limits": limits,
                    "sqlite_budget_bytes": effective_budget,
                    "storage_row_limits_enabled": row_limits_enabled,
                },
                "watermarks": watermarks,
                "storage_intents": storage_intents.snapshot() if storage_intents else None,
                "series": [],
                "would_delete_rows": 0,
                "would_free_estimated_bytes": 0,
                "unable_to_reach_budget": unavailable_budget_gap > 0,
                "budget_gap_bytes": unavailable_budget_gap,
            }

        try:
            list_all_series = getattr(storage, "list_all_series", None)
            if callable(list_all_series):
                series_list = list_all_series()
            else:
                series_list = storage.list_series()
        except Exception as exc:
            logger.warning("Storage GC dry-run: failed to list series: %s", exc)
            return {
                **plan_identity,
                "mode": "dry-run",
                "owner": "sqlite-storage",
                "available": False,
                "reason": "list-series-failed",
                "error": str(exc),
                "policy": {
                    "db_limits": limits,
                    "sqlite_budget_bytes": effective_budget,
                    "storage_row_limits_enabled": row_limits_enabled,
                },
                "watermarks": watermarks,
                "storage_intents": storage_intents.snapshot() if storage_intents else None,
                "series": [],
                "would_delete_rows": 0,
                "would_free_estimated_bytes": 0,
                "unable_to_reach_budget": unavailable_budget_gap > 0,
                "budget_gap_bytes": unavailable_budget_gap,
            }

        protected = protected_keys or set()
        total_rows = sum(int(item.get("total_count", 0) or 0) for item in series_list)
        storage_bytes = int(
            files.get("physical_size_bytes", files.get("total_size_bytes", 0)) or 0
        )
        owner_attribution_available = bool(
            files.get("owner_attribution_available", False)
        )
        klines_managed_bytes = int(files.get("klines_managed_bytes", 0) or 0)
        allocation_bytes = (
            klines_managed_bytes
            if owner_attribution_available
            else 0
        )
        bytes_per_row = (
            allocation_bytes / total_rows
            if total_rows > 0 and allocation_bytes > 0
            else 0
        )
        required_logical_relief = int(
            watermarks.get("required_logical_relief_bytes", 0) or 0
        )
        required_klines_relief = int(
            watermarks.get("required_klines_relief_bytes", 0) or 0
        )
        budget_pressure = (
            watermarks.get("level") in BUDGET_PRESSURE_LEVELS
            and required_klines_relief > 0
        )
        candidates: list[dict[str, Any]] = []

        for item in series_list:
            interval = str(item.get("interval") or "").strip()
            symbol = str(item.get("symbol") or "").strip().upper()
            exchange = str(item.get("exchange") or "binance").strip().lower()
            market_type = str(item.get("market_type") or "spot").strip().lower()
            if not symbol or not interval or is_ephemeral_interval(interval):
                continue

            tier = get_tier_for_interval(interval)
            key = SeriesKey(symbol, interval, exchange=exchange, market_type=market_type)
            base_keep_rows = int(limits.get(tier, 0) or 0)
            matched_intents = (
                [intent.to_dict() for intent in storage_intents.match(key)]
                if storage_intents is not None
                else []
            )
            intent_keep_rows = max(
                (
                    int(item.get("effective_keep_rows", 0) or 0)
                    for item in matched_intents
                ),
                default=0,
            )
            row_limit_keep_rows = (
                storage_intents.effective_keep_rows(key, base_keep_rows)
                if storage_intents is not None and row_limits_enabled
                else base_keep_rows if row_limits_enabled else 0
            )
            current_rows = int(item.get("total_count", 0) or 0)
            row_limit_delete_rows = 0
            if row_limits_enabled and row_limit_keep_rows > 0 and current_rows > row_limit_keep_rows:
                row_limit_delete_rows = current_rows - row_limit_keep_rows

            budget_floor_rows = max(1, intent_keep_rows)
            if row_limits_enabled and row_limit_keep_rows > 0:
                budget_floor_rows = max(budget_floor_rows, row_limit_keep_rows)
            budget_capacity_rows = (
                max(0, current_rows - budget_floor_rows)
                if budget_pressure
                else 0
            )
            max_delete_rows = max(row_limit_delete_rows, budget_capacity_rows)
            if max_delete_rows <= 0:
                continue

            risk_flags = self._storage_gc_risk_flags(
                key=key,
                item=item,
                protected=key in protected,
                has_storage_intent=bool(matched_intents),
            )
            victim = {
                "owner": "sqlite-storage",
                "key": str(key),
                "exchange": exchange,
                "market_type": market_type,
                "symbol": symbol,
                "interval": interval,
                "tier": tier,
                "current_rows": current_rows,
                "base_keep_rows": base_keep_rows,
                "row_limit_keep_rows": row_limit_keep_rows,
                "budget_keep_ratio": None,
                "allocation_mode": "required-relief-v2",
                "budget_floor_rows": budget_floor_rows,
                "max_deletable_rows": max_delete_rows,
                "keep_rows": current_rows - max_delete_rows,
                "would_delete_rows": max_delete_rows,
                "would_free_estimated_bytes": int(max_delete_rows * bytes_per_row),
                "earliest_open_time": item.get("earliest_open_time"),
                "latest_open_time": item.get("latest_open_time"),
                "reason": (
                    f"{tier}-tier-retention"
                    if row_limit_delete_rows > 0
                    else "sqlite-budget-required-relief"
                ),
                "risk_flags": risk_flags,
                "storage_intents": matched_intents,
                "_row_limit_delete_rows": row_limit_delete_rows,
                "_budget_capacity_rows": budget_capacity_rows,
            }
            if scoring == "smart":
                victim.update(self._storage_gc_scores(
                    victim,
                    behavior_heat=behavior_heat or {},
                    watermarks=watermarks,
                ))
            candidates.append(victim)

        if scoring == "smart":
            candidates.sort(key=lambda row: -float(row.get("scores", {}).get("finalEvictScore", 0) or 0))
        else:
            candidates.sort(key=lambda row: int(row["would_delete_rows"]), reverse=True)

        # Hard row-retention deletes are planned first.  Budget pressure then
        # allocates only the additional rows needed to reach the target.  The
        # last victim is partial, bounding estimate overshoot to one row rather
        # than applying a fixed percentage to every series.
        row_limit_relief = sum(
            int(row.get("_row_limit_delete_rows", 0) or 0) * bytes_per_row
            for row in candidates
            if not (
                AUTO_PROTECTED_RISK_FLAGS
                & set(row.get("risk_flags") or [])
            )
        )
        remaining_relief = max(0, required_klines_relief - int(row_limit_relief))
        for row in candidates:
            planned_rows = int(row.get("_row_limit_delete_rows", 0) or 0)
            capacity_rows = int(row.get("_budget_capacity_rows", 0) or 0)
            extra_capacity = max(0, capacity_rows - planned_rows)
            flags = set(row.get("risk_flags") or [])
            budget_rows = 0
            if (
                remaining_relief > 0
                and bytes_per_row > 0
                and extra_capacity > 0
                and not (AUTO_PROTECTED_RISK_FLAGS & flags)
            ):
                budget_rows = min(
                    extra_capacity,
                    max(1, math.ceil(remaining_relief / bytes_per_row)),
                )
                remaining_relief = max(
                    0,
                    remaining_relief - int(budget_rows * bytes_per_row),
                )

            planned_rows += budget_rows
            row["would_delete_rows"] = planned_rows
            row["keep_rows"] = int(row["current_rows"]) - planned_rows
            row["would_free_estimated_bytes"] = int(planned_rows * bytes_per_row)
            if budget_rows > 0 and int(row.get("_row_limit_delete_rows", 0) or 0) > 0:
                row["reason"] = f"{row['tier']}-tier-retention+sqlite-budget-required-relief"
            elif budget_rows > 0:
                row["reason"] = "sqlite-budget-required-relief"

        victims = [row for row in candidates if int(row.get("would_delete_rows", 0) or 0) > 0]
        for row in victims:
            row.pop("_row_limit_delete_rows", None)
            row.pop("_budget_capacity_rows", None)
            if scoring == "smart":
                row.update(self._storage_gc_scores(
                    row,
                    behavior_heat=behavior_heat or {},
                    watermarks=watermarks,
                ))

        if scoring == "smart":
            victims.sort(key=lambda row: -float(row.get("scores", {}).get("finalEvictScore", 0) or 0))
        else:
            victims.sort(key=lambda row: int(row["would_delete_rows"]), reverse=True)
        would_delete_rows = sum(int(row["would_delete_rows"]) for row in victims)
        would_free_estimated_bytes = sum(int(row["would_free_estimated_bytes"]) for row in victims)
        auto_eligible_free_bytes = sum(
            int(row.get("would_free_estimated_bytes", 0) or 0)
            for row in victims
            if not (AUTO_PROTECTED_RISK_FLAGS & set(row.get("risk_flags") or []))
        )
        required_free_bytes = required_klines_relief
        owner_relief_gap_bytes = int(
            watermarks.get("owner_relief_gap_bytes", 0) or 0
        )
        if (
            watermarks.get("level") in BUDGET_PRESSURE_LEVELS
            and not watermarks.get("relief_planning_available", True)
        ):
            budget_gap_bytes = int(
                watermarks.get("required_physical_relief_bytes", 0) or 0
            )
        else:
            budget_gap_bytes = owner_relief_gap_bytes + (
                max(0, required_free_bytes - auto_eligible_free_bytes)
                if budget_pressure and required_free_bytes > 0
                else 0
            )
        db_size = int(files.get("db_size_bytes", 0) or 0)
        wal_size = int(files.get("wal_size_bytes", 0) or 0)
        return {
            **plan_identity,
            "mode": "dry-run",
            "owner": "sqlite-storage",
            "scoringVersion": 1 if scoring == "smart" else 0,
            "available": True,
            "policy": {
                "db_limits": limits,
                "sqlite_budget_bytes": effective_budget,
                "storage_row_limits_enabled": row_limits_enabled,
            },
            "runtimePressure": runtime_pressure,
            "watermarks": watermarks,
            "storage_intents": storage_intents.snapshot() if storage_intents else None,
            "db_size_bytes": db_size,
            "wal_size_bytes": wal_size,
            "total_size_bytes": storage_bytes,
            "series_count": len(series_list),
            "total_rows": total_rows,
            "victim_count": len(victims),
            "would_delete_rows": would_delete_rows,
            "would_free_estimated_bytes": would_free_estimated_bytes,
            "required_physical_relief_bytes": int(
                watermarks.get("required_physical_relief_bytes", 0) or 0
            ),
            "required_logical_relief_bytes": required_logical_relief,
            "required_klines_relief_bytes": required_klines_relief,
            "owner_attribution_available": owner_attribution_available,
            "klines_managed_bytes": klines_managed_bytes,
            "unmanaged_bytes": int(files.get("unmanaged_bytes", 0) or 0),
            "checkpoint_relief_bytes": int(
                watermarks.get("checkpoint_relief_bytes", 0) or 0
            ),
            "compaction_relief_bytes": int(
                watermarks.get("compaction_relief_bytes", 0) or 0
            ),
            "estimated_bytes_per_row": round(bytes_per_row, 6),
            "unable_to_reach_budget": budget_gap_bytes > 0,
            "budget_gap_bytes": budget_gap_bytes,
            "vacuum_recommended": bool(
                watermarks.get("compaction_relief_bytes", 0)
            ) or (
                would_delete_rows > 0
                and (
                    required_klines_relief > 0
                    or db_size > 128 * 1024 * 1024
                )
            ),
            "checkpoint_recommended": (
                bool(watermarks.get("checkpoint_first"))
                or wal_size > 64 * 1024 * 1024
            ),
            "physical_compaction_pending": bool(
                watermarks.get("physical_compaction_pending")
            ),
            "series": victims,
        }

    def _storage_gc_risk_flags(
        self,
        *,
        key: SeriesKey,
        item: dict,
        protected: bool,
        has_storage_intent: bool = False,
    ) -> list[str]:
        flags: list[str] = []
        if protected:
            flags.append("active-or-subscribed")
        if has_storage_intent:
            flags.append("storage-intent")
        if is_custom_interval(key.interval):
            flags.append("custom-interval")
        latest = item.get("latest_open_time")
        interval_ms = parse_interval_ms(key.interval) or 0
        if latest and interval_ms > 0:
            if int(time.time() * 1000) - int(latest) <= interval_ms * 3:
                flags.append("latest-data-close-to-now")
        return flags

    def _storage_gc_scores(
        self,
        victim: dict[str, Any],
        *,
        behavior_heat: dict[str, dict[str, Any]],
        watermarks: dict[str, Any],
    ) -> dict[str, Any]:
        heat = behavior_heat.get(str(victim.get("key") or ""), {})
        heat_score = float(heat.get("heat_score", 0) or 0)
        reuse_probability = min(100.0, heat_score * 8 + int(heat.get("switch_count_24h", 0) or 0) * 12)
        matched_intents = victim.get("storage_intents") or []
        intent_rank = max((
            {"weak": 1, "normal": 2, "strong": 3}.get(str(item.get("priority") or "").lower(), 0)
            for item in matched_intents
        ), default=0)
        restore_cost, restore_reason = self._storage_restore_cost(victim, matched_intents)
        pressure_score = 0.0
        if watermarks.get("level") == "over_budget":
            pressure_score = 100.0
        elif watermarks.get("level") == "critical":
            pressure_score = 80.0
        elif watermarks.get("level") == "high":
            pressure_score = 45.0
        gc_value = min(100.0, float(victim.get("would_free_estimated_bytes", 0) or 0) / (1024 * 1024) * 10)
        gc_value += min(35.0, float(victim.get("would_delete_rows", 0) or 0) / 10_000)
        final = max(0.0, gc_value + pressure_score - reuse_probability - restore_cost - intent_rank * 14)
        reuse_reason = "no-recent-heat"
        if reuse_probability >= 60:
            reuse_reason = "hot-series"
        elif reuse_probability >= 20:
            reuse_reason = "recently-reused"
        return {
            "behaviorHeat": heat,
            "matchedIntents": matched_intents,
            "restoreCostReason": restore_reason,
            "reuseReason": reuse_reason,
            "scores": {
                "gcValueScore": round(gc_value, 3),
                "restoreCostScore": round(restore_cost, 3),
                "reuseProbabilityScore": round(reuse_probability, 3),
                "pressureScore": round(pressure_score, 3),
                "finalEvictScore": round(final, 3),
            },
        }

    @staticmethod
    def _storage_restore_cost(victim: dict[str, Any], matched_intents: list[dict[str, Any]]) -> tuple[float, str]:
        if any("alert" in str(item.get("source", "")) for item in matched_intents):
            return 85.0, "alert-workflow"
        if any(item.get("stream_required") for item in matched_intents):
            return 70.0, "stream-required-intent"
        if "custom-interval" in (victim.get("risk_flags") or []):
            return 75.0, "custom-interval-reaggregation"
        if matched_intents:
            return 45.0, "storage-intent"
        return 15.0, "ordinary-sqlite-history"

    def run_startup_db_cleanup(self) -> None:
        """One-time DB cleanup at startup. Runs in a thread."""
        if not self.storage_row_limits_enabled:
            logger.info("Startup DB cleanup skipped: storage row limits disabled")
            return

        storage = self._storage_provider()
        if storage is None:
            return

        try:
            series_list = storage.list_series()
        except Exception as exc:
            logger.warning("Startup cleanup: failed to list series: %s", exc)
            return

        total_deleted = 0
        cleaned_count = 0

        for series in series_list:
            symbol = series.get("symbol", "")
            interval = series.get("interval", "")
            if not symbol or not interval:
                continue

            if is_ephemeral_interval(interval):
                continue

            tier = get_tier_for_interval(interval)
            max_bars = self.db_limits.get(tier, 0)
            if max_bars == 0:
                continue

            try:
                deleted = storage.delete_oldest(
                    symbol=symbol,
                    interval=interval,
                    keep=max_bars,
                )
                if deleted > 0:
                    total_deleted += deleted
                    cleaned_count += 1
                    logger.info(
                        "Startup cleanup: %s@%s deleted %d oldest bars (kept %d)",
                        symbol,
                        interval,
                        deleted,
                        max_bars,
                    )
            except Exception as exc:
                logger.warning(
                    "Startup cleanup failed for %s@%s: %s",
                    symbol,
                    interval,
                    exc,
                )

        if total_deleted > 0:
            logger.info(
                "Startup DB cleanup complete: %d bars deleted across %d series",
                total_deleted,
                cleaned_count,
            )
            print(
                f"[startup] DB cleanup: {total_deleted} bars deleted "
                f"across {cleaned_count} series"
            )
        else:
            logger.info("Startup DB cleanup: all series within limits")

    async def ephemeral_trim_loop(self) -> None:
        """Background loop: trim ephemeral cache series every 30 minutes."""
        try:
            while True:
                await asyncio.sleep(30 * 60)
                await self.run_ephemeral_trim()
        except asyncio.CancelledError:
            pass

    async def run_ephemeral_trim(self) -> None:
        """One pass of ephemeral cache trimming."""
        limit = self._cache.get_ephemeral_limit()
        trimmed_total = 0
        skipped = 0

        for key in self._cache.get_all_keys():
            if not is_ephemeral_interval(key.interval):
                continue

            if self._event_bus.get_subscriber_count(key) > 0:
                skipped += 1
                continue

            trimmed_total += self._cache.trim_series(key, limit)

        if trimmed_total > 0 or skipped > 0:
            logger.info(
                "Ephemeral trim: %d bars trimmed, %d series skipped (active)",
                trimmed_total,
                skipped,
            )


def _optional_positive_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None
