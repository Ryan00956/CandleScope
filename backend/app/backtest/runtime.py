"""Standalone local-data runtime and durable worker for backtest runs."""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

from app.core.config import BacktestSettings
from app.data_engine.storage.raw_trade_archive import (
    ParquetRawAggTradeArchive,
    RawAggTradeCursor,
    RawAggTradeDatasetRef,
)
from app.data_engine.interval_policy import parse_interval_spec
from app.local_data.service import LocalDatasetError, LocalDatasetService
from app.market_dataset.adapters.local_bar import LocalBarSnapshotProvider
from app.market_dataset.adapters.contract_aux import (
    AUX_ROLES,
    ContractAuxSnapshotProvider,
)
from app.market_dataset.models import DatasetRef
from app.market_dataset.snapshot import (
    MarketDatasetError,
    MarketDatasetSnapshot,
    MarketEvent,
    sha256_hex,
)
from app.simulation.trade_bar_builder import derive_complete_trade_bars
from app.simulation.contract_accounting import merge_contract_timeline

from .errors import BacktestError
from .service import BacktestService
from .strategy.isolated import IsolatedStrategyProvider
from .strategy.registry import build_default_strategy_registry

logger = logging.getLogger("candlescope.backtest")
HISTORICAL_CONTRACT_MODE = "HISTORICAL_CONTRACT_V1"


def _required_contract_roles(account_model: str, funding_mode: str) -> tuple[str, ...]:
    if account_model != "LINEAR_PERP_ONE_WAY_V2":
        return AUX_ROLES
    roles = ["MARK_INDEX", "INSTRUMENT_RULES"]
    if funding_mode == "HISTORICAL_REQUIRED":
        roles.append("FUNDING")
    return tuple(roles)


def _renumber_timeline(events: tuple[MarketEvent, ...]) -> tuple[MarketEvent, ...]:
    return tuple(
        MarketEvent(
            sequence=index,
            event_time_ms=event.event_time_ms,
            role=event.role,
            payload=dict(event.payload),
        )
        for index, event in enumerate(events, start=1)
    )


