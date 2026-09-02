"""Offline, fail-closed repair of ambiguous Binance K-line rows.

This module deliberately does not use the normal repository connection or
write helpers.  A repair run targets an explicit SQLite file, creates a
point-in-time SQLite backup, verifies candidate fingerprints under
``BEGIN IMMEDIATE`` and replaces the whole batch atomically.  Network access
is delegated to the existing backfill stack; no exchange HTTP protocol is
implemented here.

The caller must stop CandleScope before an apply run.  ``apply`` and
``confirm`` are independent switches so an accidental ``--apply`` cannot
write the database.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Protocol, Sequence
from urllib.parse import urlsplit

from app.data_engine.backfill.config import BackfillConfig
from app.data_engine.backfill.fetcher import HistoricalFetcher
from app.data_engine.backfill.models import (
    BackfillStatus,
    BackfillTask,
    FetchResult,
)
from app.data_engine.ingestion.config import IngestionConfig
from app.data_engine.ingestion.transport import TransportLayer
from app.data_engine.interval_policy import (
    compute_bucket_close_ms,
    compute_bucket_start_ms,
    parse_interval_ms,
)
from app.data_engine.market_data.kline_metrics import KLINE_ENHANCED_FIELDS
from app.data_engine.series_identity import (
    DEFAULT_ASSET_CLASS,
    DEFAULT_PRICE_ADJUSTMENT,
    DEFAULT_SERIES_VARIANT,
    DEFAULT_SESSION_VARIANT,
    DEFAULT_VOLUME_SEMANTICS,
)


REPAIR_SOURCE = "repair_binance_rest_verified"
DEFAULT_CANDIDATE_SOURCE = "data_manager_closed"

# Binance spot exposes 1s K-lines; USD-M Futures does not.  Everything in
# these sets is exchange-native and may therefore be fetched directly.  A
# parseable interval outside these sets is a CandleScope custom interval and
# must be rebuilt from trusted components by a separate lane.
BINANCE_SPOT_NATIVE_INTERVALS = frozenset(
    {"1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"}
)
BINANCE_FUTURES_NATIVE_INTERVALS = BINANCE_SPOT_NATIVE_INTERVALS - {"1s"}

_BINANCE_OFFICIAL_HTTPS_HOSTS: dict[str, frozenset[str]] = {
    "spot": frozenset(
        {
            "api.binance.com",
            "api1.binance.com",
            "api2.binance.com",
            "api3.binance.com",
            "api.binance.me",
        }
    ),
    "futures": frozenset({"fapi.binance.com", "fapi.binance.me"}),
}
_MAX_TASK_CANDIDATES = 1_000

_ROW_FIELDS = (
    "exchange",
    "market_type",
    "symbol",
    "interval",
    "open_time",
    "close_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "trades",
    "taker_buy_base",
    "taker_buy_quote",
    "source",
    "created_at",
    "updated_at",
)
_VALUE_FIELDS = (
    "close_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "trades",
    "taker_buy_base",
    "taker_buy_quote",
)


class Fetcher(Protocol):
    async def fetch(self, tasks: list[BackfillTask]) -> list[FetchResult]: ...


class RepairError(RuntimeError):
    """Base error for repair validation or application failures."""


class RepairValidationError(RepairError):
    """The requested selection or database is unsafe to repair."""


class RepairApplyError(RepairError):
    """The apply transaction failed or its candidate snapshot drifted."""

    def __init__(self, message: str, manifest: dict[str, Any]) -> None:
        super().__init__(message)
        self.manifest = manifest


@dataclass(frozen=True, slots=True)
class RepairRequest:
    db_path: Path
    exchanges: tuple[str, ...] = ("binance",)
    market_types: tuple[str, ...] = ()
    symbols: tuple[str, ...] = ()
    intervals: tuple[str, ...] = ()
    sources: tuple[str, ...] = (DEFAULT_CANDIDATE_SOURCE,)
    start_ms: int | None = None
    end_ms: int | None = None
    report_path: Path | None = None
    backup_dir: Path | None = None
    max_candidates: int = 10_000
    apply: bool = False
    confirm: bool = False


@dataclass(frozen=True, slots=True)
class Candidate:
    values: tuple[Any, ...]

    @property
    def row(self) -> dict[str, Any]:
        return dict(zip(_ROW_FIELDS, self.values, strict=True))

    @property
    def key(self) -> tuple[str, str, str, str, int]:
        row = self.row
        return (
            str(row["exchange"]),
            str(row["market_type"]),
            str(row["symbol"]),
            str(row["interval"]),
            int(row["open_time"]),
        )

    @property
    def fingerprint(self) -> str:
        encoded = json.dumps(
            self.values,
            ensure_ascii=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True, slots=True)
class PlannedRepair:
    candidate: Candidate
    official: dict[str, Any]
    action: str  # relabel | replace


@dataclass(slots=True)
class RepairPlan:
    candidates: list[Candidate] = field(default_factory=list)
    repairs: list[PlannedRepair] = field(default_factory=list)
    unresolved: list[dict[str, Any]] = field(default_factory=list)
    tasks_count: int = 0


BeforeTransactionHook = Callable[[Path, Sequence[Candidate]], None]
WriteFaultHook = Callable[[int, sqlite3.Connection], None]
EndpointSnapshot = Callable[[], Mapping[str, str]]


class KlineRepairRunner:
    """Plan and optionally apply one offline Binance REST verification run."""

    def __init__(
        self,
        fetcher: Fetcher,
        *,
        official_endpoints: Mapping[str, Sequence[str]],
        endpoint_snapshot: EndpointSnapshot | None = None,
        now: Callable[[], datetime] | None = None,
        before_transaction: BeforeTransactionHook | None = None,
        write_fault: WriteFaultHook | None = None,
    ) -> None:
        self._fetcher = fetcher
        self._official_endpoints = _validate_official_https_endpoints(
            official_endpoints
        )
        self._endpoint_snapshot = endpoint_snapshot
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._before_transaction = before_transaction
        self._write_fault = write_fault

    async def run(self, request: RepairRequest) -> dict[str, Any]:
        normalized = self._validate_request(request)
        candidates = self._load_candidates(normalized)
        self._validate_candidate_intervals(candidates)

        plan = await self._build_plan(candidates)
        manifest = self._build_manifest(normalized, plan)

        # Integrity is checked after all exchange reads.  Dry-run uses a
        # read-only connection and therefore cannot create a WAL or journal.
        database_quick_check = self._quick_check(normalized.db_path)
        manifest["database_quick_check"] = database_quick_check
        if database_quick_check != "ok":
            manifest["result"] = {
                "status": "blocked_database_integrity",
                "applied": 0,
                "reason": f"source database quick_check returned {database_quick_check!r}",
            }
            return self._finish_manifest(normalized, manifest)

        if not candidates:
            manifest["result"] = {
                "status": "blocked_no_candidates" if normalized.apply else "no_candidates",
                "applied": 0,
            }
            return self._finish_manifest(normalized, manifest)

        if plan.unresolved:
            manifest["result"] = {
                "status": "blocked_unresolved" if normalized.apply else "dry_run_blocked",
                "applied": 0,
                "reason": "official verification is incomplete",
            }
            return self._finish_manifest(normalized, manifest)

        if not normalized.apply:
            manifest["result"] = {"status": "dry_run_ready", "applied": 0}
            return self._finish_manifest(normalized, manifest)

        backup_path: Path | None = None
        try:
            backup_path = self._create_backup(normalized)
            manifest["backup"] = {
                "path": str(backup_path),
                "sha256": _sha256_file(backup_path),
                "quick_check": self._quick_check(backup_path),
            }
            if self._before_transaction is not None:
                self._before_transaction(normalized.db_path, tuple(candidates))
            applied = self._apply_atomic(normalized.db_path, plan)
        except Exception as exc:
            manifest["result"] = {
                "status": "rolled_back",
                "applied": 0,
                "error": f"{type(exc).__name__}: {exc}",
            }
            if backup_path is not None and not manifest.get("backup"):
                manifest["backup"] = {"path": str(backup_path)}
            try:
                self._finish_manifest(normalized, manifest)
            except OSError as report_exc:
                manifest["result"]["manifest_error"] = str(report_exc)
            raise RepairApplyError(str(exc), manifest) from exc

        manifest["result"] = {"status": "applied", "applied": applied}
        try:
            return self._finish_manifest(normalized, manifest)
        except OSError as exc:
            # The database transaction has already committed; never describe
            # this state as rolled back.  Surface the exact state so the
            # operator can preserve stdout and regenerate the manifest.
            manifest["result"] = {
                "status": "applied_manifest_write_failed",
                "applied": applied,
                "error": f"{type(exc).__name__}: {exc}",
            }
            raise RepairApplyError(
                "database repair committed but the JSON manifest could not be written",
                manifest,
            ) from exc

    def _validate_request(self, request: RepairRequest) -> RepairRequest:
        db_path = Path(request.db_path).expanduser().resolve()
        if not db_path.is_file():
            raise RepairValidationError(f"SQLite database does not exist: {db_path}")
        if request.max_candidates <= 0:
            raise RepairValidationError("max_candidates must be greater than zero")
        if request.start_ms is not None and request.end_ms is not None and request.start_ms > request.end_ms:
            raise RepairValidationError("start_ms must be less than or equal to end_ms")
        if request.apply != request.confirm:
            if request.apply:
                raise RepairValidationError("apply requires --confirm and an offline CandleScope database")
            raise RepairValidationError("--confirm is only valid together with --apply")

        exchanges = tuple(dict.fromkeys(str(item).strip().lower() for item in request.exchanges if str(item).strip()))
        exchanges = exchanges or ("binance",)
        if exchanges != ("binance",):
            raise RepairValidationError("only exchange=binance is supported")

        market_types = tuple(
            dict.fromkeys(
                str(item).strip().lower()
                for item in request.market_types
                if str(item).strip()
            )
        )
        invalid_markets = sorted(set(market_types) - {"spot", "futures"})
        if invalid_markets:
            raise RepairValidationError(f"unsupported Binance market type(s): {', '.join(invalid_markets)}")
        required_endpoint_markets = market_types or ("spot", "futures")
        missing_endpoint_markets = [
            market
            for market in required_endpoint_markets
            if not self._official_endpoints.get(market)
        ]
        if missing_endpoint_markets:
            raise RepairValidationError(
                "official HTTPS endpoint configuration is missing for: "
                + ", ".join(missing_endpoint_markets)
            )

        symbols = tuple(dict.fromkeys(str(item).strip().upper() for item in request.symbols if str(item).strip()))
        intervals = tuple(dict.fromkeys(str(item).strip() for item in request.intervals if str(item).strip()))
        sources = tuple(dict.fromkeys(str(item).strip().lower() for item in request.sources if str(item).strip()))
        sources = sources or (DEFAULT_CANDIDATE_SOURCE,)

        for interval in intervals:
            if interval not in BINANCE_SPOT_NATIVE_INTERVALS:
                raise RepairValidationError(
                    f"interval {interval!r} is not a Binance-native interval; "
                    "custom intervals must be rebuilt from trusted components"
                )
        if "futures" in market_types and "1s" in intervals:
            raise RepairValidationError("Binance Futures does not expose a native 1s K-line interval")

        backup_dir = Path(request.backup_dir).expanduser().resolve() if request.backup_dir else db_path.parent
        # Co-locating the backup with the database is intentional: operators
        # cannot accidentally put it on a different/non-durable filesystem.
        if backup_dir != db_path.parent:
            raise RepairValidationError(
                f"backup_dir must be the database directory ({db_path.parent})"
            )

        report_path = (
            Path(request.report_path).expanduser().resolve()
            if request.report_path
            else db_path.parent / f"kline-repair-{_timestamp(self._now())}.json"
        )
        _validate_report_path(db_path, report_path)
        report_path.parent.mkdir(parents=True, exist_ok=True)

        return RepairRequest(
            db_path=db_path,
            exchanges=exchanges,
            market_types=market_types,
            symbols=symbols,
            intervals=intervals,
            sources=sources,
            start_ms=request.start_ms,
            end_ms=request.end_ms,
            report_path=report_path,
            backup_dir=backup_dir,
            max_candidates=int(request.max_candidates),
            apply=bool(request.apply),
            confirm=bool(request.confirm),
        )

    def _load_candidates(self, request: RepairRequest) -> list[Candidate]:
        where: list[str] = []
        params: list[Any] = []
        for column, values in (
            ("exchange", request.exchanges),
            ("market_type", request.market_types),
            ("symbol", request.symbols),
            ("interval", request.intervals),
            ("source", request.sources),
        ):
            if values:
                where.append(f"{column} IN ({','.join('?' for _ in values)})")
                params.extend(values)
        if request.start_ms is not None:
            where.append("open_time >= ?")
            params.append(int(request.start_ms))
        if request.end_ms is not None:
            where.append("open_time <= ?")
            params.append(int(request.end_ms))

        with _read_only_connection(request.db_path) as conn:
            columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(klines)")}
            missing = sorted(set(_ROW_FIELDS) - columns)
            if missing:
                raise RepairValidationError(f"klines schema is missing columns: {', '.join(missing)}")
            if _has_semantic_identity(columns):
                where[:0] = [
                    "provider_id = exchange",
                    "venue = exchange",
                    "asset_class = ?",
                    "series_variant = ?",
                    "price_adjustment = ?",
                    "session_variant = ?",
                    "volume_semantics = ?",
                ]
                params[:0] = [
                    DEFAULT_ASSET_CLASS,
                    DEFAULT_SERIES_VARIANT,
                    DEFAULT_PRICE_ADJUSTMENT,
                    DEFAULT_SESSION_VARIANT,
                    DEFAULT_VOLUME_SEMANTICS,
                ]
            sql = (
                f"SELECT {', '.join(_ROW_FIELDS)} FROM klines "
                f"WHERE {' AND '.join(where)} "
                "ORDER BY exchange, market_type, symbol, interval, open_time "
                "LIMIT ?"
            )
            params.append(request.max_candidates + 1)
            rows = conn.execute(sql, params).fetchall()
        if len(rows) > request.max_candidates:
            raise RepairValidationError(
                f"selection exceeds max_candidates={request.max_candidates}; "
                "narrow the range or raise the explicit limit"
            )
        return [Candidate(tuple(row[field] for field in _ROW_FIELDS)) for row in rows]

    @staticmethod
    def _validate_candidate_intervals(candidates: Sequence[Candidate]) -> None:
        invalid: list[str] = []
        for candidate in candidates:
            row = candidate.row
            market_type = str(row["market_type"]).lower()
            allowed = (
                BINANCE_FUTURES_NATIVE_INTERVALS
                if market_type == "futures"
                else BINANCE_SPOT_NATIVE_INTERVALS
            )
            if (
                str(row["exchange"]).lower() != "binance"
                or market_type not in {"spot", "futures"}
                or str(row["interval"]) not in allowed
            ):
                invalid.append(
                    f"{row['exchange']}:{row['market_type']}:{row['symbol']}@{row['interval']}:{row['open_time']}"
                )
        if invalid:
            preview = ", ".join(invalid[:5])
            suffix = " ..." if len(invalid) > 5 else ""
            raise RepairValidationError(
                f"selection contains non-Binance-native/custom series: {preview}{suffix}"
            )

    async def _build_plan(self, candidates: list[Candidate]) -> RepairPlan:
        plan = RepairPlan(candidates=list(candidates))
        if not candidates:
            return plan

        tasks = _build_fetch_tasks(candidates)
        plan.tasks_count = len(tasks)
        verification_now_ms = int(self._now().timestamp() * 1000)
        candidate_index = {candidate.key: candidate for candidate in candidates}
        task_candidates = {
            task.task_key: {
                int(open_time): candidate_index[
                    (
                        task.exchange,
                        task.market_type,
                        task.symbol,
                        task.interval,
                        int(open_time),
                    )
                ]
                for open_time in task.metadata["candidate_open_times"]
            }
            for task in tasks
        }

        try:
            results = await self._fetcher.fetch(tasks)
        except Exception as exc:
            for candidate in candidates:
                plan.unresolved.append(_unresolved(candidate, f"fetch_exception:{type(exc).__name__}:{exc}"))
            return plan

        result_by_key: dict[str, FetchResult] = {}
        duplicate_keys: set[str] = set()
        for result in results:
            key = result.task.task_key
            if key in result_by_key:
                duplicate_keys.add(key)
            result_by_key[key] = result

        for task in tasks:
            expected = task_candidates[task.task_key]
            result = result_by_key.get(task.task_key)
            if result is None:
                for candidate in expected.values():
                    plan.unresolved.append(_unresolved(candidate, "missing_fetch_result"))
                continue
            if task.task_key in duplicate_keys:
                for candidate in expected.values():
                    plan.unresolved.append(_unresolved(candidate, "duplicate_fetch_result"))
                continue
            if result.status is not BackfillStatus.COMPLETED or result.errors:
                reason = "fetch_failed:" + ";".join(result.errors or [result.status.value])
                for candidate in expected.values():
                    plan.unresolved.append(_unresolved(candidate, reason))
                continue

            official_by_time: dict[int, dict[str, Any]] = {}
            invalid_reason: str | None = None
            for bar in result.bars:
                if (
                    str(getattr(bar, "exchange", "")).lower() != str(task.exchange).lower()
                    or str(getattr(bar, "market_type", "")).lower() != str(task.market_type).lower()
                    or str(getattr(bar, "symbol", "")).upper() != str(task.symbol).upper()
                    or str(getattr(bar, "interval", "")) != str(task.interval)
                ):
                    invalid_reason = "fetch_identity_mismatch"
                    break
                try:
                    open_time = _strict_int(
                        getattr(bar, "open_time", None), field="open_time"
                    )
                except RepairValidationError as exc:
                    invalid_reason = f"invalid_official_row:{exc}"
                    break
                if not task.start_ms <= open_time <= task.end_ms:
                    invalid_reason = "fetch_range_mismatch"
                    break
                if open_time in official_by_time:
                    invalid_reason = f"duplicate_official_open_time:{open_time}"
                    break
                try:
                    official_by_time[open_time] = _validated_official_values(
                        bar,
                        now_ms=verification_now_ms,
                    )
                except RepairValidationError as exc:
                    invalid_reason = f"invalid_official_row:{exc}"
                    break
            if invalid_reason is not None:
                for candidate in expected.values():
                    plan.unresolved.append(_unresolved(candidate, invalid_reason))
                continue

            for open_time, candidate in expected.items():
                official = official_by_time.get(open_time)
                if official is None:
                    plan.unresolved.append(_unresolved(candidate, "official_row_missing"))
                    continue
                action = "relabel" if _values_match(candidate.row, official) else "replace"
                plan.repairs.append(PlannedRepair(candidate, official, action))

        plan.repairs.sort(key=lambda item: item.candidate.key)
        plan.unresolved.sort(
            key=lambda item: (
                item["exchange"], item["market_type"], item["symbol"], item["interval"], item["open_time"]
            )
        )
        return plan

    def _create_backup(self, request: RepairRequest) -> Path:
        assert request.backup_dir is not None
        request.backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = request.backup_dir / (
            f"{request.db_path.name}.pre-kline-repair-{_timestamp(self._now())}.bak"
        )
        if backup_path.exists():
            raise RepairApplyError("backup path already exists", {})

        source = sqlite3.connect(_read_only_uri(request.db_path), uri=True)
        destination = sqlite3.connect(str(backup_path))
        try:
            source.backup(destination)
            destination.commit()
        finally:
            destination.close()
            source.close()
        if self._quick_check(backup_path) != "ok":
            raise RepairValidationError(f"backup quick_check failed: {backup_path}")
        return backup_path

    def _apply_atomic(self, db_path: Path, plan: RepairPlan) -> int:
        conn = sqlite3.connect(str(db_path), timeout=0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA busy_timeout=0")
            conn.execute("BEGIN IMMEDIATE")
            current = _read_candidates_by_key(conn, [item.candidate.key for item in plan.repairs])
            for item in plan.repairs:
                row = current.get(item.candidate.key)
                if row is None:
                    raise RepairApplyError(f"candidate disappeared before apply: {item.candidate.key}", {})
                observed = Candidate(tuple(row[field] for field in _ROW_FIELDS))
                if observed.fingerprint != item.candidate.fingerprint:
                    raise RepairApplyError(f"candidate drifted before apply: {item.candidate.key}", {})

            now_ms = int(self._now().timestamp() * 1000)
            columns = {
                str(row[1]) for row in conn.execute("PRAGMA table_info(klines)")
            }
            sql = _repair_upsert_sql(semantic_identity=_has_semantic_identity(columns))
            for index, item in enumerate(plan.repairs):
                local = item.candidate.row
                official = item.official
                conn.execute(
                    sql,
                    (
                        local["exchange"],
                        local["market_type"],
                        local["symbol"],
                        local["interval"],
                        local["open_time"],
                        *(official[field] for field in _VALUE_FIELDS),
                        REPAIR_SOURCE,
                        local["created_at"],
                        now_ms,
                    ),
                )
                if self._write_fault is not None:
                    self._write_fault(index, conn)
            conn.commit()
            return len(plan.repairs)
        except Exception:
            try:
                conn.rollback()
            finally:
                pass
            raise
        finally:
            conn.close()

    def _official_fetch_manifest(self) -> dict[str, Any]:
        raw_active = (
            dict(self._endpoint_snapshot())
            if self._endpoint_snapshot is not None
            else {
                market: endpoints[0]
                for market, endpoints in self._official_endpoints.items()
            }
        )
        active: dict[str, str] = {}
        for market, configured in self._official_endpoints.items():
            value = raw_active.get(market) or configured[0]
            normalized = _validate_official_https_endpoint(market, value)
            if normalized not in configured:
                raise RepairValidationError(
                    f"active Binance {market} endpoint was not in the validated configuration: {normalized}"
                )
            active[market] = normalized
        return {
            "provider": "binance_rest",
            "official_https_only": True,
            "configured_endpoints": {
                market: list(endpoints)
                for market, endpoints in self._official_endpoints.items()
            },
            "active_endpoints": active,
        }

    def _build_manifest(self, request: RepairRequest, plan: RepairPlan) -> dict[str, Any]:
        exact = [item for item in plan.repairs if item.action == "relabel"]
        mismatch = [item for item in plan.repairs if item.action == "replace"]
        return {
            "schema_version": 1,
            "tool": "binance_kline_offline_repair",
            "created_at": self._now().isoformat(),
            "mode": "apply" if request.apply else "dry_run",
            "offline_required": True,
            "offline_confirmed": request.apply and request.confirm,
            "database": str(request.db_path),
            "report": str(request.report_path),
            "selection": {
                "exchanges": list(request.exchanges),
                "market_types": list(request.market_types),
                "symbols": list(request.symbols),
                "intervals": list(request.intervals),
                "sources": list(request.sources),
                "start_ms": request.start_ms,
                "end_ms": request.end_ms,
                "max_candidates": request.max_candidates,
            },
            "counts": {
                "candidates": len(plan.candidates),
                "fetch_tasks": plan.tasks_count,
                "exact_relabel": len(exact),
                "mismatch_replace": len(mismatch),
                "unresolved": len(plan.unresolved),
                "planned": len(plan.repairs),
            },
            "times": {
                "exact_relabel": [_time_entry(item.candidate, action="relabel") for item in exact],
                "mismatch_replace": [_time_entry(item.candidate, action="replace") for item in mismatch],
                "unresolved": list(plan.unresolved),
            },
            "repair_source": REPAIR_SOURCE,
            "official_fetch": self._official_fetch_manifest(),
            "backup": None,
            "result": {"status": "planning", "applied": 0},
        }

    @staticmethod
    def _quick_check(path: Path) -> str:
        with _read_only_connection(path) as conn:
            row = conn.execute("PRAGMA quick_check").fetchone()
        return str(row[0]) if row else "no_result"

    @staticmethod
    def _finish_manifest(request: RepairRequest, manifest: dict[str, Any]) -> dict[str, Any]:
        assert request.report_path is not None
        _write_json_atomic(request.report_path, manifest)
        return manifest


async def run_with_default_fetcher(request: RepairRequest) -> dict[str, Any]:
    """Run using CandleScope's configured transport and historical fetcher."""

    ingestion_config = IngestionConfig()
    backfill_config = BackfillConfig(
        exchange="binance",
        # One repair task can span every other native bucket.  The fetcher cap
        # is per task, so candidate count alone can truncate the official
        # response before the last candidate and create a false unresolved.
        fetch_max_total_bars=_repair_fetch_bar_budget(request.max_candidates),
    )
    transport = TransportLayer(ingestion_config)
    fetcher = HistoricalFetcher(backfill_config, transport, ingestion_config)
    configured_endpoints = {
        "spot": tuple(ingestion_config.get_http_urls("spot")),
        "futures": tuple(ingestion_config.get_http_urls("futures")),
    }

    def endpoint_snapshot() -> Mapping[str, str]:
        active = transport.snapshot().get("active_http_endpoints", {})
        return {
            market: str(active.get(f"binance:{market}", ""))
            for market in configured_endpoints
        }

    runner = KlineRepairRunner(
        fetcher,
        official_endpoints=configured_endpoints,
        endpoint_snapshot=endpoint_snapshot,
    )
    await transport.start()
    try:
        return await runner.run(request)
    finally:
        await transport.stop()


