from __future__ import annotations

import asyncio

from app.api.v1.klines import _schedule_related_interval_warmup
from app.api.v1.related_warmup import (
    RelatedIntervalWarmupScheduler,
    RelatedWarmupSubmission,
)


class _WarmupDataManager:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple, dict]] = []
        self.accept = True

    def request_backfill(self, *args, **kwargs) -> bool:
        self.calls.append((args, kwargs))
        return self.accept


class _Coordinator:
    def __init__(self) -> None:
        self.current = 1
        self.foreground_busy = False

    def is_demand_generation_current(self, _scope: str, generation: int) -> bool:
        return generation >= self.current

    def has_foreground_work(self) -> bool:
        return self.foreground_busy


def _schedule(
    dm: _WarmupDataManager,
    coordinator: _Coordinator,
    scheduler: RelatedIntervalWarmupScheduler,
    *,
    end_ms: int = 10_000_000,
    generation: int = 1,
) -> None:
    _schedule_related_interval_warmup(
        dm,
        symbol="BTCUSDT",
        current_interval="1h",
        start_ms=0,
        end_ms=end_ms,
        exchange="binance",
        market_type="spot",
        coordinator=coordinator,
        demand_scope="chart-test",
        demand_generation=generation,
        demand_owner_id=f"chart-test:{generation}",
        defer_seconds=0.01,
        warmup_scheduler=scheduler,
    )


def test_related_warmup_singleflights_pending_batch_and_ttl_dedupes_targets() -> None:
    async def run() -> tuple[_WarmupDataManager, dict[str, int]]:
        dm = _WarmupDataManager()
        coordinator = _Coordinator()
        scheduler = RelatedIntervalWarmupScheduler(
            ttl_seconds=0.2,
            dwell_seconds=0.01,
            busy_recheck_seconds=0.005,
        )
        for _ in range(20):
            _schedule(dm, coordinator, scheduler)
        await asyncio.sleep(0.04)
        assert len(dm.calls) == 3

        _schedule(dm, coordinator, scheduler)
        await asyncio.sleep(0.04)
        assert len(dm.calls) == 3

        # A new target closed-open/range identity bypasses the older TTL.
        _schedule(dm, coordinator, scheduler, end_ms=10_060_000)
        await asyncio.sleep(0.04)
        snapshot = scheduler.snapshot()
        scheduler.cancel()
        return dm, snapshot

    dm, snapshot = asyncio.run(run())
    assert len(dm.calls) == 6
    assert snapshot["singleflight_joined"] == 19
    assert snapshot["ttl_hits"] == 3
    assert snapshot["submitted"] == 6
    assert snapshot["pending"] == 0


def test_related_warmup_waits_for_foreground_quiet_dwell() -> None:
    async def run() -> tuple[_WarmupDataManager, dict[str, int]]:
        dm = _WarmupDataManager()
        coordinator = _Coordinator()
        coordinator.foreground_busy = True
        scheduler = RelatedIntervalWarmupScheduler(
            ttl_seconds=1,
            dwell_seconds=0.01,
            busy_recheck_seconds=0.005,
        )
        _schedule(dm, coordinator, scheduler)
        await asyncio.sleep(0.03)
        assert dm.calls == []

        coordinator.foreground_busy = False
        await asyncio.sleep(0.03)
        snapshot = scheduler.snapshot()
        scheduler.cancel()
        return dm, snapshot

    dm, snapshot = asyncio.run(run())
    assert len(dm.calls) == 3
    assert snapshot["foreground_deferred"] >= 1


def test_related_warmup_keeps_only_latest_scope_generation_during_dwell() -> None:
    async def run() -> tuple[_WarmupDataManager, dict[str, int]]:
        dm = _WarmupDataManager()
        coordinator = _Coordinator()
        scheduler = RelatedIntervalWarmupScheduler(
            ttl_seconds=1,
            dwell_seconds=0.01,
            busy_recheck_seconds=0.005,
        )
        _schedule(dm, coordinator, scheduler, generation=1)
        coordinator.current = 2
        _schedule(dm, coordinator, scheduler, generation=2)
        await asyncio.sleep(0.04)
        snapshot = scheduler.snapshot()
        scheduler.cancel()
        return dm, snapshot

    dm, snapshot = asyncio.run(run())
    assert len(dm.calls) == 3
    assert {
        kwargs["metadata"]["demand_generation"]
        for _, kwargs in dm.calls
    } == {2}
    assert snapshot["singleflight_joined"] == 1


