"""Optional raw ``aggTrade`` Parquet archive for deterministic replay.

The synchronous archive contract is deliberately separate from the rollup
database contract.  ``RawAggTradeArchiveWriter`` is the only async entrypoint
used by the live pipeline: it applies bounded backpressure, combines pending
batches, and sends all Parquet I/O to the shared storage executor.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Protocol, runtime_checkable
from urllib.parse import quote
from uuid import uuid4

from app.core.executors import run_storage


ARCHIVE_SCHEMA_VERSION = "1"
RAW_AGG_TRADE_COLUMNS = (
    "exchange",
    "market_type",
    "symbol",
    "agg_trade_id",
    "first_trade_id",
    "last_trade_id",
    "price",
    "quantity",
    "quote_quantity",
    "trade_time_ms",
    "event_time_ms",
    "received_at_ms",
    "is_buyer_maker",
    "source",
)


@runtime_checkable
class RawAggTradeArchive(Protocol):
    """Synchronous raw-archive backend called only from a storage worker."""

    @property
    def enabled(self) -> bool:
        """Whether raw archival is enabled."""

    def append(self, rows: Iterable[dict[str, Any]]) -> int:
        """Persist rows, returning the accepted input count.

        Backends only promise atomic publication of each immutable output
        object.  A batch spanning multiple files is not a transaction; retry
        overlap is reconciled by aggregate-trade ID during reads.
        """

    def scan_range(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_time_ms: int | None = None,
        end_time_ms: int | None = None,
        start_agg_trade_id: int | None = None,
        end_agg_trade_id: int | None = None,
        limit: int = 100_000,
    ) -> list[dict[str, Any]]:
        """Read a replay range without exposing the archive layout."""

    def coverage(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_time_ms: int | None = None,
        end_time_ms: int | None = None,
        expected_start_agg_trade_id: int | None = None,
        expected_end_agg_trade_id: int | None = None,
    ) -> "RawAggTradeCoverage":
        """Describe ID coverage and internal gaps for replay planning."""

    def diagnostics(self) -> dict[str, Any]:
        """Return archive backend state."""


class DisabledRawAggTradeArchive:
    """Explicit no-op used when raw replay data is not configured."""

    enabled = False

    def append(self, rows: Iterable[dict[str, Any]]) -> int:
        # Consume nothing: callers may pass generators and disabled mode must
        # stay allocation-free on the high-frequency path.
        del rows
        return 0

    def scan_range(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_time_ms: int | None = None,
        end_time_ms: int | None = None,
        start_agg_trade_id: int | None = None,
        end_agg_trade_id: int | None = None,
        limit: int = 100_000,
    ) -> list[dict[str, Any]]:
        del (
            exchange,
            market_type,
            symbol,
            start_time_ms,
            end_time_ms,
            start_agg_trade_id,
            end_agg_trade_id,
            limit,
        )
        return []

    def coverage(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_time_ms: int | None = None,
        end_time_ms: int | None = None,
        expected_start_agg_trade_id: int | None = None,
        expected_end_agg_trade_id: int | None = None,
    ) -> "RawAggTradeCoverage":
        complete = (
            False
            if expected_start_agg_trade_id is not None
            and expected_end_agg_trade_id is not None
            else None
        )
        return RawAggTradeCoverage(
            enabled=False,
            backend="disabled",
            exchange=str(exchange).lower(),
            market_type=str(market_type).lower(),
            symbol=str(symbol).upper(),
            start_time_ms=start_time_ms,
            end_time_ms=end_time_ms,
            row_count=0,
            file_count=0,
            earliest_agg_trade_id=None,
            latest_agg_trade_id=None,
            earliest_trade_time_ms=None,
            latest_trade_time_ms=None,
            gaps=(),
            complete=complete,
            status="disabled",
        )

    def diagnostics(self) -> dict[str, Any]:
        return {"enabled": False, "backend": "disabled"}


@dataclass(frozen=True, slots=True)
class RawAggTradeGap:
    """An internal missing aggregate-trade ID interval."""

    start_agg_trade_id: int
    end_agg_trade_id: int
    missing_count: int


@dataclass(frozen=True, slots=True)
class RawAggTradeCoverage:
    """Replay coverage result; ``complete`` is unknown without expected bounds."""

    enabled: bool
    backend: str
    exchange: str
    market_type: str
    symbol: str
    start_time_ms: int | None
    end_time_ms: int | None
    row_count: int
    file_count: int
    earliest_agg_trade_id: int | None
    latest_agg_trade_id: int | None
    earliest_trade_time_ms: int | None
    latest_trade_time_ms: int | None
    gaps: tuple[RawAggTradeGap, ...]
    complete: bool | None
    status: str = "ready"
    error: str | None = None
    truncated: bool = False
    estimated_row_count: int | None = None
    estimated_physical_row_count: int | None = None
    scanned_row_count: int = 0
    limit_kind: str | None = None


@dataclass(frozen=True, slots=True)
class _FileManifest:
    path: Path
    row_count: int
    min_agg_trade_id: int
    max_agg_trade_id: int
    min_trade_time_ms: int
    max_trade_time_ms: int
    first_trade_time_ms: int
    first_agg_trade_id: int

    @property
    def first_order_key(self) -> tuple[int, int]:
        return (self.first_trade_time_ms, self.first_agg_trade_id)


class RawAggTradeScanLimitError(RuntimeError):
    """The requested archive read cannot be completed inside safety limits."""


class ParquetRawAggTradeArchive:
    """PyArrow-backed partitioned immutable micro-batch archive.

    Layout::

        exchange=binance/market_type=futures/symbol=BTCUSDT/
        date=2026-07-14/part-00000000000000000123-
        00000000000000000456-<uuid>.parquet

    Appends never reread and rewrite an ever-growing shard.  Each Parquet file
    and its metadata sidecar are separately published by atomic rename.  A
    multi-file append is deliberately *not* transactional: readers deduplicate
    retry overlap by ``agg_trade_id`` so partial retries converge eventually.
    Offline compaction may merge small files later without changing this
    contract.
    """

    enabled = True

    def __init__(
        self,
        root: Path | str,
        *,
        max_rows_per_file: int = 100_000,
        compression: str = "zstd",
        scan_batch_size: int = 4096,
        max_scan_files: int = 2048,
        max_scan_rows: int = 1_000_000,
        max_physical_scan_rows: int = 5_000_000,
    ) -> None:
        self.root = Path(root)
        self.max_rows_per_file = max(1, int(max_rows_per_file))
        self.compression = str(compression).strip() or "zstd"
        self.scan_batch_size = max(1, min(int(scan_batch_size), 65_536))
        self.max_scan_files = max(1, int(max_scan_files))
        self.max_scan_rows = max(1, int(max_scan_rows))
        self.max_physical_scan_rows = max(1, int(max_physical_scan_rows))
        try:
            self._pa, self._pq = _load_pyarrow()
        except (ImportError, ModuleNotFoundError) as exc:
            raise RuntimeError(
                "raw aggTrade Parquet archive is enabled, but pyarrow is not "
                "installed; install pyarrow or disable raw trade archival"
            ) from exc
        self._schema = _parquet_schema(self._pa)
        self._write_lock = Lock()
        self._health_marker_path = self.root / "_archive_health.json"
        durability_error, health_marker_error = self._load_health_marker()
        self._stats = {
            "append_calls": 0,
            "input_rows": 0,
            "files_written": 0,
            "write_failures": 0,
            "manifest_fallbacks": 0,
            "scan_limit_rejections": 0,
            "last_append_error": None,
            "durability_error": durability_error,
            "health_marker_error": health_marker_error,
        }

    def append(self, rows: Iterable[dict[str, Any]]) -> int:
        payload = [_raw_trade_payload(row) for row in rows]
        if not payload:
            return 0
        groups: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
        for row in payload:
            date = _utc_date(row["trade_time_ms"])
            key = (
                row["exchange"],
                row["market_type"],
                row["symbol"],
                date,
            )
            groups.setdefault(key, []).append(row)

        with self._write_lock:
            self._stats["append_calls"] += 1
            self._stats["input_rows"] += len(payload)
            try:
                for key, grouped_rows in groups.items():
                    deduplicated = _deduplicate_raw_trades(grouped_rows)
                    for offset in range(0, len(deduplicated), self.max_rows_per_file):
                        self._write_file(
                            key,
                            deduplicated[offset : offset + self.max_rows_per_file],
                        )
            except Exception as exc:
                self._stats["write_failures"] += 1
                self._stats["last_append_error"] = str(exc)[:500]
                raise
            else:
                self._stats["last_append_error"] = None
        return len(payload)

    def record_writer_failure(self, error: str) -> None:
        """Stickily mark possible loss after the async writer exhausts retries."""

        with self._write_lock:
            durability_error = str(error)[:500]
            self._stats["durability_error"] = durability_error
            try:
                self._persist_health_marker(durability_error)
            except Exception as exc:
                # The original durability failure must remain visible even if
                # the marker cannot be published.  This method is called from
                # the writer task and therefore must never terminate it.
                marker_error = f"failed to persist health marker: {exc}"[:500]
                self._stats["health_marker_error"] = marker_error
                self._stats["durability_error"] = (
                    f"{durability_error}; {marker_error}"
                )[:500]

    def _load_health_marker(self) -> tuple[str | None, str | None]:
        try:
            if not self._health_marker_path.exists():
                return None, None
            payload = json.loads(
                self._health_marker_path.read_text(encoding="utf-8"),
            )
            if payload.get("state") != "degraded":
                raise ValueError("health marker state must be degraded")
            error = payload.get("error")
            if not isinstance(error, str) or not error.strip():
                raise ValueError("health marker error cannot be blank")
            return error[:500], None
        except Exception as exc:
            marker_error = f"archive health marker is unreadable: {exc}"[:500]
            # An unreadable marker may represent a torn/corrupt failure record;
            # never interpret it as a healthy archive.
            return marker_error, marker_error

    def _persist_health_marker(self, error: str) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        destination = self._health_marker_path
        temporary = destination.with_name(
            f".{destination.name}.{uuid4().hex}.tmp",
        )
        payload = {
            "schema_version": ARCHIVE_SCHEMA_VERSION,
            "state": "degraded",
            "error": error,
            "recorded_at_ms": int(datetime.now(tz=timezone.utc).timestamp() * 1000),
        }
        try:
            temporary.write_text(
                json.dumps(payload, separators=(",", ":"), sort_keys=True),
                encoding="utf-8",
            )
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)

    def diagnostics(self) -> dict[str, Any]:
        with self._write_lock:
            durability_error = self._stats["durability_error"]
            return {
                "enabled": True,
                "backend": "parquet-pyarrow",
                "state": "degraded" if durability_error else "ready",
                "root": str(self.root),
                "schema_version": ARCHIVE_SCHEMA_VERSION,
                "max_rows_per_file": self.max_rows_per_file,
                "scan_batch_size": self.scan_batch_size,
                "max_scan_files": self.max_scan_files,
                "max_scan_rows": self.max_scan_rows,
                "max_physical_scan_rows": self.max_physical_scan_rows,
                **self._stats,
            }

    def scan_range(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_time_ms: int | None = None,
        end_time_ms: int | None = None,
        start_agg_trade_id: int | None = None,
        end_agg_trade_id: int | None = None,
        limit: int = 100_000,
    ) -> list[dict[str, Any]]:
        bounded_limit = max(1, min(int(limit), 1_000_000))
        bounds = self._normalize_scan_bounds(
            start_time_ms=start_time_ms,
            end_time_ms=end_time_ms,
            start_agg_trade_id=start_agg_trade_id,
            end_agg_trade_id=end_agg_trade_id,
        )
        manifests = self._discover_manifests(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            start_time_ms=bounds[0],
            end_time_ms=bounds[1],
            start_agg_trade_id=bounds[2],
            end_agg_trade_id=bounds[3],
        )
        if len(manifests) > self.max_scan_files:
            self._record_scan_limit_rejection()
            raise RawAggTradeScanLimitError(
                "raw aggTrade scan exceeds max_scan_files "
                f"({self.max_scan_files}); add narrower time/ID bounds",
            )
        estimated_physical_rows = sum(item.row_count for item in manifests)
        if estimated_physical_rows > self.max_physical_scan_rows:
            self._record_scan_limit_rejection()
            raise RawAggTradeScanLimitError(
                "raw aggTrade scan exceeds max_physical_scan_rows "
                f"({estimated_physical_rows} > "
                f"{self.max_physical_scan_rows}); add narrower time/ID bounds",
            )
        deduplicated: dict[int, dict[str, Any]] = {}
        scanned_rows = 0
        files_scanned = 0
        for index, manifest in enumerate(manifests):
            if files_scanned >= self.max_scan_files:
                self._record_scan_limit_rejection()
                raise RawAggTradeScanLimitError(
                    "raw aggTrade scan exceeds max_scan_files "
                    f"({self.max_scan_files}); add narrower time/ID bounds",
                )
            files_scanned += 1
            stop_file = False
            parquet = self._pq.ParquetFile(manifest.path)
            for batch in parquet.iter_batches(
                batch_size=self.scan_batch_size,
                columns=list(RAW_AGG_TRADE_COLUMNS),
            ):
                scanned_rows += batch.num_rows
                if scanned_rows > self.max_physical_scan_rows:
                    self._record_scan_limit_rejection()
                    raise RawAggTradeScanLimitError(
                        "raw aggTrade scan exceeds max_physical_scan_rows "
                        f"({self.max_physical_scan_rows}); add narrower "
                        "time/ID bounds",
                    )
                cutoff = _row_cutoff(deduplicated, bounded_limit)
                for raw in batch.to_pylist():
                    row = _raw_trade_payload(raw)
                    order_key = (row["trade_time_ms"], row["agg_trade_id"])
                    if cutoff is not None and order_key > cutoff:
                        stop_file = True
                        break
                    if not _row_matches_bounds(row, bounds):
                        continue
                    current = deduplicated.get(row["agg_trade_id"])
                    if (
                        current is None
                        or row["received_at_ms"] >= current["received_at_ms"]
                    ):
                        deduplicated[row["agg_trade_id"]] = row
                if stop_file:
                    break
            cutoff = _row_cutoff(deduplicated, bounded_limit)
            next_manifest = (
                manifests[index + 1] if index + 1 < len(manifests) else None
            )
            if (
                cutoff is not None
                and next_manifest is not None
                and next_manifest.first_order_key > cutoff
            ):
                break
        return sorted(
            deduplicated.values(),
            key=lambda item: (item["trade_time_ms"], item["agg_trade_id"]),
        )[:bounded_limit]

    def coverage(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_time_ms: int | None = None,
        end_time_ms: int | None = None,
        expected_start_agg_trade_id: int | None = None,
        expected_end_agg_trade_id: int | None = None,
    ) -> RawAggTradeCoverage:
        bounds = self._normalize_scan_bounds(
            start_time_ms=start_time_ms,
            end_time_ms=end_time_ms,
            start_agg_trade_id=expected_start_agg_trade_id,
            end_agg_trade_id=expected_end_agg_trade_id,
        )
        expected_start = bounds[2]
        expected_end = bounds[3]
        manifests = self._discover_manifests(
            exchange=exchange,
            market_type=market_type,
            symbol=symbol,
            start_time_ms=bounds[0],
            end_time_ms=bounds[1],
            start_agg_trade_id=bounds[2],
            end_agg_trade_id=bounds[3],
        )
        estimated_rows = sum(
            _estimated_matching_rows(item, bounds[2], bounds[3])
            for item in manifests
        )
        estimated_physical_rows = sum(item.row_count for item in manifests)
        identity = (
            _identity(exchange, "exchange", lower=True),
            _identity(market_type, "market_type", lower=True),
            _identity(symbol, "symbol", upper=True),
        )
        limit_kind: str | None = None
        if len(manifests) > self.max_scan_files:
            limit_kind = "files"
        elif estimated_physical_rows > self.max_physical_scan_rows:
            limit_kind = "physical_rows"
        elif estimated_rows > self.max_scan_rows:
            limit_kind = "matched_rows"
        if limit_kind is not None:
            self._record_scan_limit_rejection()
            return self._limited_coverage(
                identity=identity,
                bounds=bounds,
                manifests=manifests,
                estimated_rows=estimated_rows,
                estimated_physical_rows=estimated_physical_rows,
                limit_kind=limit_kind,
            )

        by_id: dict[int, tuple[int, int]] = {}
        scanned_rows = 0
        matched_rows = 0
        for manifest in manifests:
            parquet = self._pq.ParquetFile(manifest.path)
            for batch in parquet.iter_batches(
                batch_size=self.scan_batch_size,
                columns=["agg_trade_id", "trade_time_ms", "received_at_ms"],
            ):
                scanned_rows += batch.num_rows
                if scanned_rows > self.max_physical_scan_rows:
                    self._record_scan_limit_rejection()
                    return self._limited_coverage(
                        identity=identity,
                        bounds=bounds,
                        manifests=manifests,
                        estimated_rows=estimated_rows,
                        estimated_physical_rows=estimated_physical_rows,
                        scanned_rows=scanned_rows,
                        limit_kind="physical_rows",
                    )
                for raw in batch.to_pylist():
                    trade_time = int(raw["trade_time_ms"])
                    if bounds[0] is not None and trade_time < bounds[0]:
                        continue
                    if bounds[1] is not None and trade_time > bounds[1]:
                        continue
                    trade_id = int(raw["agg_trade_id"])
                    if bounds[2] is not None and trade_id < bounds[2]:
                        continue
                    if bounds[3] is not None and trade_id > bounds[3]:
                        continue
                    matched_rows += 1
                    if matched_rows > self.max_scan_rows:
                        self._record_scan_limit_rejection()
                        return self._limited_coverage(
                            identity=identity,
                            bounds=bounds,
                            manifests=manifests,
                            estimated_rows=estimated_rows,
                            estimated_physical_rows=estimated_physical_rows,
                            scanned_rows=scanned_rows,
                            limit_kind="matched_rows",
                        )
                    received_at = int(raw["received_at_ms"])
                    current = by_id.get(trade_id)
                    if current is None or received_at >= current[0]:
                        by_id[trade_id] = (received_at, trade_time)

        ids = sorted(by_id)
        gaps = tuple(
            RawAggTradeGap(
                start_agg_trade_id=left + 1,
                end_agg_trade_id=right - 1,
                missing_count=right - left - 1,
            )
            for left, right in zip(ids, ids[1:])
            if right > left + 1
        )
        earliest_id = ids[0] if ids else None
        latest_id = ids[-1] if ids else None
        expected_bounds = (
            expected_start is not None
            and expected_end is not None
        )
        if expected_bounds:
            assert expected_start is not None and expected_end is not None
            complete: bool | None = (
                earliest_id == expected_start
                and latest_id == expected_end
                and not gaps
            )
        else:
            complete = None
        with self._write_lock:
            durability_error = self._stats["durability_error"]
        if durability_error:
            complete = False
        trade_times = [value[1] for value in by_id.values()]
        return RawAggTradeCoverage(
            enabled=True,
            backend="parquet-pyarrow",
            exchange=identity[0],
            market_type=identity[1],
            symbol=identity[2],
            start_time_ms=bounds[0],
            end_time_ms=bounds[1],
            row_count=len(ids),
            file_count=len(manifests),
            earliest_agg_trade_id=earliest_id,
            latest_agg_trade_id=latest_id,
            earliest_trade_time_ms=min(trade_times) if trade_times else None,
            latest_trade_time_ms=max(trade_times) if trade_times else None,
            gaps=gaps,
            complete=complete,
            status="degraded" if durability_error else "ready",
            error=str(durability_error) if durability_error else None,
            estimated_row_count=estimated_rows,
            estimated_physical_row_count=estimated_physical_rows,
            scanned_row_count=scanned_rows,
        )

    @staticmethod
    def _normalize_scan_bounds(
        *,
        start_time_ms: int | None,
        end_time_ms: int | None,
        start_agg_trade_id: int | None = None,
        end_agg_trade_id: int | None = None,
    ) -> tuple[int | None, int | None, int | None, int | None]:
        start_time = _optional_non_negative_int(start_time_ms, "start_time_ms")
        end_time = _optional_non_negative_int(end_time_ms, "end_time_ms")
        start_id = _optional_non_negative_int(
            start_agg_trade_id,
            "start_agg_trade_id",
        )
        end_id = _optional_non_negative_int(end_agg_trade_id, "end_agg_trade_id")
        if start_time is not None and end_time is not None and start_time > end_time:
            raise ValueError("start_time_ms cannot exceed end_time_ms")
        if start_id is not None and end_id is not None and start_id > end_id:
            raise ValueError("start_agg_trade_id cannot exceed end_agg_trade_id")
        return start_time, end_time, start_id, end_id

    def _discover_manifests(
        self,
        *,
        exchange: str,
        market_type: str,
        symbol: str,
        start_time_ms: int | None,
        end_time_ms: int | None,
        start_agg_trade_id: int | None = None,
        end_agg_trade_id: int | None = None,
    ) -> list[_FileManifest]:
        normalized_exchange = _identity(exchange, "exchange", lower=True)
        normalized_market = _identity(market_type, "market_type", lower=True)
        normalized_symbol = _identity(symbol, "symbol", upper=True)
        identity_root = (
            self.root
            / f"exchange={_partition_value(normalized_exchange)}"
            / f"market_type={_partition_value(normalized_market)}"
            / f"symbol={_partition_value(normalized_symbol)}"
        )
        if not identity_root.exists():
            return []
        start_date = _utc_date(start_time_ms) if start_time_ms is not None else None
        end_date = _utc_date(end_time_ms) if end_time_ms is not None else None
        manifests: list[_FileManifest] = []
        partitions = sorted(
            path
            for path in identity_root.iterdir()
            if path.is_dir() and path.name.startswith("date=")
        )
        for partition in partitions:
            date = partition.name.removeprefix("date=")
            if start_date is not None and date < start_date:
                continue
            if end_date is not None and date > end_date:
                continue
            for path in partition.glob("part-*.parquet"):
                manifest = self._read_file_manifest(path)
                if (
                    start_time_ms is not None
                    and manifest.max_trade_time_ms < start_time_ms
                ):
                    continue
                if (
                    end_time_ms is not None
                    and manifest.min_trade_time_ms > end_time_ms
                ):
                    continue
                if (
                    start_agg_trade_id is not None
                    and manifest.max_agg_trade_id < start_agg_trade_id
                ):
                    continue
                if (
                    end_agg_trade_id is not None
                    and manifest.min_agg_trade_id > end_agg_trade_id
                ):
                    continue
                manifests.append(manifest)
                # One overflow marker is enough for callers to fail closed;
                # never build an unbounded in-memory file catalog.
                if len(manifests) > self.max_scan_files:
                    manifests.sort(
                        key=lambda item: (item.first_order_key, item.path.name),
                    )
                    return manifests
        manifests.sort(key=lambda item: (item.first_order_key, item.path.name))
        return manifests

    def _read_file_manifest(self, path: Path) -> _FileManifest:
        sidecar = _manifest_path(path)
        try:
            payload = json.loads(sidecar.read_text(encoding="utf-8"))
            if payload.get("file") != path.name:
                raise ValueError("manifest file identity mismatch")
            return _FileManifest(
                path=path,
                row_count=_non_negative_int(payload.get("row_count"), "row_count"),
                min_agg_trade_id=_non_negative_int(
                    payload.get("min_agg_trade_id"),
                    "min_agg_trade_id",
                ),
                max_agg_trade_id=_non_negative_int(
                    payload.get("max_agg_trade_id"),
                    "max_agg_trade_id",
                ),
                min_trade_time_ms=_non_negative_int(
                    payload.get("min_trade_time_ms"),
                    "min_trade_time_ms",
                ),
                max_trade_time_ms=_non_negative_int(
                    payload.get("max_trade_time_ms"),
                    "max_trade_time_ms",
                ),
                first_trade_time_ms=_non_negative_int(
                    payload.get("first_trade_time_ms"),
                    "first_trade_time_ms",
                ),
                first_agg_trade_id=_non_negative_int(
                    payload.get("first_agg_trade_id"),
                    "first_agg_trade_id",
                ),
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            with self._write_lock:
                self._stats["manifest_fallbacks"] += 1
            parquet = self._pq.ParquetFile(path)
            metadata = parquet.metadata
            id_min, id_max = _column_statistics(metadata, "agg_trade_id")
            time_min, time_max = _column_statistics(metadata, "trade_time_ms")
            return _FileManifest(
                path=path,
                row_count=int(metadata.num_rows),
                min_agg_trade_id=id_min,
                max_agg_trade_id=id_max,
                min_trade_time_ms=time_min,
                max_trade_time_ms=time_max,
                # Statistics are conservative lower bounds for early-stop.
                first_trade_time_ms=time_min,
                first_agg_trade_id=id_min,
            )

    def _limited_coverage(
        self,
        *,
        identity: tuple[str, str, str],
        bounds: tuple[int | None, int | None, int | None, int | None],
        manifests: list[_FileManifest],
        estimated_rows: int,
        estimated_physical_rows: int,
        limit_kind: str,
        scanned_rows: int = 0,
    ) -> RawAggTradeCoverage:
        earliest_id = (
            min(item.min_agg_trade_id for item in manifests)
            if manifests
            else None
        )
        latest_id = (
            max(item.max_agg_trade_id for item in manifests)
            if manifests
            else None
        )
        if earliest_id is not None and bounds[2] is not None:
            earliest_id = max(earliest_id, bounds[2])
        if latest_id is not None and bounds[3] is not None:
            latest_id = min(latest_id, bounds[3])
        limits = {
            "files": (
                f"candidate files={len(manifests)}/{self.max_scan_files}"
            ),
            "matched_rows": (
                f"estimated matched rows={estimated_rows}/{self.max_scan_rows}"
            ),
            "physical_rows": (
                "estimated physical rows="
                f"{estimated_physical_rows}/{self.max_physical_scan_rows}"
            ),
        }
        error = (
            f"coverage scan exceeds {limit_kind} safety limit "
            f"({limits[limit_kind]}); add narrower UTC time or aggregate-ID bounds"
        )
        return RawAggTradeCoverage(
            enabled=True,
            backend="parquet-pyarrow",
            exchange=identity[0],
            market_type=identity[1],
            symbol=identity[2],
            start_time_ms=bounds[0],
            end_time_ms=bounds[1],
            row_count=0,
            file_count=len(manifests),
            earliest_agg_trade_id=earliest_id,
            latest_agg_trade_id=latest_id,
            earliest_trade_time_ms=(
                min(item.min_trade_time_ms for item in manifests)
                if manifests
                else None
            ),
            latest_trade_time_ms=(
                max(item.max_trade_time_ms for item in manifests)
                if manifests
                else None
            ),
            gaps=(),
            complete=False,
            status="scan_limit_exceeded",
            error=error,
            truncated=True,
            estimated_row_count=estimated_rows,
            estimated_physical_row_count=estimated_physical_rows,
            scanned_row_count=scanned_rows,
            limit_kind=limit_kind,
        )

    def _record_scan_limit_rejection(self) -> None:
        with self._write_lock:
            self._stats["scan_limit_rejections"] += 1

    def _write_file(
        self,
        key: tuple[str, str, str, str],
        rows: list[dict[str, Any]],
    ) -> None:
        exchange, market_type, symbol, date = key
        partition = (
            self.root
            / f"exchange={_partition_value(exchange)}"
            / f"market_type={_partition_value(market_type)}"
            / f"symbol={_partition_value(symbol)}"
            / f"date={date}"
        )
        partition.mkdir(parents=True, exist_ok=True)
        first_id = min(row["agg_trade_id"] for row in rows)
        last_id = max(row["agg_trade_id"] for row in rows)
        destination = partition / (
            f"part-{first_id:020d}-{last_id:020d}-{uuid4().hex}.parquet"
        )
        ordered = sorted(
            rows,
            key=lambda item: (item["trade_time_ms"], item["agg_trade_id"]),
        )
        table = self._pa.Table.from_pylist(ordered, schema=self._schema)
        temporary = destination.with_name(
            f".{destination.name}.{uuid4().hex}.tmp"
        )
        try:
            self._pq.write_table(
                table,
                temporary,
                compression=self.compression,
            )
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        sidecar = _manifest_path(destination)
        sidecar_temporary = sidecar.with_name(
            f".{sidecar.name}.{uuid4().hex}.tmp",
        )
        first = ordered[0]
        manifest = {
            "schema_version": ARCHIVE_SCHEMA_VERSION,
            "file": destination.name,
            "exchange": exchange,
            "market_type": market_type,
            "symbol": symbol,
            "date": date,
            "row_count": len(ordered),
            "min_agg_trade_id": min(row["agg_trade_id"] for row in ordered),
            "max_agg_trade_id": max(row["agg_trade_id"] for row in ordered),
            "min_trade_time_ms": min(row["trade_time_ms"] for row in ordered),
            "max_trade_time_ms": max(row["trade_time_ms"] for row in ordered),
            "first_trade_time_ms": first["trade_time_ms"],
            "first_agg_trade_id": first["agg_trade_id"],
        }
        try:
            sidecar_temporary.write_text(
                json.dumps(manifest, separators=(",", ":"), sort_keys=True),
                encoding="utf-8",
            )
            os.replace(sidecar_temporary, sidecar)
        finally:
            sidecar_temporary.unlink(missing_ok=True)
        self._stats["files_written"] += 1


@dataclass(slots=True)
class _ArchiveRequest:
    rows: list[dict[str, Any]]
    acknowledgement: asyncio.Future[int]


class RawAggTradeArchiveWriter:
    """Bounded single-consumer async batch writer for raw aggTrades.

    ``enqueue`` acknowledges queue ownership immediately while returning a
    future for application/process-level committed completion; ``write`` waits
    for that future.  The acknowledgement means atomic rename has completed,
    not that file and directory metadata survived sudden power loss: this
    implementation deliberately does not promise cross-platform file/directory
    ``fsync`` semantics.  Publication is atomic per immutable file, not across
    all files in a combined batch.  There is intentionally no lossy ``offer``
    method: silently dropping raw trades would invalidate replay completeness.
    """

    def __init__(
        self,
        archive: RawAggTradeArchive,
        *,
        flush_interval_seconds: float = 1.0,
        max_pending_batches: int = 16,
        max_rows_per_batch: int = 10_000,
        max_write_attempts: int = 3,
        retry_base_seconds: float = 0.05,
        retry_max_seconds: float = 1.0,
    ) -> None:
        self.archive = archive
        self._flush_interval_seconds = max(
            0.0,
            min(float(flush_interval_seconds), 10.0),
        )
        self._max_rows_per_batch = max(1, int(max_rows_per_batch))
        self._max_write_attempts = max(1, min(int(max_write_attempts), 10))
        self._retry_base_seconds = max(0.0, float(retry_base_seconds))
        self._retry_max_seconds = max(
            self._retry_base_seconds,
            float(retry_max_seconds),
        )
        self._queue: asyncio.Queue[_ArchiveRequest | None] = asyncio.Queue(
            maxsize=max(1, int(max_pending_batches)),
        )
        self._enqueue_lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self._closing = False
        self._metrics = {
            "batches_written": 0,
            "rows_archived": 0,
            "write_failures": 0,
            "retry_attempts": 0,
            "failed_batches": 0,
            "failed_rows": 0,
            "failure_marker_errors": 0,
            "last_error": None,
        }
        self._durability_failed = False

    def start(self) -> None:
        if self._closing:
            raise RuntimeError("raw aggTrade archive writer is closed")
        if not self.archive.enabled:
            return
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(
                self._run(),
                name="raw-agg-trade-archive-writer",
            )

    async def write(self, rows: Iterable[dict[str, Any]]) -> int:
        acknowledgement = await self.enqueue(rows)
        if acknowledgement is None:
            return 0
        return await asyncio.shield(acknowledgement)

    async def enqueue(
        self,
        rows: Iterable[dict[str, Any]],
    ) -> asyncio.Future[int] | None:
        """Transfer a batch without waiting for its process-level commit ack."""

        copied = [dict(row) for row in rows]
        if not copied or not self.archive.enabled:
            return None
        if len(copied) > self._max_rows_per_batch:
            raise ValueError(
                "raw aggTrade archive batch exceeds max_rows_per_batch "
                f"({len(copied)} > {self._max_rows_per_batch})"
            )
        async with self._enqueue_lock:
            if self._closing:
                raise RuntimeError("raw aggTrade archive writer is closed")
            self.start()
            acknowledgement = asyncio.get_running_loop().create_future()
            acknowledgement.add_done_callback(self._consume_acknowledgement)
            await self._queue.put(
                _ArchiveRequest(rows=copied, acknowledgement=acknowledgement)
            )
        return acknowledgement

    async def close(self) -> None:
        async with self._enqueue_lock:
            if self._closing:
                task = self._task
            else:
                self._closing = True
                task = self._task
                if task is not None:
                    await self._queue.put(None)
        if task is not None:
            await asyncio.shield(task)

    def diagnostics(self) -> dict[str, Any]:
        if not self.archive.enabled:
            state = "disabled"
        elif self._durability_failed:
            state = "failed"
        elif self._closing and (self._task is None or self._task.done()):
            state = "closed"
        elif self._closing:
            state = "closing"
        elif self._task is not None and not self._task.done():
            state = "running"
        else:
            state = "idle"
        return {
            "state": state,
            "pending_batches": self._queue.qsize(),
            "limits": {
                "pending_batches": self._queue.maxsize,
                "rows_per_batch": self._max_rows_per_batch,
                "write_attempts": self._max_write_attempts,
                "retry_base_seconds": self._retry_base_seconds,
                "retry_max_seconds": self._retry_max_seconds,
            },
            **self._metrics,
            "archive": self.archive.diagnostics(),
        }

    async def _run(self) -> None:
        should_stop = False
        while not should_stop:
            item = await self._queue.get()
            if item is None:
                self._queue.task_done()
                return
            requests = [item]
            if self._flush_interval_seconds:
                await asyncio.sleep(self._flush_interval_seconds)
            while True:
                try:
                    pending = self._queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                if pending is None:
                    self._queue.task_done()
                    should_stop = True
                    break
                requests.append(pending)

            rows = [row for request in requests for row in request.rows]
            error: Exception | None = None
            accepted = 0
            for attempt in range(1, self._max_write_attempts + 1):
                try:
                    accepted = await run_storage(self.archive.append, rows)
                    if accepted != len(rows):
                        raise RuntimeError(
                            "raw aggTrade archive accepted an unexpected row "
                            f"count ({accepted} != {len(rows)})",
                        )
                except Exception as exc:
                    error = exc
                    self._metrics["write_failures"] += 1
                    if attempt >= self._max_write_attempts:
                        break
                    self._metrics["retry_attempts"] += 1
                    delay = min(
                        self._retry_base_seconds * (2 ** (attempt - 1)),
                        self._retry_max_seconds,
                    )
                    if delay:
                        await asyncio.sleep(delay)
                else:
                    error = None
                    break
            if error is not None:
                self._durability_failed = True
                self._metrics["failed_batches"] += len(requests)
                self._metrics["failed_rows"] += len(rows)
                self._metrics["last_error"] = str(error)[:500]
                marker = getattr(self.archive, "record_writer_failure", None)
                if callable(marker):
                    try:
                        marker(str(error))
                    except Exception:
                        # A backend marker hook is diagnostic state handling;
                        # it must not strand acknowledgements or queue joins.
                        self._metrics["failure_marker_errors"] += 1
                for request in requests:
                    if not request.acknowledgement.done():
                        request.acknowledgement.set_exception(error)
            else:
                self._metrics["batches_written"] += 1
                self._metrics["rows_archived"] += accepted
                for request in requests:
                    if not request.acknowledgement.done():
                        request.acknowledgement.set_result(len(request.rows))
            for _ in requests:
                self._queue.task_done()

    @staticmethod
    def _consume_acknowledgement(acknowledgement: asyncio.Future[int]) -> None:
        if not acknowledgement.cancelled():
            acknowledgement.exception()


def _manifest_path(parquet_path: Path) -> Path:
    return parquet_path.with_suffix(f"{parquet_path.suffix}.manifest.json")


def _estimated_matching_rows(
    manifest: _FileManifest,
    start_agg_trade_id: int | None,
    end_agg_trade_id: int | None,
) -> int:
    """Return a safe upper bound for rows matching an optional ID slice.

    Every immutable file is deduplicated by aggregate-trade ID before write, so
    an inclusive ID interval cannot match more rows than its integer width.
    """

    lower = manifest.min_agg_trade_id
    upper = manifest.max_agg_trade_id
    if start_agg_trade_id is not None:
        lower = max(lower, start_agg_trade_id)
    if end_agg_trade_id is not None:
        upper = min(upper, end_agg_trade_id)
    if lower > upper:
        return 0
    return min(manifest.row_count, upper - lower + 1)


def _row_matches_bounds(
    row: dict[str, Any],
    bounds: tuple[int | None, int | None, int | None, int | None],
) -> bool:
    start_time, end_time, start_id, end_id = bounds
    return not (
        (start_time is not None and row["trade_time_ms"] < start_time)
        or (end_time is not None and row["trade_time_ms"] > end_time)
        or (start_id is not None and row["agg_trade_id"] < start_id)
        or (end_id is not None and row["agg_trade_id"] > end_id)
    )


def _row_cutoff(
    rows: dict[int, dict[str, Any]],
    limit: int,
) -> tuple[int, int] | None:
    if len(rows) < limit:
        return None
    return sorted(
        (row["trade_time_ms"], row["agg_trade_id"]) for row in rows.values()
    )[limit - 1]


def _column_statistics(metadata: Any, column_name: str) -> tuple[int, int]:
    try:
        column_index = list(metadata.schema.names).index(column_name)
    except (AttributeError, ValueError) as exc:
        raise RuntimeError(
            f"Parquet archive is missing required column {column_name!r}",
        ) from exc
    minima: list[int] = []
    maxima: list[int] = []
    for index in range(metadata.num_row_groups):
        statistics = metadata.row_group(index).column(column_index).statistics
        if statistics is None or not statistics.has_min_max:
            raise RuntimeError(
                "Parquet archive sidecar is missing and column statistics "
                f"are unavailable for {column_name!r}",
            )
        minima.append(int(statistics.min))
        maxima.append(int(statistics.max))
    if not minima:
        raise RuntimeError("raw aggTrade Parquet file contains no row groups")
    return min(minima), max(maxima)


def _load_pyarrow() -> tuple[Any, Any]:
    import pyarrow as pa
    import pyarrow.parquet as pq

    return pa, pq


def _parquet_schema(pa: Any) -> Any:
    return pa.schema(
        [
            pa.field("exchange", pa.string(), nullable=False),
            pa.field("market_type", pa.string(), nullable=False),
            pa.field("symbol", pa.string(), nullable=False),
            pa.field("agg_trade_id", pa.int64(), nullable=False),
            pa.field("first_trade_id", pa.int64(), nullable=False),
            pa.field("last_trade_id", pa.int64(), nullable=False),
            pa.field("price", pa.float64(), nullable=False),
            pa.field("quantity", pa.float64(), nullable=False),
            pa.field("quote_quantity", pa.float64(), nullable=False),
            pa.field("trade_time_ms", pa.int64(), nullable=False),
            pa.field("event_time_ms", pa.int64(), nullable=False),
            pa.field("received_at_ms", pa.int64(), nullable=False),
            pa.field("is_buyer_maker", pa.bool_(), nullable=False),
            pa.field("source", pa.string(), nullable=False),
        ],
        metadata={
            b"candlescope.dataset": b"raw_agg_trade",
            b"candlescope.schema_version": ARCHIVE_SCHEMA_VERSION.encode("ascii"),
        },
    )


def _raw_trade_payload(row: dict[str, Any]) -> dict[str, Any]:
    price = _positive_float(row.get("price"), "price")
    quantity = _positive_float(row.get("quantity"), "quantity")
    first_trade_id = _non_negative_int(row.get("first_trade_id"), "first_trade_id")
    last_trade_id = _non_negative_int(row.get("last_trade_id"), "last_trade_id")
    if first_trade_id > last_trade_id:
        raise ValueError("first_trade_id cannot exceed last_trade_id")
    is_buyer_maker = row.get("is_buyer_maker")
    if not isinstance(is_buyer_maker, bool):
        raise ValueError("is_buyer_maker must be a boolean")
    return {
        "exchange": _identity(row.get("exchange"), "exchange", lower=True),
        "market_type": _identity(
            row.get("market_type"),
            "market_type",
            lower=True,
        ),
        "symbol": _identity(row.get("symbol"), "symbol", upper=True),
        "agg_trade_id": _non_negative_int(
            row.get("agg_trade_id"),
            "agg_trade_id",
        ),
        "first_trade_id": first_trade_id,
        "last_trade_id": last_trade_id,
        "price": price,
        "quantity": quantity,
        "quote_quantity": _positive_float(
            row.get("quote_quantity", price * quantity),
            "quote_quantity",
        ),
        "trade_time_ms": _non_negative_int(
            row.get("trade_time_ms"),
            "trade_time_ms",
        ),
        "event_time_ms": _non_negative_int(
            row.get("event_time_ms"),
            "event_time_ms",
        ),
        "received_at_ms": _non_negative_int(
            row.get("received_at_ms"),
            "received_at_ms",
        ),
        "is_buyer_maker": is_buyer_maker,
        "source": _identity(row.get("source"), "source", lower=True),
    }


def _deduplicate_raw_trades(
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    deduplicated: dict[int, dict[str, Any]] = {}
    for row in rows:
        current = deduplicated.get(row["agg_trade_id"])
        if current is None or row["received_at_ms"] >= current["received_at_ms"]:
            deduplicated[row["agg_trade_id"]] = row
    return sorted(
        deduplicated.values(),
        key=lambda item: (item["trade_time_ms"], item["agg_trade_id"]),
    )


def _utc_date(timestamp_ms: int) -> str:
    try:
        return datetime.fromtimestamp(
            timestamp_ms / 1000,
            tz=timezone.utc,
        ).date().isoformat()
    except (OSError, OverflowError, ValueError) as exc:
        raise ValueError("trade_time_ms is outside the supported UTC range") from exc


def _partition_value(value: str) -> str:
    return quote(value, safe="-_.")


def _identity(
    value: Any,
    label: str,
    *,
    lower: bool = False,
    upper: bool = False,
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} cannot be blank")
    normalized = value.strip()
    if lower:
        return normalized.lower()
    if upper:
        return normalized.upper()
    return normalized


def _finite_float(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be finite")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be finite") from exc
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError(f"{label} must be finite")
    return number


def _positive_float(value: Any, label: str) -> float:
    number = _finite_float(value, label)
    if number <= 0:
        raise ValueError(f"{label} must be positive")
    return number


def _non_negative_int(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a non-negative integer")
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be a non-negative integer") from exc
    if number < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return number


def _optional_non_negative_int(value: Any, label: str) -> int | None:
    if value is None:
        return None
    return _non_negative_int(value, label)


__all__ = [
    "ARCHIVE_SCHEMA_VERSION",
    "DisabledRawAggTradeArchive",
    "ParquetRawAggTradeArchive",
    "RAW_AGG_TRADE_COLUMNS",
    "RawAggTradeArchive",
    "RawAggTradeCoverage",
    "RawAggTradeGap",
    "RawAggTradeScanLimitError",
    "RawAggTradeArchiveWriter",
]