@contextmanager
def _read_only_connection(path: Path) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(_read_only_uri(path), uri=True)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def _read_only_uri(path: Path) -> str:
    return f"{path.resolve().as_uri()}?mode=ro"


def _validate_report_path(db_path: Path, report_path: Path) -> None:
    protected = {
        db_path,
        Path(f"{db_path}-wal"),
        Path(f"{db_path}-shm"),
        Path(f"{db_path}-journal"),
    }
    if report_path in protected:
        raise RepairValidationError("report path must not overlap the SQLite database or its sidecars")
    if report_path.suffix.lower() != ".json":
        raise RepairValidationError("report path must use a .json suffix")
    if report_path.exists():
        raise RepairValidationError(
            f"report path already exists; refusing to overwrite: {report_path}"
        )
    temporary = report_path.with_name(f".{report_path.name}.tmp")
    if temporary.exists():
        raise RepairValidationError(
            f"report temporary path already exists; refusing to overwrite: {temporary}"
        )


def _validate_official_https_endpoints(
    endpoint_map: Mapping[str, Sequence[str]],
) -> dict[str, tuple[str, ...]]:
    invalid_markets = sorted(
        str(market) for market in endpoint_map if str(market) not in _BINANCE_OFFICIAL_HTTPS_HOSTS
    )
    if invalid_markets:
        raise RepairValidationError(
            "unsupported endpoint market type(s): " + ", ".join(invalid_markets)
        )
    normalized: dict[str, tuple[str, ...]] = {}
    for market, raw_values in endpoint_map.items():
        values = (raw_values,) if isinstance(raw_values, str) else tuple(raw_values)
        endpoints = tuple(
            dict.fromkeys(
                _validate_official_https_endpoint(str(market), value)
                for value in values
            )
        )
        if endpoints:
            normalized[str(market)] = endpoints
    if not normalized:
        raise RepairValidationError("at least one official Binance HTTPS endpoint is required")
    return normalized


