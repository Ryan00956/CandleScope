from __future__ import annotations

import json
import time
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Mapping

from app.core.config import BacktestSettings

from app.backtest.reports import REPORT_SCHEMA, build_report
from app.backtest.strategy.protocol import StrategyProviderError
from app.market_dataset.snapshot import MarketDatasetError, MarketEvent
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
from .strategy.registry import StrategyRevisionRegistry, build_default_strategy_registry

FIDELITY_MATRIX = {
    "BAR_APPROX": ("BAR", "APPROXIMATE"),
    "TRADE_TAPE": ("RAW_TRADE", "TRADE_SEQUENCE"),
    "AGG_TRADE_TAPE": ("AGG_TRADE", "AGGREGATED_TRADE_SEQUENCE"),
    "BOOK_ASSISTED": ("TRADE_AND_L2", "BOOK_ASSISTED"),
    "QUEUE_EXACT": ("ORDER_LEVEL", "ORDER_LEVEL_REQUIRED"),
}


class BacktestService:
    def __init__(
        self,
        settings: BacktestSettings,
        repository: BacktestRepository,
        strategy_registry: StrategyRevisionRegistry | None = None,
        enforce_registered_revisions: bool = False,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.strategy_registry = strategy_registry or build_default_strategy_registry()
        self.enforce_registered_revisions = enforce_registered_revisions
        self._audit_ordinals: dict[str, int] = {}

    @classmethod
    def start(
        cls,
        settings: BacktestSettings,
        *,
        now_ms: int | None = None,
        strategy_registry: StrategyRevisionRegistry | None = None,
        enforce_registered_revisions: bool = False,
    ) -> BacktestService:
        if not settings.enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_ENABLED is 0")
        repository = BacktestRepository(settings.db_path)
        repository.open(now_ms=now_ms or _now_ms())
        return cls(
            settings,
            repository,
            strategy_registry,
            enforce_registered_revisions,
        )

    def shutdown(self) -> None:
        self.repository.close()

    def capabilities(self) -> dict[str, object]:
        fidelity_modes: list[str] = []
        if self.settings.bar_effective:
            fidelity_modes.append("BAR_APPROX")
        if self.settings.trade_tape_effective:
            fidelity_modes.append("AGG_TRADE_TAPE")
        if self.settings.book_assisted_effective:
            fidelity_modes.append("BOOK_ASSISTED")
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
            "fidelity_modes": fidelity_modes,
            "strategy_revisions": self.strategy_registry.revision_ids(),
            "strategies": self.strategy_registry.descriptors(),
        }

    def validate_run(self, payload: Mapping[str, object]) -> dict[str, object]:
        identity = self._identity_from_payload(payload)
        self._assert_flags(identity.fidelity_mode)
        self._assert_active_budget()
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
        self._assert_active_budget()
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
        queue_ceiling = self.settings.max_active_runs + (
            self.settings.max_concurrent_studies * self.settings.max_trials_per_study
        )
        inserted = self.repository.insert_run_budgeted(
            record,
            max_active=self.settings.max_active_runs,
            max_queued=queue_ceiling,
        )
        if inserted == "ACTIVE_LIMIT":
            raise BacktestError("BUDGET_EXCEEDED", "active run ceiling reached")
        if inserted == "QUEUE_LIMIT":
            raise BacktestError("BUDGET_EXCEEDED", "queued run ceiling reached")
        if inserted == "EXISTING":
            concurrent = self.repository.get_run_by_idempotency(idempotency_key)
            if concurrent is not None:
                return concurrent
            raise BacktestError(
                "IDENTITY_MUTATION",
                "run identity conflicted during creation",
            )
        self._audit(run_id, "create", {"config_hash": digest})
        return record

    def get_run(self, run_id: str) -> dict[str, object]:
        record = self.repository.get_run_by_id(run_id)
        if record is None:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"unknown run {run_id}")
        return record

    def list_runs(self) -> list[dict[str, object]]:
        return self.repository.list_runs()

    def cancel_run(
        self, run_id: str, *, now_ms: int | None = None
    ) -> dict[str, object]:
        stamp = now_ms or _now_ms()
        origin: RunState | None = None
        for _attempt in range(8):
            current = RunState(self.get_run(run_id)["state"])
            if current in {RunState.COMPLETED, RunState.CANCELLED, RunState.FAILED}:
                raise BacktestError(
                    "IDENTITY_MUTATION",
                    f"run {run_id} is already terminal ({current.value})",
                )
            if current is not RunState.CANCELLING:
                transition(current, RunState.CANCELLING)
                if not self.repository.compare_and_set_run_state(
                    run_id,
                    expected_state=current.value,
                    state=RunState.CANCELLING.value,
                    updated_at_ms=stamp,
                ):
                    continue
                origin = current
            transition(RunState.CANCELLING, RunState.CANCELLED)
            if self.repository.compare_and_set_run_state(
                run_id,
                expected_state=RunState.CANCELLING.value,
                state=RunState.CANCELLED.value,
                updated_at_ms=stamp,
            ):
                self._audit(
                    run_id,
                    "cancel",
                    {"from": (origin or RunState.CANCELLING).value},
                )
                return self.get_run(run_id)
        raise BacktestError(
            "IDENTITY_MUTATION",
            f"run {run_id} changed state concurrently during cancellation",
        )

    def fail_queued_run(
        self,
        run_id: str,
        exc: Exception,
        *,
        now_ms: int | None = None,
        expected_generation: int | None = None,
    ) -> dict[str, object]:
        """Fail a leased job that could not finish dataset/provider preparation."""
        record = self.get_run(run_id)
        if RunState(record["state"]) is not RunState.QUEUED:
            return record
        if expected_generation is not None and int(record["generation"]) != expected_generation:
            return record
        stamp = now_ms or _now_ms()
        preparing = transition(RunState.QUEUED, RunState.PREPARING)
        claimed = self.repository.compare_and_set_run_state(
            run_id,
            expected_state=RunState.QUEUED.value,
            expected_generation=expected_generation,
            state=preparing.value,
            updated_at_ms=stamp,
        )
        if not claimed:
            return self.get_run(run_id)
        normalized = self._normalize_execution_error(exc)
        self._mark_failed(
            run_id,
            stamp,
            normalized,
            expected_generation=expected_generation,
        )
        return self.get_run(run_id)

    def recover_expired_leases(self, *, now_ms: int) -> list[str]:
        expired = self.repository.expire_leases(now_ms)
        for run_id in expired:
            record = self.repository.get_run_by_id(run_id)
            if record is None:
                continue
            state = RunState(record["state"])
            if state in {
                RunState.QUEUED,
                RunState.PREPARING,
                RunState.RUNNING,
                RunState.COMPLETING,
            }:
                recovered = self.repository.compare_and_set_run_state(
                    run_id,
                    expected_state=state.value,
                    expected_generation=int(record["generation"]),
                    state=RunState.QUEUED.value,
                    updated_at_ms=now_ms,
                    generation=int(record["generation"]) + 1,
                )
                if recovered:
                    self._audit(
                        run_id,
                        "lease_expired",
                        {"generation": record["generation"]},
                    )
        return expired

    def requeue_interrupted_run(
        self,
        run_id: str,
        *,
        expected_generation: int,
        now_ms: int | None = None,
    ) -> bool:
        """Fence an interrupted local worker and make its durable run claimable."""
        stamp = now_ms or _now_ms()
        record = self.repository.get_run_by_id(run_id)
        if record is None or int(record["generation"]) != expected_generation:
            return False
        state = RunState(record["state"])
        if state not in {
            RunState.QUEUED,
            RunState.PREPARING,
            RunState.RUNNING,
            RunState.COMPLETING,
        }:
            return False
        recovered = self.repository.compare_and_set_run_state(
            run_id,
            expected_state=state.value,
            expected_generation=expected_generation,
            state=RunState.QUEUED.value,
            updated_at_ms=stamp,
            generation=expected_generation + 1,
        )
        if recovered:
            self._audit(
                run_id,
                "worker_interrupted",
                {"generation": expected_generation},
            )
        return recovered

    def create_study(
        self, payload: Mapping[str, object], *, now_ms: int | None = None
    ) -> dict[str, object]:
        if not self.settings.enabled or not self.settings.study_enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_STUDY_ENABLED is 0")
        required = ("start_ms", "end_ms", "train_ms", "test_ms")
        missing = [name for name in required if payload.get(name) is None]
        if missing:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"missing {missing}")
        try:
            start_ms = int(payload["start_ms"])
            end_ms = int(payload["end_ms"])
            int(payload["train_ms"])
            int(payload["test_ms"])
        except (TypeError, ValueError) as exc:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "invalid study window") from exc
        if end_ms <= start_ms:
            raise BacktestError("DATA_QUALITY_FAILED", "end_ms must be after start_ms")
        if self.enforce_registered_revisions:
            try:
                self.strategy_registry.require(str(payload.get("strategy_revision_id") or ""))
            except StrategyProviderError as exc:
                raise BacktestError(exc.code, str(exc)) from exc
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
        status = self.repository.claim_study_start(
            study_id,
            max_running=self.settings.max_concurrent_studies,
        )
        if status == "UNKNOWN":
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"unknown study {study_id}")
        if status == "BUDGET_EXCEEDED":
            raise BacktestError("BUDGET_EXCEEDED", "concurrent Study ceiling reached")
        if status not in {"STARTED", "RUNNING"}:
            raise BacktestError(
                "IDENTITY_MUTATION",
                f"study {study_id} cannot start from {status}",
            )
        return self.ensure_study_trials(study_id)

    def ensure_study_trials(self, study_id: str) -> dict[str, object]:
        """Idempotently recover the durable trial plan for one RUNNING Study."""
        record = self.get_study(study_id)
        if record["state"] != "RUNNING":
            return record
        config = json.loads(str(record["config_json"]))
        try:
            splits = walk_forward_splits(
                start_ms=int(config["start_ms"]),
                end_ms=int(config["end_ms"]),
                train_ms=int(config["train_ms"]),
                test_ms=int(config["test_ms"]),
                step_ms=int(config.get("step_ms") or config["test_ms"]),
            )
        except KeyError as exc:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"missing {exc}") from exc
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
                "trial_count": len(existing),
                "selection_warning": "in-sample best is not an OOS claim",
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
        record = self.get_study(study_id)
        return {
            "study": record,
            "trials": self.repository.list_trials(study_id),
            "splits": [split_wire(split) for split in splits],
            "trial_count": len(planned),
            "selection_warning": "in-sample best is not an OOS claim",
        }

    def materialize_study_runs(
        self,
        study_id: str,
        *,
        preview_snapshot: Callable[..., Mapping[str, object]],
    ) -> dict[str, object]:
        study = self.ensure_study_trials(study_id)
        if study.get("state") == "CANCELLED" or (
            isinstance(study.get("study"), Mapping)
            and study["study"].get("state") == "CANCELLED"  # type: ignore[index]
        ):
            return self.get_study(study_id)
        record = self.get_study(study_id)
        if record["state"] != "RUNNING":
            return record
        config = json.loads(str(record["config_json"]))
        required = ("dataset_id", "data_epoch")
        missing = [name for name in required if not str(config.get(name) or "").strip()]
        if missing:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD",
                f"study execution requires {missing}",
            )
        splits = {
            split.split_id: split
            for split in walk_forward_splits(
                start_ms=int(config["start_ms"]),
                end_ms=int(config["end_ms"]),
                train_ms=int(config["train_ms"]),
                test_ms=int(config["test_ms"]),
                step_ms=int(config.get("step_ms") or config["test_ms"]),
            )
        }
        base_parameters = dict(config.get("parameters") or {})
        for trial in self.repository.list_trials(study_id):
            if self.get_study(study_id)["state"] != "RUNNING":
                break
            if trial.get("run_id") or trial.get("state") != "PLANNED":
                continue
            split = splits[str(trial["split_id"])]
            parameters = {**base_parameters, **json.loads(str(trial["params_json"]))}
            preview = preview_snapshot(
                dataset_id=str(config["dataset_id"]),
                data_epoch=str(config["data_epoch"]),
                start_time_ms=split.start_ms,
                end_time_ms=split.end_ms - 1,
                interval=(None if config.get("interval") is None else str(config["interval"])),
            )
            payload = {
                "strategy_revision_id": record["strategy_revision_id"],
                "dataset_id": config["dataset_id"],
                "data_epoch": config["data_epoch"],
                "snapshot_hash": preview["snapshot_hash"],
                "fidelity_mode": "BAR_APPROX",
                "start_time_ms": split.start_ms,
                "end_time_ms": split.end_ms - 1,
                "warmup_bars": int(config.get("warmup_bars") or 0),
                "interval": config.get("interval"),
                "parameters": parameters,
                "initial_balance": config.get("initial_balance", "10000"),
                "slippage_bps": config.get("slippage_bps", "1"),
                "taker_fee_bps": config.get("taker_fee_bps", "0"),
                "gap_policy": config.get("gap_policy", "REJECT"),
                "study_id": study_id,
            }
            run = self.create_run(
                payload,
                idempotency_key=f"{study_id}:{trial['trial_id']}",
            )
            self.repository.attach_trial_run(
                str(trial["trial_id"]),
                run_id=str(run["run_id"]),
            )
            latest_trial = next(
                item
                for item in self.repository.list_trials(study_id)
                if item["trial_id"] == trial["trial_id"]
            )
            if (
                self.get_study(study_id)["state"] != "RUNNING"
                or latest_trial.get("run_id") != run["run_id"]
            ):
                latest_run = self.repository.get_run_by_id(str(run["run_id"]))
                if latest_run is not None and RunState(latest_run["state"]) not in {
                    RunState.COMPLETED,
                    RunState.FAILED,
                    RunState.CANCELLED,
                }:
                    self.cancel_run(str(run["run_id"]))
                if latest_trial.get("run_id") == run["run_id"]:
                    self.repository.update_trial_for_run(
                        str(run["run_id"]),
                        state="CANCELLED",
                    )
                break
        return self.get_study(study_id)

    def cancel_study(self, study_id: str) -> dict[str, object]:
        record = self.get_study(study_id)
        if record["state"] in {"COMPLETED", "FAILED", "CANCELLED"}:
            if record["state"] == "CANCELLED":
                return record
            raise BacktestError(
                "IDENTITY_MUTATION",
                f"study {study_id} is already terminal ({record['state']})",
            )
        self.repository.update_study_state(study_id, "CANCELLED")
        self.repository.cancel_planned_trials(study_id)
        for trial in self.repository.list_trials(study_id):
            run_id = trial.get("run_id")
            if not run_id:
                continue
            run = self.repository.get_run_by_id(str(run_id))
            if run is None or RunState(run["state"]) in {
                RunState.COMPLETED,
                RunState.FAILED,
                RunState.CANCELLED,
            }:
                continue
            try:
                self.cancel_run(str(run_id))
            except BacktestError:
                latest = self.repository.get_run_by_id(str(run_id))
                if latest is None or RunState(latest["state"]) not in {
                    RunState.COMPLETED,
                    RunState.FAILED,
                    RunState.CANCELLED,
                }:
                    raise
            self.repository.update_trial_for_run(str(run_id), state="CANCELLED")
        return self.get_study(study_id)

    def compare_study_runs(self, runs: list[Mapping[str, object]]) -> dict[str, object]:
        return compare_runs(runs)

    def rank_study_oos(
        self, trials: list[Mapping[str, object]]
    ) -> list[dict[str, object]]:
        return rank_oos(trials)

    def execute_bar_run(
        self,
        run_id: str,
        *,
        events: tuple[MarketEvent, ...],
        provider: object,
        now_ms: int | None = None,
        warmup_events: int | None = None,
        snapshot_evidence: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        """Run a queued BAR backtest through the reference kernel. No live I/O."""
        if not self.settings.bar_effective:
            raise BacktestError("FLAG_DISABLED", "BAR backtests are disabled")
        record = self.get_run(run_id)
        current = RunState(record["state"])
        if record["fidelity_mode"] != "BAR_APPROX":
            raise BacktestError(
                "FIDELITY_UNSUPPORTED", "execute_bar_run only supports BAR_APPROX"
            )
        stamp = now_ms or _now_ms()
        warmup_events = self._resolve_warmup(record, warmup_events)
        expected_generation = int(record["generation"])
        for next_state in (RunState.PREPARING, RunState.RUNNING):
            current = self._transition_run(
                run_id,
                current,
                next_state,
                stamp=stamp,
                expected_generation=expected_generation,
            )
        session: StrategyProviderSession | None = None
        deadline = time.monotonic() + self.settings.max_run_seconds
        try:
            session = StrategyProviderSession(provider, run_id=run_id)  # type: ignore[arg-type]
            adapter = StrategyHostAdapter(
                session,
                step_timeout_s=self.settings.provider_step_timeout_ms / 1000,
            )
            planner = PyneHostPlanner()
            try:
                config = json.loads(str(record["config_json"]))
            except (TypeError, ValueError, json.JSONDecodeError):
                config = {}
            adapter.start(
                {
                    "roles": ["BARS"],
                    "source": config.get("strategy_source"),
                    "parameters": config.get("parameters") or {},
                    "seed": config.get("seed"),
                    "outputMode": config.get("output_mode") or "TARGET_POSITION",
                }
            )

            if len(events) > self.settings.max_bar_rows:
                raise BacktestError(
                    "BUDGET_EXCEEDED",
                    "BAR event count exceeds frozen row ceiling",
                )
            event_bytes = len(
                canonical_json(
                    [
                        {
                            "sequence": event.sequence,
                            "event_time_ms": event.event_time_ms,
                            "role": event.role,
                            "payload": dict(event.payload),
                        }
                        for event in events
                    ]
                ).encode("utf-8")
            )
            if event_bytes > self.settings.worker_memory_mb * 1024 * 1024:
                raise BacktestError(
                    "BUDGET_EXCEEDED",
                    "BAR snapshot exceeds worker memory ceiling",
                )

            observed = 0
            resume_sequence = 0

            kernel = SimulationKernel(
                slippage_bps=_config_decimal(config, "slippage_bps", "1"),
                taker_fee_bps=_config_decimal(config, "taker_fee_bps", "0"),
                maker_fee_bps=_config_decimal(config, "maker_fee_bps", "0"),
                funding_rate=_config_decimal(config, "funding_rate", "0"),
                funding_interval_ms=int(config.get("funding_interval_hours") or 8) * 3_600_000,
                initial_balance=_config_decimal(config, "initial_balance", "10000"),
                price_tick=_config_optional_decimal(config, "price_tick"),
                qty_step=_config_optional_decimal(config, "qty_step"),
                min_notional=_config_optional_decimal(config, "min_notional"),
                gap_policy=str(config.get("gap_policy") or "REJECT"),
                execution_reporter=self._execution_reporter(session),
            )
            checkpoint = self.repository.latest_checkpoint(run_id)
            if checkpoint is not None:
                payload = self._verified_checkpoint_payload(record, checkpoint)
                kernel.restore(payload["engine"])
                session.restore(payload["provider"])
                session.generation = int(record["generation"])
                planner.restore(payload.get("planner") or {})
                observed = int(payload["observed"])
                resume_sequence = int(payload["sequence"])

            def strategy(
                visible: tuple[MarketEvent, ...], event: MarketEvent
            ) -> list[dict]:
                nonlocal observed
                if observed % 256 == 0:
                    self._assert_execution_control(
                        run_id,
                        deadline=deadline,
                        expected_generation=expected_generation,
                    )
                phase = "WARMUP" if observed < warmup_events else "EVALUATION"
                observed += 1
                bar = dict(event.payload)
                self._assert_frame_inputs(provider, bar=bar, trade=None)
                wire = adapter.observe(
                    sequence=event.sequence,
                    event_time_ms=event.event_time_ms,
                    watermark_ms=event.event_time_ms,
                    phase=phase,
                    market={"venue": "local", "symbol": str(record["dataset_id"])},
                    bar=bar,
                    features=self._observation_features(provider, bar=bar, trade=None),
                )
                if wire is None:
                    return []
                return planner.plan(
                    wire,
                    current_position=kernel.account.position_qty,
                )

            remaining_events = tuple(
                event for event in events if event.sequence > resume_sequence
            )

            def checkpoint_after(event: MarketEvent) -> None:
                interval = self.settings.checkpoint_event_interval
                if interval > 0 and observed > 0 and observed % interval == 0:
                    self._save_bar_checkpoint(
                        record,
                        sequence=event.sequence,
                        observed=observed,
                        kernel=kernel,
                        session=session,
                        planner=planner,
                        event_bytes=event_bytes,
                    )

            result = kernel.run(
                remaining_events,
                strategy,
                warmup_events=0,
                finalize=True,
                checkpoint_callback=checkpoint_after,
            )
            self._assert_execution_control(
                run_id,
                deadline=deadline,
                expected_generation=expected_generation,
            )
            self._assert_provider_state_budget(session.snapshot())
            strategy_metadata = _provider_report_metadata(provider)
            provider_close_hash = session.close()
        except Exception as exc:
            normalized = self._normalize_execution_error(exc)
            self._close_failed_session(session)
            self._mark_failed(
                run_id,
                stamp,
                normalized,
                expected_generation=expected_generation,
            )
            raise normalized from (None if normalized is exc else exc)
        except BaseException:
            self._close_failed_session(session)
            raise
        return self._persist_completed_run(
            run_id,
            result=result,
            provider=provider,
            provider_close_hash=provider_close_hash,
            stamp=stamp,
            expected_generation=expected_generation,
            result_overrides={
                "data_quality": dict((snapshot_evidence or {}).get("quality") or {}),
                "strategy_metadata": strategy_metadata,
                "contract_coverage": dict(
                    (snapshot_evidence or {}).get("contract_coverage") or {}
                ) | kernel.account.coverage(),
                "fill_model": {
                    "name": "BAR_NEXT_BAR_WORST_CASE_V1",
                    "slippage_bps": str(kernel.slippage_bps),
                    "taker_fee_bps": str(kernel.taker_fee_bps),
                    "maker_fee_bps": str(kernel.maker_fee_bps),
                    "funding_rate": str(kernel.funding_rate),
                    "funding_interval_hours": kernel.funding_interval_ms // 3_600_000,
                    "funding_model": "OFF" if kernel.funding_rate == 0 else "FIXED_INTERVAL_V1",
                    "gap_policy": kernel.gap_policy,
                    "order_closeout": "CANCEL_OPEN_AT_END",
                },
            },
        )

    def execute_trade_run(
        self,
        run_id: str,
        *,
        events: tuple[MarketEvent, ...],
        provider: object,
        now_ms: int | None = None,
        warmup_events: int | None = None,
        snapshot_evidence: Mapping[str, object] | None = None,
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
        warmup_events = self._resolve_warmup(record, warmup_events)
        expected_generation = int(record["generation"])
        for next_state in (RunState.PREPARING, RunState.RUNNING):
            current = self._transition_run(
                run_id,
                current,
                next_state,
                stamp=stamp,
                expected_generation=expected_generation,
            )
        session: StrategyProviderSession | None = None
        deadline = time.monotonic() + self.settings.max_run_seconds
        try:
            session = StrategyProviderSession(provider, run_id=run_id)  # type: ignore[arg-type]
            adapter = StrategyHostAdapter(
                session,
                step_timeout_s=self.settings.provider_step_timeout_ms / 1000,
            )
            planner = PyneHostPlanner()
            try:
                config = json.loads(str(record["config_json"]))
            except (TypeError, ValueError, json.JSONDecodeError):
                config = {}
            adapter.start(
                {
                    "roles": ["TRADES"],
                    "source": config.get("strategy_source"),
                    "parameters": config.get("parameters") or {},
                    "seed": config.get("seed"),
                    "outputMode": config.get("output_mode") or "TARGET_POSITION",
                }
            )

            observed = 0
            aggregate_open: Decimal | None = None
            aggregate_high: Decimal | None = None
            aggregate_low: Decimal | None = None
            aggregate_close: Decimal | None = None
            aggregate_volume = Decimal("0")

            def strategy(
                _visible: tuple[MarketEvent, ...], event: MarketEvent
            ) -> list[dict]:
                nonlocal observed, aggregate_open, aggregate_high
                nonlocal aggregate_low, aggregate_close, aggregate_volume
                if observed % 256 == 0:
                    self._assert_execution_control(
                        run_id,
                        deadline=deadline,
                        expected_generation=expected_generation,
                    )
                phase = "WARMUP" if observed < warmup_events else "EVALUATION"
                observed += 1
                trade = dict(event.payload)
                price = Decimal(str(trade["price"]))
                qty = Decimal(str(trade["qty"]))
                if aggregate_open is None:
                    aggregate_open = price
                    aggregate_high = price
                    aggregate_low = price
                aggregate_high = max(aggregate_high or price, price)
                aggregate_low = min(aggregate_low or price, price)
                aggregate_close = price
                aggregate_volume += qty
                bar = {
                    "open": str(aggregate_open),
                    "high": str(aggregate_high),
                    "low": str(aggregate_low),
                    "close": str(aggregate_close),
                    "volume": str(aggregate_volume),
                    "authority": "OBSERVATION_ONLY",
                }
                self._assert_frame_inputs(provider, bar=bar, trade=trade)
                wire = adapter.observe(
                    sequence=event.sequence,
                    event_time_ms=event.event_time_ms,
                    watermark_ms=event.event_time_ms,
                    phase=phase,
                    market={"venue": "local", "symbol": str(record["dataset_id"])},
                    bar=bar,
                    trade=trade,
                    features=self._observation_features(provider, bar=bar, trade=trade),
                )
                if wire is None:
                    return []
                return planner.plan(
                    wire,
                    current_position=kernel.projected_position_qty,
                )

            kernel = TradeSimulationKernel(
                max_events=self.settings.max_trade_events,
                slippage_bps=_config_decimal(config, "slippage_bps", "1"),
                taker_fee_bps=_config_decimal(config, "taker_fee_bps", "0"),
                maker_fee_bps=_config_decimal(config, "maker_fee_bps", "0"),
                funding_rate=_config_decimal(config, "funding_rate", "0"),
                funding_interval_ms=int(config.get("funding_interval_hours") or 8) * 3_600_000,
                initial_balance=_config_decimal(config, "initial_balance", "10000"),
                execution_reporter=self._execution_reporter(session),
            )
            result = kernel.run(
                events,
                strategy,
                warmup_events=warmup_events,
                finalize=True,
            )
            self._assert_execution_control(
                run_id,
                deadline=deadline,
                expected_generation=expected_generation,
            )
            self._assert_provider_state_budget(session.snapshot())
            strategy_metadata = _provider_report_metadata(provider)
            provider_close_hash = session.close()
        except Exception as exc:
            normalized = self._normalize_execution_error(exc)
            self._close_failed_session(session)
            self._mark_failed(
                run_id,
                stamp,
                normalized,
                expected_generation=expected_generation,
            )
            raise normalized from (None if normalized is exc else exc)
        except BaseException:
            self._close_failed_session(session)
            raise
        report_label = (
            "TRADE_SEQUENCE"
            if record["fidelity_mode"] == "TRADE_TAPE"
            else "AGGREGATED_TRADE_SEQUENCE"
        )
        return self._persist_completed_run(
            run_id,
            result=result,
            provider=provider,
            provider_close_hash=provider_close_hash,
            stamp=stamp,
            expected_generation=expected_generation,
            result_overrides={
                "report_label": report_label,
                "strategy_metadata": strategy_metadata,
                "data_quality": dict((snapshot_evidence or {}).get("quality") or {}),
                "contract_coverage": kernel.account.coverage(),
                "fill_model": {
                    "name": "TRADE_NEXT_PRINT_CONSERVATIVE_V1",
                    "slippage_bps": str(kernel.slippage_bps),
                    "taker_fee_bps": str(kernel.taker_fee_bps),
                    "maker_fee_bps": str(kernel.maker_fee_bps),
                    "funding_rate": str(kernel.funding_rate),
                    "funding_interval_hours": kernel.funding_interval_ms // 3_600_000,
                    "funding_model": "OFF" if kernel.funding_rate == 0 else "FIXED_INTERVAL_V1",
                },
            },
        )

    def get_report(self, run_id: str) -> dict[str, object]:
        self.get_run(run_id)
        stored = self.repository.get_report(run_id)
        if stored is None:
            raise BacktestError("IDENTITY_MUTATION", "backtest report is not ready")
        return json.loads(str(stored["report_json"]))

    def get_study(self, study_id: str) -> dict[str, object]:
        record = self.repository.get_study(study_id)
        if record is None:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"unknown study {study_id}")
        record["trials"] = self.repository.list_trials(study_id)
        return record

    def list_studies(self) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        for record in self.repository.list_studies():
            record["trials"] = self.repository.list_trials(str(record["study_id"]))
            result.append(record)
        return result

    def compare_study(self, study_id: str) -> dict[str, object]:
        study = self.get_study(study_id)
        completed: list[dict[str, object]] = []
        runs: list[Mapping[str, object]] = []
        for trial in study.get("trials") or []:  # type: ignore[union-attr]
            run_id = trial.get("run_id")
            if not run_id:
                continue
            run = self.repository.get_run_by_id(str(run_id))
            if run is None or run["state"] != RunState.COMPLETED.value:
                continue
            report = self.repository.get_report(str(run_id))
            if report is None:
                continue
            report_payload = json.loads(str(report["report_json"]))
            account = report_payload.get("account") or {}
            equity_curve = report_payload.get("equity_curve") or []
            score = (
                equity_curve[-1].get("equity")
                if equity_curve and isinstance(equity_curve[-1], Mapping)
                else account.get("quote_balance")
            )
            completed.append(
                {
                    "ordinal": trial["ordinal"],
                    "split_id": trial["split_id"],
                    "params": json.loads(str(trial["params_json"])),
                    "run_id": run_id,
                    "oos_score": score,
                    "report_hash": report["report_hash"],
                }
            )
            runs.append(run)
        if not completed:
            return {
                "study_id": study_id,
                "ready": False,
                "completed_trial_count": 0,
                "ranking": [],
            }
        return {
            "study_id": study_id,
            "ready": True,
            "completed_trial_count": len(completed),
            "comparison": compare_runs(runs),
            "ranking": rank_oos(completed),
        }

    def _assert_flags(self, fidelity_mode: str) -> None:
        if not self.settings.enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_ENABLED is 0")
        if fidelity_mode == "BAR_APPROX" and not self.settings.bar_enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_BAR_ENABLED is 0")
        if (
            fidelity_mode in {"TRADE_TAPE", "AGG_TRADE_TAPE"}
            and not self.settings.trade_tape_enabled
        ):
            raise BacktestError("FLAG_DISABLED", "BACKTEST_TRADE_TAPE_ENABLED is 0")
        if fidelity_mode == "BOOK_ASSISTED" and not self.settings.book_assisted_enabled:
            raise BacktestError("FLAG_DISABLED", "BACKTEST_BOOK_ASSISTED_ENABLED is 0")

    def _assert_active_budget(self) -> None:
        states = [RunState(item["state"]) for item in self.repository.list_runs()]
        active = sum(
            state
            in {
                RunState.PREPARING,
                RunState.RUNNING,
                RunState.COMPLETING,
                RunState.PAUSING,
                RunState.CANCELLING,
            }
            for state in states
        )
        if active >= self.settings.max_active_runs:
            raise BacktestError("BUDGET_EXCEEDED", "active run ceiling reached")
        queued = sum(state is RunState.QUEUED for state in states)
        queue_ceiling = self.settings.max_active_runs + (
            self.settings.max_concurrent_studies * self.settings.max_trials_per_study
        )
        if queued >= queue_ceiling:
            raise BacktestError("BUDGET_EXCEEDED", "queued run ceiling reached")

    def _assert_execution_control(
        self,
        run_id: str,
        *,
        deadline: float,
        expected_generation: int,
    ) -> None:
        record = self.repository.get_run_by_id(run_id)
        if record is not None and RunState(record["state"]) in {
            RunState.CANCELLING,
            RunState.CANCELLED,
        }:
            raise BacktestError("IDENTITY_MUTATION", "backtest run was cancelled")
        if (
            record is None
            or RunState(record["state"]) is not RunState.RUNNING
            or int(record["generation"]) != expected_generation
        ):
            raise BacktestError(
                "IDENTITY_MUTATION",
                "backtest worker no longer owns the active run generation",
            )
        if time.monotonic() > deadline:
            raise BacktestError("BUDGET_EXCEEDED", "backtest run exceeded time ceiling")

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
            raise BacktestError(
                "DATA_QUALITY_FAILED", "end_time_ms must be after start_time_ms"
            )
        horizon_ms = end_time_ms - start_time_ms
        if horizon_ms > self.settings.max_horizon_days * 86_400_000:
            raise BacktestError("BUDGET_EXCEEDED", "run horizon exceeds frozen ceiling")
        if warmup_bars < 0 or warmup_bars > self.settings.max_warmup_bars:
            raise BacktestError("BUDGET_EXCEEDED", "warmup_bars exceeds frozen ceiling")
        try:
            parameters_json = parse_parameters(payload.get("parameters") or {})
        except (TypeError, ValueError) as exc:
            raise BacktestError(
                "SCHEMA_UNKNOWN_FIELD", "parameters must be JSON object"
            ) from exc
        required = (
            "strategy_revision_id",
            "dataset_id",
            "data_epoch",
            "snapshot_hash",
        )
        missing = [
            name for name in required if not str(payload.get(name) or "").strip()
        ]
        if missing:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"missing {missing}")
        if str(payload.get("account_model") or "LINEAR_PERP_ONE_WAY_V1") != (
            "LINEAR_PERP_ONE_WAY_V1"
        ):
            raise BacktestError("FIDELITY_UNSUPPORTED", "unsupported account model")
        if str(payload.get("gap_policy") or "REJECT") not in {
            "REJECT",
            "PAUSE",
            "SKIP_WITH_WARNING",
        }:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "unknown gap_policy")
        for name, default, strictly_positive in (
            ("initial_balance", "10000", True),
            ("slippage_bps", "1", False),
            ("taker_fee_bps", "0", False),
            ("maker_fee_bps", "0", False),
        ):
            value = _config_decimal(payload, name, default)
            if strictly_positive and value <= 0:
                raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"{name} must be positive")
            if not strictly_positive and value < 0:
                raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"{name} cannot be negative")
        funding_rate = _config_decimal(payload, "funding_rate", "0")
        if abs(funding_rate) > Decimal("1"):
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "funding_rate must be between -1 and 1")
        try:
            funding_interval_hours = int(payload.get("funding_interval_hours") or 8)
        except (TypeError, ValueError) as exc:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "invalid funding_interval_hours") from exc
        if funding_interval_hours < 1 or funding_interval_hours > 168:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "funding_interval_hours must be 1..168")
        output_mode = str(payload.get("output_mode") or "TARGET_POSITION")
        if output_mode not in {"SIGNAL", "TARGET_POSITION", "ORDER_INTENT"}:
            raise BacktestError("SCHEMA_UNKNOWN_FIELD", "unsupported output_mode")
        strategy_source = payload.get("strategy_source")
        if strategy_source is not None and len(str(strategy_source)) > 2_000:
            raise BacktestError("BUDGET_EXCEEDED", "strategy_source exceeds 2000 characters")
        if self.enforce_registered_revisions:
            try:
                descriptor = self.strategy_registry.require(
                    str(payload["strategy_revision_id"])
                )
                capabilities = descriptor.factory().describe()
                if output_mode not in capabilities.output_modes:
                    raise StrategyProviderError(
                        "PROVIDER_PROTOCOL_VIOLATION",
                        f"{descriptor.revision_id} cannot output {output_mode}",
                    )
                if strategy_source is not None and not descriptor.accepts_source:
                    raise StrategyProviderError(
                        "PROVIDER_PROTOCOL_VIOLATION",
                        f"{descriptor.revision_id} does not accept strategy source",
                    )
                probe = descriptor.factory()
                probe.prepare(
                    {
                        "roles": ["BARS" if fidelity == "BAR_APPROX" else "TRADES"],
                        "source": strategy_source,
                        "parameters": json.loads(parameters_json),
                        "outputMode": output_mode,
                    }
                )
                probe.close()
            except StrategyProviderError as exc:
                raise BacktestError(exc.code, str(exc)) from exc
        for name in ("price_tick", "qty_step", "min_notional"):
            _config_optional_decimal(payload, name)
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
            execution_json=canonical_json(
                {
                    "strategy_source": strategy_source,
                    "output_mode": output_mode,
                    "initial_balance": str(_config_decimal(payload, "initial_balance", "10000")),
                    "slippage_bps": str(_config_decimal(payload, "slippage_bps", "1")),
                    "taker_fee_bps": str(_config_decimal(payload, "taker_fee_bps", "0")),
                    "maker_fee_bps": str(_config_decimal(payload, "maker_fee_bps", "0")),
                    "funding_rate": str(funding_rate),
                    "funding_interval_hours": funding_interval_hours,
                    "price_tick": payload.get("price_tick"),
                    "qty_step": payload.get("qty_step"),
                    "min_notional": payload.get("min_notional"),
                    "gap_policy": str(payload.get("gap_policy") or "REJECT"),
                    "exchange": str(payload.get("exchange") or "binance"),
                    "market_type": str(payload.get("market_type") or "usdm"),
                }
            ),
        )

    def _audit(self, run_id: str, action: str, details: Mapping[str, object]) -> None:
        ordinal = self.repository.next_audit_ordinal(run_id)
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

    def _resolve_warmup(
        self, record: Mapping[str, object], warmup_events: int | None
    ) -> int:
        if warmup_events is not None:
            return int(warmup_events)
        try:
            config = json.loads(str(record.get("config_json") or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            config = {}
        try:
            return int(config.get("warmup_bars") or 0)
        except (TypeError, ValueError):
            return 0

    def _execution_reporter(
        self,
        session: StrategyProviderSession,
    ) -> Any:
        def report(event: dict) -> None:
            payload = dict(event)
            payload.setdefault("accepted", True)
            payload["generation"] = session.generation
            session.on_execution_report(payload)

        return report

    def _save_bar_checkpoint(
        self,
        record: Mapping[str, object],
        *,
        sequence: int,
        observed: int,
        kernel: SimulationKernel,
        session: StrategyProviderSession,
        planner: PyneHostPlanner,
        event_bytes: int,
    ) -> None:
        provider = session.snapshot()
        self._assert_provider_state_budget(provider)
        payload = {
            "schemaVersion": "candlescope.backtest-checkpoint/1",
            "run_id": record["run_id"],
            "config_hash": record["config_hash"],
            "snapshot_hash": record["snapshot_hash"],
            "sequence": int(sequence),
            "observed": int(observed),
            "engine": kernel.snapshot(),
            "provider": provider,
            "planner": planner.snapshot(),
        }
        payload_json = canonical_json(payload)
        if event_bytes + len(payload_json.encode("utf-8")) > (
            self.settings.worker_memory_mb * 1024 * 1024
        ):
            raise BacktestError(
                "BUDGET_EXCEEDED",
                "backtest execution state exceeds worker memory ceiling",
            )
        saved = self.repository.save_checkpoint(
            {
                "run_id": str(record["run_id"]),
                "sequence": int(sequence),
                "generation": int(record["generation"]),
                "payload_json": payload_json,
                "state_hash": "sha256:" + sha256_hex(payload),
                "created_at_ms": _now_ms(),
            }
        )
        if not saved:
            raise BacktestError(
                "IDENTITY_MUTATION",
                "stale worker generation cannot publish a checkpoint",
            )

    def _assert_provider_state_budget(self, snapshot: Mapping[str, object]) -> None:
        provider_bytes = len(
            canonical_json(snapshot.get("provider") or {}).encode("utf-8")
        )
        if provider_bytes > self.settings.max_provider_state_bytes:
            raise BacktestError(
                "BUDGET_EXCEEDED",
                "provider checkpoint state exceeds frozen byte ceiling",
            )

    def _verified_checkpoint_payload(
        self,
        record: Mapping[str, object],
        checkpoint: Mapping[str, object],
    ) -> dict[str, Any]:
        try:
            payload = json.loads(str(checkpoint["payload_json"]))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise BacktestError("CHECKPOINT_CORRUPT", "checkpoint payload is invalid") from exc
        expected = "sha256:" + sha256_hex(payload)
        if str(checkpoint.get("state_hash") or "") != expected:
            raise BacktestError("CHECKPOINT_CORRUPT", "checkpoint hash mismatch")
        if (
            payload.get("schemaVersion") != "candlescope.backtest-checkpoint/1"
            or payload.get("run_id") != record.get("run_id")
            or payload.get("config_hash") != record.get("config_hash")
            or payload.get("snapshot_hash") != record.get("snapshot_hash")
            or int(payload.get("sequence") or -1) != int(checkpoint["sequence"])
            or int(checkpoint.get("generation") or 0) > int(record["generation"])
        ):
            raise BacktestError(
                "CHECKPOINT_CORRUPT",
                "checkpoint identity does not match the run",
            )
        if not isinstance(payload.get("engine"), dict) or not isinstance(
            payload.get("provider"), dict
        ):
            raise BacktestError("CHECKPOINT_CORRUPT", "checkpoint state is incomplete")
        return payload

    def _persist_completed_run(
        self,
        run_id: str,
        *,
        result: Any,
        provider: object,
        provider_close_hash: str,
        stamp: int,
        expected_generation: int,
        result_overrides: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        current = transition(RunState.RUNNING, RunState.COMPLETING)
        completing_won = self.repository.compare_and_set_run_state(
            run_id,
            expected_state=RunState.RUNNING.value,
            expected_generation=expected_generation,
            state=current.value,
            updated_at_ms=stamp,
        )
        if not completing_won:
            raise BacktestError(
                "IDENTITY_MUTATION",
                "run state changed before report finalization",
            )
        try:
            completing = self.get_run(run_id)
            result_payload: dict[str, object] = {
                "decision_hash": result.decision_hash,
                "fill_hash": result.fill_hash,
                "ledger_hash": result.ledger_hash,
                "ambiguity_count": result.ambiguity_count,
                "fills": result.fills,
                "orders": result.orders,
                "rejected": result.rejected,
                "ledger": result.ledger,
                "equity_curve": result.equity_curve,
                "provider_close_hash": provider_close_hash,
            }
            result_payload.update(result_overrides or {})
            identity = getattr(provider, "identity", None)
            if callable(identity):
                result_payload["provider_identity"] = identity()
            report_metadata = getattr(provider, "report_metadata", None)
            if "strategy_metadata" not in result_payload and callable(report_metadata):
                result_payload["strategy_metadata"] = report_metadata()

            report_record = dict(completing)
            report_record["state"] = RunState.COMPLETED.value
            report = build_report(report_record, result_payload)
            report_json = canonical_json(report)
            if len(report_json.encode("utf-8")) > self.settings.max_report_bytes:
                raise BacktestError(
                    "BUDGET_EXCEEDED",
                    "backtest report exceeds frozen byte ceiling",
                )
            report_hash = str(report["hashes"]["report"])
            result_payload["report_hash"] = report_hash
            audit_details = {
                "decision_hash": result.decision_hash,
                "fill_hash": result.fill_hash,
                "ledger_hash": result.ledger_hash,
                "report_hash": report_hash,
                "ambiguity_count": result.ambiguity_count,
                "provider_close_hash": provider_close_hash,
                "provider_identity": result_payload.get("provider_identity") or {},
            }
            self.repository.finalize_run(
                run_id=run_id,
                expected_generation=expected_generation,
                report_schema=REPORT_SCHEMA,
                report_json=report_json,
                report_hash=report_hash,
                generated_at_ms=stamp,
                audit_action="complete",
                audit_actor="host",
                audit_details_json=canonical_json(audit_details),
                updated_at_ms=stamp,
            )
        except Exception as exc:
            normalized = self._normalize_execution_error(exc)
            self._mark_failed(
                run_id,
                stamp,
                normalized,
                expected_generation=expected_generation,
            )
            if normalized is exc:
                raise
            raise normalized from exc

        completed = self.get_run(run_id)
        completed["result"] = result_payload
        completed["report"] = report
        return completed

    def _normalize_execution_error(self, exc: Exception) -> Exception:
        if isinstance(exc, (BacktestError, StrategyProviderError, MarketDatasetError)):
            return exc
        return StrategyProviderError(
            "PROVIDER_CRASH_UNRECOVERABLE",
            f"provider execution failed ({type(exc).__name__})",
        )

    def _close_failed_session(self, session: StrategyProviderSession | None) -> None:
        if session is None or session.closed:
            return
        try:
            session.close()
        except Exception:
            # The primary execution error remains authoritative. A provider that
            # also fails close is already unusable and must not mask that cause.
            pass

    def _mark_failed(
        self,
        run_id: str,
        stamp: int,
        exc: Exception,
        *,
        expected_generation: int | None = None,
    ) -> None:
        record = self.repository.get_run_by_id(run_id)
        if record is None:
            return
        current = RunState(record["state"])
        if current not in {RunState.PREPARING, RunState.RUNNING, RunState.COMPLETING}:
            return
        code = str(getattr(exc, "code", None) or "PROVIDER_CRASH_UNRECOVERABLE")
        failed = transition(current, RunState.FAILED)
        changed = self.repository.compare_and_set_run_state(
            run_id,
            expected_state=current.value,
            expected_generation=expected_generation,
            state=failed.value,
            updated_at_ms=stamp,
            failure_code=code,
        )
        if changed:
            self.repository.delete_checkpoints(run_id)
            self._audit(run_id, "fail", {"code": code, "message": str(exc)})

    def _transition_run(
        self,
        run_id: str,
        current: RunState,
        target: RunState,
        *,
        stamp: int,
        expected_generation: int | None = None,
    ) -> RunState:
        next_state = transition(current, target)
        if self.repository.compare_and_set_run_state(
            run_id,
            expected_state=current.value,
            expected_generation=expected_generation,
            state=next_state.value,
            updated_at_ms=stamp,
        ):
            return next_state
        latest = self.repository.get_run_by_id(run_id)
        latest_state = None if latest is None else latest["state"]
        raise BacktestError(
            "IDENTITY_MUTATION",
            f"run state changed concurrently ({current.value} -> {latest_state})",
        )

    def _assert_frame_inputs(
        self,
        provider: object,
        *,
        bar: Mapping[str, object] | None,
        trade: Mapping[str, object] | None,
    ) -> None:
        describe = getattr(provider, "describe", None)
        if not callable(describe):
            return
        modes = tuple(getattr(describe(), "input_modes", ()) or ())
        if "BAR_CLOSE" in modes and bar is None:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "BAR_CLOSE requires a bar"
            )
        if "TRADE_EVENT" in modes and trade is None:
            raise StrategyProviderError(
                "PROVIDER_PROTOCOL_VIOLATION", "TRADE_EVENT requires a trade"
            )
        if "BOOK_EVENT" in modes:
            raise StrategyProviderError(
                "FIDELITY_UNSUPPORTED",
                "BOOK_EVENT is not available on this execute path",
            )

    def _observation_features(
        self,
        provider: object,
        *,
        bar: Mapping[str, object] | None,
        trade: Mapping[str, object] | None,
    ) -> dict[str, str]:
        source: dict[str, object] = {}
        if bar is not None:
            for name in ("open", "high", "low", "close", "volume"):
                if bar.get(name) is not None:
                    source[name] = bar[name]
        if trade is not None:
            if trade.get("price") is not None:
                source.setdefault("close", trade["price"])
                source.setdefault("price", trade["price"])
            if trade.get("qty") is not None:
                source.setdefault("volume", trade["qty"])
        names = _declared_feature_names(provider)
        if names:
            missing = [name for name in names if name not in source]
            if missing:
                raise StrategyProviderError(
                    "PROVIDER_PROTOCOL_VIOLATION",
                    f"missing features {missing}",
                )
            return {name: str(source[name]) for name in names}
        if "close" in source:
            return {"close": str(source["close"])}
        return {key: str(value) for key, value in source.items()}


def _declared_feature_names(provider: object) -> tuple[str, ...] | None:
    artifact = getattr(provider, "_artifact", None)
    schema = getattr(artifact, "feature_schema", None) if artifact is not None else None
    if schema is None:
        schema = getattr(provider, "feature_schema", None)
    names = getattr(schema, "names", None)
    if not names:
        describe = getattr(provider, "describe", None)
        capabilities = describe() if callable(describe) else None
        names = getattr(capabilities, "required_features", None)
    if not names:
        return None
    return tuple(str(name) for name in names)


def _provider_report_metadata(provider: object) -> dict[str, object]:
    report_metadata = getattr(provider, "report_metadata", None)
    if not callable(report_metadata):
        return {}
    value = report_metadata()
    return dict(value) if isinstance(value, Mapping) else {}


def _config_decimal(config: Mapping[str, object], name: str, default: str) -> Decimal:
    try:
        value = Decimal(str(config.get(name, default)))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"{name} must be Decimal") from exc
    if not value.is_finite() or value < 0:
        raise BacktestError(
            "SCHEMA_UNKNOWN_FIELD", f"{name} must be finite and non-negative"
        )
    return value


def _config_optional_decimal(config: Mapping[str, object], name: str) -> Decimal | None:
    if config.get(name) is None:
        return None
    value = _config_decimal(config, name, "0")
    if value <= 0:
        raise BacktestError("SCHEMA_UNKNOWN_FIELD", f"{name} must be positive")
    return value


def _now_ms() -> int:
    return int(time.time() * 1000)
