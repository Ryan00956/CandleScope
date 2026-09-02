"""Single composition root for DataEngine market-storage schemas."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import klines_repo
from .liquidation_store import init_liquidation_storage
from .market_metrics_repo import init_market_metrics_storage
from .sqlite_runtime import open_sqlite
from .trade_flow_store import init_trade_flow_storage

_MANIFEST_SCHEMA_VERSION = 1


@dataclass(frozen=True, slots=True)
class MarketStorageComponent:
    component: str
    backend: str
    path: Path | None
    schema_version: int
    initialized: bool
    roles: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "component": self.component,
            "backend": self.backend,
            "path": str(self.path) if self.path is not None else None,
            "schema_version": self.schema_version,
            "initialized": self.initialized,
            "roles": list(self.roles),
        }


@dataclass(frozen=True, slots=True)
class MarketStorageBootstrapReport:
    manifest_path: Path
    manifest_schema_version: int
    components: tuple[MarketStorageComponent, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "candlescope.market-storage-bootstrap/1",
            "manifest_path": str(self.manifest_path),
            "manifest_schema_version": self.manifest_schema_version,
            "components": [component.to_dict() for component in self.components],
        }


def _record_manifest(
    manifest_path: Path,
    components: tuple[MarketStorageComponent, ...],
) -> None:
    now_ms = int(time.time() * 1000)
    with open_sqlite(manifest_path) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS market_storage_schema (
                component TEXT PRIMARY KEY,
                backend TEXT NOT NULL,
                storage_path TEXT,
                schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
                initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)),
                roles TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            )
            """,
        )
        for component in components:
            connection.execute(
                """
                INSERT INTO market_storage_schema (
                    component, backend, storage_path, schema_version,
                    initialized, roles, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(component) DO UPDATE SET
                    backend = excluded.backend,
                    storage_path = excluded.storage_path,
                    schema_version = excluded.schema_version,
                    initialized = excluded.initialized,
                    roles = excluded.roles,
                    updated_at_ms = excluded.updated_at_ms
                """,
                (
                    component.component,
                    component.backend,
                    str(component.path) if component.path is not None else None,
                    component.schema_version,
                    int(component.initialized),
                    ",".join(component.roles),
                    now_ms,
                ),
            )


def _preflight_manifest(
    manifest_path: Path,
    components: tuple[MarketStorageComponent, ...],
) -> None:
    """Reject newer registered schemas before any domain initializer runs."""

    if not manifest_path.exists():
        return
    with open_sqlite(manifest_path) as connection:
        exists = connection.execute(
            """
            SELECT 1
            FROM sqlite_schema
            WHERE type = 'table' AND name = 'market_storage_schema'
            """,
        ).fetchone()
        if exists is None:
            return
        installed = {
            str(row[0]): int(row[1])
            for row in connection.execute(
                "SELECT component, schema_version FROM market_storage_schema",
            )
        }
    for component in components:
        current = installed.get(component.component)
        if current is not None and current > component.schema_version:
            raise RuntimeError(
                "market storage schema is newer than this runtime: "
                f"{component.component}={current}>{component.schema_version}",
            )


def initialize_market_storage(
    *,
    klines_db_path: Path | str,
    trade_flow_backend: str,
    trade_flow_db_path: Path | str,
    liquidation_backend: str,
    liquidation_db_path: Path | str,
) -> MarketStorageBootstrapReport:
    """Initialize registered schemas without changing their physical split."""

    main_path = Path(klines_db_path)
    configured_kline_path = Path(klines_repo.KLINES_DB_PATH)
    if main_path.resolve() != configured_kline_path.resolve():
        raise ValueError(
            "market storage bootstrap K-line path does not match KLINES_DB_PATH",
        )

    trade_backend = trade_flow_backend.strip().lower()
    liquidation_backend_name = liquidation_backend.strip().lower()
    trade_path = Path(trade_flow_db_path)
    liquidation_path = Path(liquidation_db_path)

    components = (
        MarketStorageComponent(
            component="bars",
            backend="sqlite",
            path=main_path,
            schema_version=2,
            initialized=True,
            roles=("kline_history", "history_archive_imports"),
        ),
        MarketStorageComponent(
            component="market_metrics",
            backend="sqlite",
            path=main_path,
            schema_version=1,
            initialized=True,
            roles=("funding_rate", "premium_index", "open_interest"),
        ),
        MarketStorageComponent(
            component="trade_flow_rollup",
            backend=trade_backend,
            path=trade_path,
            schema_version=1,
            initialized=trade_backend == "sqlite",
            roles=("agg_trade_rollup_1m",),
        ),
        MarketStorageComponent(
            component="liquidation_rollup",
            backend=liquidation_backend_name,
            path=liquidation_path,
            schema_version=1,
            initialized=liquidation_backend_name == "sqlite",
            roles=("liquidation_rollup_1m",),
        ),
    )
    _preflight_manifest(main_path, components)

    klines_repo.init_klines_storage()
    init_market_metrics_storage(main_path)
    if trade_backend == "sqlite":
        init_trade_flow_storage(trade_path)
    if liquidation_backend_name == "sqlite":
        init_liquidation_storage(liquidation_path)

    _record_manifest(main_path, components)
    return MarketStorageBootstrapReport(
        manifest_path=main_path,
        manifest_schema_version=_MANIFEST_SCHEMA_VERSION,
        components=components,
    )


__all__ = [
    "MarketStorageBootstrapReport",
    "MarketStorageComponent",
    "initialize_market_storage",
]