def _validate_official_https_endpoint(market: str, value: Any) -> str:
    text = str(value or "").strip()
    try:
        parsed = urlsplit(text)
        port = parsed.port
    except ValueError as exc:
        raise RepairValidationError(f"invalid Binance {market} endpoint: {text!r}") from exc
    hostname = (parsed.hostname or "").lower()
    allowed_hosts = _BINANCE_OFFICIAL_HTTPS_HOSTS.get(market, frozenset())
    if (
        parsed.scheme.lower() != "https"
        or hostname not in allowed_hosts
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise RepairValidationError(
            f"Binance {market} repair endpoint must be an official HTTPS origin: {text!r}"
        )
    return f"https://{hostname}"


def _repair_fetch_bar_budget(max_candidates: int) -> int:
    """Upper bound for one sparse task built by ``_build_fetch_tasks``."""

    per_task_candidates = min(max(int(max_candidates), 1), _MAX_TASK_CANDIDATES)
    return per_task_candidates * 2 - 1


def _build_fetch_tasks(candidates: Sequence[Candidate]) -> list[BackfillTask]:
    grouped: dict[tuple[str, str, str, str], list[Candidate]] = defaultdict(list)
    for candidate in candidates:
        exchange, market_type, symbol, interval, _ = candidate.key
        grouped[(exchange, market_type, symbol, interval)].append(candidate)

    tasks: list[BackfillTask] = []
    for (exchange, market_type, symbol, interval), rows in sorted(grouped.items()):
        rows.sort(key=lambda item: item.key[-1])
        interval_ms = parse_interval_ms(interval)
        if interval_ms is None:
            raise RepairValidationError(f"cannot parse native interval: {interval}")
        chunks: list[list[Candidate]] = []
        for candidate in rows:
            if (
                not chunks
                or len(chunks[-1]) >= _MAX_TASK_CANDIDATES
                or candidate.key[-1] - chunks[-1][-1].key[-1] > interval_ms * 2
            ):
                chunks.append([candidate])
            else:
                chunks[-1].append(candidate)
        for chunk in chunks:
            open_times = [item.key[-1] for item in chunk]
            tasks.append(
                BackfillTask(
                    symbol=symbol,
                    interval=interval,
                    start_ms=min(open_times),
                    end_ms=max(open_times),
                    # Candidates may be every other bucket.  Keep progress
                    # and the fetcher's per-task safety budget conservative.
                    estimated_bars=len(chunk) * 2 - 1,
                    exchange=exchange,
                    market_type=market_type,
                    metadata={
                        "repair": True,
                        "candidate_open_times": open_times,
                    },
                )
            )
    return tasks


def _strict_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        raise RepairValidationError(f"{field} must be an integer")
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise RepairValidationError(f"{field} must be an integer") from exc
    try:
        if float(value) != number:
            raise RepairValidationError(f"{field} must be an integer")
    except (TypeError, ValueError, OverflowError) as exc:
        raise RepairValidationError(f"{field} must be an integer") from exc
    return number


def _strict_finite_float(value: Any, *, field: str) -> float:
    if value is None or isinstance(value, bool):
        raise RepairValidationError(f"{field} is missing or non-numeric")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise RepairValidationError(f"{field} is missing or non-numeric") from exc
    if not math.isfinite(number):
        raise RepairValidationError(f"{field} must be finite")
    return number


def _validated_official_values(bar: Any, *, now_ms: int) -> dict[str, Any]:
    enhanced_fields = frozenset(
        str(item) for item in (getattr(bar, "enhanced_fields", ()) or ())
    )
    missing_enhanced = sorted(set(KLINE_ENHANCED_FIELDS) - enhanced_fields)
    if missing_enhanced:
        raise RepairValidationError(
            "official Binance row is missing enhanced fields: "
            + ", ".join(missing_enhanced)
        )

    interval = str(getattr(bar, "interval", ""))
    interval_ms = parse_interval_ms(interval)
    if interval_ms is None or interval_ms <= 0:
        raise RepairValidationError(f"unsupported official interval: {interval!r}")
    open_time = _strict_int(getattr(bar, "open_time", None), field="open_time")
    close_time = _strict_int(getattr(bar, "close_time", None), field="close_time")
    if open_time <= 0:
        raise RepairValidationError("open_time must be positive")
    if compute_bucket_start_ms(open_time, interval_ms, interval=interval) != open_time:
        raise RepairValidationError("open_time is not aligned to the native interval")
    expected_close = compute_bucket_close_ms(open_time, interval_ms, interval=interval)
    if close_time != expected_close:
        raise RepairValidationError(
            f"close_time does not match native bucket boundary ({expected_close})"
        )
    if close_time >= int(now_ms):
        raise RepairValidationError("official row belongs to the current/unclosed bucket")

    try:
        storage = bar.to_storage_dict()
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        raise RepairValidationError(
            f"official row cannot be serialized: {type(exc).__name__}: {exc}"
        ) from exc
    prices = {
        field: _strict_finite_float(storage.get(field), field=field)
        for field in ("open", "high", "low", "close")
    }
    if any(value <= 0 for value in prices.values()):
        raise RepairValidationError("OHLC prices must be positive")
    if (
        prices["high"] < max(prices["open"], prices["close"])
        or prices["low"] > min(prices["open"], prices["close"])
        or prices["high"] < prices["low"]
    ):
        raise RepairValidationError("OHLC values violate candle bounds")

    volume = _strict_finite_float(storage.get("volume"), field="volume")
    quote_volume = _strict_finite_float(
        storage.get("quote_volume"), field="quote_volume"
    )
    taker_buy_base = _strict_finite_float(
        storage.get("taker_buy_base"), field="taker_buy_base"
    )
    taker_buy_quote = _strict_finite_float(
        storage.get("taker_buy_quote"), field="taker_buy_quote"
    )
    trades = _strict_int(storage.get("trades"), field="trades")
    if min(volume, quote_volume, taker_buy_base, taker_buy_quote) < 0 or trades < 0:
        raise RepairValidationError("volume and trade fields must be non-negative")
    if volume > 0 and (quote_volume <= 0 or trades <= 0):
        raise RepairValidationError(
            "positive volume requires positive quote_volume and trades"
        )
    base_tolerance = max(1e-10, volume * 1e-10)
    quote_tolerance = max(1e-10, quote_volume * 1e-10)
    if taker_buy_base > volume + base_tolerance:
        raise RepairValidationError("taker_buy_base exceeds volume")
    if taker_buy_quote > quote_volume + quote_tolerance:
        raise RepairValidationError("taker_buy_quote exceeds quote_volume")

    return {
        "close_time": close_time,
        **prices,
        "volume": volume,
        "quote_volume": quote_volume,
        "trades": trades,
        "taker_buy_base": taker_buy_base,
        "taker_buy_quote": taker_buy_quote,
    }


def _values_match(local: dict[str, Any], official: dict[str, Any]) -> bool:
    return all(local[field] == official[field] for field in _VALUE_FIELDS)


def _unresolved(candidate: Candidate, reason: str) -> dict[str, Any]:
    entry = _time_entry(candidate, action="unresolved")
    entry["reason"] = reason
    return entry


def _time_entry(candidate: Candidate, *, action: str) -> dict[str, Any]:
    exchange, market_type, symbol, interval, open_time = candidate.key
    return {
        "exchange": exchange,
        "market_type": market_type,
        "symbol": symbol,
        "interval": interval,
        "open_time": open_time,
        "open_time_utc": datetime.fromtimestamp(open_time / 1000, timezone.utc).isoformat(),
        "action": action,
    }


def _read_candidates_by_key(
    conn: sqlite3.Connection,
    keys: Sequence[tuple[str, str, str, str, int]],
) -> dict[tuple[str, str, str, str, int], sqlite3.Row]:
    rows: dict[tuple[str, str, str, str, int], sqlite3.Row] = {}
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(klines)")}
    identity_filter = (
        " AND provider_id=exchange AND venue=exchange "
        "AND asset_class='crypto' AND series_variant='native' "
        "AND price_adjustment='raw' AND session_variant='continuous' "
        "AND volume_semantics='base_asset'"
        if _has_semantic_identity(columns)
        else ""
    )
    sql = (
        f"SELECT {', '.join(_ROW_FIELDS)} FROM klines "
        "WHERE exchange=? AND market_type=? AND symbol=? AND interval=? AND open_time=?"
        + identity_filter
    )
    for key in keys:
        row = conn.execute(sql, key).fetchone()
        if row is not None:
            rows[key] = row
    return rows


def _has_semantic_identity(columns: set[str]) -> bool:
    return {
        "provider_id",
        "venue",
        "asset_class",
        "series_variant",
        "price_adjustment",
        "session_variant",
        "volume_semantics",
    } <= columns


def _repair_upsert_sql(*, semantic_identity: bool) -> str:
    conflict_target = (
        """
            exchange, market_type, provider_id, venue, asset_class,
            symbol, interval, series_variant, price_adjustment,
            session_variant, volume_semantics, open_time
        """
        if semantic_identity
        else "exchange, market_type, symbol, interval, open_time"
    )
    return f"""
        INSERT INTO klines (
            exchange, market_type, symbol, interval, open_time,
            close_time, open, high, low, close, volume, quote_volume,
            trades, taker_buy_base, taker_buy_quote,
            source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT({conflict_target}) DO UPDATE SET
            close_time=excluded.close_time,
            open=excluded.open,
            high=excluded.high,
            low=excluded.low,
            close=excluded.close,
            volume=excluded.volume,
            quote_volume=excluded.quote_volume,
            trades=excluded.trades,
            taker_buy_base=excluded.taker_buy_base,
            taker_buy_quote=excluded.taker_buy_quote,
            source=excluded.source,
            updated_at=excluded.updated_at
    """


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    if path.exists():
        raise FileExistsError(f"refusing to overwrite existing report: {path}")
    temporary = path.with_name(f".{path.name}.tmp")
    encoded = (
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )
    published = False
    try:
        with temporary.open("x", encoding="utf-8", newline="") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        # A hard-link is an atomic no-replace publication on the same
        # filesystem.  Unlike Path.replace(), it cannot clobber a database,
        # sidecar, backup, or a report created by a concurrent operator.
        os.link(temporary, path)
        published = True
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            if not published:
                raise