class BacktestRuntime:
    def __init__(
        self,
        *,
        settings: BacktestSettings,
        local_data_dir: Path,
        service: BacktestService,
        trade_archive_dir: Path | None = None,
    ) -> None:
        self.settings = settings
        self.service = service
        self.local_data = LocalDatasetService(local_data_dir)
        self.snapshots = LocalBarSnapshotProvider(
            self.local_data,
            max_rows=settings.max_bar_rows,
        )
        self.trade_archive = (
            None
            if trade_archive_dir is None or not settings.trade_tape_effective
            else ParquetRawAggTradeArchive(
                trade_archive_dir,
                read_only=True,
                max_scan_rows=settings.max_trade_events,
            )
        )
        self.worker = BacktestWorker(
            settings=settings,
            local_data_dir=local_data_dir,
            trade_archive_dir=trade_archive_dir,
        )

    @classmethod
    def start(
        cls,
        settings: BacktestSettings,
        *,
        local_data_dir: Path,
        trade_archive_dir: Path | None = None,
    ) -> BacktestRuntime:
        service = BacktestService.start(
            settings,
            strategy_registry=build_default_strategy_registry(),
            enforce_registered_revisions=True,
        )
        runtime = cls(
            settings=settings,
            local_data_dir=local_data_dir,
            service=service,
            trade_archive_dir=trade_archive_dir,
        )
        try:
            runtime.worker.start()
        except BaseException:
            service.shutdown()
            raise
        return runtime

    def shutdown(self) -> None:
        self.worker.shutdown()
        self.service.shutdown()

    def list_datasets(self) -> list[dict[str, Any]]:
        datasets: list[dict[str, Any]] = []
        for manifest in self.local_data.list_datasets():
            interval = parse_interval_spec(str(manifest["interval"]))
            last_open_ms = manifest.get("last_open_ms")
            last_close_ms = (
                None
                if interval is None or last_open_ms is None
                else interval.next_ms(int(last_open_ms)) - 1
            )
            datasets.append(
                {
                    "dataset_id": manifest["dataset_id"],
                    "data_epoch": manifest["data_epoch"],
                    "name": manifest["name"],
                    "symbol": manifest["symbol"],
                    "interval": manifest["interval"],
                    "rows": manifest["rows"],
                    "first_open_ms": manifest.get("first_open_ms"),
                    "last_close_ms": last_close_ms,
                    "strategy_revisions": self.service.strategy_registry.revision_ids(),
                    "contract_history": manifest.get("contract_history"),
                }
            )
        return datasets

    def preview_snapshot(
        self,
        *,
        dataset_id: str,
        data_epoch: str,
        start_time_ms: int,
        end_time_ms: int,
        interval: str | None,
        fidelity_mode: str = "BAR_APPROX",
        exchange: str = "binance",
        market_type: str = "usdm",
        contract_data_mode: str = "LEGACY_FIXED_V1",
        account_model: str = "LINEAR_PERP_ONE_WAY_V1",
        funding_mode: str = "OFF",
    ) -> dict[str, Any]:
        if fidelity_mode in {"AGG_TRADE_TAPE", "AGG_TRADE_EXECUTION"}:
            manifest = self._manifest(dataset_id)
            dataset = self._freeze_trade_dataset(
                exchange=exchange,
                market_type=market_type,
                symbol=str(manifest["symbol"]),
                start_time_ms=start_time_ms,
                end_time_ms=end_time_ms,
            )
            if data_epoch not in {str(manifest["data_epoch"]), dataset.data_epoch}:
                raise BacktestError(
                    "DATA_SNAPSHOT_MISMATCH",
                    "catalog or aggregate-trade data epoch changed",
                )
            preview = _trade_preview_wire(dataset, dataset_id=dataset_id)
            if contract_data_mode == HISTORICAL_CONTRACT_MODE:
                try:
                    aux = self._open_contract_snapshot(
                        dataset_id=dataset_id,
                        data_epoch=str(manifest["data_epoch"]),
                        exchange=exchange,
                        market_type=market_type,
                        symbol=str(manifest["symbol"]),
                        start_time_ms=start_time_ms,
                        end_time_ms=end_time_ms,
                        allow_incomplete=True,
                        required_roles=_required_contract_roles(
                            account_model, funding_mode
                        ),
                    )
                except MarketDatasetError as exc:
                    preview["quality"]["contract_data"] = {
                        "status": "missing"
                        if exc.code == "DATA_ROLE_MISSING"
                        else "partial",
                        "required_roles": list(
                            _required_contract_roles(account_model, funding_mode)
                        ),
                        "role_status": {
                            role: {"status": "missing"}
                            for role in _required_contract_roles(
                                account_model, funding_mode
                            )
                        },
                        "error_code": exc.code,
                    }
                else:
                    preview["quality"]["contract_data"] = {
                        "status": aux.quality["status"],
                        "required_roles": list(
                            _required_contract_roles(account_model, funding_mode)
                        ),
                        "role_status": aux.quality["roles"],
                        "bundle_hash": aux.snapshot_hash,
                    }
                    preview["role_hashes"].update(aux.role_hashes)
                    preview["snapshot_hash"] = _trade_snapshot_hash(
                        dataset, contract_bundle_hash=aux.snapshot_hash
                    )
                    aux.close()
            return preview
        if fidelity_mode != "BAR_APPROX":
            raise BacktestError(
                "FIDELITY_UNSUPPORTED",
                f"standalone runtime cannot preview {fidelity_mode}",
            )
        ref = self._dataset_ref(
            dataset_id=dataset_id,
            data_epoch=data_epoch,
            snapshot_hash="",
            start_time_ms=start_time_ms,
            end_time_ms=end_time_ms,
            interval=interval,
            exchange=exchange,
            market_type=market_type,
            contract_data_mode=contract_data_mode,
            account_model=account_model,
            funding_mode=funding_mode,
        )
        try:
            snapshot = self.snapshots.open(
                ref,
                allow_incomplete_contract=(
                    contract_data_mode == HISTORICAL_CONTRACT_MODE
                ),
            )
        except MarketDatasetError as exc:
            raise BacktestError(exc.code, exc.message) from exc
        try:
            return _snapshot_wire(snapshot)
        finally:
            snapshot.close()

    def chart_data(self, run_id: str, *, max_bars: int = 50_000) -> dict[str, Any]:
        record = self.service.get_run(run_id)
        if record["state"] != "COMPLETED":
            raise BacktestError("IDENTITY_MUTATION", "backtest chart is not ready")
        config = json.loads(str(record["config_json"]))
        interval = str(
            config.get("signal_interval")
            if record["fidelity_mode"] == "AGG_TRADE_EXECUTION"
            else config.get("interval")
            or self._manifest(str(record["dataset_id"]))["interval"]
        )
        if record["fidelity_mode"] == "BAR_APPROX":
            ref = self._dataset_ref(
                dataset_id=record["dataset_id"],
                data_epoch=record["data_epoch"],
                snapshot_hash=record["snapshot_hash"],
                start_time_ms=config["start_time_ms"],
                end_time_ms=config["end_time_ms"],
                interval=interval,
                contract_data_mode=config.get("contract_data_mode"),
                account_model=config.get("account_model"),
                funding_mode=config.get("funding_mode"),
                exchange=str(config.get("exchange") or "binance"),
                market_type=str(config.get("market_type") or "usdm"),
            )
            try:
                snapshot = self.snapshots.open(ref)
            except MarketDatasetError as exc:
                raise BacktestError(exc.code, exc.message) from exc
            try:
                bars = [
                    _bar_wire(event)
                    for event in snapshot.events
                    if event.role == "BARS"
                ]
            finally:
                snapshot.close()
        elif record["fidelity_mode"] in {"AGG_TRADE_TAPE", "AGG_TRADE_EXECUTION"}:
            manifest = self._manifest(str(record["dataset_id"]))
            dataset = self._freeze_trade_dataset(
                exchange=str(config.get("exchange") or "binance"),
                market_type=str(config.get("market_type") or "usdm"),
                symbol=str(manifest["symbol"]),
                start_time_ms=int(config["start_time_ms"]),
                end_time_ms=int(config["end_time_ms"]),
            )
            contract_snapshot: MarketDatasetSnapshot | None = None
            try:
                contract_bundle_hash: str | None = None
                if config.get("contract_data_mode") == HISTORICAL_CONTRACT_MODE:
                    contract_snapshot = self._open_contract_snapshot(
                        dataset_id=str(record["dataset_id"]),
                        data_epoch=str(record["data_epoch"]),
                        exchange=str(config.get("exchange") or "binance"),
                        market_type=str(config.get("market_type") or "usdm"),
                        symbol=str(manifest["symbol"]),
                        start_time_ms=int(config["start_time_ms"]),
                        end_time_ms=int(config["end_time_ms"]),
                        required_roles=_required_contract_roles(
                            str(
                                config.get("account_model") or "LINEAR_PERP_ONE_WAY_V1"
                            ),
                            str(config.get("funding_mode") or "OFF"),
                        ),
                    )
                    contract_bundle_hash = contract_snapshot.snapshot_hash
                _assert_trade_identity(
                    dataset,
                    record,
                    contract_bundle_hash=contract_bundle_hash,
                )
                events = _read_trade_events(
                    self._require_trade_archive(),
                    dataset,
                    max_events=self.settings.max_trade_events,
                )
            except MarketDatasetError as exc:
                raise BacktestError(exc.code, exc.message) from exc
            finally:
                if contract_snapshot is not None:
                    contract_snapshot.close()
            if record["fidelity_mode"] == "AGG_TRADE_EXECUTION":
                bars = [
                    _bar_wire(event)
                    for event in derive_complete_trade_bars(events, interval)
                ]
            else:
                bars = _aggregate_trade_bars(events, interval)
        else:
            raise BacktestError("FIDELITY_UNSUPPORTED", "chart source is unsupported")
        truncated = len(bars) > max_bars
        if truncated:
            bars = bars[-max_bars:]
        report = self.service.get_report(run_id)
        return {
            "run_id": run_id,
            "symbol": self._manifest(str(record["dataset_id"]))["symbol"],
            "interval": interval,
            "bars": bars,
            "fills": report.get("fills") or [],
            "rejected_orders": report.get("rejected_orders") or [],
            "equity_curve": list(report.get("equity_curve") or [])[-max_bars:],
            "truncated": truncated,
        }

    def _manifest(self, dataset_id: str) -> dict[str, Any]:
        try:
            return self.local_data.get_manifest(dataset_id)
        except LocalDatasetError as exc:
            raise BacktestError("DATA_QUALITY_FAILED", str(exc)) from exc

    def _require_trade_archive(self) -> ParquetRawAggTradeArchive:
        if self.trade_archive is None:
            raise BacktestError(
                "DATA_QUALITY_FAILED",
                "local verified aggregate-trade archive is not configured",
            )
        return self.trade_archive

    def _freeze_trade_dataset(self, **values: object) -> RawAggTradeDatasetRef:
        try:
            return self._require_trade_archive().freeze_dataset(**values)  # type: ignore[arg-type]
        except BacktestError:
            raise
        except Exception as exc:
            raise BacktestError("DATA_QUALITY_FAILED", str(exc)) from exc

    def _dataset_ref(self, **values: object) -> DatasetRef:
        try:
            manifest = self.local_data.get_manifest(str(values["dataset_id"]))
        except LocalDatasetError as exc:
            raise BacktestError("DATA_QUALITY_FAILED", str(exc)) from exc
        return DatasetRef(
            dataset_id=str(values["dataset_id"]),
            data_epoch=str(values["data_epoch"]),
            snapshot_hash=str(values.get("snapshot_hash") or ""),
            venue=str(values.get("exchange") or "local"),
            market_type=str(values.get("market_type") or "linear_perpetual"),
            symbol=str(manifest["symbol"]),
            start_time_ms=int(values["start_time_ms"]),
            end_time_ms=int(values["end_time_ms"]),
            roles=(
                ("BARS",)
                + _required_contract_roles(
                    str(values.get("account_model") or "LINEAR_PERP_ONE_WAY_V1"),
                    str(values.get("funding_mode") or "OFF"),
                )
                if values.get("contract_data_mode") == HISTORICAL_CONTRACT_MODE
                else ("BARS",)
            ),
            interval=str(values.get("interval") or manifest["interval"]),
            calendar_id="UTC_FIXED",
            source="local_immutable",
            retention_policy="user_local",
        )

    def _open_contract_snapshot(
        self,
        *,
        dataset_id: str,
        data_epoch: str,
        exchange: str,
        market_type: str,
        symbol: str,
        start_time_ms: int,
        end_time_ms: int,
        allow_incomplete: bool = False,
        required_roles: tuple[str, ...] = AUX_ROLES,
    ) -> MarketDatasetSnapshot:
        path = (
            Path(self.local_data.root)
            / dataset_id
            / data_epoch.removeprefix("sha256:")
            / "contract-history.json"
        )
        if not path.exists():
            raise MarketDatasetError(
                "historical contract roles are missing", code="DATA_ROLE_MISSING"
            )
        return ContractAuxSnapshotProvider(path).open(
            DatasetRef(
                dataset_id=dataset_id,
                data_epoch=data_epoch,
                snapshot_hash="",
                venue=exchange,
                market_type=market_type,
                symbol=symbol,
                start_time_ms=start_time_ms,
                end_time_ms=end_time_ms,
                roles=required_roles,
                interval=None,
                calendar_id="UTC_FIXED",
                source="local_immutable",
                retention_policy="user_local",
            ),
            allow_incomplete=allow_incomplete,
        )

    def materialize_study(self, study_id: str) -> dict[str, Any]:
        return self.service.materialize_study_runs(
            study_id,
            preview_snapshot=self.preview_snapshot,
        )


