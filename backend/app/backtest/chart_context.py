"""Resolve chart sessions into immutable, reproducible backtest contexts."""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import threading
import time
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping

from app.data_engine.data_manager.backfill_coordinator import RepairRequest
from app.data_engine.interval_policy import IntervalSpec, parse_interval_spec
from app.data_engine.interval_resolution import (
    IntervalPurpose,
    IntervalResolutionError,
    IntervalResolver,
)
from app.local_data.service import LocalDatasetError, LocalDatasetService

from .errors import BacktestError
from .identity import canonical_json
from .quick_presets import quick_preset_for_market


SCHEMA_VERSION = "candlescope.backtest-chart-context/1"
TOKEN_TTL_MS = 5 * 60 * 1000
_AMBIGUOUS_MARKET_TYPES = {"", "auto", "contract", "derivative", "perp", "unknown"}
_MARKET_TYPE_ALIASES = {
    "coinm": "futures",
    "linear_perpetual": "futures",
    "perpetual": "futures",
    "swap": "futures",
    "usdm": "futures",
}


@dataclass(frozen=True, slots=True)
class ChartContextRequest:
    exchange: str
    market_type: str
    symbol: str
    interval: str
    range_mode: str
    start_time_ms: int | None
    end_time_ms: int | None
    fidelity_preference: str

    @classmethod
    def from_mapping(cls, values: Mapping[str, object]) -> ChartContextRequest:
        interval = parse_interval_spec(str(values.get("interval") or ""))
        return cls(
            exchange=str(values.get("exchange") or "").strip().lower(),
            market_type=_MARKET_TYPE_ALIASES.get(
                str(values.get("market_type") or "").strip().lower(),
                str(values.get("market_type") or "").strip().lower(),
            ),
            symbol=str(values.get("symbol") or "").strip().upper(),
            interval=(
                interval.canonical
                if interval is not None
                else str(values.get("interval") or "").strip()
            ),
            range_mode=str(values.get("range_mode") or "ALL_AVAILABLE").strip().upper(),
            start_time_ms=(
                None
                if values.get("start_time_ms") is None
                else int(values["start_time_ms"])
            ),
            end_time_ms=(
                None
                if values.get("end_time_ms") is None
                else int(values["end_time_ms"])
            ),
            fidelity_preference=str(
                values.get("fidelity_preference") or "FAST"
            ).strip().upper(),
        )

    def wire(self) -> dict[str, object]:
        return {
            "exchange": self.exchange,
            "market_type": self.market_type,
            "symbol": self.symbol,
            "interval": self.interval,
            "range_mode": self.range_mode,
            "start_time_ms": self.start_time_ms,
            "end_time_ms": self.end_time_ms,
            "fidelity_preference": self.fidelity_preference,
        }


@dataclass(slots=True)
class _ResolutionRecord:
    request: ChartContextRequest
    context_hash: str
    status: str
    expires_at_ms: int
    candidate_dataset_id: str | None = None
    candidate_data_epoch: str | None = None


