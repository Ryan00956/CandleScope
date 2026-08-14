from __future__ import annotations

import json
import time
import uuid
from typing import Mapping

from app.core.config import BacktestSettings

from app.backtest.reports import REPORT_SCHEMA, build_report
from app.market_dataset.snapshot import MarketEvent
from app.simulation import SimulationKernel, TradeSimulationKernel

from .errors import BacktestError
from .identity import canonical_json, config_hash, parse_parameters, sha256_hex
from .models import (
    ENGINE_VERSION,
    RunIdentity,
    RunState,
    SCHEMA_VERSION,
    transition,
)
from .repository import BacktestRepository
from .study import (
    compare_runs,
    grid_sampler,
    plan_trials,
    random_sampler,
    rank_oos,
    split_wire,
    walk_forward_splits,
)
from .strategy.host_adapter import StrategyHostAdapter
from .strategy.protocol import StrategyProviderSession
from .strategy.pyne_adapter import PyneHostPlanner

FIDELITY_MATRIX = {
    "BAR_APPROX": ("BAR", "APPROXIMATE"),
    "TRADE_TAPE": ("RAW_TRADE", "TRADE_SEQUENCE"),
    "AGG_TRADE_TAPE": ("AGG_TRADE", "AGGREGATED_TRADE_SEQUENCE"),
    "BOOK_ASSISTED": ("TRADE_AND_L2", "BOOK_ASSISTED"),
    "QUEUE_EXACT": ("ORDER_LEVEL", "ORDER_LEVEL_REQUIRED"),
}