class BacktestWorker:
    def __init__(
        self,
        *,
        settings: BacktestSettings,
        local_data_dir: Path,
        trade_archive_dir: Path | None = None,
    ) -> None:
        self.settings = settings
        self.local_data = LocalDatasetService(local_data_dir)
        self.snapshots = LocalBarSnapshotProvider(
            self.local_data,
            max_rows=settings.max_bar_rows,
        )
        self.trade_archive = (
            None
            if trade_archive_dir is None or not settings.trade_tape_effective
            else ParquetRawAggTradeArchive(
                trade_archive_dir,
                read_only=True,
                max_scan_rows=settings.max_trade_events,
            )
        )
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._lease_ms = max(30_000, self.settings.provider_step_timeout_ms * 10)

    def start(self) -> None:
        if self._threads:
            return
        for slot in range(max(1, self.settings.max_active_runs)):
            owner = f"worker-{uuid.uuid4().hex}-{slot}"
            thread = threading.Thread(
                target=self._run,
                args=(slot, owner),
                name=f"candlescope-backtest-worker-{slot}",
                daemon=True,
            )
            thread.start()
            self._threads.append(thread)

    def shutdown(self) -> None:
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=5)
        self._threads = []

    def _run(self, slot: int, owner: str) -> None:
        service = BacktestService.start(
            self.settings,
            strategy_registry=build_default_strategy_registry(),
            enforce_registered_revisions=True,
        )
        try:
            service.recover_expired_leases(now_ms=_now_ms())
            next_study_reconcile = 0.0
            while not self._stop.is_set():
                try:
                    now = time.monotonic()
                    if slot == 0 and now >= next_study_reconcile:
                        service.recover_expired_leases(now_ms=_now_ms())
                        self._reconcile_studies(service)
                        next_study_reconcile = now + 1.0
                    record = service.repository.claim_next_queued(
                        owner=owner,
                        now_ms=_now_ms(),
                        lease_ms=self._lease_ms,
                    )
                    if record is None:
                        self._stop.wait(0.2)
                        continue
                    self._execute(service, record, owner=owner)
                except Exception:
                    logger.exception("Backtest worker slot %s loop failed", slot)
                    self._stop.wait(0.5)
        finally:
            service.shutdown()

    def _reconcile_studies(self, service: BacktestService) -> None:
        for study in service.repository.list_studies(state="RUNNING"):
            study_id = str(study["study_id"])
            try:
                service.materialize_study_runs(
                    study_id,
                    preview_snapshot=self._preview_snapshot,
                )
            except BacktestError as exc:
                if exc.code == "BUDGET_EXCEEDED":
                    return
                logger.warning(
                    "Backtest Study %s failed to materialize: %s", study_id, exc
                )
                service.repository.update_study_state(study_id, "FAILED")
            except Exception:
                logger.exception(
                    "Backtest Study %s crashed during materialization",
                    study_id,
                )
                service.repository.update_study_state(study_id, "FAILED")

    def _preview_snapshot(self, **values: object) -> dict[str, Any]:
        try:
            manifest = self.local_data.get_manifest(str(values["dataset_id"]))
            ref = DatasetRef(
                dataset_id=str(values["dataset_id"]),
                data_epoch=str(values["data_epoch"]),
                snapshot_hash="",
                venue=str(values.get("exchange") or "binance"),
                market_type=str(values.get("market_type") or "usdm"),
                symbol=str(manifest["symbol"]),
                start_time_ms=int(values["start_time_ms"]),
                end_time_ms=int(values["end_time_ms"]),
                roles=(
                    ("BARS",)
                    + _required_contract_roles(
                        str(values.get("account_model") or "LINEAR_PERP_ONE_WAY_V1"),
                        str(values.get("funding_mode") or "OFF"),
                    )
                    if values.get("contract_data_mode") == HISTORICAL_CONTRACT_MODE
                    else ("BARS",)
                ),
                interval=str(values.get("interval") or manifest["interval"]),
                calendar_id="UTC_FIXED",
                source="local_immutable",
                retention_policy="user_local",
            )
            snapshot = self.snapshots.open(
                ref,
                allow_incomplete_contract=(
                    values.get("contract_data_mode") == HISTORICAL_CONTRACT_MODE
                ),
            )
        except (LocalDatasetError, MarketDatasetError) as exc:
            code = getattr(exc, "code", "DATA_QUALITY_FAILED")
            raise BacktestError(str(code), str(exc)) from exc
        try:
            return _snapshot_wire(snapshot)
        finally:
            snapshot.close()

    def _execute(
        self,
        service: BacktestService,
        record: Mapping[str, object],
        *,
        owner: str,
    ) -> None:
        run_id = str(record["run_id"])
        snapshot: MarketDatasetSnapshot | None = None
        contract_snapshot: MarketDatasetSnapshot | None = None
        heartbeat_stop = threading.Event()
        heartbeat = threading.Thread(
            target=self._heartbeat,
            args=(service, record, heartbeat_stop, owner),
            name=f"backtest-lease-{run_id}",
            daemon=True,
        )
        heartbeat.start()
        try:
            config = json.loads(str(record["config_json"]))
            manifest = self.local_data.get_manifest(str(record["dataset_id"]))
            provider = IsolatedStrategyProvider(
                str(
                    config.get("strategy_execution_revision")
                    or record["strategy_revision_id"]
                ),
                step_timeout_s=self.settings.provider_step_timeout_ms / 1000,
            )
            if record["fidelity_mode"] == "BAR_APPROX":
                ref = DatasetRef(
                    dataset_id=str(record["dataset_id"]),
                    data_epoch=str(record["data_epoch"]),
                    snapshot_hash=str(record["snapshot_hash"]),
                    venue=str(config.get("exchange") or "binance"),
                    market_type=str(config.get("market_type") or "usdm"),
                    symbol=str(manifest["symbol"]),
                    start_time_ms=int(config["start_time_ms"]),
                    end_time_ms=int(config["end_time_ms"]),
                    roles=(
                        ("BARS",)
                        + _required_contract_roles(
                            str(
                                config.get("account_model") or "LINEAR_PERP_ONE_WAY_V1"
                            ),
                            str(config.get("funding_mode") or "OFF"),
                        )
                        if config.get("contract_data_mode") == HISTORICAL_CONTRACT_MODE
                        else ("BARS",)
                    ),
                    interval=str(config.get("interval") or manifest["interval"]),
                    calendar_id="UTC_FIXED",
                    source="local_immutable",
                    retention_policy="user_local",
                )
                snapshot = self.snapshots.open(ref)
                market_events = (
                    tuple(snapshot.events)
                    if str(config.get("account_model")) == "LINEAR_PERP_ONE_WAY_V2"
                    else _bar_execution_events(
                        snapshot.events,
                        interval_name=str(
                            config.get("interval") or manifest["interval"]
                        ),
                    )
                )
                if not market_events:
                    raise MarketDatasetError(
                        "selected snapshot contains no complete bars",
                        code="DATA_QUALITY_FAILED",
                    )
                service.execute_bar_run(
                    run_id,
                    events=market_events,
                    provider=provider,
                    snapshot_evidence={
                        "quality": snapshot.quality,
                        "contract_coverage": snapshot.quality.get(
                            "contract_data",
                            {
                                "status": "not_required",
                                "model": "LEGACY_FIXED_V1",
                            },
                        ),
                    },
                )
            elif record["fidelity_mode"] in {"AGG_TRADE_TAPE", "AGG_TRADE_EXECUTION"}:
                if self.trade_archive is None:
                    raise MarketDatasetError(
                        "local verified aggregate-trade archive is not configured",
                        code="DATA_QUALITY_FAILED",
                    )
                dataset = self.trade_archive.freeze_dataset(
                    exchange=str(config.get("exchange") or "binance"),
                    market_type=str(config.get("market_type") or "usdm"),
                    symbol=str(manifest["symbol"]),
                    start_time_ms=int(config["start_time_ms"]),
                    end_time_ms=int(config["end_time_ms"]),
                )
                contract_bundle_hash: str | None = None
                if config.get("contract_data_mode") == HISTORICAL_CONTRACT_MODE:
                    contract_snapshot = self._open_contract_snapshot(
                        dataset_id=str(record["dataset_id"]),
                        data_epoch=str(manifest["data_epoch"]),
                        exchange=str(config.get("exchange") or "binance"),
                        market_type=str(config.get("market_type") or "usdm"),
                        symbol=str(manifest["symbol"]),
                        start_time_ms=int(config["start_time_ms"]),
                        end_time_ms=int(config["end_time_ms"]),
                        required_roles=_required_contract_roles(
                            str(
                                config.get("account_model") or "LINEAR_PERP_ONE_WAY_V1"
                            ),
                            str(config.get("funding_mode") or "OFF"),
                        ),
                    )
                    contract_bundle_hash = contract_snapshot.snapshot_hash
                _assert_trade_identity(
                    dataset,
                    record,
                    contract_bundle_hash=contract_bundle_hash,
                )
                events = _read_trade_events(
                    self.trade_archive,
                    dataset,
                    max_events=self.settings.max_trade_events,
                )
                if (
                    contract_snapshot is not None
                    and str(config.get("account_model")) == "LINEAR_PERP_ONE_WAY_V2"
                ):
                    events = _renumber_timeline(
                        merge_contract_timeline(contract_snapshot.events, events)
                    )
                evidence = {
                    "quality": {
                        "status": "accepted",
                        "source_event_kind": "AGG_TRADE",
                        "completeness": dataset.completeness,
                        "source_quality": dataset.source_quality,
                        "gap_count": 0,
                        "row_count": dataset.row_count,
                    }
                }
                if contract_snapshot is not None:
                    evidence["quality"]["contract_data"] = {
                        "status": "complete",
                        "role_status": contract_snapshot.quality["roles"],
                        "bundle_hash": contract_snapshot.snapshot_hash,
                    }
                    contract_snapshot.close()
                    contract_snapshot = None
                if record["fidelity_mode"] == "AGG_TRADE_EXECUTION":
                    service.execute_dual_clock_run(
                        run_id,
                        events=events,
                        provider=provider,
                        snapshot_evidence=evidence,
                    )
                else:
                    service.execute_trade_run(
                        run_id,
                        events=events,
                        provider=provider,
                        snapshot_evidence=evidence,
                    )
            else:
                raise MarketDatasetError(
                    f"standalone worker cannot execute {record['fidelity_mode']}",
                    code="FIDELITY_UNSUPPORTED",
                )
        except Exception as exc:
            latest = service.repository.get_run_by_id(run_id)
            if latest is not None and latest["state"] == "QUEUED":
                service.fail_queued_run(
                    run_id,
                    exc,
                    expected_generation=int(record["generation"]),
                )
            logger.warning("Backtest run %s failed: %s", run_id, exc)
        except BaseException as exc:
            recovered = service.requeue_interrupted_run(
                run_id,
                expected_generation=int(record["generation"]),
            )
            logger.error(
                "Backtest worker interruption for %s (requeued=%s): %s",
                run_id,
                recovered,
                exc,
            )
        finally:
            heartbeat_stop.set()
            heartbeat.join(timeout=2)
            if snapshot is not None:
                snapshot.close()
            if contract_snapshot is not None:
                contract_snapshot.close()
            service.repository.release_lease(run_id, owner=owner)
            study_id = record.get("study_id")
            if study_id:
                latest = service.repository.get_run_by_id(run_id)
                if latest is not None:
                    service.repository.update_trial_for_run(
                        run_id,
                        state=str(latest["state"]),
                    )
                    service.repository.update_train_trial_for_run(
                        run_id,
                        state=str(latest["state"]),
                    )
                    service.repository.finish_study_if_terminal(str(study_id))

    def _heartbeat(
        self,
        service: BacktestService,
        record: Mapping[str, object],
        stop: threading.Event,
        owner: str,
    ) -> None:
        interval_s = max(1.0, self._lease_ms / 3000)
        while not stop.wait(interval_s):
            try:
                renewed = service.repository.renew_lease(
                    str(record["run_id"]),
                    owner=owner,
                    generation=int(record["generation"]),
                    expires_at_ms=_now_ms() + self._lease_ms,
                )
                if not renewed:
                    logger.error(
                        "Backtest lease ownership was lost for %s",
                        record["run_id"],
                    )
                    return
            except Exception:
                logger.exception(
                    "Backtest lease heartbeat failed for %s",
                    record["run_id"],
                )
                return