class ChartBacktestContextResolver:
    """Thin facade over immutable local data and Host-owned market data."""

    def __init__(self, runtime: Any, *, now_ms: Any | None = None) -> None:
        self.runtime = runtime
        self.local_data: LocalDatasetService = runtime.local_data
        self.settings = runtime.settings
        self._now_ms = now_ms or (lambda: int(time.time() * 1000))
        self._records: dict[str, _ResolutionRecord] = {}
        self._idempotent_results: dict[str, tuple[str, dict[str, Any]]] = {}
        self._context_results: dict[str, dict[str, Any]] = {}
        self._idempotency_locks: dict[str, asyncio.Lock] = {}
        self._materialize_locks: dict[str, asyncio.Lock] = {}
        self._guard = threading.RLock()

    def resolve(
        self,
        values: Mapping[str, object],
        *,
        host_data_manager: Any | None = None,
    ) -> dict[str, Any]:
        request = ChartContextRequest.from_mapping(values)
        base_hash = self._hash({"request": request.wire()})
        interval = parse_interval_spec(request.interval)
        if interval is None:
            return self._finalize(
                request,
                base_hash,
                "UNSUPPORTED_INTERVAL",
                warnings=[self._warning("INTERVAL_INVALID", "该周期无法精确解析。")],
            )
        if request.market_type in _AMBIGUOUS_MARKET_TYPES:
            return self._finalize(
                request,
                base_hash,
                "AMBIGUOUS_MARKET",
                warnings=[
                    self._warning(
                        "MARKET_IDENTITY_REQUIRED", "请选择明确的现货或合约市场。"
                    )
                ],
            )
        if request.fidelity_preference == "FAST" and not self.settings.bar_effective:
            return self._unsupported_fidelity(request, base_hash)
        if request.fidelity_preference == "PRECISE" and (
            not self.settings.trade_tape_effective or self.runtime.trade_archive is None
        ):
            return self._unsupported_fidelity(request, base_hash)

        manifests = [
            item
            for item in self.local_data.list_datasets()
            if str(item.get("symbol") or "").upper() == request.symbol
        ]
        exact = [item for item in manifests if self._manifest_matches(item, request)]
        ambiguous = [
            item
            for item in manifests
            if not item.get("exchange") or not item.get("market_type")
        ]
        interval_failures = 0
        incomplete: tuple[dict[str, Any], dict[str, Any]] | None = None
        for manifest in exact:
            try:
                self.local_data.resolve_interval(manifest, request.interval)
            except LocalDatasetError:
                interval_failures += 1
                continue
            resolved_range = self._range_for_manifest(request, manifest)
            if resolved_range is None:
                continue
            preview = self._preview(request, manifest, *resolved_range)
            if preview is None:
                continue
            if self._preview_is_complete(preview, interval, *resolved_range):
                return self._ready(request, manifest, preview, *resolved_range)
            if incomplete is None:
                incomplete = (manifest, preview)

        if exact and interval_failures == len(exact):
            return self._finalize(
                request,
                base_hash,
                "UNSUPPORTED_INTERVAL",
                warnings=[
                    self._warning(
                        "INTERVAL_NOT_COMPOSABLE",
                        "现有不可变数据不能按整数倍精确构造该周期。",
                    )
                ],
            )
        if request.fidelity_preference == "PRECISE":
            return self._unsupported_fidelity(request, base_hash)
        if host_data_manager is None:
            if ambiguous and not exact:
                return self._finalize(
                    request,
                    base_hash,
                    "AMBIGUOUS_MARKET",
                    warnings=[
                        self._warning(
                            "DATASET_MARKET_AMBIGUOUS",
                            "本地数据集缺少交易所或市场类型身份。",
                        )
                    ],
                )
            return self._finalize(
                request,
                base_hash,
                "UNAVAILABLE",
                warnings=[
                    self._warning(
                        "HOST_DATA_UNAVAILABLE", "Host 市场数据服务当前不可用。"
                    )
                ],
            )

        route = self._resolve_host_interval(request)
        if route is None:
            return self._finalize(
                request,
                base_hash,
                "UNSUPPORTED_INTERVAL",
                warnings=[
                    self._warning(
                        "INTERVAL_NOT_COMPOSABLE",
                        "Host 不支持该周期，也没有可精确聚合的基础周期。",
                    )
                ],
            )
        effective_range = self._host_range(request, host_data_manager, route.source_interval)
        if effective_range is None:
            return self._finalize(
                request,
                base_hash,
                "NEEDS_DATA",
                candidate=(incomplete[0] if incomplete else None),
                coverage=self._coverage(request, None, None, [], complete=False),
                materialize={
                    "required": True,
                    "source_interval": route.source_interval,
                    "estimated_bars": None,
                    "estimated_bytes": None,
                    "reason": "range_not_available_locally",
                },
            )
        start_ms, end_ms = effective_range
        local_query = self._query_host(
            request,
            host_data_manager,
            start_ms=start_ms,
            end_ms=end_ms,
        )
        bars = list(getattr(local_query, "bars", []) or []) if local_query is not None else []
        missing = self._missing_ranges(local_query)
        estimated = self._expected_rows(interval, start_ms, end_ms)
        available_start, available_end = self._bar_bounds(bars, interval)
        context_hash = self._hash(
            {"request": request.wire(), "start_time_ms": start_ms, "end_time_ms": end_ms}
        )
        return self._finalize(
            request,
            context_hash,
            "NEEDS_DATA",
            candidate=(incomplete[0] if incomplete else None),
            effective_range=effective_range,
            coverage=self._coverage(
                request,
                available_start,
                available_end,
                missing,
                complete=False,
                requested_range=effective_range,
            ),
            materialize={
                "required": True,
                "source_interval": route.source_interval,
                "estimated_bars": max(0, estimated - len(bars)),
                "estimated_bytes": max(0, estimated - len(bars)) * 80,
                "reason": "immutable_snapshot_required",
            },
        )

    async def materialize(
        self,
        *,
        resolution_token: str,
        user_confirmed: bool,
        idempotency_key: str,
        host_data_manager: Any | None,
        backfill_coordinator: Any | None,
        expected_dataset_id: str | None = None,
        expected_data_epoch: str | None = None,
    ) -> dict[str, Any]:
        if not user_confirmed:
            raise BacktestError(
                "USER_CONFIRMATION_REQUIRED",
                "chart-context materialization requires explicit user confirmation",
            )
        record = self._record(resolution_token)
        if record.status != "NEEDS_DATA":
            raise BacktestError(
                "RESOLUTION_NOT_MATERIALIZABLE",
                "the resolution token does not require data materialization",
            )
        if host_data_manager is None:
            raise BacktestError(
                "HOST_DATA_UNAVAILABLE", "Host market data service is unavailable"
            )
        if expected_dataset_id is not None and (
            expected_dataset_id != record.candidate_dataset_id
        ):
            raise BacktestError(
                "DATA_SNAPSHOT_MISMATCH", "resolved dataset identity changed"
            )
        if expected_data_epoch is not None and (
            expected_data_epoch != record.candidate_data_epoch
        ):
            raise BacktestError(
                "DATA_SNAPSHOT_MISMATCH", "resolved dataset revision changed"
            )
        self._assert_candidate_current(record)

        with self._guard:
            existing = self._idempotent_results.get(idempotency_key)
            if existing is not None:
                if existing[0] != record.context_hash:
                    raise BacktestError(
                        "IDEMPOTENCY_CONFLICT",
                        "idempotency key belongs to another chart context",
                    )
                return deepcopy(existing[1])
            idempotency_lock = self._idempotency_locks.setdefault(
                idempotency_key, asyncio.Lock()
            )

        async with idempotency_lock:
            with self._guard:
                existing = self._idempotent_results.get(idempotency_key)
                if existing is not None:
                    if existing[0] != record.context_hash:
                        raise BacktestError(
                            "IDEMPOTENCY_CONFLICT",
                            "idempotency key belongs to another chart context",
                        )
                    return deepcopy(existing[1])
                context_lock = self._materialize_locks.setdefault(
                    record.context_hash, asyncio.Lock()
                )
            async with context_lock:
                self._assert_candidate_current(record)
                with self._guard:
                    completed = self._context_results.get(record.context_hash)
                    if completed is not None:
                        self._idempotent_results[idempotency_key] = (
                            record.context_hash,
                            deepcopy(completed),
                        )
                        return deepcopy(completed)
                result = await self._materialize_once(
                    record,
                    host_data_manager=host_data_manager,
                    backfill_coordinator=backfill_coordinator,
                )
                with self._guard:
                    self._context_results[record.context_hash] = deepcopy(result)
                    self._idempotent_results[idempotency_key] = (
                        record.context_hash,
                        deepcopy(result),
                    )
                return result

    def _assert_candidate_current(self, record: _ResolutionRecord) -> None:
        if record.candidate_dataset_id is None:
            return
        try:
            current = self.local_data.get_manifest(record.candidate_dataset_id)
        except LocalDatasetError as exc:
            raise BacktestError(
                "DATA_SNAPSHOT_MISMATCH", "resolved dataset is no longer available"
            ) from exc
        if current.get("data_epoch") != record.candidate_data_epoch:
            raise BacktestError(
                "DATA_SNAPSHOT_MISMATCH", "resolved dataset revision changed"
            )

    async def _materialize_once(
        self,
        record: _ResolutionRecord,
        *,
        host_data_manager: Any,
        backfill_coordinator: Any | None,
    ) -> dict[str, Any]:
        request = record.request
        if request.fidelity_preference != "FAST":
            raise BacktestError(
                "FIDELITY_UNSUPPORTED",
                "precise chart materialization requires an imported trade archive",
            )
        route = self._resolve_host_interval(request)
        if route is None:
            raise BacktestError(
                "INTERVAL_UNSUPPORTED", "the interval cannot be constructed exactly"
            )
        effective_range = self._host_range(request, host_data_manager, route.source_interval)
        if effective_range is None:
            raise BacktestError(
                "DATA_RANGE_UNAVAILABLE", "the requested chart range is not available"
            )
        start_ms, end_ms = effective_range
        query = self._query_host(
            request,
            host_data_manager,
            start_ms=start_ms,
            end_ms=end_ms,
        )
        interval = parse_interval_spec(request.interval)
        assert interval is not None
        if not self._host_query_is_complete(query, interval, start_ms, end_ms):
            if backfill_coordinator is None:
                raise BacktestError(
                    "HOST_DATA_UNAVAILABLE", "Host backfill service is unavailable"
                )
            repair = RepairRequest(
                symbol=request.symbol,
                interval=route.source_interval,
                start_ms=start_ms,
                end_ms=end_ms,
                exchange=request.exchange,
                market_type=request.market_type,
                reason="backtest_chart_context",
                priority=10,
                requester="backtest_chart_context",
                wait_policy="wait",
                metadata={
                    "requires_trusted_finality": True,
                    "chart_context_hash": record.context_hash,
                },
            )
            try:
                await backfill_coordinator.request_and_wait(repair)
            except Exception as exc:
                raise BacktestError(
                    "DATA_PREPARATION_FAILED", "Host data preparation failed"
                ) from exc
            query = self._query_host(
                request,
                host_data_manager,
                start_ms=start_ms,
                end_ms=end_ms,
            )
        if not self._host_query_is_complete(query, interval, start_ms, end_ms):
            raise BacktestError(
                "DATA_COVERAGE_INCOMPLETE",
                "Host data is still incomplete after preparation",
            )
        bars = list(getattr(query, "bars", []) or [])
        if len(bars) > self.settings.max_bar_rows:
            raise BacktestError(
                "BUDGET_EXCEEDED", "chart snapshot exceeds the BAR row ceiling"
            )
        dataset_id = f"local-{record.context_hash.removeprefix('sha256:')[:32]}"
        try:
            manifest = self.local_data.freeze_host_bars(
                bars,
                dataset_id=dataset_id,
                name=f"{request.exchange} {request.market_type} {request.symbol} {request.interval}",
                exchange=request.exchange,
                market_type=request.market_type,
                symbol=request.symbol,
                interval=request.interval,
                chart_context_hash=record.context_hash,
            )
        except LocalDatasetError as exc:
            raise BacktestError(
                "DATA_PREPARATION_FAILED", "immutable snapshot validation failed"
            ) from exc
        preview = self.runtime.preview_snapshot(
            dataset_id=manifest["dataset_id"],
            data_epoch=manifest["data_epoch"],
            start_time_ms=start_ms,
            end_time_ms=end_ms,
            interval=request.interval,
            fidelity_mode="BAR_APPROX",
            exchange=request.exchange,
            market_type=request.market_type,
        )
        if not self._preview_is_complete(preview, interval, start_ms, end_ms):
            raise BacktestError(
                "DATA_COVERAGE_INCOMPLETE", "immutable snapshot coverage is incomplete"
            )
        return self._ready(request, manifest, preview, start_ms, end_ms)

    def _ready(
        self,
        request: ChartContextRequest,
        manifest: Mapping[str, Any],
        preview: Mapping[str, Any],
        start_ms: int,
        end_ms: int,
    ) -> dict[str, Any]:
        identity = {
            "request": request.wire(),
            "dataset_id": manifest["dataset_id"],
            "data_epoch": preview["data_epoch"],
            "snapshot_hash": preview["snapshot_hash"],
            "start_time_ms": start_ms,
            "end_time_ms": end_ms,
        }
        context_hash = self._hash(identity)
        return self._finalize(
            request,
            context_hash,
            "READY",
            candidate=manifest,
            effective_range=(start_ms, end_ms),
            snapshot=preview,
            coverage=self._coverage(
                request,
                int(preview["coverage_start_ms"]),
                int(preview["coverage_end_ms"]),
                [],
                complete=True,
                row_count=int(preview.get("market_row_count") or preview["row_count"]),
                requested_range=(start_ms, end_ms),
            ),
            materialize={"required": False},
        )

    def _finalize(
        self,
        request: ChartContextRequest,
        context_hash: str,
        status: str,
        *,
        candidate: Mapping[str, Any] | None = None,
        effective_range: tuple[int, int] | None = None,
        snapshot: Mapping[str, Any] | None = None,
        coverage: Mapping[str, Any] | None = None,
        materialize: Mapping[str, Any] | None = None,
        warnings: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        expires_at_ms = self._now_ms() + TOKEN_TTL_MS
        token = secrets.token_urlsafe(32)
        record = _ResolutionRecord(
            request=ChartContextRequest(
                **{
                    **request.wire(),
                    "start_time_ms": (
                        effective_range[0] if effective_range else request.start_time_ms
                    ),
                    "end_time_ms": (
                        effective_range[1] if effective_range else request.end_time_ms
                    ),
                }
            ),
            context_hash=context_hash,
            status=status,
            expires_at_ms=expires_at_ms,
            candidate_dataset_id=(
                str(candidate["dataset_id"]) if candidate is not None else None
            ),
            candidate_data_epoch=(
                str(candidate["data_epoch"]) if candidate is not None else None
            ),
        )
        with self._guard:
            self._prune_records()
            self._records[token] = record
        preset = quick_preset_for_market(request.market_type)
        dataset_id = str(candidate["dataset_id"]) if candidate is not None else None
        data_epoch = (
            str(snapshot["data_epoch"])
            if snapshot is not None
            else str(candidate["data_epoch"])
            if candidate is not None
            else None
        )
        return {
            "schema_version": SCHEMA_VERSION,
            "status": status,
            "resolution_token": token,
            "chart_context_hash": context_hash,
            "expires_at_ms": expires_at_ms,
            "request": request.wire(),
            "dataset_id": dataset_id,
            "data_epoch": data_epoch,
            "snapshot_hash": (
                str(snapshot["snapshot_hash"]) if snapshot is not None else None
            ),
            "coverage": dict(coverage or self._coverage(request, None, None, [], complete=False)),
            "fidelity": {
                "preference": request.fidelity_preference,
                "mode": (
                    "BAR_APPROX"
                    if request.fidelity_preference == "FAST"
                    else "AGG_TRADE_EXECUTION"
                ),
                "capabilities": (
                    list(snapshot.get("fidelity_capabilities") or [])
                    if snapshot is not None
                    else list(self.runtime.service.capabilities()["fidelity_modes"])
                ),
            },
            "quality_warnings": list(warnings or []),
            "quick_preset_id": preset["id"],
            "cost_preset": {
                "preset_id": preset["id"],
                "preset_revision": preset["revision"],
                "fee_source": preset["fee_source"],
                "fee_bps": preset["fee_bps"],
                "slippage_bps": preset["slippage_bps"],
            },
            "account_execution_preset": {
                key: preset[key]
                for key in (
                    "account_model",
                    "sizing_policy",
                    "equity_percent",
                    "initial_cash",
                    "leverage",
                    "execution_model_revision",
                    "contract_data_mode",
                    "funding_mode",
                )
            },
            "materialize": dict(materialize or {"required": status == "NEEDS_DATA"}),
        }

    def _record(self, token: str) -> _ResolutionRecord:
        with self._guard:
            self._prune_records()
            record = self._records.get(token)
        if record is None:
            raise BacktestError(
                "RESOLUTION_TOKEN_INVALID", "resolution token is invalid or expired"
            )
        return record

    def _prune_records(self) -> None:
        now_ms = self._now_ms()
        expired = [
            key for key, value in self._records.items() if value.expires_at_ms <= now_ms
        ]
        for key in expired:
            self._records.pop(key, None)

    def _preview(
        self,
        request: ChartContextRequest,
        manifest: Mapping[str, Any],
        start_ms: int,
        end_ms: int,
    ) -> dict[str, Any] | None:
        try:
            return self.runtime.preview_snapshot(
                dataset_id=manifest["dataset_id"],
                data_epoch=manifest["data_epoch"],
                start_time_ms=start_ms,
                end_time_ms=end_ms,
                interval=request.interval,
                fidelity_mode=(
                    "BAR_APPROX"
                    if request.fidelity_preference == "FAST"
                    else "AGG_TRADE_EXECUTION"
                ),
                exchange=request.exchange,
                market_type=request.market_type,
            )
        except BacktestError:
            return None

    @staticmethod
    def _preview_is_complete(
        preview: Mapping[str, Any],
        interval: IntervalSpec,
        start_ms: int,
        end_ms: int,
    ) -> bool:
        row_count = int(preview.get("market_row_count") or preview.get("row_count") or 0)
        if row_count < 1:
            return False
        coverage_start = int(preview.get("coverage_start_ms") or start_ms)
        coverage_end = int(preview.get("coverage_end_ms") or end_ms)
        if coverage_start > interval.floor_ms(start_ms) or coverage_end < end_ms:
            return False
        first_sequence = int(preview.get("first_sequence") or 0)
        last_sequence = int(preview.get("last_sequence") or 0)
        if first_sequence != 1 or last_sequence != row_count:
            return False
        quality = preview.get("quality") or {}
        return not any(
            int(item.get("start_ms", end_ms + 1)) <= end_ms
            and int(item.get("end_ms", start_ms - 1)) >= start_ms
            for item in quality.get("excluded_ranges", [])
        )

    @staticmethod
    def _manifest_matches(
        manifest: Mapping[str, Any], request: ChartContextRequest
    ) -> bool:
        return (
            str(manifest.get("exchange") or "").lower() == request.exchange
            and str(manifest.get("market_type") or "").lower() == request.market_type
            and str(manifest.get("symbol") or "").upper() == request.symbol
        )

    @staticmethod
    def _range_for_manifest(
        request: ChartContextRequest, manifest: Mapping[str, Any]
    ) -> tuple[int, int] | None:
        if request.range_mode != "ALL_AVAILABLE":
            if request.start_time_ms is None or request.end_time_ms is None:
                return None
            return request.start_time_ms, request.end_time_ms
        interval = parse_interval_spec(request.interval)
        if interval is None or manifest.get("first_open_ms") is None:
            return None
        source_interval = parse_interval_spec(str(manifest.get("interval") or ""))
        last_open = manifest.get("last_open_ms")
        if source_interval is None or last_open is None:
            return None
        return int(manifest["first_open_ms"]), source_interval.next_ms(int(last_open)) - 1

    def _resolve_host_interval(self, request: ChartContextRequest) -> Any | None:
        try:
            return IntervalResolver().resolve(
                exchange=request.exchange,
                market_type=request.market_type,
                interval=request.interval,
                purpose=IntervalPurpose.HISTORY,
            )
        except (IntervalResolutionError, ValueError):
            return None

    @staticmethod
    def _host_range(
        request: ChartContextRequest, host_data_manager: Any, source_interval: str
    ) -> tuple[int, int] | None:
        if request.range_mode != "ALL_AVAILABLE":
            if request.start_time_ms is None or request.end_time_ms is None:
                return None
            return request.start_time_ms, request.end_time_ms
        try:
            bounds = host_data_manager.get_bounds(
                request.symbol,
                source_interval,
                exchange=request.exchange,
                market_type=request.market_type,
            )
        except Exception:
            return None
        earliest = bounds.get("storage_earliest_ms")
        latest = bounds.get("storage_latest_ms")
        if earliest is None or latest is None:
            cache_earliest = bounds.get("cache_earliest")
            cache_latest = bounds.get("cache_latest")
            if cache_earliest is not None and cache_latest is not None:
                earliest = int(cache_earliest) * 1000
                latest = int(cache_latest) * 1000
        if earliest is None or latest is None:
            earliest = bounds.get("earliest") or bounds.get("start_ms")
            latest = bounds.get("latest") or bounds.get("end_ms")
        if earliest is None or latest is None:
            return None
        interval = parse_interval_spec(source_interval)
        end_ms = (
            interval.next_ms(int(latest)) - 1 if interval is not None else int(latest)
        )
        return int(earliest), end_ms

    def _query_host(
        self,
        request: ChartContextRequest,
        host_data_manager: Any,
        *,
        start_ms: int,
        end_ms: int,
    ) -> Any | None:
        interval = parse_interval_spec(request.interval)
        query_start_ms = interval.floor_ms(start_ms) if interval is not None else start_ms
        try:
            return host_data_manager.query(
                request.symbol,
                request.interval,
                start_ms=query_start_ms,
                end_ms=end_ms,
                limit=self.settings.max_bar_rows + 1,
                exchange=request.exchange,
                market_type=request.market_type,
                auto_backfill=False,
                backfill_requester="backtest_chart_context_resolve",
            )
        except Exception:
            return None

    @classmethod
    def _host_query_is_complete(
        cls,
        query: Any | None,
        interval: IntervalSpec,
        start_ms: int,
        end_ms: int,
    ) -> bool:
        if query is None or cls._missing_ranges(query):
            return False
        bars = list(getattr(query, "bars", []) or [])
        if not bars or any(not bool(getattr(bar, "is_closed", True)) for bar in bars):
            return False
        opens = [int(getattr(bar, "time")) * 1000 for bar in bars]
        required_first = interval.floor_ms(start_ms)
        required_last = interval.floor_ms(end_ms)
        return (
            opens[0] == required_first
            and opens[-1] == required_last
            and all(interval.is_successor(left, right) for left, right in zip(opens, opens[1:]))
        )

    @staticmethod
    def _missing_ranges(query: Any | None) -> list[dict[str, Any]]:
        if query is None:
            return []
        result: list[dict[str, Any]] = []
        for item in list(getattr(query, "missing_ranges", []) or []):
            if isinstance(item, Mapping):
                result.append(dict(item))
            elif callable(getattr(item, "to_dict", None)):
                result.append(dict(item.to_dict()))
        return result

    @staticmethod
    def _bar_bounds(
        bars: list[Any], interval: IntervalSpec
    ) -> tuple[int | None, int | None]:
        if not bars:
            return None, None
        return (
            int(getattr(bars[0], "time")) * 1000,
            interval.next_ms(int(getattr(bars[-1], "time")) * 1000) - 1,
        )

    @staticmethod
    def _expected_rows(interval: IntervalSpec, start_ms: int, end_ms: int) -> int:
        first = interval.floor_ms(start_ms)
        last = interval.floor_ms(end_ms)
        if interval.nominal_ms > 0 and interval.alignment.value != "calendar_month":
            return max(0, (last - first) // interval.nominal_ms + 1)
        count = 0
        cursor = first
        while cursor <= last and count <= 1_000_000:
            count += 1
            cursor = interval.next_ms(cursor)
        return count

    @staticmethod
    def _coverage(
        request: ChartContextRequest,
        available_start_ms: int | None,
        available_end_ms: int | None,
        missing_ranges: list[dict[str, Any]],
        *,
        complete: bool,
        row_count: int | None = None,
        requested_range: tuple[int, int] | None = None,
    ) -> dict[str, Any]:
        return {
            "requested_start_ms": (
                requested_range[0] if requested_range else request.start_time_ms
            ),
            "requested_end_ms": (
                requested_range[1] if requested_range else request.end_time_ms
            ),
            "available_start_ms": available_start_ms,
            "available_end_ms": available_end_ms,
            "row_count": row_count,
            "missing_ranges": missing_ranges,
            "complete": complete,
        }

    def _unsupported_fidelity(
        self, request: ChartContextRequest, context_hash: str
    ) -> dict[str, Any]:
        return self._finalize(
            request,
            context_hash,
            "UNSUPPORTED_FIDELITY",
            warnings=[
                self._warning(
                    "FIDELITY_NOT_AVAILABLE",
                    "当前数据不支持所选精度；可切换快速估算或导入成交档案。",
                )
            ],
        )

    @staticmethod
    def _warning(code: str, message: str) -> dict[str, str]:
        return {"code": code, "message": message}

    @staticmethod
    def _hash(value: Mapping[str, Any]) -> str:
        return f"sha256:{hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()}"