def test_rejected_related_warmup_does_not_poison_ttl() -> None:
    async def run() -> tuple[_WarmupDataManager, dict[str, int]]:
        dm = _WarmupDataManager()
        coordinator = _Coordinator()
        scheduler = RelatedIntervalWarmupScheduler(
            ttl_seconds=1,
            dwell_seconds=0.01,
            busy_recheck_seconds=0.005,
        )
        dm.accept = False
        _schedule(dm, coordinator, scheduler)
        await asyncio.sleep(0.04)
        assert len(dm.calls) == 3

        dm.accept = True
        _schedule(dm, coordinator, scheduler)
        await asyncio.sleep(0.04)
        snapshot = scheduler.snapshot()
        scheduler.cancel()
        return dm, snapshot

    dm, snapshot = asyncio.run(run())
    assert len(dm.calls) == 6
    assert snapshot["submit_failed"] == 3
    assert snapshot["submitted"] == 3
    assert snapshot["ttl_entries"] == 3


def test_related_warmup_cancel_releases_pending_timer_without_submission() -> None:
    async def run() -> tuple[_WarmupDataManager, dict[str, int]]:
        dm = _WarmupDataManager()
        coordinator = _Coordinator()
        scheduler = RelatedIntervalWarmupScheduler(
            ttl_seconds=1,
            dwell_seconds=0.05,
            busy_recheck_seconds=0.005,
        )
        _schedule_related_interval_warmup(
            dm,
            symbol="BTCUSDT",
            current_interval="1h",
            start_ms=0,
            end_ms=10_000_000,
            exchange="binance",
            market_type="spot",
            coordinator=coordinator,
            demand_scope="chart-cancel",
            demand_generation=1,
            defer_seconds=0.05,
            warmup_scheduler=scheduler,
        )
        scheduler.cancel()
        await asyncio.sleep(0.06)
        return dm, scheduler.snapshot()

    dm, snapshot = asyncio.run(run())
    assert dm.calls == []
    assert snapshot["pending"] == 0
    assert snapshot["ttl_entries"] == 0


def test_related_warmup_ttl_expires_and_allows_same_target_again() -> None:
    async def run() -> tuple[_WarmupDataManager, dict[str, int]]:
        now = [10.0]
        dm = _WarmupDataManager()
        coordinator = _Coordinator()
        scheduler = RelatedIntervalWarmupScheduler(
            ttl_seconds=1,
            dwell_seconds=0.005,
            busy_recheck_seconds=0.005,
            now=lambda: now[0],
        )
        _schedule(dm, coordinator, scheduler)
        now[0] += 0.02
        await asyncio.sleep(0.02)
        assert len(dm.calls) == 3

        now[0] += 1.01
        _schedule(dm, coordinator, scheduler)
        now[0] += 0.02
        await asyncio.sleep(0.02)
        snapshot = scheduler.snapshot()
        scheduler.cancel()
        return dm, snapshot

    dm, snapshot = asyncio.run(run())
    assert len(dm.calls) == 6
    assert snapshot["submitted"] == 6
    assert snapshot["ttl_entries"] == 3


def test_related_warmup_bounds_pending_and_ttl_registries() -> None:
    async def run() -> tuple[dict[str, int], dict[str, int]]:
        submitted: list[int] = []
        scheduler = RelatedIntervalWarmupScheduler(
            ttl_seconds=10,
            dwell_seconds=0.05,
            busy_recheck_seconds=0.005,
            max_entries=2,
        )
        for index in range(3):
            scheduler.schedule(
                ("pending", index),
                prepare=lambda index=index: (
                    RelatedWarmupSubmission(
                        key=("target", index),
                        submit=lambda index=index: submitted.append(index) is None,
                    ),
                ),
                dwell_seconds=0.05,
            )
        pending_snapshot = scheduler.snapshot()
        await asyncio.sleep(0.07)
        ttl_snapshot = scheduler.snapshot()
        scheduler.cancel()
        return pending_snapshot, ttl_snapshot

    pending_snapshot, ttl_snapshot = asyncio.run(run())
    assert pending_snapshot["pending"] == 2
    assert pending_snapshot["evicted"] == 1
    assert ttl_snapshot["pending"] == 0
    assert ttl_snapshot["ttl_entries"] == 2