def _snapshot_wire(snapshot: MarketDatasetSnapshot) -> dict[str, Any]:
    market_row_count = sum(
        1 for event in snapshot.events if event.role in {"BARS", "TRADES"}
    )
    return {
        "data_epoch": snapshot.ref_identity.get("data_epoch"),
        "snapshot_hash": snapshot.snapshot_hash,
        "coverage_start_ms": snapshot.coverage_start_ms,
        "coverage_end_ms": snapshot.coverage_end_ms,
        "row_count": snapshot.row_count,
        "market_row_count": market_row_count,
        "first_sequence": snapshot.first_sequence,
        "last_sequence": snapshot.last_sequence,
        "quality": snapshot.quality,
        "role_hashes": snapshot.role_hashes,
        "fidelity_capabilities": list(snapshot.fidelity_capabilities),
        "identity": snapshot.ref_identity,
    }


def _bar_execution_events(
    events: tuple[MarketEvent, ...],
    *,
    interval_name: str,
) -> tuple[MarketEvent, ...]:
    """Project combined contract snapshots onto the BAR execution clock.

    The combined snapshot sequence is authoritative for deterministic cross-role
    ordering.  The BAR kernel has its own sequence contract where a skipped
    number represents an actual missing interval, so auxiliary roles must not
    create artificial gaps and real BAR gaps must remain visible.
    """

    interval = parse_interval_spec(interval_name)
    if interval is None:
        raise MarketDatasetError("invalid BAR interval", code="DATA_QUALITY_FAILED")
    result: list[MarketEvent] = []
    previous_open_ms: int | None = None
    sequence = 0
    for event in events:
        if event.role != "BARS":
            continue
        open_time_ms = int(event.payload["open_time_ms"])
        sequence += (
            1
            if previous_open_ms is None
            or interval.is_successor(previous_open_ms, open_time_ms)
            else 2
        )
        result.append(
            MarketEvent(
                sequence=sequence,
                event_time_ms=event.event_time_ms,
                role=event.role,
                payload=event.payload,
            )
        )
        previous_open_ms = open_time_ms
    return tuple(result)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _trade_snapshot_hash(
    dataset: RawAggTradeDatasetRef,
    *,
    contract_bundle_hash: str | None = None,
) -> str:
    payload: object = dataset.to_dict()
    if contract_bundle_hash is not None:
        payload = {
            "schema_version": "backtest.trade-contract-snapshot.v1",
            "trade_dataset": dataset.to_dict(),
            "contract_bundle_hash": contract_bundle_hash,
        }
    return f"sha256:{sha256_hex(payload)}"