class BacktestService:
    def __init__(self, settings: BacktestSettings, repository: BacktestRepository) -> None:
        self.settings = settings
        self.repository = repository
        self._audit_ordinals: dict[str, int] = {}

    @classmethod
    def start(cls, settings: BacktestSettings, *, now_ms: int | None = None) -> BacktestService:
        if not settings.enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_ENABLED is 0")
        repository = BacktestRepository(settings.db_path)
        repository.open(now_ms=now_ms or _now_ms())
        return cls(settings, repository)

    def shutdown(self) -> None:
        self.repository.close()

    def capabilities(self) -> dict[str, object]:
        return {
            "engine_version": ENGINE_VERSION,
            "schema_version": SCHEMA_VERSION,
            "account_model": "LINEAR_PERP_ONE_WAY_V1",
            "provider_protocol": "strategy-provider/1",
            "flags": {
                "BACKTEST_ENABLED": self.settings.enabled,
                "BACKTEST_BAR_ENABLED": self.settings.bar_enabled,
                "BACKTEST_TRADE_TAPE_ENABLED": self.settings.trade_tape_enabled,
                "BACKTEST_STUDY_ENABLED": self.settings.study_enabled,
            },
            "fidelity_modes": ["BAR_APPROX"] if self.settings.bar_effective else [],
        }

    def validate_run(self, payload: Mapping[str, object]) -> dict[str, object]:
        identity = self._identity_from_payload(payload)
        self._assert_flags(identity.fidelity_mode)
        return {
            "ok": True,
            "config_hash": config_hash(identity),
            "fidelity_mode": identity.fidelity_mode,
            "source_event_kind": identity.source_event_kind,
            "engine_version": identity.engine_version,
        }

    def create_run(
        self,
        payload: Mapping[str, object],
        *,
        idempotency_key: str,
        now_ms: int | None = None,
    ) -> dict[str, object]:
        if not idempotency_key.strip():
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "idempotency key is required")
        existing = self.repository.get_run_by_idempotency(idempotency_key)
        if existing is not None:
            return existing
        identity = self._identity_from_payload(payload)
        self._assert_flags(identity.fidelity_mode)
        stamp = now_ms or _now_ms()
        digest = config_hash(identity)
        run_id = f"bt_{uuid.uuid4().hex}"
        record = {
            "run_id": run_id,
            "study_id": payload.get("study_id"),
            "idempotency_key": idempotency_key,
            "state": RunState.QUEUED.value,
            "fidelity_mode": identity.fidelity_mode,
            "source_event_kind": identity.source_event_kind,
            "strategy_revision_id": identity.strategy_revision_id,
            "dataset_id": identity.dataset_id,
            "data_epoch": identity.data_epoch,
            "snapshot_hash": identity.snapshot_hash,
            "config_json": canonical_json(payload),
            "config_hash": digest,
            "engine_version": identity.engine_version,
            "generation": 1,
            "failure_code": None,
            "created_at_ms": stamp,
            "updated_at_ms": stamp,
        }
        self.repository.insert_run(record)
        self._audit(run_id, "create", {"config_hash": digest})
        return record

    def get_run(self, run_id: str) -> dict[str, object]:
        record = self.repository.get_run_by_id(run_id)
        if record is None:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"unknown run {run_id}")
        return record

    def list_runs(self) -> list[dict[str, object]]:
        return self.repository.list_runs()

    def cancel_run(self, run_id: str, *, now_ms: int | None = None) -> dict[str, object]:
        record = self.get_run(run_id)
        current = RunState(record["state"])
        if current in {RunState.COMPLETED, RunState.CANCELLED, RunState.FAILED}:
            raise BacktestError(
                "IDENTITY_MUTATION",
                f"run {run_id} is already terminal ({current.value})",
            )
        if current is not RunState.CANCELLING:
            if current is RunState.QUEUED:
                next_state = transition(current, RunState.CANCELLING)
                next_state = transition(next_state, RunState.CANCELLED)
            else:
                next_state = transition(current, RunState.CANCELLING)
                next_state = transition(next_state, RunState.CANCELLED)
        else:
            next_state = transition(current, RunState.CANCELLED)
        stamp = now_ms or _now_ms()
        self.repository.update_run_state(
            run_id, state=next_state.value, updated_at_ms=stamp
        )
        self._audit(run_id, "cancel", {"from": current.value})
        return self.get_run(run_id)

    def recover_expired_leases(self, *, now_ms: int) -> list[str]:
        expired = self.repository.expire_leases(now_ms)
        for run_id in expired:
            record = self.repository.get_run_by_id(run_id)
            if record is None:
                continue
            state = RunState(record["state"])
            if state in {RunState.PREPARING, RunState.RUNNING}:
                self.repository.update_run_state(
                    run_id,
                    state=RunState.QUEUED.value,
                    updated_at_ms=now_ms,
                    generation=int(record["generation"]) + 1,
                )
                self._audit(run_id, "lease_expired", {"generation": record["generation"]})
        return expired

    def create_study(self, payload: Mapping[str, object], *, now_ms: int | None = None) -> dict[str, object]:
        if not self.settings.enabled or not self.settings.study_enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_STUDY_ENABLED is 0")
        stamp = now_ms or _now_ms()
        study_id = f"st_{uuid.uuid4().hex}"
        config = canonical_json(payload)
        record = {
            "study_id": study_id,
            "name": str(payload.get("name") or study_id),
            "hypothesis": str(payload.get("hypothesis") or ""),
            "strategy_revision_id": str(payload["strategy_revision_id"]),
            "config_json": config,
            "config_hash": "sha256:" + sha256_hex(config),
            "state": "CREATED",
            "created_at_ms": stamp,
        }
        self.repository.insert_study(record)
        return record

    def start_study(self, study_id: str) -> dict[str, object]:
        record = self.get_study(study_id)
        if record["state"] == "CANCELLED":
            raise BacktestError("IDENTITY_MUTATION", "cancelled study cannot start")
        config = json.loads(str(record["config_json"]))
        splits = walk_forward_splits(
            start_ms=int(config["start_ms"]),
            end_ms=int(config["end_ms"]),
            train_ms=int(config["train_ms"]),
            test_ms=int(config["test_ms"]),
            step_ms=int(config.get("step_ms") or config["test_ms"]),
        )
        space = config.get("parameter_space") or {}
        sampler = str(config.get("sampler") or "grid")
        if sampler == "random":
            params = random_sampler(
                space,
                count=int(config.get("random_count") or 1),
                seed=int(config.get("seed") or 1),
            )
        else:
            params = grid_sampler(space)
        max_trials = int(config.get("max_trials") or self.settings.max_trials_per_study)
        if max_trials > self.settings.max_trials_per_study:
            raise BacktestError("BUDGET_EXCEEDED", "study exceeds frozen trial ceiling")
        planned = plan_trials(splits, params, max_trials=max_trials)
        existing = self.repository.list_trials(study_id)
        if existing:
            return {
                "study": record,
                "trials": existing,
                "splits": [split_wire(split) for split in splits],
            }
        for spec in planned:
            self.repository.insert_trial(
                {
                    "trial_id": f"tr_{uuid.uuid4().hex}",
                    "study_id": study_id,
                    "ordinal": spec.ordinal,
                    "split_id": spec.split_id,
                    "params_json": canonical_json(spec.params),
                    "params_hash": spec.params_hash,
                    "run_id": None,
                    "state": "PLANNED",
                }
            )
        self.repository.update_study_state(study_id, "RUNNING")
        record = self.get_study(study_id)
        return {
            "study": record,
            "trials": self.repository.list_trials(study_id),
            "splits": [split_wire(split) for split in splits],
            "trial_count": len(planned),
            "selection_warning": "in-sample best is not an OOS claim",
        }

    def cancel_study(self, study_id: str) -> dict[str, object]:
        record = self.get_study(study_id)
        self.repository.update_study_state(study_id, "CANCELLED")
        record["state"] = "CANCELLED"
        record["trials"] = self.repository.list_trials(study_id)
        return record

    def compare_study_runs(self, runs: list[Mapping[str, object]]) -> dict[str, object]:
        return compare_runs(runs)

    def rank_study_oos(self, trials: list[Mapping[str, object]]) -> list[dict[str, object]]:
        return rank_oos(trials)

    def execute_bar_run(
        self,
        run_id: str,
        *,
        events: tuple[MarketEvent, ...],
        provider: object,
        now_ms: int | None = None,
        warmup_events: int = 0,
    ) -> dict[str, object]:
        """Run a queued BAR backtest through the reference kernel. No live I/O."""
        if not self.settings.bar_effective:
            raise BacktestError("FLAG_DISABLED", "BAR backtests are disabled")
        record = self.get_run(run_id)
        current = RunState(record["state"])
        if record["fidelity_mode"] != "BAR_APPROX":
            raise BacktestError("FIDELITY_UNSUPPORTED", "execute_bar_run only supports BAR_APPROX")
        stamp = now_ms or _now_ms()
        for next_state in (RunState.PREPARING, RunState.RUNNING):
            current = transition(current, next_state)
            self.repository.update_run_state(run_id, state=current.value, updated_at_ms=stamp)
        session = StrategyProviderSession(provider, run_id=run_id)  # type: ignore[arg-type]
        adapter = StrategyHostAdapter(session)
        planner = PyneHostPlanner()
        try:
            config = json.loads(str(record["config_json"]))
        except (TypeError, ValueError, json.JSONDecodeError):
            config = {}
        adapter.start(
            {
                "roles": ["BARS"],
                "source": config.get("source"),
                "parameters": config.get("parameters") or {},
                "seed": config.get("seed"),
                "outputMode": config.get("outputMode") or "TARGET_POSITION",
            }
        )

        def strategy(visible: tuple[MarketEvent, ...], event: MarketEvent) -> list[dict]:
            phase = "WARMUP" if event.sequence <= warmup_events else "EVALUATION"
            wire = adapter.observe(
                sequence=event.sequence,
                event_time_ms=event.event_time_ms,
                watermark_ms=event.event_time_ms,
                phase=phase,
                market={"venue": "local", "symbol": str(record["dataset_id"])},
                bar=dict(event.payload),
            )
            if wire is None:
                return []
            return planner.plan(wire)

        result = SimulationKernel().run(events, strategy, warmup_events=warmup_events)
        current = transition(RunState.RUNNING, RunState.COMPLETING)
        current = transition(current, RunState.COMPLETED)
        self.repository.update_run_state(run_id, state=current.value, updated_at_ms=stamp)
        self._audit(
            run_id,
            "complete",
            {
                "decision_hash": result.decision_hash,
                "fill_hash": result.fill_hash,
                "ledger_hash": result.ledger_hash,
                "report_hash": result.report_hash,
                "ambiguity_count": result.ambiguity_count,
                "provider_identity": getattr(provider, "identity", lambda: {})(),
            },
        )
        completed = self.get_run(run_id)
        completed["result"] = {
            "decision_hash": result.decision_hash,
            "fill_hash": result.fill_hash,
            "ledger_hash": result.ledger_hash,
            "report_hash": result.report_hash,
            "ambiguity_count": result.ambiguity_count,
            "fills": result.fills,
        }
        report = build_report(completed, completed["result"])
        self.repository.save_report(
            run_id,
            REPORT_SCHEMA,
            canonical_json(report),
            result.report_hash,
            stamp,
        )
        completed["report"] = report
        return completed

    def execute_trade_run(
        self,
        run_id: str,
        *,
        events: tuple[MarketEvent, ...],
        provider: object,
        now_ms: int | None = None,
        warmup_events: int = 0,
    ) -> dict[str, object]:
        if not self.settings.trade_tape_effective:
            raise BacktestError("FLAG_DISABLED", "TRADE_TAPE backtests are disabled")
        record = self.get_run(run_id)
        current = RunState(record["state"])
        if record["fidelity_mode"] not in {"TRADE_TAPE", "AGG_TRADE_TAPE"}:
            raise BacktestError(
                "FIDELITY_UNSUPPORTED",
                "execute_trade_run only supports TRADE_TAPE or AGG_TRADE_TAPE",
            )
        stamp = now_ms or _now_ms()
        for next_state in (RunState.PREPARING, RunState.RUNNING):
            current = transition(current, next_state)
            self.repository.update_run_state(run_id, state=current.value, updated_at_ms=stamp)
        session = StrategyProviderSession(provider, run_id=run_id)  # type: ignore[arg-type]
        adapter = StrategyHostAdapter(session)
        planner = PyneHostPlanner()
        try:
            config = json.loads(str(record["config_json"]))
        except (TypeError, ValueError, json.JSONDecodeError):
            config = {}
        adapter.start(
            {
                "roles": ["TRADES"],
                "source": config.get("source"),
                "parameters": config.get("parameters") or {},
                "seed": config.get("seed"),
                "outputMode": config.get("outputMode") or "TARGET_POSITION",
            }
        )

        def strategy(visible: tuple[MarketEvent, ...], event: MarketEvent) -> list[dict]:
            phase = "WARMUP" if event.sequence <= warmup_events else "EVALUATION"
            wire = adapter.observe(
                sequence=event.sequence,
                event_time_ms=event.event_time_ms,
                watermark_ms=event.event_time_ms,
                phase=phase,
                market={"venue": "local", "symbol": str(record["dataset_id"])},
                bar=None,
            )
            if wire is None:
                return []
            return planner.plan(wire)

        kernel = TradeSimulationKernel(max_events=self.settings.max_trade_events)
        result = kernel.run(events, strategy, warmup_events=warmup_events)
        current = transition(RunState.RUNNING, RunState.COMPLETING)
        current = transition(current, RunState.COMPLETED)
        self.repository.update_run_state(run_id, state=current.value, updated_at_ms=stamp)
        completed = self.get_run(run_id)
        completed["result"] = {
            "decision_hash": result.decision_hash,
            "fill_hash": result.fill_hash,
            "ledger_hash": result.ledger_hash,
            "report_hash": result.report_hash,
            "ambiguity_count": result.ambiguity_count,
            "fills": result.fills,
            "report_label": (
                "TRADE_SEQUENCE"
                if record["fidelity_mode"] == "TRADE_TAPE"
                else "AGGREGATED_TRADE_SEQUENCE"
            ),
        }
        report = build_report(completed, completed["result"])
        self.repository.save_report(
            run_id,
            REPORT_SCHEMA,
            canonical_json(report),
            result.report_hash,
            stamp,
        )
        completed["report"] = report
        return completed

    def get_report(self, run_id: str) -> dict[str, object]:
        record = self.get_run(run_id)
        stored = self.repository.get_report(run_id)
        if stored is None:
            return build_report(record)
        return json.loads(str(stored["report_json"]))

    def get_study(self, study_id: str) -> dict[str, object]:
        record = self.repository.get_study(study_id)
        if record is None:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"unknown study {study_id}")
        return record

    def _assert_flags(self, fidelity_mode: str) -> None:
        if not self.settings.enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_ENABLED is 0")
        if fidelity_mode == "BAR_APPROX" and not self.settings.bar_enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_BAR_ENABLED is 0")
        if fidelity_mode in {"TRADE_TAPE", "AGG_TRADE_TAPE"} and not self.settings.trade_tape_enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_TRADE_TAPE_ENABLED is 0")
        if fidelity_mode == "BOOK_ASSISTED" and not self.settings.book_assisted_enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_BOOK_ASSISTED_ENABLED is 0")

    def _identity_from_payload(self, payload: Mapping[str, object]) -> RunIdentity:
        fidelity = str(payload.get("fidelity_mode") or "")
        if fidelity not in FIDELITY_MATRIX:
            raise BacktestError("FIDELITY_UNSUPPORTED", f"unknown fidelity {fidelity}")
        source_kind, _label = FIDELITY_MATRIX[fidelity]
        requested_kind = str(payload.get("source_event_kind") or source_kind)
        if requested_kind != source_kind:
            raise BacktestError(
                "FIDELITY_MISLABEL",
                f"{fidelity} cannot use source {requested_kind}",
            )
        try:
            start_time_ms = int(payload["start_time_ms"])
            end_time_ms = int(payload["end_time_ms"])
            warmup_bars = int(payload.get("warmup_bars") or 0)
        except (KeyError, TypeError, ValueError) as exc:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "invalid time window") from exc
        if end_time_ms <= start_time_ms:
            raise BacktestError("DATA_QUALITY_FAILED", "end_time_ms must be after start_time_ms")
        if warmup_bars < 0 or warmup_bars > self.settings.max_warmup_bars:
            raise BacktestError("BUDGET_EXCEEDED", "warmup_bars exceeds frozen ceiling")
        try:
            parameters_json = parse_parameters(payload.get("parameters") or {})
        except (TypeError, ValueError) as exc:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "parameters must be JSON object") from exc
        required = (
            "strategy_revision_id",
            "dataset_id",
            "data_epoch",
            "snapshot_hash",
        )
        missing = [name for name in required if not str(payload.get(name) or "").strip()]
        if missing:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"missing {missing}")
        return RunIdentity(
            strategy_revision_id=str(payload["strategy_revision_id"]),
            dataset_id=str(payload["dataset_id"]),
            data_epoch=str(payload["data_epoch"]),
            snapshot_hash=str(payload["snapshot_hash"]),
            fidelity_mode=fidelity,
            source_event_kind=source_kind,
            start_time_ms=start_time_ms,
            end_time_ms=end_time_ms,
            warmup_bars=warmup_bars,
            parameters_json=parameters_json,
            account_model=str(payload.get("account_model") or "LINEAR_PERP_ONE_WAY_V1"),
        )

    def _audit(self, run_id: str, action: str, details: Mapping[str, object]) -> None:
        ordinal = self._audit_ordinals.get(run_id, 0) + 1
        self._audit_ordinals[run_id] = ordinal
        payload = canonical_json(details)
        self.repository.append_audit(
            run_id,
            ordinal,
            action,
            "host",
            payload,
            "sha256:" + sha256_hex(f"{run_id}:{ordinal}:{action}:{payload}"),
        )


def _now_ms() -> int:
    return int(time.time() * 1000)
