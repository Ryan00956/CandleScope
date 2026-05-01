from __future__ import annotations

import asyncio
from pathlib import Path

from app.data_engine.data_manager import DataManager


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