def _trade_preview_wire(
    dataset: RawAggTradeDatasetRef,
    *,
    dataset_id: str,
) -> dict[str, Any]:
    digest = _trade_snapshot_hash(dataset)
    return {
        "data_epoch": dataset.data_epoch,
        "catalog_dataset_id": dataset_id,
        "snapshot_hash": digest,
        "coverage_start_ms": dataset.start_time_ms,
        "coverage_end_ms": dataset.end_time_ms,
        "row_count": dataset.row_count,
        "first_sequence": 1,
        "last_sequence": dataset.row_count,
        "quality": {
            "status": "accepted",
            "source_event_kind": "AGG_TRADE",
            "completeness": dataset.completeness,
            "source_quality": dataset.source_quality,
            "gap_count": 0,
        },
        "role_hashes": {"TRADES": digest},
        "fidelity_capabilities": ["AGG_TRADE_TAPE", "AGG_TRADE_EXECUTION"],
        "identity": dataset.to_dict(),
    }


def _assert_trade_identity(
    dataset: RawAggTradeDatasetRef,
    record: Mapping[str, object],
    *,
    contract_bundle_hash: str | None = None,
) -> None:
    if dataset.data_epoch != str(record["data_epoch"]):
        raise MarketDatasetError(
            "aggregate-trade data epoch changed",
            code="DATA_SNAPSHOT_MISMATCH",
        )
    if _trade_snapshot_hash(dataset, contract_bundle_hash=contract_bundle_hash) != str(
        record["snapshot_hash"]
    ):
        raise MarketDatasetError(
            "aggregate-trade snapshot manifest changed",
            code="DATA_SNAPSHOT_MISMATCH",
        )


