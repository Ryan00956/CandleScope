from __future__ import annotations

import asyncio
from pathlib import Path

from app.data_engine.data_manager import DataManager
from app.data_engine.data_manager.backfill_coordinator import RepairRequest
from app.data_engine.data_manager.maintenance import _request_repairs_bounded


BACKEND_ROOT = Path(__file__).resolve().parents[1]


class _Maintenance:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def repair_custom_storage(self, **kwargs):
        self.calls.append(("repair_custom_storage", kwargs))
        return {"status": "ok", "kind": "repair"}

    async def scan_and_fill_gaps(self, **kwargs):
        self.calls.append(("scan_and_fill_gaps", kwargs))
        return {"status": "ok", "kind": "scan"}

    async def delete_storage_data(self, **kwargs):
        self.calls.append(("delete_storage_data", kwargs))
        return 3


def test_data_manager_exposes_maintenance_facade_methods() -> None:
    async def _run() -> None:
        dm = DataManager()
        maintenance = _Maintenance()
        dm.maintenance = maintenance

        repair = await dm.repair_custom_storage(
            symbols_filter=["BTCUSDT"],
            backfill_coordinator=object(),
            exchange="okx",
            market_type="SPOT",
        )
        scan = await dm.scan_and_fill_storage_gaps(
            symbols_filter=[],
            backfill_coordinator=object(),
            exchange="binance",
            market_type="FUTURES",
        )
        deleted = await dm.delete_storage_data(
            symbol="BTCUSDT",
            interval="1m",
            start_ms=1,
            end_ms=2,
            exchange="binance",
            market_type="SPOT",
        )

        assert repair == {"status": "ok", "kind": "repair"}
        assert scan == {"status": "ok", "kind": "scan"}
        assert deleted == 3
        assert maintenance.calls[0][0] == "repair_custom_storage"
        assert maintenance.calls[0][1]["symbols_filter"] == ["BTCUSDT"]
        assert maintenance.calls[0][1]["backfill_coordinator"] is not None
        assert maintenance.calls[0][1]["exchange"] == "okx"
        assert maintenance.calls[0][1]["market_type"] == "spot"
        assert maintenance.calls[1][0] == "scan_and_fill_gaps"
        assert maintenance.calls[1][1]["market_type"] == "futures"
        assert maintenance.calls[2] == (
            "delete_storage_data",
            {
                "symbol": "BTCUSDT",
                "interval": "1m",
                "start_ms": 1,
                "end_ms": 2,
                "exchange": "binance",
                "market_type": "spot",
            },
        )

    asyncio.run(_run())


def test_interior_gap_repairs_are_bounded_ordered_and_fail_closed() -> None:
    async def _run() -> None:
        class _Coordinator:
            def __init__(self) -> None:
                self.active = 0
                self.max_active = 0

            async def request_and_wait(self, request):
                self.active += 1
                self.max_active = max(self.max_active, self.active)
                try:
                    await asyncio.sleep((10 - request.start_ms) * 0.0001)
                    if request.start_ms == 5:
                        raise RuntimeError("upstream failed")
                    return request.request_id
                finally:
                    self.active -= 1

        coordinator = _Coordinator()
        requests = [
            RepairRequest(
                symbol="BTCUSDT",
                interval="1m",
                start_ms=index,
                end_ms=index,
                request_id=f"gap-{index}",
            )
            for index in range(10)
        ]

        results = await _request_repairs_bounded(
            coordinator,
            requests,
            max_concurrency=3,
        )

        assert coordinator.max_active == 3
        assert [
            value if succeeded else str(value)
            for succeeded, value in results
        ] == [
            "gap-0",
            "gap-1",
            "gap-2",
            "gap-3",
            "gap-4",
            "upstream failed",
            "gap-6",
            "gap-7",
            "gap-8",
            "gap-9",
        ]

    asyncio.run(_run())


def test_api_routes_use_data_manager_maintenance_facade() -> None:
    checked = [
        BACKEND_ROOT / "app/api/v1/settings.py",
        BACKEND_ROOT / "app/api/v1/klines.py",
    ]
    forbidden = (
        "dm.maintenance",
        "query_engine._storage",
        "dm.cache._",
        "dm._db_limits",
        "BackfillEngine(",
        "backfill_engine.run",
        "detect_only",
        "dm.retention.",
        "._cfg",
        "._ingress",
        "._transport",
    )

    offenders: list[str] = []
    for path in checked:
        text = path.read_text(encoding="utf-8", errors="ignore")
        for token in forbidden:
            if token in text:
                offenders.append(f"{path.relative_to(BACKEND_ROOT)}:{token}")

    assert offenders == []