def _read_trade_events(
    archive: ParquetRawAggTradeArchive,
    dataset: RawAggTradeDatasetRef,
    *,
    max_events: int,
) -> tuple[MarketEvent, ...]:
    if dataset.row_count > max_events:
        raise MarketDatasetError(
            "aggregate-trade event count exceeds frozen ceiling",
            code="BUDGET_EXCEEDED",
        )
    pin = archive.pin_dataset(dataset)
    events: list[MarketEvent] = []
    cursor: RawAggTradeCursor | None = None
    try:
        while True:
            page = archive.scan_page(
                exchange=dataset.exchange,
                market_type=dataset.market_type,
                symbol=dataset.symbol,
                start_time_ms=dataset.start_time_ms,
                end_time_ms=dataset.end_time_ms,
                start_agg_trade_id=dataset.expected_first_agg_trade_id,
                end_agg_trade_id=dataset.expected_last_agg_trade_id,
                after=cursor,
                limit=min(50_000, max_events),
                dataset_ref=dataset,
            )
            for row in page.rows:
                sequence = len(events) + 1
                agg_trade_id = int(row["agg_trade_id"])
                events.append(
                    MarketEvent(
                        sequence=sequence,
                        event_time_ms=int(row["trade_time_ms"]),
                        role="TRADES",
                        payload={
                            "source_event_kind": "AGG_TRADE",
                            "source_sequence": agg_trade_id,
                            "tie_break": f"AGG_TRADE:{agg_trade_id}",
                            "price": str(row["price"]),
                            "qty": str(row["quantity"]),
                            "is_buyer_maker": bool(row.get("is_buyer_maker", False)),
                            "agg_trade_id": agg_trade_id,
                            "first_trade_id": row.get("first_trade_id"),
                            "last_trade_id": row.get("last_trade_id"),
                        },
                    )
                )
            if page.exhausted:
                break
            if page.next_cursor is None or page.next_cursor == cursor:
                raise MarketDatasetError(
                    "aggregate-trade pagination did not advance",
                    code="DATA_QUALITY_FAILED",
                )
            cursor = page.next_cursor
    finally:
        archive.release_dataset(pin)
    if len(events) != dataset.row_count:
        raise MarketDatasetError(
            "aggregate-trade snapshot row count changed",
            code="DATA_SNAPSHOT_MISMATCH",
        )
    return tuple(events)


def _bar_wire(event: MarketEvent) -> dict[str, object]:
    return {
        "time": int(event.payload["open_time_ms"]) // 1000,
        "open": float(event.payload["open"]),
        "high": float(event.payload["high"]),
        "low": float(event.payload["low"]),
        "close": float(event.payload["close"]),
        "volume": float(event.payload["volume"]),
    }


def _aggregate_trade_bars(
    events: tuple[MarketEvent, ...],
    interval: str,
) -> list[dict[str, object]]:
    spec = parse_interval_spec(interval)
    if spec is None:
        raise BacktestError(
            "SCHEMA_UNKNOWN_FIELD", f"invalid chart interval {interval}"
        )
    bars: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    current_open_ms: int | None = None
    for event in events:
        bucket = spec.floor_ms(event.event_time_ms)
        price = Decimal(str(event.payload["price"]))
        qty = Decimal(str(event.payload["qty"]))
        if current is None or bucket != current_open_ms:
            if current is not None:
                bars.append(current)
            current_open_ms = bucket
            current = {
                "time": bucket // 1000,
                "open": float(price),
                "high": float(price),
                "low": float(price),
                "close": float(price),
                "volume": float(qty),
            }
        else:
            current["high"] = max(float(current["high"]), float(price))
            current["low"] = min(float(current["low"]), float(price))
            current["close"] = float(price)
            current["volume"] = float(current["volume"]) + float(qty)
    if current is not None:
        bars.append(current)
    return bars
